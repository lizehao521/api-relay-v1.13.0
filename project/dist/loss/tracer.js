/**
 * P5 执行轨迹（pattern-009/015）在中转站层的降级形态。
 *
 * 中转站看不到客户端 Agent 的多步编排，但**看得到一次请求内部的全部步骤**：
 * auth → precheck → fingerprint → route → upstream_request → upstream_response
 * → classify → retry → stream → meter → respond。
 *
 * 这个 request-level trace 的价值：
 * - 排障：一次失败请求"卡在哪一步"不再靠猜，用户报障可以直接给 traceId。
 * - 复盘：diff 两次失败请求的轨迹，定位是上游抖动还是我们自己的策略问题。
 * - 可视化：管理看板把它当时间线渲染。
 *
 * 写入策略：内存环（同步，零阻塞）+ 可选落库（异步批量，走 Store）。
 */
import { RingBuffer, monotonicMs, truncate } from '../util/index.js';
export class TraceBuilder {
    traceId;
    requestId;
    startedAt;
    maxSteps;
    enabled;
    steps = [];
    startMs;
    failedAtStage;
    /** 每一步的明细超过这个长度就截断，避免轨迹本身变成新的"原始载荷" */
    static SUMMARY_MAX = 240;
    constructor(traceId, requestId, startedAt, maxSteps, enabled) {
        this.traceId = traceId;
        this.requestId = requestId;
        this.startedAt = startedAt;
        this.maxSteps = maxSteps;
        this.enabled = enabled;
        this.startMs = monotonicMs();
    }
    step(stage, ok, summary, detail, error) {
        if (!this.enabled)
            return;
        if (this.steps.length >= this.maxSteps)
            return;
        const offsetMs = monotonicMs() - this.startMs;
        const s = {
            stage,
            at: this.startedAt + offsetMs,
            offsetMs,
            ok,
            summary: truncate(summary, TraceBuilder.SUMMARY_MAX),
            ...(detail ? { detail } : {}),
            ...(error ? { error: truncate(error, TraceBuilder.SUMMARY_MAX) } : {}),
        };
        this.steps.push(s);
        if (!ok && this.failedAtStage === undefined)
            this.failedAtStage = stage;
    }
    fail(stage, summary, detail, error) {
        this.step(stage, false, summary, detail, error);
    }
    finish(ctx) {
        return {
            traceId: this.traceId,
            requestId: this.requestId,
            startedAt: this.startedAt,
            durationMs: Math.max(0, Math.round(monotonicMs() - this.startMs)),
            steps: this.steps,
            ...(this.failedAtStage ? { failedAtStage: this.failedAtStage } : {}),
            outcome: ctx.outcome,
        };
    }
    get stepCount() {
        return this.steps.length;
    }
}
/** 轨迹仓库：内存环 + 可选持久化 */
export class TraceStore {
    persist;
    ring;
    /**
     * 归一化的启用判定。B4（审查修复·能力层根因）：enabled 支持取值函数 → 运行期热更新即时
     * 生效（此前构造期捕获，loss-reduction/update 热改 trace.enabled 静默无效）。
     * 传 boolean 时按常量处理（向后兼容旧调用方与测试）。
     */
    isEnabled;
    constructor(ringSize, persist, enabled = true) {
        this.persist = persist;
        this.isEnabled = typeof enabled === 'function' ? enabled : () => enabled;
        this.ring = new RingBuffer(Math.max(10, ringSize));
    }
    save(trace) {
        if (!this.isEnabled())
            return;
        this.ring.push(trace);
        try {
            this.persist(trace);
        }
        catch {
            // fail-open：轨迹落盘失败不影响请求
        }
    }
    recent(limit) {
        return this.ring.toArray().slice(0, limit);
    }
    find(traceId) {
        return this.ring.toArray().find((t) => t.traceId === traceId);
    }
    size() {
        return this.ring.size;
    }
}
export function diffTraces(a, b) {
    const stagesA = a.steps.map((s) => s.stage);
    const stagesB = b.steps.map((s) => s.stage);
    const setA = new Set(stagesA);
    const setB = new Set(stagesB);
    const diverged = [];
    for (const stage of new Set([...stagesA, ...stagesB])) {
        const sa = a.steps.find((s) => s.stage === stage);
        const sb = b.steps.find((s) => s.stage === stage);
        if (!sa || !sb)
            continue;
        if (sa.ok !== sb.ok || sa.summary !== sb.summary) {
            diverged.push({ stage, a: sa.summary, b: sb.summary, aOk: sa.ok, bOk: sb.ok });
        }
    }
    return {
        traceA: a.traceId,
        traceB: b.traceId,
        durationDeltaMs: b.durationMs - a.durationMs,
        onlyInA: [...setA].filter((s) => !setB.has(s)),
        onlyInB: [...setB].filter((s) => !setA.has(s)),
        diverged,
        sameOutcome: a.outcome === b.outcome,
    };
}
/** 把轨迹渲染成人类可读的时间线（管理看板与 CLI 都用它） */
export function renderTrace(trace, opts = {}) {
    const lines = [];
    const color = opts.color ?? false;
    const dim = (s) => (color ? `\u001b[2m${s}\u001b[0m` : s);
    const red = (s) => (color ? `\u001b[31m${s}\u001b[0m` : s);
    const green = (s) => (color ? `\u001b[32m${s}\u001b[0m` : s);
    lines.push(`trace ${trace.traceId}  request ${trace.requestId}`);
    lines.push(`outcome=${trace.outcome} duration=${trace.durationMs}ms${trace.failedAtStage ? ` failed_at=${trace.failedAtStage}` : ''}`);
    for (const s of trace.steps) {
        const mark = s.ok ? green('ok  ') : red('FAIL');
        const detail = s.detail ? ` ${dim(JSON.stringify(s.detail))}` : '';
        const err = s.error ? ` ${red(s.error)}` : '';
        lines.push(`  +${String(s.offsetMs).padStart(6)}ms ${mark} ${s.stage.padEnd(17)} ${s.summary}${detail}${err}`);
    }
    return lines.join('\n');
}
//# sourceMappingURL=tracer.js.map