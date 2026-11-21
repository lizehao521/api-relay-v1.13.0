/**
 * 应用装配：把配置、存储、上游池、路由、鉴权、降损层、网关与管理接口连成一体。
 *
 * 刻意保持"显式装配"（无 IoC 容器）：中转站的依赖图应该一眼看完，
 * 因为排障时最贵的成本是"不知道谁依赖谁"。
 */
import { Logger } from './core/logger.js';
import { DEFAULT_TIERS } from './core/config.js';
import { createStore, SqliteStore } from './store/index.js';
import { createSharedState, RedisSharedStateStore } from './store/shared-state.js';
import { ProviderPool } from './upstream/pool.js';
import { closeH2Sessions } from './upstream/http2.js';
import { Router } from './upstream/pool.js';
import { KeyRegistry } from './gateway/keys.js';
import { Meter } from './loss/meter.js';
import { TraceStore } from './loss/tracer.js';
import { Engine } from './gateway/engine.js';
import { RelayServer } from './gateway/server.js';
import { AdminApi } from './admin/api.js';
import { KbStore } from './kb/store.js';
import { AgentRunner } from './agent/runner.js';
import { createAgentLlm } from './agent/llm.js';
import { createAgentContext } from './agent/context.js';
import { createAgentToolContext } from './agent/tools.js';
export async function createApp(config, baseLogger) {
    const logger = baseLogger ?? new Logger(config.logLevel);
    /* ---------- 存储（数据库故障自动降级为内存） ---------- */
    const store = await createStore({
        driver: config.storage.driver,
        path: config.storage.path,
        batchSize: config.lossReduction.meter.batchSize,
        flushIntervalMs: config.lossReduction.meter.flushIntervalMs,
        logger,
    });
    /* ---------- 知识库（垂直 Agent 能力，独立 SQLite 库；未配置则不建） ---------- */
    let kb;
    if (config.kb?.path) {
        kb = new KbStore({ path: config.kb.path, chunkSize: config.kb.chunkSize, chunkOverlap: config.kb.chunkOverlap });
        await kb.init();
        logger.info('kb.ready', { path: config.kb.path, ok: kb.ok, chunkSize: config.kb.chunkSize });
    }
    /* ---------- 共享状态（REQ-01：限流/配额/熔断；默认内存，可注入 Redis runner） ---------- */
    // 未注入 redisRunner 时 createSharedState 强制回退内存实现（数据面零硬依赖）。
    // 生产多实例部署时在此处注入由使用方提供的 RedisCommandRunner 即可切换到共享后端。
    const state = createSharedState(config, { store, logger });
    await state.init();
    // G4（审查修复·短板4）：限流/额度是**每实例**判定的——只有共享后端（Redis）才跨实例一致。
    // 单实例口径下多实例部署实际上限 ≈ N 倍。这里判定并（在"被反代/公开读"这类多实例风险面下）显式告警。
    const sharedLimits = state instanceof RedisSharedStateStore;
    if (!sharedLimits && (config.server.behindProxy === true || config.server.publicQuotaRemote === true)) {
        logger.warn('deploy.single_instance_limits', {
            hint: '限流/额度为单实例口径（多实例上限 ≈ N 倍）。多实例部署前请注入共享 state（Redis）',
            behindProxy: config.server.behindProxy === true,
            publicQuotaRemote: config.server.publicQuotaRemote === true,
        });
        store.logEvent('warn', 'deploy.single_instance_limits', {
            behindProxy: config.server.behindProxy === true,
            publicQuotaRemote: config.server.publicQuotaRemote === true,
            host: config.server.host,
            port: config.server.port,
        });
    }
    /* ---------- 上游池（可恢复熔断状态） ---------- */
    const restored = store instanceof SqliteStore || 'loadBreakers' in store ? safeLoadBreakers(store) : new Map();
    const pool = new ProviderPool(config, logger, {
        ...(restored.size > 0 ? { restoredBreakers: restored } : {}),
        // 熔断持久化改由共享状态承载（内存后端会写回 store.saveBreaker，与改造前等价）
        state,
    });
    // 拉取共享后端里的熔断状态（跨实例可见；内存后端语义等价于既有恢复路径）
    await pool.refreshBreakersFromShared();
    const router = new Router(pool, config);
    // 恢复面板创建的 key（只有哈希可用；明文不可恢复，这是刻意的安全取舍）
    const storedKeyMeta = store.listKeyMeta?.() ?? [];
    const keys = new KeyRegistry({
        config,
        store,
        logger,
        state,
        restoredKeys: storedKeyMeta
            .filter((m) => (m.origin === 'panel' || m.origin === 'voucher') && !!m.keyHash)
            .map((m) => ({
            keyId: m.keyId,
            label: m.label,
            tier: m.tier,
            tenantId: m.tenantId,
            enabled: m.enabled,
            keyHash: m.keyHash,
            // 券 key 与面板 key 的治理策略不同（不可硬删/轮换），来源必须一起恢复。
            origin: m.origin === 'voucher' ? 'voucher' : 'panel',
            ...(m.allowedModels ? { allowedModels: m.allowedModels } : {}),
            ...(m.expiresAt !== undefined ? { expiresAt: m.expiresAt } : {}),
            ...(m.quotaOverride !== undefined ? { quotaOverride: m.quotaOverride } : {}),
            // 这里逐字段列举，漏一个就等于"落了库但重启即丢" —— 按钱的额度就踩过一次。
            ...(m.costQuotaOverride !== undefined ? { costQuotaOverride: m.costQuotaOverride } : {}),
        })),
    });
    // B4（审查修复·能力层根因）：以**取值函数**注入 enabled —— Meter/TraceStore 运行期读取配置，
    // loss-reduction/update 热改 meter.enabled / trace.enabled 即时生效（此前构造期捕获、热改无效）。
    const meter = new Meter({ store, enabled: () => config.lossReduction.meter.enabled, hashPayloads: config.lossReduction.meter.hashPayloads });
    const traceStore = new TraceStore(config.lossReduction.trace.ringSize, (t) => store.recordTrace(t), () => config.lossReduction.trace.enabled);
    const engine = new Engine({ config, logger, store, pool, router, keys, meter, traceStore });
    const admin = new AdminApi({
        config,
        logger,
        engine,
        pool,
        router,
        keys,
        meter,
        store,
        traceStore,
        kb,
        serverStats: () => server.stats,
        // G4：把"限流/额度是否跨实例共享"透传给管理面（health 标注口径）
        sharedLimits,
    });
    /* ---------- 内部 Agent 系统（自托管运维/迭代决策环；未启用则不建） ---------- */
    let agent;
    if (config.agent?.enabled) {
        const agentKeyRec = config.clients.find((c) => c.id === config.agent.clientId);
        const agentKey = agentKeyRec?.key ?? '';
        // Agent 调 LLM 走本网关（自证闭环）；baseUrl 在 start() 里回填（listen 之后才知道确切 host）
        const llm = createAgentLlm({ baseUrl: 'http://127.0.0.1', key: agentKey, model: config.agent.model ?? 'default' });
        // baseUrl 需要真实端口，先用占位，start() 时替换
        const context = createAgentContext({
            pool, store, meter, kb, traceStore,
            recentEvents: config.agent.recentEvents,
        });
        // v2 主题 1：工具上下文（只读取证——store/pool/meter/trace/kb/config）
        const toolCtx = createAgentToolContext({
            pool, store, meter, traceStore, kb, config,
            kbId: config.agent.kbId,
        });
        agent = new AgentRunner({
            config: config.agent,
            logger,
            llm,
            context,
            toolCtx,
            kb,
            store,
            kbId: config.agent.kbId ?? 'kb_demo',
        });
    }
    // 回填 agent 到 admin.deps（AdminDeps.agent 可选字段；agent 构建在 admin 之后）
    if (agent) {
        const adminRef = admin;
        adminRef.deps.agent = agent;
    }
    const server = new RelayServer({ config, engine, admin, logger, kb, keys });
    /* 每日按配置留存清理（manual#319 → 审查修复·B3·能力层根因）：调度从 admin 层下沉到网关
       启动处，由应用统一承担，AdminApi 不再兜底。三道保险：days 非法不跑、fail-open、
       timer.unref；只有真删了行才记审计事件（storage.prune）。 */
    const retentionDays = config.lossReduction?.meter?.retentionDays;
    if (typeof retentionDays === 'number' && retentionDays >= 1) {
        const prune = () => {
            void Promise.resolve()
                .then(() => store.prune(retentionDays))
                .then((n) => { if (n > 0)
                store.logEvent('info', 'storage.prune', { days: retentionDays, deleted: n }); })
                .catch(() => { });
        };
        prune();
        const pruneTimer = setInterval(prune, 86_400_000);
        if (typeof pruneTimer.unref === 'function')
            pruneTimer.unref();
    }
    return {
        config,
        logger,
        store,
        kb,
        agent,
        pool,
        router,
        keys,
        meter,
        traceStore,
        engine,
        server,
        admin,
        async start() {
            const bound = await server.listen();
            // 回填 Agent 的 LLM base URL（listen 之后才知道确切 host:port），并启动周期巡检
            if (agent) {
                agent.setBaseUrl(bound.url);
                agent.start();
            }
            logger.info('relay.listening', {
                url: bound.url,
                providers: config.providers.length,
                clients: keys.listKeys().length,
                precheck: config.lossReduction.precheck.enabled,
                attribution: config.lossReduction.attribution.enabled,
                meter: config.lossReduction.meter.enabled,
            });
            return { url: bound.url };
        },
        async stop() {
            await server.close(config.server.shutdownGraceMs);
        },
        async shutdown() {
            agent?.stop();
            await server.close(config.server.shutdownGraceMs);
            await store.close();
            await kb?.close();
            // 关掉上游 HTTP/2 会话（平时已 unref，不拦退出；这里显式收尾更干净）
            closeH2Sessions();
            logger.info('relay.shutdown_complete', {});
        },
    };
}
function safeLoadBreakers(store) {
    try {
        const s = store;
        return s.loadBreakers ? s.loadBreakers() : new Map();
    }
    catch {
        return new Map();
    }
}
/**
 * 测试/内存模式的档位（G1·单一真源）。
 *
 * 结构从 `DEFAULT_TIERS`（生产默认，core/config.ts）**派生**，只在此一处覆盖测试友好值：
 * 放宽 rpm/并发、去掉总量帽，避免单测撞限流误伤。差异是刻意的、且集中一地——
 * 此前 memoryConfig 内联了另一套数值，与 core/config.ts 各写一遍，导致
 * 「同一把 free key，内存启动 vs 文件启动行为不同」的错觉（审查发现·短板5）。
 */
function memoryTiers() {
    const out = {};
    for (const [id, base] of Object.entries(DEFAULT_TIERS)) {
        out[id] = {
            ...base,
            label: id,
            rpm: 1000,
            maxConcurrency: id === 'free' ? 8 : id === 'standard' ? 32 : 64,
            periodQuotaTokens: null,
            periodQuotaCny: null,
        };
    }
    return out;
}
/** 供 CLI/测试复用：内存配置（不读文件） */
export function memoryConfig(overrides = {}) {
    return {
        server: {
            host: '127.0.0.1',
            port: 0,
            trustProxy: false,
            behindProxy: false,
            maxBodyBytes: 8 * 1024 * 1024,
            upstreamTimeoutMs: 60_000,
            upstreamTtfbTimeoutMs: 10_000,
            shutdownGraceMs: 1_000,
            ...(overrides.server ?? {}),
        },
        storage: { driver: 'memory', path: ':memory:', ...(overrides.storage ?? {}) },
        lossReduction: overrides.lossReduction ?? {
            precheck: { enabled: true, onBlock: 'reject', budgetUs: 3_000, maxMessages: 512, maxTools: 128, maxTokensCeiling: 1_000_000, dangerousCommandPatterns: ['rm\\s+-rf\\s+/(?!\\w)'] },
            attribution: {
                enabled: true,
                includeEvidence: false,
                autoRetry: 1,
                siblingModelFallback: true,
                backoffBaseMs: 10,
                backoffMaxMs: 200,
                retryableReasons: ['rate_limited', 'upstream_timeout', 'upstream_unavailable', 'network_error', 'model_overloaded', 'stream_interrupted'],
                breakerThreshold: 3,
                breakerCooldownMs: 1_000,
            },
            meter: { enabled: true, batchSize: 50, flushIntervalMs: 100, retentionDays: 7, hashPayloads: true, hashSalt: 'test-salt' },
            trace: { enabled: true, ringSize: 100, persist: true, maxSteps: 64 },
            fingerprint: { enabled: true, agentThreshold: 0.6 },
        },
        tiers: overrides.tiers ?? memoryTiers(),
        providers: overrides.providers ?? [],
        clients: overrides.clients ?? [],
        modelAliases: overrides.modelAliases ?? {},
        // 之前这里漏了阶梯与能力表：传进来会被静默丢掉，测试只能建完再赋值，
        // 于是"配置里到底有什么模型"这件事没法在构造时表达（写测试时踩过）。
        ...(overrides.modelLadders ? { modelLadders: overrides.modelLadders } : {}),
        ...(overrides.modelCapabilities ? { modelCapabilities: overrides.modelCapabilities } : {}),
        logLevel: overrides.logLevel ?? 'error',
        ...(overrides.defaultProvider ? { defaultProvider: overrides.defaultProvider } : {}),
        ...(overrides.sourcePath ? { sourcePath: overrides.sourcePath } : {}),
    };
}
//# sourceMappingURL=app.js.map