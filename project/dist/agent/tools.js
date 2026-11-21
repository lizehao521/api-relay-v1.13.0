/**
 * Agent 工具集（v2 主题 1）。
 *
 * v1 的上下文是一次性塞死的快照；v2 给 Agent 一组**只读**工具，
 * 允许它在 maxToolSteps 内"取证→再决策"：
 *   get_metrics / list_events / get_provider / list_providers /
 *   get_trace / search_kb / get_catalog / read_policy
 *
 * 硬约束（写死在代码里，不开放配置）：
 *   - 全部只读、无副作用——不提供任何写操作；
 *   - 每个工具的输出都经 sanitize 截断，防止单次结果把上下文撑爆；
 *   - 工具实现不 import admin（避免鉴权耦合），直接读同源数据结构。
 *
 * 事实依赖（v1 实测形状）：
 *   - meter.summarize(windowMs) → MeterSummary（overall/byModel/byProvider/byFailureReason/lossReduction…）
 *   - store.listEvents(limit) → { ts, level, kind, detail }[]
 *   - store.attributionStats(sinceMs) → AttributionStats
 *   - pool.snapshot() → ProviderSnapshot[]（含 health/concurrency/keyPool）
 *   - traceStore.recent(limit) / find(traceId) → TraceRecord（含 steps/failedAtStage）
 *   - kb.search(kbId, query, topK) → KbSearchResult[]
 */
/* ------------------------------------------------------------------ *
 * 工具实现
 * ------------------------------------------------------------------ */
const WINDOW_PRESETS = {
    '5m': 5 * 60_000,
    '1h': 60 * 60_000,
    '24h': 24 * 60 * 60_000,
};
function windowMsFrom(raw) {
    const s = String(raw ?? '24h');
    return WINDOW_PRESETS[s] ?? WINDOW_PRESETS['24h'];
}
/** 截断工具输出：序列化后超过 cap 字符只保留前 cap，并标注截断 */
function cap(obj, capBytes) {
    let text = JSON.stringify(obj);
    if (text.length <= capBytes)
        return obj;
    text = text.slice(0, capBytes);
    // 尽量在最后一个完整对象边界收口（不追求完美 JSON，调用方按字符串读）
    return { truncated: true, snippet: text };
}
/* ---------------- 1. get_metrics ---------------- */
const getMetrics = {
    name: 'get_metrics',
    description: '读取网关运营指标汇总（请求量/错误率/token/成本/降损层健康）。window 取 5m/1h/24h；dimension 可选 all/model/provider/tier，返回该维度的拆分行。',
    parameters: { window: '5m|1h|24h（默认 24h）', dimension: '可选 all|model|provider|tier（默认 all）' },
    run(args, ctx) {
        const windowMs = windowMsFrom(args['window']);
        const s = ctx.meter.summarize(windowMs);
        const dim = String(args['dimension'] ?? 'all');
        if (dim === 'all') {
            return cap({
                window: { from: s.from, to: s.to },
                overall: s.overall,
                lossReduction: s.lossReduction,
                byFailureReason: s.byFailureReason.slice(0, 10),
                clientAuthFailures: s.clientAuthFailures,
            }, 4000);
        }
        const rows = dim === 'model' ? s.byModel : dim === 'provider' ? s.byProvider : s.byTier;
        return cap({ window: { from: s.from, to: s.to }, dimension: dim, rows: rows.slice(0, 12) }, 4000);
    },
};
/* ---------------- 2. list_events ---------------- */
const listEvents = {
    name: 'list_events',
    description: '读取网关最近运维事件（key/上游/KB/agent 写操作与告警）。可按 kind 与 level 过滤。',
    parameters: { limit: '条数，默认 20，上限 100', kind: '可选，按事件 kind 前缀过滤（如 provider/key/agent）', level: '可选 info|warn|error' },
    run(args, ctx) {
        const limit = Math.max(1, Math.min(100, Number(args['limit'] ?? 20) || 20));
        const kindPrefix = args['kind'] === undefined ? undefined : String(args['kind']);
        const level = args['level'] === undefined ? undefined : String(args['level']);
        let evs = ctx.store.listEvents(200);
        if (kindPrefix)
            evs = evs.filter((e) => String(e.kind ?? '').startsWith(kindPrefix));
        if (level)
            evs = evs.filter((e) => String(e.level ?? '') === level);
        return cap(evs.slice(0, limit).map((e) => ({
            ts: e.ts, level: e.level, kind: e.kind,
            detail: e.detail ? JSON.stringify(e.detail).slice(0, 200) : '',
        })), 4000);
    },
};
/* ---------------- 3. get_provider ---------------- */
const getProvider = {
    name: 'get_provider',
    description: '读取单个上游的深度状态：健康（熔断/连续失败）、并发、key 池轮换状态、声明模型与成本。',
    parameters: { id: '上游 id（必填）' },
    run(args, ctx) {
        const id = String(args['id'] ?? '');
        const p = ctx.pool.snapshot().find((x) => x.id === id);
        if (!p)
            return { error: `unknown provider: ${id}` };
        return cap({
            id: p.id, label: p.label, disabled: p.disabled,
            breakerOpen: p.health.openUntil > Date.now(),
            health: { totalRequests: p.health.totalRequests, totalFailures: p.health.totalFailures, consecutiveFailures: p.health.consecutiveFailures, openUntil: p.health.openUntil },
            concurrency: p.concurrency,
            keyPool: p.keyPool ? p.keyPool.map((k) => ({ index: k.index, dead: k.dead, cooldownMsLeft: k.cooldownMsLeft, failures: k.failures })) : undefined,
            models: p.models.slice(0, 20),
            cost: p.cost,
        }, 3000);
    },
};
/* ---------------- 4. list_providers ---------------- */
const listProviders = {
    name: 'list_providers',
    description: '列出全部上游的概要（id/禁用/熔断/失败数），用于先总览再对可疑上游用 get_provider 深挖。',
    parameters: {},
    run(_args, ctx) {
        return cap(ctx.pool.snapshot().map((p) => ({
            id: p.id, label: p.label, disabled: p.disabled,
            breakerOpen: p.health.openUntil > Date.now(),
            totalRequests: p.health.totalRequests, totalFailures: p.health.totalFailures,
        })), 3000);
    },
};
/* ---------------- 5. get_trace ---------------- */
const getTrace = {
    name: 'get_trace',
    description: '读取最近失败请求的轨迹（某次请求卡在哪一步）。不带 id 时返回最近 N 条失败轨迹摘要；带 id 返回单条完整轨迹。',
    parameters: { id: '可选 traceId（从摘要里取）', limit: '不带 id 时返回条数，默认 5，上限 10' },
    run(args, ctx) {
        if (!ctx.traceStore)
            return { error: 'trace disabled' };
        const id = args['id'] === undefined ? undefined : String(args['id']);
        if (id) {
            const t = ctx.traceStore.find(id);
            if (!t)
                return { error: `trace not found (可能已滚出内存环): ${id}` };
            return cap({
                traceId: t.traceId, requestId: t.requestId, startedAt: t.startedAt,
                durationMs: t.durationMs, outcome: t.outcome, failedAtStage: t.failedAtStage,
                steps: t.steps.map((s) => ({ stage: s.stage, ok: s.ok, summary: s.summary })),
            }, 3000);
        }
        const limit = Math.max(1, Math.min(10, Number(args['limit'] ?? 5) || 5));
        const failed = ctx.traceStore.recent(50).filter((t) => t.outcome !== 'success').slice(0, limit);
        return cap(failed.map((t) => ({
            traceId: t.traceId, durationMs: t.durationMs, outcome: t.outcome, failedAtStage: t.failedAtStage,
        })), 2000);
    },
};
/* ---------------- 6. search_kb ---------------- */
const searchKb = {
    name: 'search_kb',
    description: '检索知识库（错题本/迭代知识）。query 用当前异常的关键词（失败原因/上游 id/模型名），不要用泛词。',
    parameters: { query: '检索词（必填，建议含具体失败原因或上游名）', topK: '返回块数，默认 5，上限 10' },
    run(args, ctx) {
        if (!ctx.kb || !ctx.kb.ok)
            return { error: 'kb disabled' };
        const query = String(args['query'] ?? '');
        if (!query.trim())
            return { error: 'query required' };
        const topK = Math.max(1, Math.min(10, Number(args['topK'] ?? 5) || 5));
        const hits = ctx.kb.search(ctx.kbId, query, topK);
        return cap(hits.map((h) => ({ title: h.docTitle, score: h.score, text: h.text.slice(0, 300) })), 3000);
    },
};
/* ---------------- 7. get_catalog ---------------- */
const getCatalog = {
    name: 'get_catalog',
    description: '读取失败归因分布（byFailureReason 含 unknown 占比）与建议动作分布——判断"该补哪条归因规则"的数据源。',
    parameters: { window: '5m|1h|24h（默认 24h）' },
    run(args, ctx) {
        const windowMs = windowMsFrom(args['window']);
        const a = ctx.store.attributionStats(Date.now() - windowMs);
        const total = a.byReason.reduce((n, r) => n + r.count, 0);
        const unknown = a.byReason.find((r) => r.reason === 'unknown');
        return cap({
            window: windowMs,
            byReason: a.byReason.slice(0, 12),
            unknownPct: total ? Math.round(((unknown?.count ?? 0) / total) * 1000) / 10 : 0,
            byAction: a.byAction.slice(0, 10),
            clientAuth: a.clientAuth,
        }, 3000);
    },
};
/* ---------------- 8. read_policy ---------------- */
const readPolicy = {
    name: 'read_policy',
    description: '读取当前降损层开关与分层策略（只读）：预检/归因/计量/轨迹开关、各层的 precheck/attribution 模式与限额。',
    parameters: {},
    run(_args, ctx) {
        const c = ctx.config;
        return cap({
            precheck: { enabled: c.lossReduction.precheck.enabled, onBlock: c.lossReduction.precheck.onBlock, budgetUs: c.lossReduction.precheck.budgetUs },
            attribution: { enabled: c.lossReduction.attribution.enabled, autoRetry: c.lossReduction.attribution.autoRetry, breakerThreshold: c.lossReduction.attribution.breakerThreshold },
            meter: { enabled: c.lossReduction.meter.enabled, retentionDays: c.lossReduction.meter.retentionDays },
            tiers: Object.fromEntries(Object.entries(c.tiers).map(([k, t]) => [k, {
                    precheck: t.precheck, attribution: t.attribution, rpm: t.rpm, maxConcurrency: t.maxConcurrency,
                }])),
        }, 3000);
    },
};
/* ------------------------------------------------------------------ *
 * 注册表（固定，不开放配置——工具白名单是安全边界的一部分）
 * ------------------------------------------------------------------ */
export const AGENT_TOOLS = Object.freeze([
    getMetrics, listEvents, getProvider, listProviders, getTrace, searchKb, getCatalog, readPolicy,
]);
export const AGENT_TOOL_NAMES = AGENT_TOOLS.map((t) => t.name);
/** app.ts 装配用：聚合工具上下文（trace/kb 可选——未启用时对应工具返回 disabled） */
export function createAgentToolContext(deps) {
    return {
        store: deps.store,
        pool: deps.pool,
        meter: deps.meter,
        traceStore: deps.traceStore,
        kb: deps.kb,
        config: deps.config,
        kbId: deps.kbId ?? 'kb_demo',
    };
}
//# sourceMappingURL=tools.js.map