/**
 * AgentContextProvider（v2 主题 3：上下文工程）。
 *
 * v1 把整坨快照（overview 6000 字符 + providers 3000 + events 3000）一次塞给 LLM；
 * v2 反过来：首条消息只给**极简健康面板**（信号密度高、token 少），细节由 Agent
 * 用工具按需取证。同时补三件 v1 缺的：
 *
 *   1. 健康信号前置：unknown 归因占比 / precheckDegraded / 熔断上游数 /
 *      预算越线 / 零 token 守卫——这些是"最该驱动运维动作"的信号（v1 埋在大 JSON 里）；
 *   2. 自适应窗口：错误率越高窗口越细（5m），平稳用 24h——快照跟着异常显著性走；
 *   3. trace 接入：最近失败轨迹的 id + 首次失败阶段（供 Agent 引用与工具下钻）。
 *
 * 仍然不依赖 HTTP（直接读 pool/store/meter 同源数据），巡检不受 admin 鉴权影响。
 */
export function adaptiveWindowMs(errorRate) {
    if (errorRate >= 0.2)
        return 300_000; // ≥20%：急性故障，看 5 分钟
    if (errorRate >= 0.05)
        return 3_600_000; // ≥5%：慢性异常，看 1 小时
    return 86_400_000; // 平稳：24h 长趋势
}
export function createAgentContext(deps) {
    const limit = deps.recentEvents ?? 30;
    return {
        async collect() {
            const now = Date.now();
            /* ---- 先用 1h 快速探测错误率，决定主窗口 ---- */
            const probe = deps.store.windowStatsPreferPersistent(now - 60 * 60_000);
            const probeRate = probe.requests ? probe.errors / probe.requests : 0;
            const windowMs = adaptiveWindowMs(probeRate);
            const stats = deps.store.windowStatsPreferPersistent(now - windowMs);
            /* ---- 健康信号（前置的关键少数，v1 缺失） ---- */
            const attribution = deps.store.attributionStats(now - windowMs);
            const reasonTotal = attribution.byReason.reduce((n, r) => n + r.count, 0);
            const unknownCount = attribution.byReason
                .filter((r) => r.reason === 'unknown')
                .reduce((n, r) => n + r.count, 0);
            const providers = deps.pool.snapshot().map((p) => ({
                id: p.id,
                label: p.label,
                disabled: p.disabled,
                breakerOpen: p.health.openUntil > now,
                totalRequests: p.health.totalRequests,
                totalFailures: p.health.totalFailures,
                consecutiveFailures: p.health.consecutiveFailures,
            }));
            const breakerOpenCount = providers.filter((p) => p.breakerOpen).length;
            /* ---- 失败轨迹摘要（trace 接入；脱敏——只给 id/阶段/结果，不给载荷） ---- */
            const failedTraces = (deps.traceStore?.recent(50) ?? [])
                .filter((t) => t.outcome !== 'success')
                .slice(0, 5)
                .map((t) => ({ traceId: t.traceId, durationMs: t.durationMs, failedAtStage: t.failedAtStage ?? null }));
            const recentEvents = deps.store.listEvents(limit).map((e) => ({
                ts: e['ts'],
                level: e['level'],
                kind: e['kind'],
                detail: e['detail'],
            }));
            const overview = {
                uptime_s: Math.round(process.uptime()),
                window: { ms: windowMs, label: windowMs === 5 * 60_000 ? '5m' : windowMs === 60 * 60_000 ? '1h' : '24h' },
                requests: stats.requests,
                errors: stats.errors,
                errorRate: stats.requests ? Math.round((stats.errors / stats.requests) * 1000) / 1000 : 0,
                health: {
                    unknownAttributionPct: reasonTotal ? Math.round((unknownCount / reasonTotal) * 1000) / 10 : 0,
                    breakerOpenProviders: breakerOpenCount,
                    precheckDegraded: attribution.precheck.degraded,
                    precheckBlocked: attribution.precheck.blocked,
                    zeroTokenGuard: deps.meter.snapshot().zeroTokenCount,
                    clientAuthFailures: attribution.clientAuth.count,
                },
                failedTraces,
            };
            return { overview, providers, recentEvents, kbHits: [] };
        },
    };
}
//# sourceMappingURL=context.js.map