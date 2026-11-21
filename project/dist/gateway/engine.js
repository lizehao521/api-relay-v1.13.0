/**
 * 中转引擎（与 HTTP 传输解耦的核心管道）。
 *
 * 管道顺序（P5 轨迹的步骤即来源于此）：
 *   parse → auth → precheck(P2) → fingerprint → complexity → route → upstream → classify(P3) → meter(P8) → respond
 *
 * 三条不可破坏的契约：
 *   1. **成功响应零改写**：非流式响应体原样字节透传；流式 SSE 帧原样字节透传。
 *      一切附加信息只进响应头 / 错误体。
 *   2. **fail-open**：预检、归因、度量、轨迹、指纹任一环节异常都不得让请求失败。
 *      唯一 fail-closed 的是鉴权（安全边界）。
 *   3. **可归因**：任何非 2xx 响应都必须带 relay_attribution（在 enabled 的前提下）。
 */
import { BoundedCache, backoffDelay, estimateJsonTokens, estimateTokensFromBytes, monotonicMs, monotonicUs, ownLookup, sha256Hex, truncate } from '../util/index.js';
import { createClassifier } from '../loss/attribution.js';
import { compileDangerousPatterns, precheck } from '../loss/precheck.js';
import { computeFingerprint } from '../loss/fingerprint.js';
import { computeCost } from '../loss/meter.js';
import { TraceBuilder } from '../loss/tracer.js';
import { UNATTRIBUTED_KEY_ID } from '../store/index.js';
import { authFailureSuggestion } from './keys.js';
import { DuplicateObserver, KeyFeatureWindow, NoRouteError, assessComplexity, countsTowardUpstreamHealth, } from '../upstream/pool.js';
import { rewriteSseModel } from '../upstream/client.js';
import { FailurePresenter, rewriteJsonModel } from './presenter.js';
import { buildStreamErrorFrame } from './adapters.js';
// M-05：headerSafe 已随呈现层迁至 presenter.ts；此处转发导出，保持既有 import 路径不变
export { headerSafe } from './presenter.js';
// C1（审查修复·模块归档）：rewriteJsonModel 同属"呈现"，迁往 presenter.ts 后转发导出，
// 保持既有 import 路径（含测试）不变。
export { rewriteJsonModel };
function isSuccessOutcome(outcome) {
    return outcome.kind === 'passthrough' || outcome.kind === 'buffered';
}
/**
 * 主线路在**对冲已启动之后**才真实失败时，给对冲的额外宽限（毫秒）。
 * 超过就按主线路失败返回（交上层重试/换阶），不能因为等对冲把失败路径拖到
 * 上游 TTFB 超时（90s）那么久（审计 P2-4）。
 */
const HEDGE_FAILURE_GRACE_MS = 2_000;
/* ------------------------------------------------------------------ *
 * HTTP 状态与错误码映射
 * ------------------------------------------------------------------ */
const ERROR_STATUS = {
    invalid_request_error: 400,
    authentication_error: 401,
    permission_error: 403,
    not_found_error: 404,
    request_too_large: 413,
    rate_limit_error: 429,
    // 余额/配额不足必须是 402 而不是 429：SDK 把 429 映射成 RateLimitError，
    // Agent 框架会对其自动重试 —— 永久性错误返 429 会引发无效重试风暴。
    insufficient_quota: 402,
    upstream_error: 502,
    upstream_timeout: 504,
    relay_internal_error: 500,
    model_not_found: 404,
};
/* ------------------------------------------------------------------ *
 * 引擎
 * ------------------------------------------------------------------ */
export class Engine {
    deps;
    classifier;
    dangerousPatterns;
    duplicateObserver = new DuplicateObserver(60_000);
    keyFeatures = new KeyFeatureWindow();
    lr;
    /** M-05：呈现层（错误码 / 错误体 / 归因头 / 校验 HMAC）抽为注入式依赖，Engine 只保留管道编排 */
    presenter;
    constructor(deps) {
        this.deps = deps;
        this.lr = deps.config.lossReduction;
        this.presenter = new FailurePresenter({ lr: () => this.lr, hideUpstream: () => this.deps.config.server.hideUpstream === true });
        this.classifier = createClassifier(new BoundedCache(2_000));
        this.dangerousPatterns = compileDangerousPatterns(this.lr.precheck.dangerousCommandPatterns);
    }
    get modelCatalog() {
        const models = this.deps.router.catalog();
        const set = new Set(models);
        return {
            has: (m) => set.has(m),
            list: () => models,
            anyAvailable: () => this.deps.pool.all().some((e) => !e.config.disabled && !this.deps.pool.isOpen(e)),
        };
    }
    /**
     * 每模型的输出上限（max_tokens 上限），供预检的模型级检查用。
     *
     * 这是把一条**死代码**接活：`PrecheckContext.modelMaxTokens` 早在 precheck.ts 里
     * 就被读取，但此前全库没有任何调用方装配它（engine 只传 endpoint/body/catalog），
     * 于是模型级上限检查从未生效。数据源是 `modelCapabilities.maxOutputTokens`
     * —— 各厂商真实上限差很多且只在自己那边校验（实测 Agnes 硬上限 65536，
     * 超了回 400「max_tokens 不能超过 65536」；MiMo 接受 65537+）。
     *
     * 只收**有声明**的模型：没声明的留给 precheck 的全局天花板兜底，
     * 不在这里臆造一个上限（宁可放过不可误杀）。
     */
    get modelMaxTokens() {
        const out = {};
        for (const [m, cap] of Object.entries(this.deps.config.modelCapabilities ?? {})) {
            if (typeof cap?.maxOutputTokens === 'number' && cap.maxOutputTokens > 0)
                out[m] = cap.maxOutputTokens;
        }
        return out;
    }
    /* ============================ 入口 ============================ */
    async handle(req) {
        const startedAt = Date.now();
        const startedMono = monotonicMs();
        const endpoint = req.path.replace(/\/+$/, '');
        const parsed = this.parseBody(req.rawBody);
        if (!parsed.ok) {
            return this.presenter.simpleError('invalid_request_error', parsed.message, ['请检查请求体是否为合法 JSON'], 400);
        }
        const body = parsed.body;
        const requestedModel = typeof body['model'] === 'string' ? body['model'] : '';
        const stream = body['stream'] === true;
        const payloadHash = this.lr.meter.hashPayloads
            ? sha256Hex(Buffer.from(req.rawBody), this.lr.meter.hashSalt).slice(0, 32)
            : '';
        const trace = new TraceBuilder(`tr_${req.requestId.slice(3)}`, req.requestId, startedAt, this.lr.trace.maxSteps, this.lr.trace.enabled);
        /* ---------- auth ---------- */
        const t0Auth = monotonicUs();
        const auth = await this.deps.keys.authenticate({
            ...(req.headers['authorization'] ? { authorization: req.headers['authorization'] } : {}),
            ...(requestedModel ? { model: requestedModel } : {}),
            path: req.path,
            signal: req.signal,
        });
        const authUs = monotonicUs() - t0Auth;
        if (!auth.ok) {
            trace.fail('auth', `鉴权失败: ${auth.error.code}`, { code: auth.error.code });
            return this.authErrorResponse(req, auth.error, trace, startedMono, auth.identity?.tier);
        }
        trace.step('auth', true, `key=${auth.identity.keyId} tier=${auth.identity.tier}`, { authUs: Math.round(authUs) });
        // 从这里开始，任何提前返回都必须 release 并发额度。
        // 流式成功路径例外（S1-2 修复）：客户端并发额度必须**活到流真正结束**——
        // 之前 finally 无条件抢先释放，maxConcurrency 承诺对流式请求系统性失效
        // （free 层 4 并发可同时挂几十个活跃流）。因此：
        //   · handle 返回 EngineStream（流式成功）→ 释放责任移交 buildStreamResult.onEnd
        //     （server.writeStream 保证在流 close/error 时调用 onEnd；
        //      此外 signal abort → release 的兜底链仍然在位）；
        //   · 其余一切路径 → finally 兜底释放。
        let released = false;
        let releaseDelegated = false; // true = 已移交给流式 onEnd，finally 不得抢先
        const release = () => {
            if (!released) {
                released = true;
                auth.release();
            }
        };
        const delegateReleaseToStream = () => {
            releaseDelegated = true;
        };
        req.signal.addEventListener('abort', release, { once: true });
        try {
            /* ---------- 度量上下文 ---------- */
            const features = this.keyFeatures.features(auth.identity.keyId, startedAt);
            const fingerprint = this.fingerprintOf(body, req.headers, features, auth.identity.keyId);
            this.keyFeatures.observeRequest(auth.identity.keyId, startedAt);
            const isToolCalling = fingerprint.features.hasToolCalls || fingerprint.features.hasTools;
            const complexity = assessComplexity({ body, clientKind: fingerprint.kind, isToolCalling });
            const ctx = {
                requestId: req.requestId,
                startedAt,
                startedMono,
                traceId: trace.traceId,
                method: req.method,
                path: req.path,
                client: auth.identity,
                fingerprint,
                requestedModel,
                stream,
                payloadHash,
                payloadBytes: req.rawBody.byteLength,
                isToolCalling,
                routes: [],
                bytesIn: req.rawBody.byteLength,
                bytesOut: 0,
                durationMs: 0,
                overheadUs: { precheck: 0, classify: 0, meter: 0 },
                outcome: 'success',
            };
            /* ---------- P2 预检 ---------- */
            const precheckStart = monotonicUs();
            const precheckResult = precheck({
                endpoint: this.normalizeEndpoint(endpoint),
                body,
                catalog: this.modelCatalog,
                // 模型级 max_tokens 上限（接活此前从未被装配的死代码分支：
                // PrecheckContext.modelMaxTokens 一直在被读，却没有任何调用方传过）
                modelMaxTokens: this.modelMaxTokens,
            }, { config: this.lr, dangerousPatterns: this.dangerousPatterns });
            ctx.overheadUs.precheck = monotonicUs() - precheckStart;
            const blocks = precheckResult.violations.filter((v) => v.severity === 'block');
            const enforce = auth.policy.precheck === 'enforce' && this.lr.precheck.enabled;
            // 误拦逃生舱：客户端显式声明跳过拦截。这是"可控 + 可逆"原则的落点——
            // 用户不该被治理层的误判锁死，且我们不因此放行任何安全边界。
            const precheckBypassed = (req.headers['x-relay-precheck'] ?? '').toLowerCase() === 'off';
            const reject = enforce && blocks.length > 0 && this.lr.precheck.onBlock === 'reject' && !precheckBypassed;
            ctx.precheck = {
                result: precheckResult,
                disposition: reject ? 'reject' : blocks.length > 0 ? 'observe' : 'pass',
            };
            if (precheckBypassed && blocks.length > 0) {
                ctx.precheck.result = {
                    ...precheckResult,
                    violations: [
                        ...precheckResult.violations,
                        {
                            code: 'precheck_bypassed',
                            severity: 'info',
                            pointer: '',
                            message: `客户端通过 X-Relay-Precheck: off 主动跳过了 ${blocks.length} 条阻断级预检`,
                            fix: '如需恢复拦截，移除该请求头',
                        },
                    ],
                };
            }
            if (blocks.length > 0) {
                trace.step('precheck', !reject, `发现 ${blocks.length} 条阻断级问题（${reject ? '已拦截' : '仅记录，放行'}）`, { codes: blocks.map((b) => b.code).join(','), disposition: ctx.precheck.disposition });
            }
            else {
                trace.step('precheck', true, `通过（${precheckResult.violations.length} 条提示，耗时 ${Math.round(ctx.overheadUs.precheck)}µs）`, {
                    violations: precheckResult.violations.length,
                    degraded: !!precheckResult.degraded,
                });
            }
            if (reject) {
                const first = blocks[0];
                const card = this.presenter.precheckCard(first.code, blocks.map((b) => `${b.pointer || '/'}: ${b.message}`), requestedModel);
                ctx.attribution = card;
                ctx.outcome = 'client_error';
                ctx.httpStatus = 400;
                ctx.durationMs = Math.round(monotonicMs() - startedMono);
                return this.finishJson(ctx, trace, auth, {
                    kind: 'json',
                    status: 400,
                    body: this.presenter.errorBody('invalid_request_error', first.message, {
                        param: first.pointer,
                        code: first.code,
                        type: 'invalid_request_error',
                    }, card, auth.policy, { violations: blocks }),
                    headers: { 'x-relay-precheck': 'blocked' },
                });
            }
            /* ---------- 路由 + 上游调用（竖向阶梯 × 横向供应商） ----------
             * 竖向：同一请求沿档位阶梯换模型（旗舰挂了往平衡推、极速挂了往旗舰推），
             *       目的是让客户的任务自动跑完，而不是把错误丢回去。
             * 横向：同一个模型挂多个供应商时，优先换供应商（语义完全不变）。
             *
             * 两个集合的层级不同，换阶时的处置也不同：
             * - `fatal`  密钥/权限/余额类，是**供应商级**的——换阶也不能再选它，全程保留。
             * - `tried`  本次尝试试过的供应商，是**尝试级**的——换阶时清空，否则下一阶会被饿死。
             */
            const ttfbTimeoutMs = this.deps.config.server.upstreamTtfbTimeoutMs;
            const ladder = this.resolveLadder(requestedModel, body, ctx.isToolCalling);
            const maxSameModelRetries = Math.max(0, this.lr.attribution.autoRetry);
            const maxAttempts = Math.max(1, ladder.length * (1 + maxSameModelRetries));
            const tried = new Set();
            const fatal = new Set();
            let ladderIndex = 0;
            let sameModelRetries = 0;
            let lastNoRoute;
            let lastFailure;
            if (ladder.length > 1) {
                trace.step('route', true, `档位阶梯共 ${ladder.length} 阶：${ladder.join(' → ')}`, {
                    ladder: ladder.join('|'),
                    tools: ctx.isToolCalling,
                });
            }
            for (let attempt = 0; attempt < maxAttempts; attempt++) {
                if (ladderIndex >= ladder.length)
                    break;
                const targetModel = ladder[ladderIndex];
                let routed;
                try {
                    routed = this.deps.router.route({
                        requestedModel: targetModel,
                        exclude: fatal,
                        tried,
                        deprioritize: new Set(tried),
                        tier: auth.policy,
                        clientKind: fingerprint.kind,
                        complexity,
                        ...(req.forceProviderId ? { forceProviderId: req.forceProviderId } : {}),
                    });
                }
                catch (err) {
                    if (err instanceof NoRouteError) {
                        lastNoRoute = err;
                        // 这一阶走不通（没有上游声明支持 / 全在熔断）→ 换下一阶，而不是直接失败
                        const skipped = ladderIndex + 1;
                        ladderIndex++;
                        sameModelRetries = 0;
                        tried.clear();
                        if (ladderIndex < ladder.length) {
                            trace.step('route', false, `第 ${skipped} 阶 ${targetModel} 不可用，跳到 ${ladder[ladderIndex]}`, {
                                rejected: err.rejected.map((r) => `${r.providerId}:${r.why}`).join(','),
                            });
                            continue;
                        }
                        break;
                    }
                    throw err;
                }
                routed.decision.ladderStep = { index: ladderIndex, total: ladder.length, from: requestedModel };
                ctx.routes.push(routed.decision);
                trace.step('route', true, `→ ${routed.decision.providerId}（${routed.decision.reason}）model=${routed.decision.upstreamModel}`, {
                    attempt,
                    reason: routed.decision.reason,
                    candidates: routed.decision.candidatesConsidered.join('|'),
                    ...(routed.decision.estimatedCostPerMTok !== undefined ? { estCostPerMTok: routed.decision.estimatedCostPerMTok } : {}),
                });
                /* 为一个候选上游构造请求体（不同上游的模型名可能不同 → 各自重写） */
                const buildUpstreamReq = (decision, attemptNo) => {
                    const upstreamPath = this.upstreamPath(endpoint, decision.upstreamModel);
                    const rewrittenBody = this.rewriteUpstreamBody(body, decision.upstreamModel);
                    // 流式必须自己注入 include_usage，否则上游不回 usage，P8 计量整段丢成 0
                    //（2026-09-14 实测：375 个流式请求 prompt/completion/total 全是 0）。
                    // 注入后上游多出来的那一帧由客户端转发层（dropUsageOnlyFrames）滤掉。
                    const usagePlan = this.withStreamUsage(rewrittenBody, stream);
                    return {
                        path: upstreamPath,
                        model: decision.upstreamModel,
                        body: usagePlan.body,
                        stream,
                        attempt: attemptNo,
                        ...(usagePlan.injected ? { injectedUsage: true } : {}),
                    };
                };
                /* 一次"拿到首个响应"的尝试：排队 → 发送 → 释放额度。绝不抛异常。 */
                const runAttempt = async (decision, entry, attemptNo, signal, hedged) => {
                    const upstreamReq = buildUpstreamReq(decision, attemptNo);
                    const acquireStart = monotonicMs();
                    let releaseSlot;
                    try {
                        releaseSlot = await entry.limiter.acquire(signal);
                    }
                    catch {
                        // 客户端在排队期间断开（交给上层的 clientAborted 分支统一成 499）
                        return {
                            outcome: {
                                kind: 'error',
                                providerId: decision.providerId,
                                model: decision.upstreamModel,
                                networkError: { message: '客户端在等待上游并发额度时断开' },
                                durationMs: 0,
                                clientAborted: true,
                            },
                            decision,
                            entry,
                            hedged,
                        };
                    }
                    const queueMs = monotonicMs() - acquireStart;
                    const reqStart = monotonicMs();
                    try {
                        // trace.step 放进 try：它若抛异常也不能漏掉 releaseSlot（审计 P3-7）。
                        trace.step('upstream_request', true, hedged ? `POST ${upstreamReq.path}（对冲）` : `POST ${upstreamReq.path}`, {
                            provider: decision.providerId,
                            queueMs,
                            stream,
                            bodyBytes: Buffer.byteLength(JSON.stringify(upstreamReq.body), 'utf8'),
                            ...(hedged ? { hedged: true } : {}),
                        });
                        const outcome = await entry.client.send(upstreamReq, signal);
                        return { outcome, decision, entry, hedged };
                    }
                    catch (err) {
                        // 客户端实现不应抛异常，但 fail-open 兜底
                        return {
                            outcome: {
                                kind: 'error',
                                providerId: decision.providerId,
                                model: decision.upstreamModel,
                                networkError: { message: err instanceof Error ? err.message : String(err) },
                                durationMs: monotonicMs() - reqStart,
                            },
                            decision,
                            entry,
                            hedged,
                        };
                    }
                    finally {
                        releaseSlot();
                    }
                };
                /* 双线路对冲（2026-09-15）：同一模型有两个可用上游时，主线路超过
                 * hedgeDelayMs 还没产出首个响应，就并行发起备线路，**谁先成功用谁**，
                 * 另一条立即中止。目的不是压低中位数延迟，而是**提高任务完成率** ——
                 * 两条 Agnes 线路"慢但都 200"时旧的"出错才换线"不介入，客户只能干等。
                 * 主线路在宽限内成功/失败时行为与旧版完全一致（失败照旧走重试/换阶）。 */
                const hedgeDelayMs = this.deps.config.server.hedgeDelayMs ?? 0;
                const hedgePlan = hedgeDelayMs > 0 && !req.forceProviderId
                    ? this.routeHedgeCandidate(targetModel, fatal, tried, auth.policy, complexity, fingerprint.kind, routed.decision)
                    : undefined;
                if (hedgePlan) {
                    // 对冲沿用主线路的阶梯信息，否则 modeHeader 的 x-relay-ladder 会丢（审计 P2-5）
                    hedgePlan.decision.ladderStep = routed.decision.ladderStep;
                }
                // runAttempt 已内部 try/catch，理论上不会 reject；这里再加一层兜底，
                // 免得万一的异常变成未处理拒绝把进程带崩（关键路径不加赌注）。
                const safeRun = (decision, entry, attemptNo, hedged) => (signal) => runAttempt(decision, entry, attemptNo, signal, hedged).catch((err) => ({
                    outcome: {
                        kind: 'error',
                        providerId: decision.providerId,
                        model: decision.upstreamModel,
                        networkError: { message: err instanceof Error ? err.message : String(err) },
                        durationMs: 0,
                    },
                    decision,
                    entry,
                    hedged,
                }));
                const race = await this.sendWithHedge(safeRun(routed.decision, routed.entry, attempt, false), hedgePlan
                    ? (signal) => {
                        try {
                            trace.step('route', true, `⇉ 对冲并发：${hedgePlan.decision.providerId}（${hedgePlan.decision.reason}）model=${hedgePlan.decision.upstreamModel}`, {
                                attempt: attempt + 1,
                                hedged: true,
                                candidates: hedgePlan.decision.candidatesConsidered.join('|'),
                            });
                            // ⚠️ 这里**不** push 到 ctx.routes：routes.at(-1) 被 meter/响应头当作
                            // "实际服务方"，而对冲到点就发起、赢的未必是它 —— 只有赢家才 push
                            // （审计 P1-1：否则主线路赢时会把 providerId 记成输家）。
                            return safeRun(hedgePlan.decision, hedgePlan.entry, attempt + 1, true)(signal);
                        }
                        catch (err) {
                            // trace.step 等同步前缀若抛异常，不能让它逃出 setTimeout 回调（审计 P3-6）
                            return Promise.resolve({
                                outcome: {
                                    kind: 'error',
                                    providerId: hedgePlan.decision.providerId,
                                    model: hedgePlan.decision.upstreamModel,
                                    networkError: { message: err instanceof Error ? err.message : String(err) },
                                    durationMs: 0,
                                },
                                decision: hedgePlan.decision,
                                entry: hedgePlan.entry,
                                hedged: true,
                            });
                        }
                    }
                    : undefined, hedgeDelayMs, req.signal);
                const attemptResult = race.winner;
                const outcome = attemptResult.outcome;
                if (attemptResult.hedged) {
                    // 备线路先成功：后续的成功处理/归因/计量都改用备线路的 decision/entry
                    routed = { decision: attemptResult.decision, entry: attemptResult.entry };
                    // 只有赢家进 routes，保证 meter/响应头指向真正服务的那条（审计 P1-1）
                    ctx.routes.push(routed.decision);
                    trace.step('hedge', true, `对冲命中：${attemptResult.decision.providerId} 先返回首个响应`, {
                        provider: attemptResult.decision.providerId,
                    });
                }
                // 被对冲接住的那条若有**真实失败**（不是我们主动 abort 的），照旧记一次上游失败，
                // 否则坏线路永远不累计失败、熔断永远不打开（审计 P2-3）。
                if (race.loser && race.loser.outcome.kind === 'error' && !race.loser.outcome.clientAborted) {
                    const lo = race.loser.outcome;
                    const classified = this.classifier.classify({
                        ...(lo.httpStatus !== undefined ? { httpStatus: lo.httpStatus } : {}),
                        ...(lo.bodyText !== undefined ? { bodyText: lo.bodyText } : {}),
                        ...(lo.headers ? { headers: lo.headers } : {}),
                        ...(lo.networkError ? { networkError: lo.networkError } : {}),
                        providerId: race.loser.decision.providerId,
                        model: race.loser.decision.upstreamModel,
                        attempt: 1,
                    });
                    this.deps.pool.noteFailure(race.loser.entry, classified.card.failure_reason, isFatal(classified.card.failure_reason), {
                        countsTowardBreaker: countsTowardUpstreamHealth(classified.card.failure_reason),
                    });
                    this.keyFeatures.observeFailure(auth.identity.keyId);
                    trace.fail('classify', `对冲接住的真实失败：${race.loser.decision.providerId} ${classified.card.failure_reason}`, {
                        provider: race.loser.decision.providerId,
                        recoverable: classified.card.recoverable,
                    });
                }
                /* ---------- 成功路径 ---------- */
                if (outcome.kind === 'passthrough') {
                    this.deps.pool.noteSuccess(routed.entry, outcome.response.ttfbMs);
                    trace.step('upstream_response', true, `HTTP ${outcome.response.status}（流式，首字节 ${outcome.response.ttfbMs}ms）`, {
                        provider: routed.decision.providerId,
                        ttfbMs: outcome.response.ttfbMs,
                    });
                    ctx.ttfbMs = outcome.response.ttfbMs;
                    ctx.httpStatus = outcome.response.status;
                    delegateReleaseToStream(); // S1-2：流式路径由 onEnd 释放，finally 不得抢先
                    return this.buildStreamResult(ctx, trace, auth, outcome, routed.decision, release);
                }
                if (outcome.kind === 'buffered') {
                    this.deps.pool.noteSuccess(routed.entry, outcome.ttfbMs);
                    // 模型名回显修正（只改 model 字段，见 rewriteSseModel 的说明）
                    const finalBody = ctx.requestedModel &&
                        (this.deps.config.server.hideUpstream || ctx.requestedModel !== routed.decision.upstreamModel)
                        ? rewriteJsonModel(outcome.bodyText, ctx.requestedModel)
                        : outcome.bodyText;
                    trace.step('upstream_response', true, `HTTP ${outcome.status}（缓冲 ${outcome.bodyText.length}B，${outcome.durationMs}ms）`, {
                        provider: routed.decision.providerId,
                        ttfbMs: outcome.ttfbMs,
                        bytes: outcome.bodyText.length,
                    });
                    ctx.ttfbMs = outcome.ttfbMs;
                    ctx.usage = this.withCost(outcome.usage, this.costFor(routed.entry.config, routed.decision.upstreamModel), this.listCostFor(routed.entry.config, routed.decision.upstreamModel));
                    ctx.bytesOut = Buffer.byteLength(finalBody, 'utf8');
                    ctx.httpStatus = outcome.status;
                    ctx.durationMs = Math.round(monotonicMs() - startedMono);
                    ctx.outcome = 'success';
                    /*
                     * 200 + content_filter：上游安全策略截断（审计 A-P1-5 指出这是**死代码** ——
                     * classify 只在失败路径被调用，200 的成功路径从不检查，规则在
                     * attribution.ts 里躺了很久）。DESIGN.md §7.3 说"只打标记、绝不改写响应体"，
                     * 所以：加一个响应头 + 事件，**响应体一个字节不动**（成功响应零附加的红线照旧）。
                     */
                    const safetyFiltered = /content_filter/i.test(finalBody);
                    if (safetyFiltered) {
                        this.deps.logger.warn('upstream.content_filtered', {
                            requestId: req.requestId,
                            providerId: routed.decision.providerId,
                            model: routed.decision.upstreamModel,
                        });
                        this.deps.store.logEvent('warn', 'upstream.content_filtered', {
                            requestId: req.requestId,
                            providerId: routed.decision.providerId,
                            keyId: auth.identity.keyId,
                        });
                    }
                    return this.finishJson(ctx, trace, auth, {
                        kind: 'json',
                        status: outcome.status,
                        body: finalBody,
                        headers: {
                            ...this.presenter.attributionHeadersForSuccess(auth.policy),
                            ...this.presenter.modeHeader(ctx, auth.policy),
                            ...this.presenter.verificationHeaders(req, finalBody, req.requestId),
                            // G2/G5：额度余量 + 近限告警（仅当该 key 配了帽）
                            ...this.presenter.quotaHeaders(auth.quota),
                            ...(safetyFiltered ? { 'x-relay-warning': 'content_filtered' } : {}),
                        },
                        ...(outcome.usage ? { usage: ctx.usage } : {}),
                    });
                }
                /* ---------- 失败路径：归因 ---------- */
                const classifyStart = monotonicUs();
                const { card, durationUs } = this.classifier.classify({
                    ...(outcome.httpStatus !== undefined ? { httpStatus: outcome.httpStatus } : {}),
                    ...(outcome.bodyText !== undefined ? { bodyText: outcome.bodyText } : {}),
                    ...(outcome.headers ? { headers: outcome.headers } : {}),
                    ...(outcome.networkError ? { networkError: outcome.networkError } : {}),
                    ...(outcome.clientAborted ? { clientAborted: true } : {}),
                    providerId: routed.decision.providerId,
                    model: routed.decision.upstreamModel,
                    attempt: attempt + 1,
                });
                ctx.overheadUs.classify += durationUs;
                lastFailure = { card, outcome };
                const fatalOnClientAbort = !!outcome.clientAborted;
                const autoRetryable = !fatalOnClientAbort &&
                    card.recoverable &&
                    this.lr.attribution.retryableReasons.includes(card.failure_reason) &&
                    attempt + 1 < maxAttempts;
                // 立即熔断仅限"重试不可能成功"的归因：密钥/权限/余额。
                // 注意 503/overload 虽然 recoverable=false（不建议客户端重试），但对中转站是
                // 典型的**瞬时**上游故障，必须靠连续失败计数熔断，否则一次抖动就把上游摘掉。
                //
                // 但**客户端自己断开不算上游失败**：它可能只是网络慢、用户点了取消、或页面关了，
                // 对上游健康度没有任何信息量。曾经这里无条件记账，后果是"客户端超时能把上游
                // 对整个网关摘掉"（实测：几次 curl 超时断开就把 MiMo 熔断了，而 MiMo 当时已恢复）。
                // 真正卡住的上游由 TTFB 超时判成 upstream_timeout，那条照常计数。
                if (!outcome.clientAborted) {
                    this.deps.pool.noteFailure(routed.entry, card.failure_reason, isFatal(card.failure_reason), {
                        // 请求级归因（内容过滤/参数非法/模型级 403/404 等）不构成上游健康证据，
                        // 不能让它把整个 provider 熔断（实测一条违规请求曾把全网关无关模型打成 503）。
                        countsTowardBreaker: countsTowardUpstreamHealth(card.failure_reason),
                    });
                    this.keyFeatures.observeFailure(auth.identity.keyId);
                }
                trace.fail('classify', `${card.failure_reason} → ${card.suggested_next.action}`, {
                    provider: routed.decision.providerId,
                    recoverable: card.recoverable,
                    autoRetry: autoRetryable,
                    confidence: card.confidence,
                });
                const fatalReason = isFatal(card.failure_reason);
                tried.add(routed.decision.providerId);
                if (fatalReason)
                    fatal.add(routed.decision.providerId);
                /* 分支一：同一模型再来一次（换供应商优先，其次才是同一供应商） */
                const canRetrySameModel = autoRetryable && !fatalReason && sameModelRetries < maxSameModelRetries;
                if (canRetrySameModel) {
                    sameModelRetries++;
                    const delay = card.suggested_next.retryAfterMs ?? backoffDelay(attempt, this.lr.attribution.backoffBaseMs, this.lr.attribution.backoffMaxMs);
                    const capped = Math.min(delay, ttfbTimeoutMs, this.lr.attribution.backoffMaxMs);
                    trace.step('retry', true, `同模型第 ${sameModelRetries + 1} 次尝试将在 ${capped}ms 后发起`, {
                        delayMs: capped,
                        reason: card.failure_reason,
                    });
                    await sleepUnlessAborted(capped, req.signal).catch(() => undefined);
                    if (req.signal.aborted)
                        break;
                    continue;
                }
                /* 分支二：走不动了 → 沿阶梯换模型（竖向）。
                 * 只有"值得换模型"的失败才换：请求本身非法（内容过滤、参数错）换谁都没用，
                 * 那类直接返回，让客户改请求，而不是拿他的请求去试遍所有模型。 */
                const switchable = LADDER_SWITCH_REASONS.has(card.failure_reason) && ladderIndex + 1 < ladder.length;
                if (switchable) {
                    const fromModel = targetModel;
                    ladderIndex++;
                    sameModelRetries = 0;
                    tried.clear(); // 尝试级集合：换阶必须清，否则下一阶的供应商会被全部排除
                    const delay = Math.min(card.suggested_next.retryAfterMs ?? this.lr.attribution.backoffBaseMs, this.lr.attribution.backoffMaxMs);
                    trace.step('retry', true, `阶梯推进：${fromModel} → ${ladder[ladderIndex]}（因 ${card.failure_reason}）`, {
                        delayMs: delay,
                        reason: card.failure_reason,
                        fatal: fatalReason,
                    });
                    await sleepUnlessAborted(delay, req.signal).catch(() => undefined);
                    if (req.signal.aborted)
                        break;
                    continue;
                }
                /* 阶梯已到最后一阶：只有"可重试"的瞬态错误才值得再来一次；
                 * 致命错误（401/余额）和请求级错误立即返回，省掉一次白跑的往返。 */
                if (autoRetryable) {
                    const delay = Math.min(card.suggested_next.retryAfterMs ?? this.lr.attribution.backoffBaseMs, this.lr.attribution.backoffMaxMs);
                    trace.step('retry', true, `阶梯耗尽（第 ${ladderIndex + 1}/${ladder.length} 阶），${delay}ms 后重试当前模型`, {
                        delayMs: delay,
                        reason: card.failure_reason,
                    });
                    tried.clear();
                    await sleepUnlessAborted(delay, req.signal).catch(() => undefined);
                    if (req.signal.aborted)
                        break;
                    continue;
                }
                if (outcome.clientAborted) {
                    ctx.outcome = 'aborted';
                    ctx.attribution = this.presenter.abortedCard(routed.decision.providerId);
                    ctx.durationMs = Math.round(monotonicMs() - startedMono);
                    ctx.httpStatus = 499;
                    return this.finishJson(ctx, trace, auth, {
                        kind: 'json',
                        status: 499,
                        body: this.presenter.errorBody('relay_internal_error', '客户端已断开，上游调用已中止', {}, ctx.attribution, auth.policy),
                        headers: {},
                    });
                }
                // 不可自动恢复 → 立即返回（不浪费客户端时间）
                break;
            }
            /* ---------- 全部尝试失败 ---------- */
            const failure = lastFailure;
            if (!failure) {
                /* 一个上游请求都没发出去：要么整个阶梯都不可达（lastNoRoute），
                 * 要么配置本身有问题。前者是可归因的正常结果，不该报成 500。 */
                if (lastNoRoute) {
                    const card = this.noRouteCard(lastNoRoute);
                    // 状态码必须与"可恢复性"同义：凭据/余额类根因是**不可恢复**的，
                    // 回 503 会让客户端按"暂时不可用"退避重试一个永不成功的请求（ADR 明确禁止）。
                    const status = noRouteStatus(card);
                    ctx.attribution = card;
                    ctx.outcome = 'client_error';
                    ctx.httpStatus = status;
                    ctx.durationMs = Math.round(monotonicMs() - startedMono);
                    trace.fail('route', `档位阶梯全部不可达：${card.message}`, {
                        ladder: ladder.join('|'),
                        rejected: lastNoRoute.rejected.map((r) => `${r.providerId}:${r.why}`).join(','),
                    });
                    return this.finishJson(ctx, trace, auth, {
                        kind: 'json',
                        status,
                        body: this.presenter.errorBody(this.presenter.errorCodeFor(card), card.message, { code: card.failure_reason, param: 'model' }, card, auth.policy, {
                            no_route: true,
                            no_route_kind: lastNoRoute.kind,
                            declared_providers: lastNoRoute.declared.join(','),
                            root_cause: lastNoRoute.rootCause ?? '',
                            ladder: ladder.join(' -> '),
                            rejected: lastNoRoute.rejected.map((r) => `${r.providerId}: ${r.why}`),
                        }),
                        headers: this.presenter.attributionHeaders(card, auth.policy),
                    });
                }
                ctx.outcome = 'relay_error';
                ctx.durationMs = Math.round(monotonicMs() - startedMono);
                return this.finishJson(ctx, trace, auth, {
                    kind: 'json',
                    status: 500,
                    body: this.presenter.errorBody('relay_internal_error', '未产生任何上游尝试记录（内部状态异常）', {}, undefined, auth.policy),
                    headers: {},
                });
            }
            // lastFailure 只在 error 分支被赋值；这里显式收窄类型
            const lastErr = lastFailure?.outcome.kind === 'error' ? lastFailure.outcome : undefined;
            ctx.attribution = failure.card;
            ctx.outcome = lastErr?.clientAborted ? 'aborted' : 'upstream_error';
            const status = lastErr?.httpStatus ?? ERROR_STATUS.upstream_error;
            ctx.httpStatus = lastErr?.clientAborted ? 499 : status;
            ctx.durationMs = Math.round(monotonicMs() - startedMono);
            if (lastErr) {
                // 上游错误体：保留原文与 code，但补齐 OpenAI error schema 的必填字段
                // （研究 02 结论 A：GLM 缺 type/param、SiliconFlow 无 error 包裹层、
                //  OpenRouter 的 code 是数字 —— 不补齐会让严格解码器直接崩）
                const passthrough = this.upstreamErrorPassthrough(lastErr, this.presenter.errorCodeFor(failure.card), auth.policy, failure.card);
                const headers = {
                    ...this.presenter.attributionHeaders(failure.card, auth.policy),
                };
                if (lastErr.headers?.['retry-after'])
                    headers['retry-after'] = lastErr.headers['retry-after'];
                if (lastErr.headers?.['x-ratelimit-remaining-requests']) {
                    headers['x-ratelimit-remaining-requests'] = lastErr.headers['x-ratelimit-remaining-requests'];
                }
                if (passthrough) {
                    return this.finishJson(ctx, trace, auth, {
                        kind: 'json',
                        status: ctx.httpStatus,
                        body: passthrough,
                        headers,
                    });
                }
            }
            return this.finishJson(ctx, trace, auth, {
                kind: 'json',
                status: ctx.httpStatus,
                body: this.presenter.errorBody(this.presenter.errorCodeFor(failure.card), failure.card.message, { code: failure.card.failure_reason }, failure.card, auth.policy),
                headers: this.presenter.attributionHeaders(failure.card, auth.policy),
            });
        }
        finally {
            // S1-2：流式成功路径的释放责任已移交 onEnd（releaseDelegated=true），
            // finally 兜底只负责"没有走到移交"的一切路径（错误/非流式/异常抛出）。
            if (!releaseDelegated)
                release();
        }
    }
    /* ============================ 档位阶梯 ============================ */
    /**
     * 解析档位阶梯（竖向）：把请求的模型名展开成"按顺序尝试的模型列表"。
     *
     * 两件事同时做：
     * 1. 读 modelLadders 配置；没配就是单元素 [requestedModel]，行为与以前完全一致。
     * 2. **按能力过滤**——这是切模型的安全前提：
     *    · 请求带 tools 时，跳过声明 tools:false 的模型（切过去整个任务会废）
     *    · 预估输入 token 超过某模型 contextWindow 时，跳过它
     *    过滤后如果空了，就退回未过滤的原始阶梯（宁可试，也不要因为漏配能力而拒绝服务）。
     */
    resolveLadder(requestedModel, body, isToolCalling) {
        // ownLookup 而非 modelLadders?.[requestedModel]：requestedModel 直接来自请求体的
        // model 字段（**公开 API 可达**）。中招实录（2026-10-02 实测）：
        //   model=constructor  → modelLadders['constructor'] 命中 Object 构造函数，
        //     `.length` 是 1（>0 成立），`[...configured]` 展开函数抛
        //     TypeError: configured is not iterable → 客户端拿到 **HTTP 500**
        //   model=toString/valueOf → 404 报文把 "function toString() { [native code] }"
        //     泄漏给客户端
        //   model=__proto__    → 404 报文泄漏 "[object Object]"
        const configured = ownLookup(this.deps.config.modelLadders, requestedModel);
        let raw = configured && configured.length > 0 ? [...configured] : [requestedModel];
        /* ---------- 精确模型名的阶梯补齐（否则竖向兜底对点名请求完全失效） ----------
         *
         * resolveLadder 原本只认「阶梯名」：客户直接点名某个具体模型时，阶梯退化成
         * [该模型] 单阶，于是 maxAttempts = 1 × (1+autoRetry) = 2 —— 只剩两次**横向**
         * 尝试（换供应商），竖向换模型的兜底一步都走不了。后果恰是本函数头顶注释里
         * 明令要避免的那件事：「把错误丢回去」。
         *
         * 实测（2026-10-02）：客户点名 agnes-2.0-flash（Agnes 免费档限流极低）→
         * agnes-cn 429 → autoRetry 重试到 agnes → 也 429 → 429 原样回给客户。
         * 而同厂商的 agnes-2.5-flash / agnes-3.0-flash 当时完全正常（HTTP 200），
         * 且运营已在 modelLadders 里把这三者声明为同属「极速」档、可互换
         * （2.0-flash 还是该档首选）。DB 里 09-14 有真实客户 30 秒内连吃 3 个 429。
         * 横向兜底其实是生效的（成功记录里也有 attempt=2），只是两个 Agnes 节点
         * 属于同一免费档、会同时被限流，此时唯一的活路就是竖向换模型。
         *
         * 补齐规则（保守，不动客户点名那个模型的地位）：
         *   ① 只在该模型已被某个阶梯声明时补齐 —— 没被声明说明运营没标等价关系，不擅自替换
         *   ② 只追加**排在其后**的同档模型 —— 客户点名的模型永远占第一阶，先试它
         *   ③ 跨多个阶梯都出现时取并集；**同厂姊妹优先**，跨厂商兜底排在最后
         *      （同厂 = 模型名第一个 '-' 之前那段相同，计价/特性/上下文都更接近原模型）
         * 例：agnes-2.0-flash ∈ 旗舰[第3阶] ∪ 平衡[第2阶] ∪ 极速[第1阶]
         *     → [2.0-flash, 2.5-flash, 3.0-flash, mimo-v2.6-flash]
         *     （若只按 YAML 键序收集，会先收进 旗舰 里的 mimo-v2.6-flash，
         *       变成 [2.0-flash, mimo-v2.6-flash, 3.0-flash, 2.5-flash] —— 同厂姊妹
         *       反而排在跨厂商后面，客户被悄悄换到另一个计价体系的模型。）
         * 规则②同时保证 flash 不会被换成更贵的 pro（mimo-极速里 pro 排在 flash 之前），
         * 只会往运营排序里更次的等价档走。
         */
        if (!configured && this.lr.attribution.siblingModelFallback) {
            const sameFamily = [];
            const otherFamily = [];
            // 同厂 = 模型名第一个 '-' 之前的那段相同（agnes-2.0-flash / agnes-2.5-flash 同为 'agnes'）。
            // 同厂姊妹排在前面：计价、模型特性、上下文窗口都更接近客户点名的那个模型；
            // 跨厂商（agnes → mimo）只该在同厂全限流时才用。
            const family = (m) => m.split('-')[0] ?? m;
            for (const steps of Object.values(this.deps.config.modelLadders ?? {})) {
                const at = steps.indexOf(requestedModel);
                if (at < 0)
                    continue;
                for (const m of steps.slice(at + 1)) {
                    const bucket = family(m) === family(requestedModel) ? sameFamily : otherFamily;
                    if (!bucket.includes(m))
                        bucket.push(m);
                }
            }
            const siblings = [...sameFamily, ...otherFamily];
            if (siblings.length > 0)
                raw = [requestedModel, ...siblings];
        }
        // 去重但保序
        const seen = new Set();
        const ladder = raw.filter((m) => (seen.has(m) ? false : (seen.add(m), true)));
        const caps = this.deps.config.modelCapabilities ?? {};
        const estTokens = estimateJsonTokens(body['messages']) + estimateJsonTokens(body['tools']);
        const usable = ladder.filter((m) => {
            // ownLookup 而非 caps[m]：后者在 m 为 'constructor'/'toString' 等时会命中
            // Object.prototype，把「未声明能力」误判成「声明了」——于是约束被静默绕过。
            const cap = ownLookup(caps, m);
            if (!cap)
                return true; // 未声明 = 未知，允许（宁可试）
            if (isToolCalling && cap.tools === false)
                return false;
            if (cap.contextWindow !== undefined && estTokens > cap.contextWindow)
                return false;
            return true;
        });
        return usable.length > 0 ? usable : ladder;
    }
    /* ============================ 内部工具 ============================ */
    parseBody(raw) {
        if (raw.byteLength === 0)
            return { ok: true, body: {} };
        try {
            const text = new TextDecoder('utf-8').decode(raw);
            const parsed = JSON.parse(text);
            if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
                return { ok: false, message: '请求体必须是 JSON 对象' };
            }
            return { ok: true, body: parsed };
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { ok: false, message: `请求体不是合法 JSON：${truncate(msg, 200)}` };
        }
    }
    normalizeEndpoint(path) {
        const p = path.replace(/\/+$/, '');
        if (p.endsWith('/chat/completions'))
            return '/v1/chat/completions';
        if (p.endsWith('/embeddings'))
            return '/v1/embeddings';
        if (p.endsWith('/completions'))
            return '/v1/completions';
        if (p.endsWith('/responses'))
            return '/v1/responses';
        if (p.endsWith('/messages'))
            return '/v1/messages';
        return p;
    }
    upstreamPath(endpoint, _upstreamModel) {
        const p = endpoint.replace(/\/+$/, '');
        const known = ['/chat/completions', '/embeddings', '/completions', '/responses', '/messages', '/models'];
        for (const suffix of known) {
            if (p.endsWith(suffix))
                return suffix;
        }
        return p.startsWith('/v1/') ? p.slice(3) : p;
    }
    /** 只改 model 字段（别名/上游映射），其余字段原样保留 */
    rewriteUpstreamBody(body, upstreamModel) {
        if (body['model'] === upstreamModel)
            return body;
        return { ...body, model: upstreamModel };
    }
    /**
     * 流式请求注入 `stream_options:{include_usage:true}`。
     *
     * 为什么必须做：OpenAI 兼容接口**默认不在流式响应里回 usage**，只有显式要求才回。
     * 不注入的后果不是"少记几个数"，而是**整条流式流量记成 0 token** ——
     * 2026-09-14 实测：375 个流式请求 prompt/completion/total 全是 0，
     * 客户在别处已经消耗了上千万 token，我们面板只显示 11 万。
     *
     * 客户**自己**要过 usage 时（`include_usage:true`）不注入、也不滤帧 —— 那是它的权利。
     * 返回的 `injected` 会一路传到上游客户端，用来把多出来的那一帧滤掉。
     *
     * 已实测四个上游都接受这个字段：Agnes 国内/国际、MiMo、TokenRhythm。
     */
    withStreamUsage(body, stream) {
        if (!stream)
            return { body, injected: false };
        const existing = body['stream_options'];
        const current = existing !== null && typeof existing === 'object' && !Array.isArray(existing)
            ? existing
            : {};
        if (current['include_usage'] === true)
            return { body, injected: false };
        return { body: { ...body, stream_options: { ...current, include_usage: true } }, injected: true };
    }
    fingerprintOf(body, headers, features, keyId) {
        try {
            const fp = computeFingerprint({
                body,
                headers,
                requests60s: features.requests60s,
                distinctSystemPrompts5m: features.distinctSystemPrompts5m,
                retries10m: features.failures10m,
                salt: this.lr.meter.hashSalt,
            });
            if (fp.features.systemPromptHash) {
                // 短窗口内不同 system prompt 的数量是"多会话 Agent"的强特征
                this.keyFeatures.observeSystemPrompt(keyId, fp.features.systemPromptHash, Date.now());
            }
            return fp;
        }
        catch {
            return {
                kind: 'unknown',
                agentScore: 0,
                features: {
                    hasToolCalls: false,
                    hasTools: false,
                    multiTurn: false,
                    roleAlternation: 0,
                    systemPromptHash: '',
                    streamRequested: body['stream'] === true,
                    jsonMode: false,
                },
                ruleVersion: 0,
            };
        }
    }
    /**
     * 取"这个上游的**这个型号**"的单价：先查 `modelCosts`（键为上游真实型号），再回退厂商级 `cost`。
     *
     * 为什么需要：`cost` 挂在厂商上，但同厂不同型号单价可能差十几倍甚至一边免费。
     * 2026-09-14 实测 Agnes 官方定价：`agnes-3.0-flash`/`agnes-2.5-flash` 当前限时 $0，
     * 而 `agnes-2.5-pro` 是 $0.45/$0.90 —— 只有一个厂商级价目时，"上游成本"必然算错。
     */
    costFor(provider, upstreamModel) {
        if (!provider)
            return undefined;
        // ownLookup：upstreamModel 源自请求的 model 字段。原型链键（constructor 等）会让
        // `provider.modelCosts?.[m]` 命中 Object.prototype 而拿到函数，本该回落到
        // provider.cost 的分支被跳过，成本核算随之算错（静默错账，比报错更难发现）。
        return ownLookup(provider.modelCosts, upstreamModel) ?? provider.cost;
    }
    /** 取**刊例价**（牌面价）：按型号覆盖优先，其次厂商级；没配就是 undefined（由 withCost 回落到实付价）。 */
    listCostFor(provider, upstreamModel) {
        if (!provider)
            return undefined;
        // ownLookup：同 costFor，upstreamModel 源自请求的 model 字段。
        return ownLookup(provider.modelListCosts, upstreamModel) ?? provider.listCost;
    }
    /**
     * 打上两个口径的金额：
     *   · `costCny`     —— **实付**（当前有效价，含限时优惠），额度与毛利看它
     *   · `listCostCny` —— **按刊例价折算**（牌面价），对外报价对比看它
     * 没配刊例价时，牌面价取实付价（而不是留空），保证这一列永远有值可比。
     */
    withCost(usage, cost, listCost) {
        if (!usage)
            return undefined;
        const out = { ...usage };
        if (cost)
            out.costCny = computeCost(usage, cost);
        const listTable = listCost ?? cost;
        if (listTable)
            out.listCostCny = computeCost(usage, listTable);
        return out;
    }
    /**
     * 上游错误体透传：保留上游原文与 code，但补齐 OpenAI error schema 的必填字段，
     * 并按分层策略附加归因。这是"我只是管道 + 我让错误可执行"两条承诺的交汇点：
     * - message / code 一律以**上游原文**为准（绝不替换成我们的话术）
     * - 只在缺失时补齐 `type` 与 `param`（GLM 缺 type/param、SiliconFlow 无 error 包裹层）
     * - 归因只作为**附加**字段/响应头出现
     */
    upstreamErrorPassthrough(outcome, mappedCode, policy, card) {
        if (!outcome.bodyText)
            return undefined;
        let parsed;
        try {
            parsed = JSON.parse(outcome.bodyText);
        }
        catch {
            return undefined;
        }
        if (!parsed || typeof parsed !== 'object')
            return undefined;
        const rawErr = parsed['error'];
        // 形态一：标准 OpenAI（含 DeepSeek / DashScope 兼容模式）
        if (rawErr && typeof rawErr === 'object' && !Array.isArray(rawErr)) {
            const err = rawErr;
            const message = typeof err['message'] === 'string' ? err['message'] : card.message;
            const body = {
                error: {
                    message,
                    type: typeof err['type'] === 'string' ? err['type'] : mappedCode,
                    param: err['param'] ?? null,
                    // 审查修复（缺点#3）：上游 code 可能是数字（OpenRouter）——OpenAI 契约要求
                    // string|null，直接透传数字会让严格解码器崩（文件头研究结论已注明却未落实到 code）。
                    code: asErrorCode(err['code'], card.failure_reason),
                    ...(err['relay_details'] ? { relay_details: err['relay_details'] } : {}),
                },
            };
            return JSON.stringify(this.presenter.applyAttribution(body, card, policy));
        }
        // 形态二：无 error 包裹层（SiliconFlow / 部分自研上游）：{"code":20012,"message":"..."}
        // 形态三：字符串型 error（{"error":"..."}）
        if (typeof rawErr === 'string') {
            const body = { error: { message: rawErr, type: mappedCode, param: null, code: card.failure_reason } };
            return JSON.stringify(this.presenter.applyAttribution(body, card, policy));
        }
        if (typeof parsed['message'] === 'string' || parsed['code'] !== undefined) {
            const body = {
                error: {
                    message: typeof parsed['message'] === 'string' ? parsed['message'] : card.message,
                    type: mappedCode,
                    param: null,
                    // 审查修复（缺点#3）：同形态一，数字 code 规范化为字符串再透传。
                    code: asErrorCode(parsed['code'], card.failure_reason),
                    relay_details: { upstream_raw: parsed },
                },
            };
            return JSON.stringify(this.presenter.applyAttribution(body, card, policy));
        }
        return undefined;
    }
    /**
     * 为"对冲"选一条**同模型**的备线路（与主线路不同的上游）。
     *
     * 只接受 upstreamModel 与主线路完全相同的候选 —— 语义必须等价，否则宁可不对冲
     * （别名解析到不同真身模型时，不能拿"另一个模型"的结果糊弄客户）。
     */
    routeHedgeCandidate(targetModel, fatal, tried, tier, complexity, clientKind, primary) {
        try {
            const alt = this.deps.router.route({
                requestedModel: targetModel,
                exclude: new Set([...fatal, primary.providerId]),
                tried: new Set([...tried, primary.providerId]),
                deprioritize: new Set([...tried, primary.providerId]),
                tier,
                clientKind,
                complexity,
            });
            return alt.decision.upstreamModel === primary.upstreamModel ? alt : undefined;
        }
        catch {
            // 没有第二个可用候选（NoRouteError）→ 不对冲
            return undefined;
        }
    }
    /**
     * 竞速：主线路 +（可选）对冲线路，**谁先拿到成功响应用谁**，另一条立即中止。
     *
     * - 主线路在 hedgeDelayMs 内就成功或失败 → 直接返回，与旧行为完全一致
     *   （失败交给上层重试/换阶，不会因为对冲而多等）。
     * - 宽限到点主线路仍未回 → 并发备线路；备线路先成功就用它并中止主线路；
     *   两条都失败则返回主线路的失败（上层只按一次失败归因）。
     *
     * 被中止的那条是**我们主动放弃**，不是上游故障，所以调用方不要给它记熔断。
     */
    async sendWithHedge(primaryRun, hedgeRun, delayMs, parentSignal) {
        const primaryCtrl = new AbortController();
        const primarySignal = AbortSignal.any([parentSignal, primaryCtrl.signal]);
        let hedgeCtrl;
        return await new Promise((resolve) => {
            let done = false;
            let hedgeStarted = false;
            let hedgeSettled = false;
            let primaryResult;
            let hedgeResult;
            let timer;
            let failGraceTimer;
            // 被丢弃的那条若已拿到响应流（passthrough），必须显式销毁上游流与度量支，
            // 否则 abort 传不下去、我们继续为丢弃的结果付费（审计 P1-2）。
            const cleanupLoser = (r) => {
                if (r.outcome.kind === 'passthrough') {
                    try {
                        r.outcome.response.abort();
                    }
                    catch {
                        /* ignore */
                    }
                }
            };
            const finish = (winner, loser) => {
                if (done)
                    return;
                done = true;
                if (timer)
                    clearTimeout(timer);
                if (failGraceTimer)
                    clearTimeout(failGraceTimer);
                const loserCtrl = loser === 'hedge' ? hedgeCtrl : loser === 'primary' ? primaryCtrl : undefined;
                if (loserCtrl && !loserCtrl.signal.aborted)
                    loserCtrl.abort();
                const loserRes = loser === 'hedge' ? hedgeResult : loser === 'primary' ? primaryResult : undefined;
                if (loserRes)
                    cleanupLoser(loserRes);
                resolve({ winner, ...(loserRes ? { loser: loserRes } : {}) });
            };
            void primaryRun(primarySignal).then((r) => {
                if (done) {
                    cleanupLoser(r);
                    return;
                }
                primaryResult = r;
                if (isSuccessOutcome(r.outcome)) {
                    finish(r, 'hedge');
                    return;
                }
                // 主线路在宽限内失败、对冲还没开始 → 保持旧行为，让上层重试/换阶
                if (!hedgeStarted) {
                    finish(r);
                    return;
                }
                // 主线路在**对冲已开始之后**才真实失败：给对冲一个额外小宽限，超时就按主失败
                // 返回，不能因为等对冲把失败路径拖到上游 TTFB 超时（审计 P2-4）。
                if (hedgeSettled) {
                    finish(r, 'hedge');
                    return;
                }
                failGraceTimer = setTimeout(() => finish(r, 'hedge'), HEDGE_FAILURE_GRACE_MS);
                failGraceTimer.unref();
            });
            if (!hedgeRun)
                return;
            timer = setTimeout(() => {
                if (done)
                    return;
                if (parentSignal.aborted)
                    return;
                hedgeStarted = true;
                hedgeCtrl = new AbortController();
                const hedgeSignal = AbortSignal.any([parentSignal, hedgeCtrl.signal]);
                void hedgeRun(hedgeSignal).then((r) => {
                    if (done) {
                        cleanupLoser(r);
                        return;
                    }
                    hedgeResult = r;
                    hedgeSettled = true;
                    if (isSuccessOutcome(r.outcome)) {
                        finish(r, 'primary');
                        return;
                    }
                    // 对冲也失败：主线路已失败就回主失败；主线路还在跑就等它
                    if (primaryResult)
                        finish(primaryResult, 'hedge');
                });
            }, delayMs);
            timer.unref();
        });
    }
    buildStreamResult(ctx, trace, auth, outcome, decision, release) {
        const passthrough = outcome.response;
        const headers = {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache, no-transform',
            connection: 'keep-alive',
            'x-accel-buffering': 'no',
            ...passthrough.headers,
            ...this.presenter.modeHeader(ctx, auth.policy),
            // G2/G5：额度余量 + 近限告警（仅当该 key 配了帽）
            ...this.presenter.quotaHeaders(auth.quota),
        };
        if (auth.policy.attribution === 'header') {
            headers['x-relay-loss-reduction'] = `precheck=${auth.policy.precheck};attribution=header${this.deps.config.server.hideUpstream ? '' : `;provider=${decision.providerId}`}`;
        }
        else if (auth.policy.attribution === 'full') {
            headers['x-relay-loss-reduction'] = `precheck=${auth.policy.precheck};attribution=full${this.deps.config.server.hideUpstream ? '' : `;provider=${decision.providerId}`}`;
        }
        const ttfbMs = passthrough.ttfbMs;
        // 模型名回显修正：上游会把别名解析成真实模型名回显，严格客户端（判别联合/严格解码器）
        // 会因 model 不匹配而崩。仅当两者不同才做逐帧改写，且只改 model 一个字段。
        const needsModelRewrite = ctx.requestedModel !== '' &&
            (this.deps.config.server.hideUpstream || ctx.requestedModel !== decision.upstreamModel);
        const clientStream = needsModelRewrite ? rewriteSseModel(passthrough.stream, ctx.requestedModel) : passthrough.stream;
        // REQ-03（批次4）：按分层预构造「中途失败帧」——free(off)=不注入；standard/pro=注入。
        // 仅在失败路径由 server.writeStream 写出；正常结束路径完全不受影响（红线 1）。
        const midStreamErrorFrame = auth.policy.attribution === 'off'
            ? undefined
            : buildStreamErrorFrame({
                reason: 'stream_interrupted',
                message: '上游在流式响应中途中断',
                recoverable: true,
                suggestedAction: 'retry_same',
                ...(auth.policy.attribution === 'full' && !this.deps.config.server.hideUpstream ? { upstream: decision.providerId } : {}),
            });
        if (needsModelRewrite) {
            trace.step('stream', true, `模型名回显改写：${decision.upstreamModel} → ${ctx.requestedModel}`, {
                upstreamModel: decision.upstreamModel,
                requestedModel: ctx.requestedModel,
            });
        }
        let bytesOut = ctx.bytesIn;
        const onEnd = (info) => {
            bytesOut = info.bytes;
            ctx.bytesOut = bytesOut;
            ctx.durationMs = Math.round(monotonicMs() - ctx.startedMono);
            ctx.ttfbMs = ttfbMs;
            if (info.aborted) {
                ctx.outcome = 'aborted';
                ctx.attribution = {
                    failure_reason: 'stream_interrupted',
                    message: '客户端在流式响应完成前断开连接',
                    suggested_next: { action: 'retry_same' },
                    recoverable: true,
                    upstream: decision.providerId,
                    confidence: 1,
                };
            }
            else {
                ctx.outcome = 'success';
            }
            // P8 度量（流式在结束后记账）
            this.recordMeter(ctx, trace);
            release();
        };
        // 流式 usage：多数上游在最后一个 chunk 给出 usage，但引擎已经返回了，
        // 因此我们通过 transcript 回调在流结束时补齐 token 计数。
        const originalOnEnd = onEnd;
        return {
            kind: 'stream',
            status: passthrough.status,
            headers,
            stream: clientStream,
            ...(midStreamErrorFrame ? { midStreamErrorFrame } : {}),
            ttfbMs,
            // REQ-03：流完整性判据——上游中途断连在 undici 下表现为 done（静默），
            // server 必须靠 tee 旁路解析出的 sawDone 判定「是否见到 [DONE]」。
            isStreamComplete: async () => {
                const t = await passthrough.transcriptDone;
                return t.sawDone;
            },
            // 从**请求起点**起算的整体上限（含前面的重试/换路）。server 到点截断。
            // startedAt 不在本作用域（在外层 handle 的更窄作用域里），用 ctx.startedMono 换算：
            //   deadline = 现在 + 上限 - 已流逝   （时长运算与时钟无关，两种时钟混用没问题）
            deadlineAt: Date.now() +
                (this.deps.config.server.upstreamTimeoutMs ?? 300_000) -
                Math.round(monotonicMs() - ctx.startedMono),
            onEnd: async (info) => {
                // ⚠️ 必须 await 旁路那一支解析完，不能直接读 passthrough.transcript()。
                // 两个 tee 分支各跑各的：客户端那支读完时，旁路可能还在解析 ——
                // 此时 transcript 是空壳，usage 拿不到、连"按字符估算"的兜底也进不去，
                // 流式 token 会整段记成 0（2026-09-14 实测 375 条流式请求全为 0）。
                const transcript = await passthrough.transcriptDone;
                if (transcript.usage) {
                    // ⚠️ 这里**不能**再调 normalizeUsage()：transcript 里的 usage 已经由
                    // transcriptFromSse 归一化成驼峰字段（promptTokens/…），而 normalizeUsage
                    // 只认上游原始的下划线字段（prompt_tokens/…）。二次归一化会把 59 个 token
                    // 洗成 0 并因全零返回 undefined —— 流式计量就是这样被静默清零的。
                    ctx.usage = this.withCost(transcript.usage, this.costFor(this.deps.pool.get(decision.providerId)?.config, decision.upstreamModel), this.listCostFor(this.deps.pool.get(decision.providerId)?.config, decision.upstreamModel));
                }
                else if (transcript.contentChars > 0 || transcript.reasoningChars > 0) {
                    // 上游没给 usage（部分兼容实现）：按体积估算。
                    // ⚠️ prompt 这一侧必须用 estimateTokensFromBytes（payloadBytes 是**数字**）——
                    // 用 estimateJsonTokens 会把它 stringify 成 "586000" 再估，得 2，少 4 个数量级。
                    const approxIn = estimateTokensFromBytes(ctx.payloadBytes);
                    const approxOut = Math.ceil((transcript.contentChars + transcript.reasoningChars) / 2);
                    ctx.usage = this.withCost({ promptTokens: approxIn, completionTokens: approxOut, totalTokens: approxIn + approxOut }, this.costFor(this.deps.pool.get(decision.providerId)?.config, decision.upstreamModel), this.listCostFor(this.deps.pool.get(decision.providerId)?.config, decision.upstreamModel));
                }
                if (transcript.toolCalls && transcript.toolCalls.length > 0) {
                    ctx.isToolCalling = true;
                }
                trace.step('stream', true, `符号态重建：chunk=${transcript.chunkCount} 内容=${transcript.contentChars}字 工具调用=${transcript.toolCalls?.length ?? 0} 畸形帧=${transcript.malformedFrames}`, {
                    chunks: transcript.chunkCount,
                    malformed: transcript.malformedFrames,
                    sawDone: transcript.sawDone,
                    finishReason: transcript.finishReason ?? '',
                });
                originalOnEnd(info);
            },
        };
    }
    // 审查修复（缺点#5）：移除 `released` 死参数——三处调用全传 false、函数体只 `void released`。
    recordMeter(ctx, trace) {
        try {
            const t0 = monotonicUs();
            const dup = ctx.payloadHash ? this.duplicateObserver.observe(ctx.client.keyId, ctx.payloadHash, ctx.startedAt) : 1;
            ctx.overheadUs.meter = monotonicUs() - t0;
            this.deps.meter.record(ctx, ctx.fingerprint, dup);
            const record = trace.finish(ctx);
            this.deps.traceStore.save(record);
        }
        catch (err) {
            this.deps.logger.warn('meter.record_failed', { error: err instanceof Error ? err.message : String(err), requestId: ctx.requestId });
        }
    }
    /** 非流式/错误路径的统一收尾：度量 + 轨迹 + 释放并发 */
    finishJson(ctx, trace, auth, result) {
        ctx.durationMs = ctx.durationMs || Math.round(monotonicMs() - ctx.startedMono);
        if (result.status >= 400 && ctx.outcome === 'success')
            ctx.outcome = 'client_error';
        if (result.usage)
            ctx.usage = result.usage;
        ctx.httpStatus = result.status;
        ctx.bytesOut = typeof result.body === 'string' ? Buffer.byteLength(result.body, 'utf8') : ctx.bytesOut;
        trace.step('respond', result.status < 400, `HTTP ${result.status}`, { bytes: ctx.bytesOut, outcome: ctx.outcome });
        this.recordMeter(ctx, trace);
        return result;
    }
    /**
     * 无路由可用时的归因。
     *
     * 关键：**"上游全在熔断"和"没有上游支持这个模型"是两件完全不同的事**，
     * 前者是上游故障（去修上游/等冷却），后者才该换模型。如果把前者说成后者，
     * 用户会去改模型名，越改越错。
     */
    noRouteCard(err) {
        const breakers = err.openBreakers;
        const rootCause = err.rootCause;
        const evidence = err.rejected.map((r) => `${r.providerId}: ${r.why}`);
        /* 分支顺序 = 从"最具体的已知原因"到"最泛的未知原因"。
         * 唯一不能含糊的是最后那条：只要**有**上游声明支持这个模型，
         * 就绝不能说成"模型不存在"——那会让用户去改模型名，越改越错。 */
        // ① 真·模型不存在：一个声明它的上游都没有
        if (err.kind === 'model_unsupported') {
            return {
                failure_reason: 'model_not_found',
                message: `没有任何上游声明支持模型 ${err.requestedModel}（这是模型清单问题，不是上游故障）`,
                suggested_next: { action: 'switch_model' },
                recoverable: true,
                upstream: 'relay',
                confidence: 0.9,
                evidence,
            };
        }
        // ② 有上游，但全在熔断冷却中 → 上游故障，等冷却
        if (breakers.length > 0) {
            const detail = breakers
                .map((b) => `${b.providerId}（连续 ${b.consecutiveFailures} 次失败${b.lastFailureReason ? '，最近原因 ' + b.lastFailureReason : ''}）`)
                .join('、');
            const credentialProblem = rootCause === 'auth_invalid' || rootCause === 'permission_denied';
            const balanceProblem = rootCause === 'quota_exhausted';
            const permanent = credentialProblem || balanceProblem;
            const alsoDisabled = err.disabledCount > 0 ? `另有 ${err.disabledCount} 个上游被人工摘除。` : '';
            return {
                failure_reason: permanent ? rootCause : 'upstream_unavailable',
                message: `上游 ${detail} 正处于熔断冷却中，本次请求没有可用上游。` +
                    alsoDisabled +
                    (rootCause
                        ? `根因是上游侧的「${rootCause}」，与请求的模型名无关。`
                        : '这是上游侧的连续故障，与请求的模型名无关。'),
                suggested_next: permanent
                    ? { action: credentialProblem ? 'fix_credentials' : 'top_up_balance' }
                    : { action: 'retry_with_backoff', retryAfterMs: 30_000 },
                recoverable: !permanent,
                upstream: 'relay',
                confidence: 0.9,
                evidence,
            };
        }
        // ③ 有上游，但被人工摘除（运营动作）
        if (err.disabledCount > 0) {
            return {
                failure_reason: 'upstream_unavailable',
                message: `服务模型 ${err.requestedModel} 的上游都被人工摘除了（运营动作），请求无处可去`,
                suggested_next: { action: 'retry_with_backoff', retryAfterMs: 60_000 },
                recoverable: true,
                upstream: 'relay',
                confidence: 0.95,
                evidence,
            };
        }
        /* ④ 有上游声明支持，但全部在**本次请求内**被排除
         *    （典型：它们已经被判定为供应商级致命错误，所以后续阶不再选它们）。
         *    这里同样不许说成模型不存在。 */
        return {
            failure_reason: 'upstream_unavailable',
            message: `模型 ${err.requestedModel} 有 ${err.declared.length} 个上游声明支持，但它们在本请求内已被排除` +
                `（${err.rejected.map((r) => `${r.providerId}: ${r.why}`).join('；') || '原因未记录'}）。` +
                '这是请求级排除，不是模型不存在，也不是上游此刻故障。',
            suggested_next: { action: 'retry_with_backoff', retryAfterMs: 5_000 },
            recoverable: true,
            upstream: 'relay',
            confidence: 0.85,
            evidence,
        };
    }
    authErrorResponse(req, error, trace, startedMono, tier) {
        const status = authStatus(error.code);
        const suggestion = authFailureSuggestion(error);
        const card = {
            failure_reason: authReason(error.code),
            message: error.message,
            suggested_next: {
                action: suggestion.action,
                ...(suggestion.retryAfterMs !== undefined ? { retryAfterMs: suggestion.retryAfterMs } : {}),
            },
            recoverable: authRecoverable(error.code),
            upstream: 'relay',
            confidence: 1,
            ...(error.allowed ? { evidence: [`allowed_models=${error.allowed.join(',')}`] } : {}),
        };
        const body = {
            error: {
                message: error.message,
                // type 要与 code 同义：模型名写错不是"鉴权问题"，
                // 归到 authentication_error 会让人去查密钥（OpenAI 对未知模型也用 invalid_request_error）
                // 审查修复（缺点#2）：补上 too_many_concurrent —— authStatus 判它 429、
                // authReason 判它 rate_limited，唯独这里漏了，导致并发超限回 429 却标
                // type='authentication_error'：SDK 会按鉴权错误分发（不按限流退避），
                // 与 dashboard.ts:1299/1841 的文档、以及 authFailureSuggestion 直接矛盾。
                type: authErrorType(error.code),
                param: null,
                code: error.code,
                relay_attribution: {
                    failure_reason: card.failure_reason,
                    suggested_next: card.suggested_next,
                    recoverable: card.recoverable,
                    upstream: 'relay',
                    confidence: 1,
                },
            },
        };
        const headers = {
            'x-relay-attribution': `${card.failure_reason};next=${card.suggested_next.action};recoverable=${card.recoverable};upstream=relay`,
        };
        if (error.retryAfterMs !== undefined)
            headers['retry-after'] = String(Math.max(1, Math.ceil(error.retryAfterMs / 1000)));
        // 鉴权失败的度量：无 key 记录时用匿名身份，保证"未授权访问"也可见
        const ctx = {
            requestId: req.requestId,
            startedAt: Date.now(),
            startedMono: monotonicMs(),
            traceId: trace.traceId,
            method: req.method,
            path: req.path,
            client: {
                keyId: UNATTRIBUTED_KEY_ID,
                keyLabel: '未鉴权',
                // tier 只是为了让记录有个合法值；看板呈现时按 keyId===anonymous 统一改写成「(未鉴权)」，
                // 绝不能让这 202 条 401 冒充成"免费层的流量"。
                tier: tier ?? 'free',
                tenantId: 'anonymous',
            },
            fingerprint: {
                kind: 'unknown',
                agentScore: 0,
                features: {
                    hasToolCalls: false,
                    hasTools: false,
                    multiTurn: false,
                    roleAlternation: 0,
                    systemPromptHash: '',
                    streamRequested: false,
                    jsonMode: false,
                },
                ruleVersion: 0,
            },
            requestedModel: '',
            stream: false,
            payloadHash: '',
            payloadBytes: req.rawBody.byteLength,
            isToolCalling: false,
            routes: [],
            attribution: card,
            bytesIn: req.rawBody.byteLength,
            // 审查修复（缺点#4）：原为 JSON.stringify(body).length（**字符数**），含中文的错误体
            // 会少算字节；与 finishJson 的 Buffer.byteLength 口径对齐。
            bytesOut: Buffer.byteLength(JSON.stringify(body), 'utf8'),
            durationMs: Math.round(monotonicMs() - startedMono),
            overheadUs: { precheck: 0, classify: 0, meter: 0 },
            // 审查修复（缺点#6）：原为 `status === 429 ? 'client_error' : 'client_error'`——
            // 三元两分支恒等（死分支）。鉴权失败一律归 client_error，直接写死，去掉误导性条件。
            outcome: 'client_error',
            httpStatus: status,
        };
        this.recordMeter(ctx, trace);
        return { kind: 'json', status, body: JSON.stringify(body), headers };
    }
}
/**
 * 鉴权失败 → 对外 OpenAI 兼容 `error.type`。
 * 与 authStatus/authReason 同族的纯函数（审查修复·缺点#2 顺带抽出，便于单测覆盖）。
 * 关键：限流/并发超限必须映射到 rate_limit_error、与 HTTP 429 同义——
 * 否则 SDK 会按 authentication_error 分发（不按限流退避，甚至不重试）。
 */
export function authErrorType(code) {
    switch (code) {
        case 'rate_limited':
        case 'too_many_concurrent':
            return 'rate_limit_error';
        case 'quota_exhausted':
            return 'insufficient_quota';
        case 'model_not_found':
        case 'model_not_allowed':
            // 模型名写错不是"鉴权问题"：归到 authentication_error 会让人去查密钥
            //（OpenAI 对未知模型也用 invalid_request_error）
            return 'invalid_request_error';
        default:
            return 'authentication_error';
    }
}
function authStatus(code) {
    switch (code) {
        case 'rate_limited':
        case 'too_many_concurrent':
            return 429;
        case 'quota_exhausted':
            // 402 而非 429：余额/额度耗尽不可通过重试恢复，返 429 会触发 Agent 自动重试风暴
            return 402;
        case 'model_not_allowed':
            return 403;
        case 'model_not_found':
            // 404 而不是 403：这是"东西不存在"，不是"你没权限"。403 会让人去翻权限设置。
            return 404;
        case 'missing_key':
        case 'invalid_key':
        case 'expired_key':
        case 'key_disabled':
            return 401;
        default:
            return 500;
    }
}
function authReason(code) {
    switch (code) {
        case 'rate_limited':
        case 'too_many_concurrent':
            return 'rate_limited';
        case 'quota_exhausted':
            return 'quota_exhausted';
        case 'model_not_allowed':
            return 'permission_denied';
        case 'model_not_found':
            return 'model_not_found';
        case 'missing_key':
        case 'invalid_key':
        case 'expired_key':
        case 'key_disabled':
            return 'auth_invalid';
        default:
            return 'relay_internal_error';
    }
}
function authRecoverable(code) {
    return ['rate_limited', 'too_many_concurrent', 'model_not_allowed', 'model_not_found'].includes(code);
}
/**
 * 哪些失败值得沿档位阶梯换模型。
 *
 * 判据：**换一个模型有可能成功吗？**
 * - 值得换：上游侧/模型侧的问题——限流、过载、超时、网络、上游 5xx、模型没权限、
 *   模型不存在、密钥或余额问题（换个模型可能落在别的供应商上）、上下文超限（换个
 *   上下文更大的模型就成立）、无法归因（试下一阶比直接放弃合理）。
 * - 不值得换：请求本身的问题——内容过滤、参数非法、tool_calls 结构错、治理层自身错。
 *   换谁都会以同样方式失败，应该把错误返回给客户让他改请求，而不是拿他的请求试遍所有模型。
 */
const LADDER_SWITCH_REASONS = new Set([
    'rate_limited',
    'model_overloaded',
    'upstream_unavailable',
    'upstream_timeout',
    'network_error',
    'stream_interrupted',
    'permission_denied',
    'model_not_found',
    'auth_invalid',
    'quota_exhausted',
    'context_length_exceeded',
    'unknown',
]);
/**
 * 是否属于"重试不可能成功"的**供应商级**致命故障 → 立即熔断该上游、本次请求内不再选它。
 *
 * 为什么 `permission_denied`(403) 不在里面（实测教训）：
 * 403 绝大多数是**模型级**的——"这个 key 没开通这个模型"。实测 Agnes 的 key 调
 * `agnes-2.5-pro` 全系列返回 403，但 `agnes-*.flash` 正常。如果把 403 当成供应商级致命，
 * 那阶梯换到 pro 那一阶时就会把整个 provider 摘掉，后面所有台阶全部跳过 → 请求直接 503，
 * **一个模型没权限，把整个厂商都判死了**。
 *
 * 所以：401（密钥无效）和余额不足是供应商级；403 是模型级，只推进阶梯，不禁用供应商。
 */
function isFatal(reason) {
    return reason === 'auth_invalid' || reason === 'quota_exhausted';
}
/**
 * 无路由（请求一个上游都没发出去）时对外返回的状态码。
 *
 * 原则：**状态码要能独立表达"该不该重试"**，不能只靠响应体里的 suggestion。
 * - 凭据无效 / 无权限 → 401：用户要换 key，重试一万次也不会成功；
 * - 余额/配额耗尽 → 402：与 ADR「预算用尽必须 402 而不是 429」同一原则；
 * - 模型不存在 → 404：调用方改模型名；
 * - 其余（熔断冷却、被人工摘除、请求级排除）→ 503：等冷却或找运营。
 */
export function noRouteStatus(card) {
    switch (card.failure_reason) {
        case 'model_not_found':
            return 404;
        case 'auth_invalid':
        case 'permission_denied':
            return 401;
        case 'quota_exhausted':
            return 402;
        default:
            return 503;
    }
}
/**
 * 把上游 error.code 规范化为 OpenAI 契约要求的 **string**（数字 code 转字符串）。
 * 审查修复（缺点#3）：OpenRouter 等上游的 code 是数字，直接透传会破坏 code:string|null，
 * 严格客户端/解码器会因类型不符而崩。非字符串且非有限数字时回落到归因码。
 */
export function asErrorCode(v, fallback) {
    if (typeof v === 'string')
        return v;
    if (typeof v === 'number' && Number.isFinite(v))
        return String(v);
    return fallback;
}
function sleepUnlessAborted(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(new Error('aborted'));
            return;
        }
        const t = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(t);
            reject(new Error('aborted'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
    });
}
export { ERROR_STATUS };
//# sourceMappingURL=engine.js.map