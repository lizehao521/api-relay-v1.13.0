/**
 * 上游池与路由。
 *
 * 池负责"有哪些上游、谁健康、谁还有并发额度"；路由负责"这次请求用谁、为什么"。
 * 两者都不持有会话状态，重启后行为一致（熔断状态可从 SQLite 恢复）。
 *
 * 归因 → 熔断 → 故障转移 的闭环：
 *   classifyFailure 判为不可恢复（如 auth_invalid / quota_exhausted）→ 直接把上游摘到熔断；
 *   判为可恢复（rate_limited / 5xx / timeout）→ 计入连续失败，达到阈值摘除，冷却后半开。
 */
import { BoundedCache, ewma, ownLookup } from '../util/index.js';
import { createUpstreamClient } from './client.js';
export class ConcurrencyLimiter {
    limit;
    shared;
    inFlight = 0;
    queue = [];
    constructor(limit, shared) {
        this.limit = limit;
        this.shared = shared;
    }
    setLimit(limit) {
        this.limit = Math.max(1, limit);
        this.drain();
    }
    get active() {
        return this.inFlight;
    }
    get waiting() {
        return this.queue.length;
    }
    async acquire(signal) {
        // 批次3（REQ-01，语义=**排队**）：注入共享后端时走跨实例排队（轮询等待全局名额）。
        if (this.shared)
            return this.acquireShared(signal);
        if (this.inFlight < this.limit) {
            this.inFlight++;
            return () => this.release();
        }
        await new Promise((resolve, reject) => {
            const onAbort = () => {
                const i = this.queue.indexOf(grant);
                if (i >= 0)
                    this.queue.splice(i, 1);
                reject(new Error('aborted'));
            };
            const grant = () => {
                signal?.removeEventListener('abort', onAbort);
                // ⚠️ 必须在**同步**的 grant 里自增：drain() 调用 next() 后同一 tick 就要能看到
                // inFlight 变化，否则会误判"还有额度"而把整个队列一次性唤醒（审计 P2-8；
                // 对冲让同一上游并发 acquire 翻倍，更容易踩到）。
                this.inFlight++;
                resolve();
            };
            this.queue.push(grant);
            signal?.addEventListener('abort', onAbort, { once: true });
        });
        return () => this.release();
    }
    release() {
        this.inFlight = Math.max(0, this.inFlight - 1);
        this.drain();
    }
    drain() {
        // grant() 现在**同步**自增 inFlight，所以这里的 while 条件在每次唤醒后立刻成立/失效，
        // 不会超发（审计 P2-8）。
        while (this.inFlight < this.limit && this.queue.length > 0) {
            const next = this.queue.shift();
            if (!next)
                break;
            next();
        }
    }
    stats() {
        return { active: this.inFlight, waiting: this.queue.length, limit: this.limit };
    }
    /**
     * 跨实例排队获取名额（REQ-01，语义=排队）。
     *
     * 轮询等待全局名额：`concurrencyAcquire` 成功即占用；全局满则退避后重试，
     * 直到成功或 `signal` 中断。**fail-open**：共享后端不可用时 `concurrencyAcquire`
     * 内部已降级为进程内计数（不会因此拒绝请求）。
     *
     * 注意：共享模式下本地 `inFlight/waiting` 不再计数（stats 里恒 0）——真实并发由
     * 共享后端裁决；面板并发列在共享模式下为近似值。
     */
    async acquireShared(signal) {
        const s = this.shared;
        let waitMs = 50;
        for (;;) {
            if (signal?.aborted)
                throw new Error('aborted');
            const ok = await s.store.concurrencyAcquire(s.key, this.limit, s.ttlMs);
            if (ok) {
                return () => {
                    void s.store.concurrencyRelease(s.key).catch(() => undefined);
                };
            }
            await delayAbortable(waitMs, signal);
            waitMs = Math.min(200, Math.round(waitMs * 1.5));
        }
    }
}
/** 可中断延时（acquireShared 的排队等待；signal 中断即抛 aborted）。 */
function delayAbortable(ms, signal) {
    return new Promise((resolve, reject) => {
        const cleanup = () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
        };
        const onAbort = () => {
            cleanup();
            reject(new Error('aborted'));
        };
        const timer = setTimeout(() => {
            cleanup();
            resolve();
        }, ms);
        if (signal?.aborted) {
            onAbort();
            return;
        }
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}
/**
 * 计入上游健康度（熔断计数）的失败原因白名单。
 *
 * 判据：这次失败是否提供了"上游本身是否可用"的信息。
 * - 计入：上游限流/过载/超时/不可达/网络错误/流中断，以及密钥失效与余额耗尽
 *   （这两类虽是供应商级，但请求重试必然失败，必须立刻摘除，避免全量空转）。
 * - 不计入：内容过滤、参数非法、工具调用参数错、上下文超限（请求级——换个请求就好）、
 *   模型不存在/无权限（模型级——同一 provider 的其他模型仍然可用）、
 *   中转站自身内部错误（不是上游的锅）、客户端主动断开、未知归因。
 *
 * 曾经的实现把上面这些一律计入 `consecutiveFailures`，实测后果：一条被内容过滤
 * 的请求就让整个 provider 对全网关熔断，所有无关模型一起 503。
 */
const BREAKER_COUNTED_REASONS = new Set([
    'rate_limited',
    'quota_exhausted',
    'auth_invalid',
    'model_overloaded',
    'upstream_timeout',
    'upstream_unavailable',
    'network_error',
    'stream_interrupted',
]);
/** 该归因是否应计入上游熔断计数（见 BREAKER_COUNTED_REASONS 的判据） */
export function countsTowardUpstreamHealth(reason) {
    return BREAKER_COUNTED_REASONS.has(reason);
}
export class ProviderPool {
    config;
    logger;
    entries = new Map();
    breakerPersist;
    /**
     * 共享状态（REQ-01）。**可选**：注入后熔断/半开状态会镜像到共享后端，
     * 供其他实例读取；未注入时保持现状（仅本地 + breakerPersist）。
     *
     * 说明（本轮已知残留）：`isOpen` 被同步的 `Router.route` 调用，故热路径仍以本地
     * health 为准；跨实例可见性通过"写入镜像 + `refreshBreakersFromShared()` 拉取"实现，
     * 把路由改成异步读取共享状态属 REQ-02。
     */
    state;
    constructor(config, logger, options = {}) {
        this.config = config;
        this.logger = logger;
        this.breakerPersist = options.breakerPersist;
        this.state = options.state;
        for (const p of config.providers) {
            // 把服务端的超时**真的接进**上游客户端（此前只传了 userAgent，
            // 导致配置里的 upstreamTtfbTimeoutMs / upstreamTimeoutMs 形同虚设）。
            const client = createUpstreamClient(p, {
                userAgent: 'api-relay/0.1',
                timeoutMs: config.server.upstreamTimeoutMs,
                ttfbTimeoutMs: config.server.upstreamTtfbTimeoutMs,
                ...(config.server.upstreamStallTimeoutMs !== undefined
                    ? { stallTimeoutMs: config.server.upstreamStallTimeoutMs }
                    : {}),
            });
            const restored = options.restoredBreakers?.get(p.id);
            // healthy 必须与 openUntil 一致（r10 修复）：此前这里硬编码 `healthy: true`，
            // 于是恢复一个**仍处于熔断**的上游时，面板详情页会显示「健康: 正常」紧挨着
            // 「熔断剩余: 29分」——自相矛盾，运维据此会以为上游可用。
            // 不变量：healthy === (openUntil <= now)，由 noteFailure/noteSuccess/isOpen 共同维持。
            const restoredOpenUntil = restored?.openUntil ?? 0;
            this.entries.set(p.id, {
                config: p,
                client,
                limiter: new ConcurrencyLimiter(p.concurrency ?? 32, 
                // 仅在**真正共享**的后端（Redis）注入：内存 state 是进程内实现，注入它等于
                // 把本地队列换成轮询（无收益反有开销）。未共享时保持本地排队（零回归）。
                this.state && this.state.health().backend === 'shared'
                    ? { store: this.state, key: `provider:${p.id}`, ttlMs: (config.server.upstreamTimeoutMs ?? 120_000) + 60_000 }
                    : undefined),
                health: {
                    providerId: p.id,
                    healthy: restoredOpenUntil <= Date.now(),
                    consecutiveFailures: restored?.consecutiveFailures ?? 0,
                    openUntil: restoredOpenUntil,
                    ...(restored?.lastReason ? { lastFailureReason: restored.lastReason } : {}),
                    ewmaLatencyMs: 0,
                    totalRequests: 0,
                    totalFailures: 0,
                },
            });
        }
    }
    get(id) {
        return this.entries.get(id);
    }
    all() {
        return [...this.entries.values()];
    }
    /** 是否处于熔断打开状态 */
    isOpen(entry, now = Date.now()) {
        if (entry.health.openUntil === 0)
            return false;
        if (now >= entry.health.openUntil) {
            // 半开：允许一次试探
            entry.health.openUntil = 0;
            entry.health.healthy = true;
            this.persistBreaker(entry);
            return false;
        }
        return true;
    }
    /** 可用性：未禁用 + 未熔断 */
    isAvailable(entry, now = Date.now()) {
        if (entry.config.disabled)
            return false;
        return !this.isOpen(entry, now);
    }
    noteSuccess(entry, latencyMs) {
        entry.health.consecutiveFailures = 0;
        entry.health.healthy = true;
        entry.health.openUntil = 0;
        entry.health.ewmaLatencyMs = ewma(entry.health.ewmaLatencyMs, latencyMs);
        entry.health.totalRequests++;
        this.persistBreaker(entry);
        // REQ-01：镜像到共享后端（fail-open），使其他实例的 breakerGet 立即看到清空
        void this.state?.breakerNoteSuccess(entry.config.id).catch(() => { });
    }
    /**
     * 记录一次上游失败。
     *
     * `countsTowardBreaker=false` 用于**请求级**失败（内容过滤、参数非法、上下文超限、
     * 模型级 403/404 等）：这类失败说明"这一个请求不合规"，不能说明"这个上游不健康"。
     * 它们依旧计入 `totalFailures` 与 `lastFailureReason` 供面板归因，但不增加
     * `consecutiveFailures`、不打开熔断、也不镜像到共享后端——否则单个用户发一条
     * 违规请求就能把整个 provider 对全网关摘掉。
     */
    noteFailure(entry, reason, fatal, opts = {}) {
        const counts = opts.countsTowardBreaker !== false;
        // 统计与归因：无论是否计入健康度都要记
        entry.health.lastFailureReason = reason;
        entry.health.lastErrorAt = Date.now();
        entry.health.totalRequests++;
        entry.health.totalFailures++;
        if (!counts)
            return;
        entry.health.consecutiveFailures++;
        const { breakerThreshold, breakerCooldownMs } = this.config.lossReduction.attribution;
        if (fatal || entry.health.consecutiveFailures >= breakerThreshold) {
            entry.health.healthy = false;
            entry.health.openUntil = Date.now() + breakerCooldownMs;
            this.logger.warn('upstream.breaker_open', {
                provider: entry.config.id,
                reason,
                fatal,
                consecutiveFailures: entry.health.consecutiveFailures,
                cooldownMs: breakerCooldownMs,
            });
        }
        else {
            entry.health.healthy = true;
        }
        this.persistBreaker(entry);
        // REQ-01：镜像失败计数/熔断到共享后端（Lua 原子），供跨实例判定
        void this.state
            ?.breakerNoteFailure(entry.config.id, reason, { fatal, threshold: breakerThreshold, cooldownMs: breakerCooldownMs })
            .catch(() => { });
    }
    /** 人工摘除/恢复（运营动作） */
    setDisabled(providerId, disabled) {
        const entry = this.entries.get(providerId);
        if (!entry)
            return false;
        entry.config.disabled = disabled;
        if (!disabled) {
            entry.health.openUntil = 0;
            entry.health.consecutiveFailures = 0;
            entry.health.healthy = true;
        }
        this.persistBreaker(entry);
        // REQ-01：恢复时同步清空共享后端的熔断状态
        if (!disabled)
            void this.state?.breakerReset(providerId).catch(() => { });
        return true;
    }
    /**
     * 人工重置熔断（运营动作，r10 修复）。
     *
     * 此前 admin 的 providerReset **直接改 entry.health 字段、不走 persistBreaker**——
     * 于是「重置成功」只对当前进程生效，重启后从 breaker_state 恢复出旧的 openUntil/
     * consecutiveFailures，熔断原样回来。实测：置 openUntil=+30min → POST reset（回 200
     * openUntil:0）→ 重启 → 仍熔断剩 1673 秒。运维会以为重置没生效而反复点。
     *
     * 与 setDisabled 的关键区别：那个只改 config.disabled（运行态，重启回配置文件），
     * 顺带清熔断；本方法只清熔断**且必须落盘**——因为熔断恰恰是跨重启保持的那一半。
     */
    resetBreaker(providerId) {
        const entry = this.entries.get(providerId);
        if (!entry)
            return false;
        entry.health.consecutiveFailures = 0;
        entry.health.openUntil = 0;
        entry.health.healthy = true;
        this.persistBreaker(entry);
        // REQ-01：人工重置必须同时作用于共享后端，否则其他实例仍认为上游熔断
        void this.state?.breakerReset(providerId).catch(() => { });
        return true;
    }
    /**
     * 从共享后端拉取熔断状态并合入本地 health（跨实例可见性，REQ-01）。
     *
     * 这是"写入镜像 + 按需拉取"里的拉取侧：把其他实例触发的熔断在本实例也生效。
     * 供装配层/后台定时调用；本轮**不进热路径**（`Router.route` 是同步的），
     * 以免为每次路由引入一次网络往返与回归风险 —— 见类注释的已知残留说明。
     */
    async refreshBreakersFromShared(now = Date.now()) {
        if (!this.state)
            return;
        for (const entry of this.entries.values()) {
            try {
                const s = await this.state.breakerGet(entry.config.id);
                if (!s)
                    continue;
                // 采用"更严格"的共享真值：远端 openUntil 更晚、失败计数更高时才覆盖本地
                if (s.openUntil > entry.health.openUntil) {
                    entry.health.openUntil = s.openUntil;
                    entry.health.healthy = s.openUntil <= now;
                }
                if (s.consecutiveFailures > entry.health.consecutiveFailures) {
                    entry.health.consecutiveFailures = s.consecutiveFailures;
                }
                if (s.lastReason)
                    entry.health.lastFailureReason = s.lastReason;
            }
            catch {
                /* fail-open：拉取失败视为无变化 */
            }
        }
    }
    /** 半开试探令牌（全局唯一）。返回 true 表示本实例获得试探权。 */
    async acquireHalfOpen(providerId, ttlMs) {
        if (!this.state)
            return true; // 无共享后端时退化为本地半开（与现状一致）
        try {
            return await this.state.breakerAcquireHalfOpen(providerId, ttlMs);
        }
        catch {
            return true; // fail-open：拿不到令牌也放行一次试探
        }
    }
    persistBreaker(entry) {
        try {
            this.breakerPersist?.(entry.config.id, {
                openUntil: entry.health.openUntil,
                consecutiveFailures: entry.health.consecutiveFailures,
                ...(entry.health.lastFailureReason ? { lastReason: entry.health.lastFailureReason } : {}),
            });
        }
        catch {
            /* fail-open */
        }
    }
    snapshot() {
        return this.all().map((e) => {
            const keyPool = e.client.keySnapshot?.();
            const keyCount = (e.config.apiKeys?.length ?? 0) + (e.config.apiKey ? 1 : 0);
            return {
                id: e.config.id,
                label: e.config.label,
                protocol: e.config.protocol,
                baseUrl: e.config.baseUrl,
                models: e.config.models,
                tags: e.config.tags ?? [],
                weight: e.config.weight ?? 1,
                priority: e.config.priority ?? 0,
                disabled: !!e.config.disabled,
                health: { ...e.health },
                concurrency: e.limiter.stats(),
                ...(e.config.cost ? { cost: e.config.cost } : {}),
                // 2026-09-14 审计 B-1：快照只带 cost，面板因此看不到双口径/按型号覆盖。
                // 财务按面板单价对账必错（Agnes 面板显示 ¥0.36/¥1.08，实际实付已被
                // modelCosts 覆盖成 0）。这里把其余价格字段与 http2 开关一并暴露。
                ...(e.config.listCost ? { listCost: e.config.listCost } : {}),
                ...(e.config.modelCosts ? { modelCosts: e.config.modelCosts } : {}),
                ...(e.config.modelListCosts ? { modelListCosts: e.config.modelListCosts } : {}),
                ...(e.config.http2 ? { http2: true } : {}),
                apiKeyMasked: keyCount > 1 ? `${keyCount} keys` : maskKey(e.config.apiKey),
                ...(keyPool ? { keyPool } : {}),
            };
        });
    }
}
/**
 * 纯函数启发式。刻意保持保守：只有在**明确证据**下才降级为 simple，
 * 因为"把难任务路由到弱模型"是比多花钱严重得多的错误。
 */
export function assessComplexity(input) {
    const body = input.body;
    const signals = [];
    let score = 0;
    const messages = Array.isArray(body['messages']) ? body['messages'] : [];
    const tools = Array.isArray(body['tools']) ? body['tools'] : [];
    const model = typeof body['model'] === 'string' ? body['model'] : '';
    const textLen = JSON.stringify(messages).length;
    if (tools.length > 0) {
        score += 3;
        signals.push('tools_declared(+3)');
    }
    if (input.isToolCalling) {
        score += 3;
        signals.push('tool_calls_in_history(+3)');
    }
    if (messages.length > 4) {
        score += 2;
        signals.push(`messages=${messages.length}(+2)`);
    }
    if (textLen > 20_000) {
        score += 3;
        signals.push(`payload=${textLen}B(+3)`);
    }
    else if (textLen > 6_000) {
        score += 1;
        signals.push(`payload=${textLen}B(+1)`);
    }
    const maxTokens = Number(body['max_tokens'] ?? body['max_completion_tokens'] ?? 0);
    if (maxTokens > 2_000) {
        score += 2;
        signals.push(`max_tokens=${maxTokens}(+2)`);
    }
    if (/(reason|think|o1|o3|r1|deep-?seek-?reasoner|qwq)/i.test(model)) {
        score += 4;
        signals.push('reasoning_model(+4)');
    }
    if (body['response_format'] !== undefined) {
        score += 1;
        signals.push('structured_output(+1)');
    }
    if (input.clientKind === 'agent') {
        score += 1;
        signals.push('agent_client(+1)');
    }
    const level = score >= 6 ? 'complex' : score >= 2 ? 'standard' : 'simple';
    return { level, score, signals };
}
export class NoRouteError extends Error {
    requestedModel;
    declared;
    rejected;
    breakers;
    disabledCount;
    kind;
    /** 熔断中的上游及其最近失败原因（用于把"上游挂了"和"模型不存在"区分开） */
    openBreakers;
    constructor(requestedModel, 
    /** **声明**支持该模型的上游（不管是否被禁用/熔断/请求级排除）。
     *  这个列表是"模型不存在"与"模型存在但暂时没路"的唯一判据：
     *  以前这里在抛出点固定传 []，导致任何零候选都被判成"没人声明这个模型"，
     *  于是把上游故障说成模型名写错。 */
    declared, rejected, breakers = [], disabledCount = 0) {
        super(`没有可用上游能服务模型 ${requestedModel}（声明支持它的上游 ${declared.length} 个，本次全部不可用：${rejected
            .map((r) => `${r.providerId}:${r.why}`)
            .join('; ') || '无'}）`);
        this.requestedModel = requestedModel;
        this.declared = declared;
        this.rejected = rejected;
        this.breakers = breakers;
        this.disabledCount = disabledCount;
        this.name = 'NoRouteError';
        this.openBreakers = breakers;
        const declaredCount = declared.length;
        const excluded = declaredCount - disabledCount - breakers.length;
        if (declaredCount === 0)
            this.kind = 'model_unsupported';
        else if (breakers.length > 0 && disabledCount === 0 && excluded === 0)
            this.kind = 'all_breaker_open';
        else if (disabledCount > 0 && breakers.length === 0 && excluded === 0)
            this.kind = 'all_disabled';
        else if (breakers.length === 0 && disabledCount === 0 && excluded > 0)
            this.kind = 'all_excluded';
        else
            this.kind = 'mixed';
    }
    /** 熔断上游的**根本**失败原因（供机器分流：限流该退避，密钥错该换 key） */
    get rootCause() {
        return this.openBreakers[0]?.lastFailureReason;
    }
}
export class Router {
    pool;
    config;
    /**
     * 轮转游标（同厂商多 key 平级分摊，见 pick() 内注释）。
     *
     * 同一厂商的多把 key（如 opencsg-1/2/3）在 priority/cost/weight 上完全相同，
     * 若排序末级（ewma 延迟）也未采集，排序会退化成"固定首选第一条" ——
     * 实测 24h：opencsg-1 占 95.8%、另外两把闲置。该游标按请求递增，
     * 使平级候选轮流当选，把同一厂商的配额摊到每一把 key 上。
     */
    rrCursor = 0;
    constructor(pool, config) {
        this.pool = pool;
        this.config = config;
    }
    /** 把用户请求的 model 解析为上游真实模型名 */
    resolveModel(requested) {
        // ownLookup 而非 this.config.modelAliases[requested]：模型名直接来自请求体，
        // `model=constructor` / `toString` / `valueOf` 会命中 Object.prototype 而拿到一个
        // 函数，接着被当成"真实模型名"往下传 —— 实测把这些 JS 内部结构泄漏进了
        // 404 报文（"没有任何上游声明支持模型 function toString() { [native code] }"）。
        const alias = ownLookup(this.config.modelAliases, requested);
        return alias ?? requested;
    }
    /**
     * 网关**认识**的全部模型名（含别名与档位阶梯名），不管当前能不能服务。
     *
     * 为什么是"认识"而不是"可用"：P2 预检的职责是判断"这个名字是不是我们会服务的名字"。
     * 如果上游被禁用就把它从目录里删掉，预检会给出"网关不认识模型 X"——
     * 而事实是这个模型存在、只是它的上游暂时不可用。用户会去改模型名，越改越错。
     *
     * 所以：预检用 catalog()（认识的名字），路由失败时再由 route() 给出准确原因
     * （"没有可用上游"而不是"模型不存在"）。对外列模型用 availableCatalog()。
     */
    catalog() {
        const set = new Set();
        for (const e of this.pool.all()) {
            for (const m of e.config.models)
                set.add(m);
            for (const [alias, target] of Object.entries(e.config.modelMap ?? {})) {
                if (e.config.models.includes(target))
                    set.add(alias);
            }
        }
        for (const alias of Object.keys(this.config.modelAliases))
            set.add(alias);
        for (const name of Object.keys(this.config.modelLadders ?? {}))
            set.add(name);
        return [...set].sort();
    }
    /**
     * 当前**真的能服务**的模型名（上游未禁用）。用于对外 `GET /v1/models`
     * 与管理面板——列出此刻能用的，而不是全部名义上认识的。
     */
    availableCatalog() {
        const set = new Set();
        for (const e of this.pool.all()) {
            if (e.config.disabled)
                continue;
            for (const m of e.config.models)
                set.add(m);
            for (const [alias, target] of Object.entries(e.config.modelMap ?? {})) {
                if (e.config.models.includes(target))
                    set.add(alias);
            }
        }
        for (const [alias, target] of Object.entries(this.config.modelAliases)) {
            if (this.pool.all().some((e) => !e.config.disabled && e.config.models.includes(target)))
                set.add(alias);
        }
        // 阶梯名：至少有一阶能服务才算可用
        for (const [name, ladder] of Object.entries(this.config.modelLadders ?? {})) {
            const reachable = ladder.some((step) => {
                const target = this.resolveModel(step);
                return this.pool.all().some((e) => !e.config.disabled && e.config.models.includes(target));
            });
            if (reachable)
                set.add(name);
        }
        return [...set].sort();
    }
    /** 阶梯名 → 实际可达的上游集合（把每一阶的上游并起来） */
    ladderReachability() {
        const out = [];
        for (const [name, rawLadder] of Object.entries(this.config.modelLadders ?? {})) {
            const ladder = rawLadder.map((m) => this.resolveModel(m));
            const providers = new Set();
            for (const step of ladder) {
                const target = this.resolveModel(step);
                for (const e of this.pool.all()) {
                    if (!e.config.disabled && e.config.models.includes(target))
                        providers.add(e.config.id);
                }
            }
            out.push({ model: name, providers: [...providers], ladder });
        }
        return out;
    }
    /** 上游实际的模型名（供 provider.modelMap 转换） */
    upstreamModelFor(entry, target) {
        // ownLookup：target 是模型名（源自请求体），'constructor' 等原型链键会命中
        // Object.prototype 而拿到函数，本该走 `?? target` 回落的分支被静默跳过。
        return ownLookup(entry.config.modelMap, target) ?? target;
    }
    route(opts) {
        const now = opts.now ?? Date.now();
        const target = this.resolveModel(opts.requestedModel);
        const tried = opts.tried ?? new Set();
        const deprioritize = opts.deprioritize ?? new Set();
        const rejected = [];
        const breakers = [];
        let disabledCount = 0;
        // 先记录"谁声明支持这个模型"——这是与"模型名写错"区分开的唯一依据
        const declared = this.pool
            .all()
            .filter((e) => e.config.models.includes(target))
            .map((e) => e.config.id)
            .sort();
        const candidates = this.pool.all().filter((e) => {
            if (opts.exclude.has(e.config.id)) {
                rejected.push({ providerId: e.config.id, why: 'fatal_error_this_request' });
                return false;
            }
            if (!e.config.models.includes(target))
                return false;
            if (e.config.disabled) {
                disabledCount++;
                rejected.push({ providerId: e.config.id, why: 'disabled' });
                return false;
            }
            if (this.pool.isOpen(e, now)) {
                breakers.push({
                    providerId: e.config.id,
                    consecutiveFailures: e.health.consecutiveFailures,
                    ...(e.health.lastFailureReason ? { lastFailureReason: e.health.lastFailureReason } : {}),
                });
                rejected.push({ providerId: e.config.id, why: `breaker_open(连续 ${e.health.consecutiveFailures} 次失败${e.health.lastFailureReason ? '，最近原因 ' + e.health.lastFailureReason : ''})` });
                return false;
            }
            return true;
        });
        // 强制指定（排障/A-B）
        if (opts.forceProviderId) {
            const forced = this.pool.get(opts.forceProviderId);
            if (forced && forced.config.models.includes(target)) {
                candidates.length = 0;
                candidates.push(forced);
            }
            else {
                rejected.push({ providerId: opts.forceProviderId, why: '强制指定但该上游不声明此模型' });
            }
        }
        if (candidates.length === 0) {
            throw new NoRouteError(target, declared, rejected, breakers, disabledCount);
        }
        let reason = 'explicit';
        if (!opts.forceProviderId) {
            const costAware = opts.tier.smartRouting && opts.complexity.level === 'simple';
            if (costAware) {
                const priced = candidates.filter((c) => c.config.cost);
                if (priced.length > 0) {
                    candidates.splice(0, candidates.length, ...priced);
                    reason = 'smart_routing';
                }
            }
            // 分层排序：
            //   ① 本次请求还没试过的上游优先（抖动时自动探索其他上游）
            //   ② 刚失败的上游排最后（只在无其他候选时才回到它 —— 这就是"重试"的唯一出路）
            //   ③ 优先级 → 成本 → 权重 → ewma 延迟
            // 同厂商多 key 轮转（v1.9.0：多把 key 分摊同一厂商配额）
            // —— 同一厂商的多条线路（baseUrl 相同、priority/cost/weight 相同的不同 key）
            //    在排序上是"完全平级"的；若末端 ewma 延迟也未采集，稳定排序会让**第一条**
            //    永远胜出。实测 24h：opencsg-1 承担 3759 单里的 3601（95.8%），另外两把 key
            //    配额基本闲置 —— 与"多 key 分摊同一厂商配额"的部署意图完全相反。
            // 处理：排序前按请求序号**旋转**候选数组，再交给稳定排序 —— 完全平级的候选即按
            //    轮转顺序轮流当选；priority/cost/weight 有差异时排序仍按原语义决定先后，不受影响。
            if (candidates.length > 1) {
                const offset = this.rrCursor % candidates.length;
                this.rrCursor = (this.rrCursor + 1) % 1_000_003; // 质数取模，避免与候选数形成周期共振
                if (offset > 0)
                    candidates.push(...candidates.splice(0, offset));
            }
            candidates.sort((a, b) => {
                const ta = tried.has(a.config.id) ? 1 : 0;
                const tb = tried.has(b.config.id) ? 1 : 0;
                if (ta !== tb)
                    return ta - tb;
                const da = deprioritize.has(a.config.id) ? 1 : 0;
                const db = deprioritize.has(b.config.id) ? 1 : 0;
                if (da !== db)
                    return da - db;
                const pa = a.config.priority ?? 0;
                const pb = b.config.priority ?? 0;
                if (pa !== pb)
                    return pb - pa;
                const ca = a.config.cost ? a.config.cost.inputPerMTok + a.config.cost.outputPerMTok : Number.POSITIVE_INFINITY;
                const cb = b.config.cost ? b.config.cost.inputPerMTok + b.config.cost.outputPerMTok : Number.POSITIVE_INFINITY;
                if (ca !== cb)
                    return ca - cb;
                const wa = a.config.weight ?? 1;
                const wb = b.config.weight ?? 1;
                if (wa !== wb)
                    return wb - wa;
                // 延迟比较：**只在跨厂商之间生效**（v1.9.0）。
                // 同一厂商（同 baseUrl）的多条线路多为"同厂商的多把 key"，部署意图是**分摊配额**
                // 而非互相择优 —— 若让延迟参与，最快的那把会长期吸走绝大多数流量（实测 24h #1 占 95.8%），
                // 配额等于没摊开。故同厂商一律视为平级，交由上层"按请求轮转"的顺序决定。
                // 跨厂商仍保留"快者优先"的性能收益；无样本时不参与比较（避免"有样本恒赢"的自锁）。
                if (a.config.baseUrl !== b.config.baseUrl) {
                    const la = a.health.ewmaLatencyMs;
                    const lb = b.health.ewmaLatencyMs;
                    if (la !== undefined && lb !== undefined && la !== lb)
                        return la - lb;
                }
                return 0;
            });
            if (reason === 'explicit' && tried.size > 0)
                reason = 'failover';
            else if (reason === 'explicit' && candidates.length > 1)
                reason = 'priority';
        }
        const winner = candidates[0];
        const decision = {
            providerId: winner.config.id,
            upstreamModel: this.upstreamModelFor(winner, target),
            reason,
            attempt: tried.size,
            candidatesConsidered: candidates.map((c) => c.config.id),
            ...(winner.config.cost
                ? { estimatedCostPerMTok: round2((winner.config.cost.inputPerMTok + winner.config.cost.outputPerMTok) / 2) }
                : {}),
        };
        return { decision, entry: winner };
    }
    /** 给定模型的可路由上游（管理看板用）。阶梯名也会出现，列的是各阶上游的并集。 */
    reachability() {
        const byName = new Map();
        for (const r of this.ladderReachability())
            byName.set(r.model, r.ladder);
        const out = [];
        for (const model of this.catalog()) {
            const target = this.resolveModel(model);
            const providers = this.pool
                .all()
                .filter((e) => !e.config.disabled && e.config.models.includes(target))
                .map((e) => e.config.id);
            const ladder = byName.get(model);
            if (ladder) {
                // 阶梯名没有"自己"的上游——它的可达性是各阶上游的并集
                const union = new Set(providers);
                for (const step of ladder) {
                    for (const e of this.pool.all()) {
                        if (!e.config.disabled && e.config.models.includes(step))
                            union.add(e.config.id);
                    }
                }
                out.push({ model, providers: [...union], ladder });
            }
            else {
                out.push({ model, providers });
            }
        }
        return out;
    }
}
function round2(n) {
    return Math.round(n * 100) / 100;
}
function maskKey(key) {
    return key.length > 10 ? `${key.slice(0, 6)}...${key.slice(-4)}` : '***';
}
/* ------------------------------------------------------------------ *
 * 同轮/短窗口重复请求去重（P7 的网关侧等价物）
 * ------------------------------------------------------------------ */
/**
 * 注意：中转站不能"同轮去重"（没有轮的概念，也没有返回旧结果的权力——那等于 P6 缓存，
 * 会破坏信任假设）。这里做的是**只读观测**：统计同一 key 在短窗口内发送了完全相同的
 * payload 的次数，用于 P8 度量与向用户提示"你在无效重试"。
 * 判定为纯函数 + 有界窗口计数，绝不缓存响应、绝不返回陈旧结果。
 */
export class DuplicateObserver {
    windowMs;
    windows;
    constructor(windowMs = 60_000) {
        this.windowMs = windowMs;
        const buckets = new BoundedCache(20_000);
        this.windows = {
            push: (key, ts) => {
                const cur = buckets.get(key);
                if (cur && ts - cur.ts <= windowMs)
                    buckets.set(key, { ts: cur.ts, n: cur.n + 1 });
                else
                    buckets.set(key, { ts, n: 1 });
            },
            count: (key, ts) => {
                const cur = buckets.get(key);
                return cur && ts - cur.ts <= windowMs ? cur.n : 0;
            },
        };
    }
    /** 记录一次并返回窗口内累计次数（含本次） */
    observe(keyId, payloadHash, ts = Date.now()) {
        const key = `${keyId}:${payloadHash}`;
        this.windows.push(key, ts);
        return this.windows.count(key, ts);
    }
    /** 只读峰值，不产生写入（用于看板） */
    peek(keyId, payloadHash, ts = Date.now()) {
        return this.windows.count(`${keyId}:${payloadHash}`, ts);
    }
}
export class KeyFeatureWindow {
    maxKeys;
    requests = new Map();
    systemPrompts = new Map();
    failures = new Map();
    constructor(maxKeys = 20_000) {
        this.maxKeys = maxKeys;
    }
    observeRequest(keyId, ts = Date.now()) {
        push(this.requests, keyId, ts, 120_000, this.maxKeys);
    }
    observeSystemPrompt(keyId, hash, ts = Date.now()) {
        if (!hash)
            return;
        const arr = this.systemPrompts.get(keyId) ?? [];
        arr.push({ hash, ts });
        prunePrompts(arr, ts, 600_000);
        this.systemPrompts.set(keyId, arr);
        this.trim(this.systemPrompts);
    }
    observeFailure(keyId, ts = Date.now()) {
        push(this.failures, keyId, ts, 1_200_000, this.maxKeys);
    }
    features(keyId, ts = Date.now()) {
        const reqs = this.requests.get(keyId) ?? [];
        const fails = this.failures.get(keyId) ?? [];
        const prompts = this.systemPrompts.get(keyId) ?? [];
        const distinct = new Set(prompts.filter((p) => ts - p.ts <= 300_000).map((p) => p.hash));
        return {
            requests60s: reqs.filter((t) => ts - t <= 60_000).length,
            distinctSystemPrompts5m: distinct.size,
            failures10m: fails.filter((t) => ts - t <= 600_000).length,
        };
    }
    trim(map) {
        if (map.size <= this.maxKeys)
            return;
        let dropped = 0;
        for (const k of map.keys()) {
            map.delete(k);
            if (++dropped > this.maxKeys / 2)
                break;
        }
    }
}
function push(map, keyId, ts, windowMs, maxKeys) {
    const arr = map.get(keyId) ?? [];
    arr.push(ts);
    prune(arr, ts, windowMs);
    map.set(keyId, arr);
    if (map.size > maxKeys) {
        let dropped = 0;
        for (const k of map.keys()) {
            map.delete(k);
            if (++dropped > maxKeys / 2)
                break;
        }
    }
}
function prune(arr, ts, windowMs) {
    const cutoff = ts - windowMs;
    while (arr.length > 0 && arr[0] < cutoff)
        arr.shift();
}
function prunePrompts(arr, ts, windowMs) {
    const cutoff = ts - windowMs;
    while (arr.length > 0 && arr[0].ts < cutoff)
        arr.shift();
}
//# sourceMappingURL=pool.js.map