/**
 * 内部 Agent 系统（v2）：自托管运维/迭代决策环。
 *
 * v1 → v2 的结构性升级（对照 docs/AGENT-V2-改进方案.md）：
 *   主题 1  只读工具循环（tools.ts，maxToolSteps 硬上限）
 *   主题 2  决策契约 v2（severity/category/proposedChange/schemaVersion/toolCalls）
 *   主题 4  长期记忆（memory.ts 发现项状态机 + 回喂上一轮）
 *   主题 5  护栏（日配额 + 自伤熔断 + 租约去重 + 重试 + JSON 修复调用）
 *   主题 6  指标（metrics() 供 /admin/api/agent/metrics）
 *   主题 8  降损主线（决策可提 rule_gap；Agent 自身连续失败写 agent.degraded）
 *
 * v1 缺陷修复：
 *   D8  already_running 拒绝轮不再入历史（runCount 不虚高）
 *   D9  parseDecision 改平衡括号扫描（非贪婪），多对象输出不再拼出非法 JSON
 *   D10 autoWriteKb 语义对齐注释：默认 false（仅人工确认写 KB），v1 行为改为显式 opt-in
 *
 * 安全不变量（与 v1 一致，不动）：
 *   - 主路径（鉴权/路由/透传）完全不碰 Agent；Agent 故障绝不影响网关转发
 *   - Agent 不直接改运行中的配置/数据库，只产"建议"（proposedChange 仅声明）
 *   - 所有 LLM 调用带 agent 指纹（client_kind=agent），计量可识别
 */
import { AGENT_TOOLS, AGENT_TOOL_NAMES } from './tools.js';
import { AgentMemory } from './memory.js';
import { agentError } from './errors.js';
import { DEFAULT_MATRIX_CONFIG, MatrixHistory, applyMatrixVerdict, evaluateDecision, normalizeMatrixConfig, validateMatrixConfig, } from './matrix.js';
import { PROMPT_VERSION, buildSystemPrompt, buildFirstUserMessage, buildToolResultMessage, buildRepairMessage, buildChatSystemPrompt } from './prompts.js';
export const PROPOSED_CHANGE_TARGETS = ['provider.disable', 'tier.precheck', 'agent.interval', 'client.quota'];
/* ------------------------------------------------------------------ *
 * 决策解析（D9 修复：平衡括号扫描替代贪婪正则）
 * ------------------------------------------------------------------ */
/**
 * 抠出文本中所有**顶层平衡**的 JSON 对象片段。
 * v1 的贪婪 /\{[\s\S]*\}/ 会从第一个 { 吞到最后一个 }，把多个对象拼成非法串整体失败；
 * v2 逐个扫描平衡对象，由调用方按"特征键"（kind/schemaVersion/tool）挑出目标对象——
 * LLM 输出里常含示例对象（如 {"example":{...}}），第一个平衡对象未必是决策。
 */
function extractBalancedObjects(raw) {
    const out = [];
    let i = 0;
    while (i < raw.length) {
        const start = raw.indexOf('{', i);
        if (start < 0)
            break;
        let depth = 0;
        let inStr = false;
        let esc = false;
        let closed = -1;
        for (let j = start; j < raw.length; j++) {
            const ch = raw[j];
            if (inStr) {
                if (esc) {
                    esc = false;
                    continue;
                }
                if (ch === '\\') {
                    esc = true;
                    continue;
                }
                if (ch === '"')
                    inStr = false;
                continue;
            }
            if (ch === '"') {
                inStr = true;
                continue;
            }
            if (ch === '{')
                depth++;
            else if (ch === '}') {
                depth--;
                if (depth === 0) {
                    closed = j;
                    break;
                }
            }
        }
        if (closed < 0)
            break; // 未闭合：剩余文本里没有完整对象
        out.push(raw.slice(start, closed + 1));
        i = closed + 1;
    }
    return out;
}
/** 从多个候选对象里挑第一个能 parse 且含任一特征键的 */
function pickObjectWithKeys(raw, keys) {
    const text = raw.trim();
    const candidates = text.startsWith('{') ? [text, ...extractBalancedObjects(text)] : extractBalancedObjects(text);
    for (const c of candidates) {
        let obj;
        try {
            obj = JSON.parse(c);
        }
        catch {
            continue;
        }
        if (typeof obj !== 'object' || obj === null)
            continue;
        const o = obj;
        if (keys.some((k) => k in o))
            return o;
    }
    return undefined;
}
export function parseToolCallIntent(raw) {
    const o = pickObjectWithKeys(raw, ['tool']);
    if (!o)
        return undefined;
    if (typeof o['tool'] !== 'string' || !o['tool'])
        return undefined;
    if (!AGENT_TOOL_NAMES.includes(o['tool']))
        return undefined;
    const args = (o['args'] && typeof o['args'] === 'object' && !Array.isArray(o['args']))
        ? o['args'] : {};
    return { tool: o['tool'], args };
}
export function parseDecision(raw) {
    const o = pickObjectWithKeys(raw, ['kind', 'schemaVersion'])
        ?? (() => { throw agentError('parse_failed', 'LLM 输出不是合法 JSON: ' + raw.slice(0, 120)); })();
    const kind = (['ops', 'iteration', 'kb', 'none'].includes(String(o['kind']))
        ? String(o['kind']) : 'none');
    const severity = (['info', 'warn', 'critical'].includes(String(o['severity']))
        ? String(o['severity']) : kind === 'none' ? 'info' : 'warn');
    const conf = Number(o['confidence']);
    const decision = {
        schemaVersion: Number(o['schemaVersion']) === 2 ? 2 : 1,
        kind,
        severity,
        category: String(o['category'] ?? 'other').replace(/[^a-z0-9_|-]/gi, '').slice(0, 32) || 'other',
        summary: String(o['summary'] ?? '(未给)'),
        analysis: String(o['analysis'] ?? ''),
        recommendation: String(o['recommendation'] ?? ''),
        confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0.5,
        evidence: Array.isArray(o['evidence']) ? o['evidence'].map((x) => String(x)).slice(0, 12) : [],
        toolCalls: Array.isArray(o['toolCalls']) ? o['toolCalls'].map((x) => String(x)).slice(0, 12) : [],
    };
    if (o['kbNote'] && typeof o['kbNote'] === 'object') {
        const n = o['kbNote'];
        if (typeof n['title'] === 'string' && typeof n['content'] === 'string') {
            decision.kbNote = { title: n['title'], content: n['content'] };
        }
    }
    // proposedChange：白名单校验（主题 2 的安全边界——不在白名单的 target 直接丢弃）
    if (o['proposedChange'] && typeof o['proposedChange'] === 'object') {
        const pc = o['proposedChange'];
        if (typeof pc['target'] === 'string' && PROPOSED_CHANGE_TARGETS.includes(pc['target'])
            && pc['payload'] && typeof pc['payload'] === 'object' && !Array.isArray(pc['payload'])) {
            decision.proposedChange = {
                target: pc['target'],
                payload: pc['payload'],
                impact: String(pc['impact'] ?? ''),
                rollback: String(pc['rollback'] ?? ''),
                risk: (['low', 'medium', 'high'].includes(String(pc['risk'])) ? String(pc['risk']) : 'medium'),
            };
        }
    }
    return decision;
}
/* ------------------------------------------------------------------ *
 * 配额护栏（主题 5）
 * ------------------------------------------------------------------ */
class DailyQuota {
    tokens = 0;
    costCny = 0;
    day = '';
    roll() {
        const today = new Date().toISOString().slice(0, 10);
        if (this.day !== today) {
            this.day = today;
            this.tokens = 0;
            this.costCny = 0;
        }
    }
    check(limits) {
        this.roll();
        if (limits.tokens && limits.tokens > 0 && this.tokens >= limits.tokens) {
            return { ok: false, reason: `日 token 上限 ${limits.tokens} 已用 ${this.tokens}` };
        }
        if (limits.costCny && limits.costCny > 0 && this.costCny >= limits.costCny) {
            return { ok: false, reason: `日金额上限 ¥${limits.costCny} 已用 ¥${this.costCny.toFixed(2)}` };
        }
        return { ok: true };
    }
    consume(promptTokens, completionTokens, costCny = 0) {
        this.roll();
        this.tokens += promptTokens + completionTokens;
        this.costCny += costCny;
    }
    snapshot() {
        this.roll();
        return { day: this.day, tokens: this.tokens, costCny: Math.round(this.costCny * 1000) / 1000 };
    }
}
/* ------------------------------------------------------------------ *
 * 多实例租约（主题 5：SQLite 主库防并发——零依赖，用事件表打标实现）
 * ------------------------------------------------------------------ */
class InstanceLease {
    store;
    selfId;
    holder = '';
    heldAt = 0;
    constructor(store, selfId) {
        this.store = store;
        this.selfId = selfId;
    }
    /** 尝试获取（TTL 内有效）；拿到返回 true */
    acquire(ttlMs) {
        const now = Date.now();
        this.refresh(ttlMs);
        if (this.holder && this.holder !== this.selfId)
            return false;
        const prev = this.holder === this.selfId ? this.heldAt : 0;
        this.holder = this.selfId;
        this.heldAt = now;
        try {
            this.store?.logEvent('info', 'agent.lease', { holder: this.selfId, at: now, ttlMs, prev });
        }
        catch { /* 租约标记失败按单实例处理 */ }
        return now - prev >= 0;
    }
    release() {
        if (this.holder !== this.selfId)
            return;
        this.holder = '';
        this.heldAt = 0;
    }
    refresh(ttlMs) {
        if (!this.store)
            return;
        try {
            const evs = this.store.listEvents(50);
            const ev = evs.find((e) => e.kind === 'agent.lease' && e.detail && e.detail['holder']);
            if (!ev)
                return;
            const holder = String(ev.detail['holder']);
            const at = Number(ev.detail['at'] ?? 0);
            if (holder !== this.selfId && at > this.heldAt && Date.now() - at <= ttlMs) {
                this.holder = holder;
                this.heldAt = at;
            }
        }
        catch { /* 读不到租约 → 按持有处理 */ }
    }
}
const HISTORY_CAP = 50;
const MAX_TOOL_STEPS = 8; // 工具循环硬上限（主题 1 安全边界）
const DEGRADED_THRESHOLD = 3; // 连续失败 N 轮 → agent.degraded 事件（主题 8）
/**
 * 决策矩阵运行期配置的持久化键（走既有 store controlDoc，即"settings/KV"能力）。
 * 与 tenants/plans 同款载体：整存整取、fail-open；重启后可回读，不必改 YAML 再重启。
 */
const MATRIX_CONFIG_DOC_KEY = 'agent_matrix_config';
class InMemoryHistory {
    runs = [];
    set(r) {
        this.runs.push(r);
        if (this.runs.length > HISTORY_CAP)
            this.runs.splice(0, this.runs.length - HISTORY_CAP);
    }
    get() {
        return [...this.runs].reverse(); // 新在前
    }
}
export class AgentRunner {
    deps;
    history = new InMemoryHistory();
    memory;
    quota = new DailyQuota();
    lease;
    selfId = `agent-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    running = false;
    timer;
    baseUrl = '';
    /** 成功/失败计数（Agent 自伤熔断与 degraded 信号用） */
    consecutiveFailures = 0;
    totalRuns = 0;
    totalFailures = 0;
    durationsMs = [];
    byErrorCode = new Map();
    byKind = new Map();
    toolCallCount = 0;
    /** 决策矩阵历史环（内存，容量随配置热更新；只服务 novelty 降权与面板趋势） */
    matrixRing = new MatrixHistory(DEFAULT_MATRIX_CONFIG.historyLimit);
    /** 运行期覆盖的矩阵配置（管理面 update 写入并持久化；缺省 = 完全以 YAML 为准） */
    matrixRuntime;
    matrixLoaded = false;
    constructor(deps) {
        this.deps = { ...deps, history: deps.history ?? this.history };
        this.memory = new AgentMemory(deps.store);
        this.lease = new InstanceLease(deps.store, this.selfId);
    }
    setBaseUrl(url) {
        this.baseUrl = url;
        const llm = this.deps.llm;
        llm.setBaseUrl?.(url);
    }
    get enabled() {
        return this.deps.config.enabled === true;
    }
    start() {
        if (!this.enabled)
            return;
        const ms = this.deps.config.intervalMs ?? 0;
        if (ms <= 0)
            return;
        if (this.timer)
            return;
        this.timer = setInterval(() => {
            void this.run('auto').catch((e) => this.deps.logger.error('agent.auto_run_failed', { error: String(e) }));
        }, ms);
        this.timer.unref?.();
        this.deps.logger.info('agent.started', { intervalMs: ms, model: this.model(), promptVersion: PROMPT_VERSION });
    }
    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
    }
    model() {
        return this.deps.config.model ?? 'default';
    }
    /* ---------------- 只读接口（面板/管理 API） ---------------- */
    get baseUrl_() { return this.baseUrl; }
    get isRunning() { return this.running; }
    lastRun() { return this.deps.history.get()[0]; }
    runs() { return this.deps.history.get(); }
    /** 发现项视图（面板未闭环清单） */
    findings() { return this.memory.all(); }
    openFindings() { return this.memory.openFindings(); }
    markFinding(id, status) {
        return this.memory.mark(id, status);
    }
    status() {
        const last = this.lastRun();
        return {
            enabled: this.enabled,
            model: this.model(),
            clientId: this.deps.config.clientId ?? '',
            intervalMs: this.deps.config.intervalMs ?? 0,
            autoWriteKb: this.deps.config.autoWriteKb === true, // v2：默认 false（D10 对齐）
            kbId: this.deps.config.kbId ?? 'kb_demo',
            running: this.running,
            baseUrl: this.baseUrl || '(尚未 listen)',
            lastRun: last ?? null,
            runCount: this.deps.history.get().length,
            promptVersion: PROMPT_VERSION,
            maxToolSteps: MAX_TOOL_STEPS,
            quota: this.quota.snapshot(),
            openFindings: this.memory.openFindings().length,
            consecutiveFailures: this.consecutiveFailures,
        };
    }
    /** 主题 6：Agent 自身指标（/admin/api/agent/metrics） */
    metrics() {
        const runs = this.durationsMs;
        const sorted = [...runs].sort((a, b) => a - b);
        const pct = (p) => (sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0) : 0);
        const totalTokens = this.deps.history.get().reduce((n, r) => n + r.promptTokens + r.completionTokens, 0);
        return {
            promptVersion: PROMPT_VERSION,
            runs: { total: this.totalRuns, failures: this.totalFailures, successRate: this.totalRuns ? Math.round(((this.totalRuns - this.totalFailures) / this.totalRuns) * 1000) / 10 : 0 },
            latencyMs: { p50: pct(0.5), p95: pct(0.95) },
            tokens: { total: totalTokens, quota: this.quota.snapshot() },
            toolCalls: this.toolCallCount,
            byKind: Object.fromEntries(this.byKind),
            byErrorCode: Object.fromEntries(this.byErrorCode),
            findings: { open: this.memory.openFindings().length, total: this.memory.all().length },
            degraded: this.consecutiveFailures >= DEGRADED_THRESHOLD,
        };
    }
    /* ---------------- 决策矩阵（可选能力；未启用时这些接口只读不干预） ---------------- */
    /**
     * 当前生效的矩阵配置。
     *
     * 优先级：运行期覆盖（已持久化）> YAML `agent.decisionMatrix` > 内置默认值。
     * 运行期覆盖之所以压过 YAML：管理面改过的值写进了持久化文档，重启后若被 YAML 覆盖回去，
     * 面板上就会呈现"改完就丢"的错觉。要彻底回到 YAML，用 updateMatrixConfig 显式改回即可。
     */
    matrixConfig() {
        this.ensureMatrixLoaded();
        const cfg = this.matrixRuntime ?? normalizeMatrixConfig(this.deps.config.decisionMatrix);
        // 容量随配置同步（面板刚调小上限时不该还看到旧的 50 条）
        this.matrixRing.setCap(cfg.historyLimit);
        return cfg;
    }
    /** 最近矩阵评估（新在前；limit 缺省返回全部） */
    matrixHistory(limit) {
        this.ensureMatrixLoaded();
        return this.matrixRing.getHistory(limit);
    }
    /** 矩阵统计（accept/queue/reject 分布、平均分、被驳回最多的 category） */
    matrixStats() {
        this.ensureMatrixLoaded();
        return this.matrixRing.stats();
    }
    /** 清空矩阵历史（只清趋势，不影响配置；重启/调参后想重新观察时用） */
    clearMatrixHistory() {
        this.matrixRing.clear();
    }
    /**
     * 更新矩阵配置：合并 → 全量校验 → 归一化 → 持久化 → 审计事件。
     *
     * 非法配置**抛错**（不静默纠正），且抛错时当前生效配置保持不变——管理面据此返回 400，
     * 不会出现"配置改了一半"的中间态。权重按维度级合并（只改 impact 不清空其它维度）。
     */
    updateMatrixConfig(partial) {
        const current = this.matrixConfig();
        const merged = {
            ...current,
            ...partial,
            ...(partial.weights !== undefined ? { weights: { ...current.weights, ...partial.weights } } : {}),
        };
        const checked = validateMatrixConfig(merged);
        if (!checked.ok) {
            // 附带 code/details：管理面据此直接回 400 + details[]（逐条中文原因），
            // 客户端不必解析拼接后的 message。仅补充字段，不改抛错语义。
            const err = new Error(`决策矩阵配置非法：${checked.errors.join('；')}`);
            err.code = 'invalid_matrix_config';
            err.details = checked.errors;
            throw err;
        }
        const next = normalizeMatrixConfig(merged);
        this.matrixRuntime = next;
        this.matrixRing.setCap(next.historyLimit);
        try {
            // 持久化到既有 controlDoc（settings/KV）：重启后 ensureMatrixLoaded 回读
            this.deps.store?.saveControlDoc(MATRIX_CONFIG_DOC_KEY, next);
        }
        catch (e) {
            // 落盘失败不能让本次调整"看起来成功了却重启即丢"——留 warn 与事件，仍让内存态生效
            this.deps.logger.warn('agent.matrix_config_persist_failed', { error: String(e) });
        }
        this.deps.store?.logEvent('info', 'agent.matrix_config', {
            enabled: next.enabled,
            acceptThreshold: next.acceptThreshold,
            queueThreshold: next.queueThreshold,
            weights: next.weights,
            historyLimit: next.historyLimit,
            adaptiveNovelty: next.adaptiveNovelty,
            source: 'runtime',
        });
        return next;
    }
    /** 懒加载持久化配置（只读一次；读不到/损坏 → 以 YAML 为准，fail-open） */
    ensureMatrixLoaded() {
        if (this.matrixLoaded)
            return;
        this.matrixLoaded = true;
        try {
            const doc = this.deps.store?.loadControlDoc(MATRIX_CONFIG_DOC_KEY);
            if (doc === undefined || doc === null)
                return;
            const checked = validateMatrixConfig(doc);
            if (!checked.ok) {
                this.deps.store?.logEvent('warn', 'agent.matrix_config_invalid', { errors: checked.errors });
                return;
            }
            this.matrixRuntime = normalizeMatrixConfig(doc);
        }
        catch {
            // 读取失败不影响主流程：按 YAML 配置起步
        }
    }
    /**
     * 对话模式（v3 主题 7）：多轮对话 + 只读工具调用。
     *
     * 与巡检共用同一 LLM 入口（本网关 /v1/chat/completions）与只读工具上下文，
     * 但**不写** agent.decision（不污染巡检统计），只记 agent.chat 审计事件。
     * 与巡检互斥：巡检在跑时拒绝对话，避免并发抢同一 running 状态。
     */
    async chat(history) {
        const zero = { toolCalls: [], llmCalls: 0, promptTokens: 0, completionTokens: 0 };
        if (this.running)
            return { reply: 'Agent 正在执行巡检，请稍后重试。', ...zero };
        const limits = { tokens: this.deps.config.dailyTokenLimit, costCny: this.deps.config.dailyCostCnyLimit };
        const q = this.quota.check(limits);
        if (!q.ok) {
            this.deps.store?.logEvent('warn', 'agent.chat_quota_blocked', { reason: q.reason, ...this.quota.snapshot() });
            return { reply: 'Agent 日配额已耗尽（' + q.reason + '），请次日再试或调大 agent.dailyTokenLimit / dailyCostCnyLimit。', ...zero };
        }
        this.running = true;
        const timeoutMs = this.deps.config.llmTimeoutMs ?? 60_000;
        try {
            const messages = [
                { role: 'system', content: buildChatSystemPrompt() },
            ];
            for (const m of history.slice(-20)) {
                const role = m.role === 'assistant' ? 'assistant' : 'user';
                if (typeof m.content === 'string' && m.content.trim())
                    messages.push({ role, content: m.content });
            }
            let promptTokens = 0;
            let completionTokens = 0;
            let llmCalls = 0;
            let lastContent = '';
            const toolCalls = [];
            for (let step = 0; step <= MAX_TOOL_STEPS; step++) {
                const llm = await this.deps.llm.chat(messages, { model: this.model(), timeoutMs });
                promptTokens += llm.promptTokens;
                completionTokens += llm.completionTokens;
                llmCalls++;
                lastContent = llm.content;
                const intent = parseToolCallIntent(llm.content);
                if (intent && step < MAX_TOOL_STEPS) {
                    const tool = AGENT_TOOLS.find((t) => t.name === intent.tool);
                    let result;
                    try {
                        result = tool ? tool.run(intent.args, this.deps.toolCtx) : { error: 'unknown_tool: ' + intent.tool };
                        this.toolCallCount++;
                    }
                    catch (e) {
                        result = { error: 'tool_failed: ' + String(e instanceof Error ? e.message : e) };
                    }
                    toolCalls.push(intent.tool);
                    messages.push({ role: 'user', content: buildToolResultMessage(intent.tool, result, MAX_TOOL_STEPS - step - 1) });
                    continue;
                }
                break;
            }
            this.quota.consume(promptTokens, completionTokens, 0);
            this.deps.store?.logEvent('info', 'agent.chat', { llmCalls, promptTokens, completionTokens, toolCalls });
            return { reply: lastContent, toolCalls, llmCalls, promptTokens, completionTokens };
        }
        finally {
            this.running = false;
        }
    }
    /* ---------------- 主循环 ---------------- */
    async run(trigger) {
        const started = Date.now();
        if (this.running) {
            // D8 修复：拒绝轮不再写历史（v1 把它 set 进去导致 runCount 虚高）
            return {
                trigger, startedAt: started, durationMs: 0, model: this.model(),
                clientId: this.deps.config.clientId ?? '', promptTokens: 0, completionTokens: 0, llmCalls: 0,
                decision: { schemaVersion: 2, kind: 'none', severity: 'info', category: 'agent_self', summary: '上一轮仍在运行，本轮跳过', analysis: '', recommendation: '稍后再触发', confidence: 0, evidence: [], toolCalls: [] },
                ok: false, errorCode: 'already_running', error: 'already_running',
                promptVersion: PROMPT_VERSION, openFindings: this.memory.openFindings().length,
            };
        }
        // 主题 5：日配额护栏（先查后跑；超限拒绝并记事件）
        const limits = { tokens: this.deps.config.dailyTokenLimit, costCny: this.deps.config.dailyCostCnyLimit };
        const q = this.quota.check(limits);
        if (!q.ok) {
            this.deps.store?.logEvent('warn', 'agent.quota_blocked', { trigger, reason: q.reason, ...this.quota.snapshot() });
            const run = {
                trigger, startedAt: started, durationMs: 0, model: this.model(),
                clientId: this.deps.config.clientId ?? '', promptTokens: 0, completionTokens: 0, llmCalls: 0,
                decision: { schemaVersion: 2, kind: 'none', severity: 'info', category: 'agent_self', summary: 'Agent 日配额耗尽，本轮拒绝启动', analysis: '', recommendation: '次日自动恢复，或调大 agent.dailyTokenLimit', confidence: 0, evidence: [], toolCalls: [] },
                ok: false, errorCode: 'quota_blocked', error: q.reason,
                promptVersion: PROMPT_VERSION, openFindings: this.memory.openFindings().length,
            };
            this.deps.history?.set(run);
            return run;
        }
        // 主题 5：多实例租约（auto 才抢；manual 是人工显式意图，不去抢）
        if (trigger === 'auto' && !this.lease.acquire(5 * 60_000)) {
            return {
                trigger, startedAt: started, durationMs: 0, model: this.model(),
                clientId: this.deps.config.clientId ?? '', promptTokens: 0, completionTokens: 0, llmCalls: 0,
                decision: { schemaVersion: 2, kind: 'none', severity: 'info', category: 'agent_self', summary: '另一实例持有巡检租约，本轮让位', analysis: '', recommendation: '无需处理', confidence: 0, evidence: [], toolCalls: [] },
                ok: false, errorCode: 'lease_lost', error: 'lease_lost',
                promptVersion: PROMPT_VERSION, openFindings: this.memory.openFindings().length,
            };
        }
        this.running = true;
        try {
            const snap = await this.deps.context.collect();
            // 主题 4：记忆回喂——上一轮结论 + 未闭环发现项
            const last = this.lastRun();
            const lastSummary = last?.ok ? last.decision.summary : undefined;
            const openFindings = this.memory.openFindings();
            const system = buildSystemPrompt();
            const messages = [
                { role: 'system', content: system },
                { role: 'user', content: buildFirstUserMessage(snap.overview, openFindings, lastSummary) },
            ];
            // ---- 工具循环（主题 1）----
            let promptTokens = 0;
            let completionTokens = 0;
            let llmCalls = 0;
            let decision;
            let ok = true;
            let errorCode;
            let error;
            const timeoutMs = this.deps.config.llmTimeoutMs ?? 60_000;
            const usageOf = this.deps.llm;
            for (let step = 0; step <= MAX_TOOL_STEPS && !decision; step++) {
                const llm = await this.deps.llm.chat(messages, { model: this.model(), timeoutMs });
                promptTokens += llm.promptTokens;
                completionTokens += llm.completionTokens;
                llmCalls++;
                const intent = parseToolCallIntent(llm.content);
                if (intent && step < MAX_TOOL_STEPS) {
                    const tool = AGENT_TOOLS.find((t) => t.name === intent.tool);
                    let result;
                    try {
                        result = tool.run(intent.args, this.deps.toolCtx);
                        this.toolCallCount++;
                    }
                    catch (e) {
                        result = { error: 'tool_failed: ' + String(e instanceof Error ? e.message : e) };
                    }
                    messages.push({ role: 'user', content: buildToolResultMessage(intent.tool, result, MAX_TOOL_STEPS - step - 1) });
                    continue;
                }
                // 非工具调用 → 按决策解析（失败给一次修复机会）
                try {
                    decision = parseDecision(llm.content);
                }
                catch (e) {
                    const problem = e instanceof Error ? e.message : String(e);
                    if (step < MAX_TOOL_STEPS) {
                        messages.push({ role: 'user', content: buildRepairMessage(llm.content, problem) });
                        continue; // 修复调用（主题 5）
                    }
                    ok = false;
                    errorCode = e.code ?? 'parse_failed';
                    error = problem;
                    decision = {
                        schemaVersion: 2, kind: 'none', severity: 'info', category: 'agent_self',
                        summary: '(LLM 输出解析失败)', analysis: '', recommendation: '查看 agent 指标 byErrorCode 与事件日志',
                        confidence: 0, evidence: [llm.content.slice(0, 200)], toolCalls: [],
                    };
                }
            }
            if (!decision) {
                // 工具预算耗尽仍未出决策（理论上前面的分支已兜底）
                ok = false;
                errorCode = 'schema_invalid';
                error = 'tool budget exhausted without decision';
                decision = {
                    schemaVersion: 2, kind: 'none', severity: 'info', category: 'agent_self',
                    summary: '(工具预算耗尽未出决策)', analysis: '', recommendation: '调大 maxToolSteps 或换更强模型',
                    confidence: 0, evidence: [], toolCalls: [],
                };
            }
            // 配额记账（主题 5）
            this.quota.consume(promptTokens, completionTokens);
            if (usageOf.usage) {
                // llm.ts 自身 usage 与循环累计取大者（防工具循环外调用漏记）
                const u = usageOf.usage();
                this.quota.consume(Math.max(0, u.promptTokens - promptTokens), Math.max(0, u.completionTokens - completionTokens));
            }
            // ---- 决策矩阵仲裁（可选能力）----
            // 只有 decisionMatrix.enabled===true 才介入：未启用时**不调用矩阵、不写矩阵事件**，
            // decision 与 run 的结构和引入该能力之前逐字一致（零行为回归）。
            // 矩阵只仲裁不扩权：最多把档位下压、把 reject 的动作剥离，绝不提升档位或扩大动作范围。
            let matrix;
            const matrixCfg = this.matrixConfig();
            if (matrixCfg.enabled) {
                matrix = evaluateDecision(decision, matrixCfg, this.matrixRing.all());
                // applyMatrixVerdict 返回**新对象**（不原地改传入的 decision，除替换动作外无其它副作用）：
                // reject 档的 proposedChange 在此被剥离——被驳回的建议不得流向任何执行路径。
                decision = applyMatrixVerdict(decision, matrix);
                this.matrixRing.push(matrix);
                this.deps.store?.logEvent('info', 'agent.matrix_decision', {
                    score: matrix.score,
                    tier: matrix.tier,
                    rawTier: matrix.rawTier,
                    category: matrix.category,
                    kind: matrix.kind,
                    severity: matrix.severity,
                    // 四门摘要：一眼看出是"分数不够"还是"门没过"
                    gates: matrix.gates.map((g) => `${g.id}:${g.passed ? 'pass' : 'fail'}`),
                    failedGates: matrix.gates.filter((g) => !g.passed).map((g) => g.id),
                    hasChange: matrix.effectiveChange !== undefined,
                });
            }
            // 主题 4：发现项状态机（kind != none 记/刷；none 时尝试按 summary 销号）
            if (ok && decision.kind !== 'none') {
                this.memory.observe(decision.category, decision.summary, decision.severity, decision.recommendation, started);
            }
            else if (ok && decision.kind === 'none' && decision.analysis) {
                this.memory.reconcileFromDecision(started, [decision.analysis]);
            }
            // KB 回写（主题 2/D10：autoWriteKb 默认 false——仅显式 opt-in 才自动写；
            // 面板"写入 KB"按钮走 upsertDoc 同款防堆积路径）
            if (ok && decision.kbNote && this.deps.kb && this.deps.kb.ok && this.deps.config.kbId
                && (decision.kind === 'kb' || decision.kind === 'iteration')
                && this.deps.config.autoWriteKb === true) {
                const r2 = this.deps.kb.upsertDoc(this.deps.config.kbId, decision.kbNote.title, decision.kbNote.content, 'agent');
                if ('error' in r2) {
                    errorCode = 'kb_write_failed';
                    error = 'kb_write_failed: ' + r2.error;
                    ok = false;
                }
                else {
                    this.deps.logger.info('agent.kb_written', { kbId: this.deps.config.kbId, title: decision.kbNote.title, docId: r2.id, mode: 'upsert' });
                }
            }
            // 审计事件（所有决策，含 none，都留痕）
            this.deps.store?.logEvent(ok ? 'info' : 'warn', 'agent.decision', {
                trigger, kind: decision.kind, severity: decision.severity, category: decision.category,
                summary: decision.summary, confidence: decision.confidence,
                evidence: decision.evidence, toolCalls: decision.toolCalls,
                promptTokens, completionTokens, llmCalls, ok,
                ...(errorCode ? { errorCode } : {}), ...(error ? { error } : {}),
                // 启用矩阵时把仲裁档位一并写进决策事件（未启用时不加字段，事件结构与旧版一致）
                ...(matrix ? { matrixTier: matrix.tier, matrixScore: matrix.score } : {}),
            });
            // 主题 6/8：指标累计 + Agent 自身 degraded 信号
            this.totalRuns++;
            if (!ok) {
                this.totalFailures++;
                this.consecutiveFailures++;
                if (this.consecutiveFailures === DEGRADED_THRESHOLD) {
                    this.deps.store?.logEvent('error', 'agent.degraded', { consecutiveFailures: this.consecutiveFailures, lastErrorCode: errorCode });
                }
            }
            else {
                this.consecutiveFailures = 0;
            }
            this.byKind.set(decision.kind, (this.byKind.get(decision.kind) ?? 0) + 1);
            if (errorCode)
                this.byErrorCode.set(errorCode, (this.byErrorCode.get(errorCode) ?? 0) + 1);
            this.durationsMs.push(Date.now() - started);
            if (this.durationsMs.length > 200)
                this.durationsMs.shift();
            const run = {
                trigger, startedAt: started, durationMs: Date.now() - started, model: this.model(),
                clientId: this.deps.config.clientId ?? '', promptTokens, completionTokens, llmCalls,
                decision, ok,
                // 矩阵快照只在启用时出现（未启用时 run 结构与引入前完全一致）
                ...(matrix ? { matrix } : {}),
                ...(errorCode ? { errorCode } : {}), ...(error ? { error } : {}),
                promptVersion: PROMPT_VERSION,
                openFindings: this.memory.openFindings().length,
            };
            this.deps.history?.set(run);
            return run;
        }
        catch (e) {
            // LLM 网络层错误（agentError）或未预期异常
            const code = e.code ?? 'llm_network';
            const msg = e instanceof Error ? e.message : String(e);
            this.totalRuns++;
            this.totalFailures++;
            this.consecutiveFailures++;
            if (this.consecutiveFailures === DEGRADED_THRESHOLD) {
                this.deps.store?.logEvent('error', 'agent.degraded', { consecutiveFailures: this.consecutiveFailures, lastErrorCode: code });
            }
            this.byErrorCode.set(code, (this.byErrorCode.get(code) ?? 0) + 1);
            this.deps.store?.logEvent('warn', 'agent.decision', { trigger, ok: false, errorCode: code, error: msg });
            const run = {
                trigger, startedAt: started, durationMs: Date.now() - started, model: this.model(),
                clientId: this.deps.config.clientId ?? '', promptTokens: 0, completionTokens: 0, llmCalls: 0,
                decision: { schemaVersion: 2, kind: 'none', severity: 'info', category: 'agent_self', summary: '(本轮失败)', analysis: '', recommendation: '查看 agent 指标 byErrorCode', confidence: 0, evidence: [], toolCalls: [] },
                ok: false, errorCode: code, error: msg,
                promptVersion: PROMPT_VERSION, openFindings: this.memory.openFindings().length,
            };
            this.deps.history?.set(run);
            return run;
        }
        finally {
            this.running = false;
            this.lease.release();
        }
    }
}
/* ------------------------------------------------------------------ *
 * 工具函数导出
 * ------------------------------------------------------------------ */
/** finding 去重键的摘要（决策的稳定前缀） */
export function decisionSummaryFor(d) {
    return d.summary;
}
//# sourceMappingURL=runner.js.map