/**
 * 客户端 SDK 薄封装（对接方案 §10.2 待补能力第一案）
 *
 * 把 P3 失败归因的 `retry_with_backoff` + `retryAfterMs` 变成一行调用：
 *
 * ```ts
 * const res = await autoRetry('https://relay.example/v1/chat/completions', {
 *   method: 'POST',
 *   headers: { authorization: 'Bearer sk-...', 'content-type': 'application/json' },
 *   body: JSON.stringify({ model: 'glm-4.7', messages: [{ role: 'user', content: '你好' }] }),
 * });
 * const data = await res.json();
 * ```
 *
 * 消费的归因契约（全部从网关源码核实，勿凭记忆改）：
 * - **pro 层（attribution=full）**：错误体 `error.relay_attribution` =
 *   `{ failure_reason, suggested_next: { action, retryAfterMs?, autoPerformed? },
 *      recoverable, upstream, confidence, evidence? }`
 *   （src/gateway/engine.ts `applyAttribution`，形状见 src/gateway/protocol.ts `OpenAIErrorBody`）
 * - **standard 层（attribution=header）**：`X-Relay-Attribution` 响应头，格式
 *   `<failure_reason>;next=<action>[;retry_after_ms=<ms>];recoverable=<true|false>;upstream=<providerId>`
 *   非 ASCII 值按 UTF-8 百分号编码（src/gateway/engine.ts `attributionHeaders` + `headerSafe`）
 * - **`Retry-After` 头**：整数秒。网关在"可恢复 + 有 retryAfterMs"的错误上附带
 *   （engine.ts `attributionHeaders`），"没有可用上游"的 503 也附带（DECISIONS.md ADR-013）。
 *   free 层虽然关掉归因，但 Retry-After 照发（它排在归因开关之前），所以本 SDK 对三层都可用。
 *
 * 重试判定与网关自身语义对齐（src/core/config.ts `lossReduction.attribution`）：
 * - 默认重试次数 = 1（`autoRetry` 默认值），退避基数 400ms、上限 8s、抖动 ×[0.75, 1.0)
 * - 默认可重试的 failure_reason = 网关 `retryableReasons` 六项（见 RETRYABLE_FAILURE_REASONS）
 * - 判定式：`recoverable === true && failure_reason ∈ retryableReasons`。
 *   注意 recoverable 单独为真**不代表**可重试（如 `permission_denied` 是"换模型"，
 *   `model_not_found` 是"改名字"），这与网关 engine.ts 的 autoRetryable 判定一致。
 *
 * 流式语义（与项目"流式只做字节转发"原则一致）：
 * - 2xx 响应**原样返回**，body 一字节不读 —— SSE 流式语义完整保留。
 * - 重试只发生在"拿到响应头之前"（429/5xx/网络错误都在这一层）。一旦开始回传流，
 *   字节已交付给调用方，中途断线**无法安全重试**，会以 body 读取异常的形式抛出。
 * - 非 2xx 的 body 会被 SDK 读取用于解析归因 —— 错误路径本就不存在"流式结果"，
 *   原文完整保留在 AutoRetryError.bodyText 上。
 *
 * 运行时零依赖：本文件不 import 任何运行时模块（连 node:* 都不需要），
 * 只用全局 fetch / AbortController / setTimeout，类型从仓库契约 `import type`。
 */
/** 默认可重试的 failure_reason —— 与网关 retryableReasons 默认值逐字对齐
 * （src/core/config.ts / src/app.ts）：限流/超时/5xx/网络/过载/流中断 */
export const RETRYABLE_FAILURE_REASONS = [
    'rate_limited',
    'upstream_timeout',
    'upstream_unavailable',
    'network_error',
    'model_overloaded',
    'stream_interrupted',
];
function normalizeOptions(opts) {
    return {
        maxRetries: Math.max(0, Math.floor(opts.maxRetries ?? 1)),
        backoffBaseMs: Math.max(1, opts.backoffBaseMs ?? 400),
        backoffMaxMs: Math.max(1, opts.backoffMaxMs ?? 8_000),
        maxWaitMs: Math.max(0, opts.maxWaitMs ?? 60_000),
        timeoutMs: Math.max(0, opts.timeoutMs ?? 0),
        retryableReasons: opts.retryableReasons ?? RETRYABLE_FAILURE_REASONS,
        fetchImpl: opts.fetchImpl ?? globalThis.fetch,
        sleep: opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
        ...(opts.onRetry ? { onRetry: opts.onRetry } : {}),
    };
}
/** 指数退避 + 抖动（与网关 backoffFor 同式：capped × [0.75, 1.0)）。attempt 为刚失败的尝试序号（1 起） */
function backoffDelayMs(attempt, baseMs, maxMs) {
    const capped = Math.min(baseMs * 2 ** Math.max(0, attempt - 1), maxMs);
    return Math.round(capped * 0.75 + Math.random() * capped * 0.25);
}
/** autoRetry 的统一失败出口：归因信息都在上面，客户端不需要解析上游错误文本 */
export class AutoRetryError extends Error {
    kind;
    status;
    failureReason;
    attribution;
    attempts;
    bodyText;
    response;
    retryAfterMs;
    retryBudgetExhausted;
    constructor(init) {
        super(init.message, init.cause !== undefined ? { cause: init.cause } : undefined);
        this.name = 'AutoRetryError';
        this.kind = init.kind;
        this.failureReason = init.failureReason;
        this.attempts = init.attempts;
        this.retryBudgetExhausted = init.retryBudgetExhausted ?? false;
        if (init.status !== undefined)
            this.status = init.status;
        if (init.attribution !== undefined)
            this.attribution = init.attribution;
        if (init.bodyText !== undefined)
            this.bodyText = init.bodyText;
        if (init.response !== undefined)
            this.response = init.response;
        if (init.retryAfterMs !== undefined)
            this.retryAfterMs = init.retryAfterMs;
    }
}
/* ------------------------------------------------------------------ *
 * 归因解析（pro 层 body → standard 层 header → 缺省）
 * ------------------------------------------------------------------ */
function safeDecode(value) {
    // 网关 headerSafe 对非 ASCII 做百分号编码；遇到裸 '%' 等非法序列时原样返回
    try {
        return decodeURIComponent(value);
    }
    catch {
        return value;
    }
}
/** pro 层：错误体 error.relay_attribution */
function parseBodyAttribution(bodyText) {
    if (!bodyText)
        return undefined;
    try {
        const parsed = JSON.parse(bodyText);
        if (typeof parsed !== 'object' || parsed === null)
            return undefined;
        const err = parsed['error'];
        if (typeof err !== 'object' || err === null)
            return undefined;
        return normalizeAttribution(err['relay_attribution']);
    }
    catch {
        return undefined; // 非 JSON（HTML 错误页等）——归因链路 fail-open
    }
}
function normalizeAttribution(value) {
    if (typeof value !== 'object' || value === null)
        return undefined;
    const o = value;
    if (typeof o['failure_reason'] !== 'string')
        return undefined;
    const next = typeof o['suggested_next'] === 'object' && o['suggested_next'] !== null
        ? o['suggested_next']
        : {};
    const rawRetryAfter = next['retryAfterMs'];
    const retryAfterMs = typeof rawRetryAfter === 'number' && Number.isFinite(rawRetryAfter) && rawRetryAfter >= 0
        ? rawRetryAfter
        : undefined;
    return {
        failure_reason: o['failure_reason'],
        suggested_next: {
            action: typeof next['action'] === 'string' ? next['action'] : '',
            ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
            ...(next['autoPerformed'] === true ? { autoPerformed: true } : {}),
        },
        recoverable: o['recoverable'] === true,
        upstream: typeof o['upstream'] === 'string' ? o['upstream'] : '',
        ...(typeof o['confidence'] === 'number' ? { confidence: o['confidence'] } : {}),
        ...(Array.isArray(o['evidence']) ? { evidence: o['evidence'].map((e) => String(e)) } : {}),
    };
}
/**
 * standard 层：X-Relay-Attribution 头
 * 格式（engine.ts attributionHeaders）：`<failure_reason>;next=<action>[;retry_after_ms=<ms>];recoverable=<bool>;upstream=<id>`
 * 未知键忽略（网关未来加字段不至于让旧客户端崩）。
 */
function parseAttributionHeader(header) {
    const parts = header
        .split(';')
        .map((p) => p.trim())
        .filter((p) => p.length > 0);
    const reason = parts.shift();
    if (reason === undefined)
        return undefined;
    let action = '';
    let retryAfterMs;
    let recoverable = false;
    let upstream = '';
    for (const part of parts) {
        const eq = part.indexOf('=');
        if (eq <= 0)
            continue;
        const key = part.slice(0, eq).trim();
        const raw = part.slice(eq + 1).trim();
        if (key === 'next')
            action = safeDecode(raw);
        else if (key === 'retry_after_ms') {
            const n = Number(raw);
            if (Number.isFinite(n) && n >= 0)
                retryAfterMs = n;
        }
        else if (key === 'recoverable')
            recoverable = raw === 'true';
        else if (key === 'upstream')
            upstream = safeDecode(raw);
    }
    return {
        failure_reason: safeDecode(reason),
        suggested_next: { action, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) },
        recoverable,
        upstream,
    };
}
function parseAttribution(res, bodyText) {
    const fromBody = parseBodyAttribution(bodyText);
    if (fromBody)
        return fromBody;
    const header = res.headers.get('x-relay-attribution');
    return header !== null ? parseAttributionHeader(header) : undefined;
}
/** 标准 Retry-After 头：整数秒或 HTTP 日期（网关侧只会发整数秒，这里按 RFC 7231 全解析） */
function parseRetryAfterHeaderMs(raw) {
    if (raw === null)
        return undefined;
    const t = raw.trim();
    if (/^\d+(?:\.\d+)?$/.test(t))
        return Number(t) * 1000;
    const date = Date.parse(t);
    return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}
/* ------------------------------------------------------------------ *
 * 无归因时的状态码兜底（free 层：错误体零附加，SDK 仍要能用）
 * ------------------------------------------------------------------ */
function fallbackReasonForStatus(status) {
    if (status === 429)
        return 'rate_limited';
    if (status === 401)
        return 'auth_invalid';
    if (status === 402)
        return 'quota_exhausted';
    if (status === 403)
        return 'permission_denied';
    if (status === 404)
        return 'model_not_found';
    if (status === 408 || status === 504)
        return 'upstream_timeout';
    if (status >= 500)
        return 'upstream_unavailable';
    return 'invalid_request';
}
function fallbackRetryableByStatus(status) {
    return status === 429 || status === 408 || status === 504 || status >= 500;
}
/** 从错误体里取上游/网关的 error.message（归因卡片本身不带 message，人话在这） */
function upstreamMessageOf(bodyText) {
    if (!bodyText)
        return undefined;
    try {
        const parsed = JSON.parse(bodyText);
        if (typeof parsed !== 'object' || parsed === null)
            return undefined;
        const err = parsed['error'];
        if (typeof err !== 'object' || err === null)
            return undefined;
        const msg = err['message'];
        return typeof msg === 'string' ? msg : undefined;
    }
    catch {
        return undefined;
    }
}
/* ------------------------------------------------------------------ *
 * 主入口：autoRetry
 * ------------------------------------------------------------------ */
/**
 * 带 P3 归因语义的 fetch：可重试失败按服务器给的 `retryAfterMs`（缺省指数退避+抖动）自动重试；
 * 不可重试失败（quota_exhausted / auth_invalid / permission_denied / model_not_found 等）
 * 立即抛出带归因的 {@link AutoRetryError}。
 *
 * - 2xx 响应**原样返回**（body 不读，流式语义保留）；非 2xx 一律重试或抛错，不会静默返回错误响应。
 * - 用户的 init 原样透传（含 `X-Relay-Precheck` 等自定义头）；仅 `signal` 会被替换为
 *   内部组合信号（用户取消仍然生效并透传原始 AbortError）。
 * - 重试会原样重发 `init.body`：请确保 body 可重放（字符串/Buffer/普通对象）。
 *   流式请求体（一次性 ReadableStream）无法重放，重试时会失败——用
 *   {@link createAutoRetryClient}.chat 可避开（它发 JSON 字符串）。
 * - 注意：网关自身也可能先自动重试过一轮（pro 层 `autoPerformed=true`），
 *   客户端的重试预算是在此之上的第二道。
 */
export async function autoRetry(url, init = {}, opts = {}) {
    const conf = normalizeOptions(opts);
    /* --- 信号组合：用户取消 + 总超时 都汇入同一个 AbortController --- */
    const userSignal = init.signal ?? undefined;
    const ctrl = new AbortController();
    const onUserAbort = () => {
        ctrl.abort(userSignal?.reason);
    };
    if (userSignal) {
        if (userSignal.aborted)
            ctrl.abort(userSignal.reason);
        else
            userSignal.addEventListener('abort', onUserAbort, { once: true });
        // 注意：成功返回后**不**摘掉这个监听——用户之后 abort 应当能切断正在读的流式 body。
    }
    let timedOut = false;
    let timer;
    if (conf.timeoutMs > 0) {
        timer = setTimeout(() => {
            timedOut = true;
            ctrl.abort();
        }, conf.timeoutMs);
    }
    const deadline = conf.timeoutMs > 0 ? Date.now() + conf.timeoutMs : undefined;
    const abortOutcome = (err, attempt) => {
        if (timedOut) {
            return new AutoRetryError({
                kind: 'timeout',
                failureReason: 'upstream_timeout',
                message: `总超时（timeoutMs=${conf.timeoutMs}ms）已到，放弃重试（已尝试 ${attempt} 次）`,
                attempts: attempt,
                ...(err !== undefined ? { cause: err } : {}),
            });
        }
        return err instanceof Error ? err : new Error(String(err)); // 用户取消：透传原始 AbortError
    };
    const sleepWithAbort = async (ms, attempt) => {
        // 每次等待都往 ctrl.signal 挂一个 { once: true } 的 abort 监听；
        // race 结束（无论 sleep 先到还是 abort 先到）后必须摘除，否则多次重试会累积监听器。
        let onAbort;
        try {
            await Promise.race([
                conf.sleep(ms),
                new Promise((_, reject) => {
                    if (ctrl.signal.aborted) {
                        reject(ctrl.signal.reason ?? new Error('aborted'));
                        return;
                    }
                    onAbort = () => reject(ctrl.signal.reason ?? new Error('aborted'));
                    ctrl.signal.addEventListener('abort', onAbort, { once: true });
                }),
            ]);
        }
        catch (err) {
            if (ctrl.signal.aborted)
                throw abortOutcome(err, attempt);
            throw err; // 注入的 sleep 自己挂了：如实上抛，不冒充取消
        }
        finally {
            if (onAbort !== undefined)
                ctrl.signal.removeEventListener('abort', onAbort);
        }
    };
    try {
        for (let attempt = 1;; attempt++) {
            let res;
            try {
                res = await conf.fetchImpl(url, { ...init, signal: ctrl.signal });
            }
            catch (err) {
                if (ctrl.signal.aborted)
                    throw abortOutcome(err, attempt);
                if (attempt > conf.maxRetries) {
                    throw new AutoRetryError({
                        kind: 'network',
                        failureReason: 'network_error',
                        message: `网络错误且重试预算已耗尽（已尝试 ${attempt} 次）：${err instanceof Error ? err.message : String(err)}`,
                        attempts: attempt,
                        retryBudgetExhausted: true,
                        ...(err !== undefined ? { cause: err } : {}),
                    });
                }
                const delayMs = Math.min(backoffDelayMs(attempt, conf.backoffBaseMs, conf.backoffMaxMs), conf.maxWaitMs);
                if (deadline !== undefined && Date.now() + delayMs > deadline) {
                    throw new AutoRetryError({
                        kind: 'timeout',
                        failureReason: 'upstream_timeout',
                        message: `剩余时间不足以完成退避等待（需 ${delayMs}ms），总超时（timeoutMs=${conf.timeoutMs}ms）放弃`,
                        attempts: attempt,
                        ...(err !== undefined ? { cause: err } : {}),
                    });
                }
                conf.onRetry?.({ attempt: attempt + 1, delayMs, failureReason: 'network_error' });
                await sleepWithAbort(delayMs, attempt);
                continue;
            }
            /* 成功直通：不读 body（流式零等待零缓冲）；超时定时器由外层 finally 统一清理 */
            if (res.ok) {
                return res;
            }
            /* 失败：读错误体（错误路径本就无流式语义），解析归因后裁决 */
            let bodyText;
            try {
                bodyText = await res.text();
            }
            catch (err) {
                if (ctrl.signal.aborted)
                    throw abortOutcome(err, attempt);
                // 响应体中途断开：等价网络错误
                if (attempt > conf.maxRetries) {
                    throw new AutoRetryError({
                        kind: 'network',
                        failureReason: 'network_error',
                        message: `读取错误响应体时连接中断（已尝试 ${attempt} 次）`,
                        attempts: attempt,
                        retryBudgetExhausted: true,
                        ...(err !== undefined ? { cause: err } : {}),
                    });
                }
                const delayMs = Math.min(backoffDelayMs(attempt, conf.backoffBaseMs, conf.backoffMaxMs), conf.maxWaitMs);
                if (deadline !== undefined && Date.now() + delayMs > deadline) {
                    throw new AutoRetryError({
                        kind: 'timeout',
                        failureReason: 'upstream_timeout',
                        message: `剩余时间不足以完成退避等待（需 ${delayMs}ms），总超时（timeoutMs=${conf.timeoutMs}ms）放弃`,
                        attempts: attempt,
                        ...(err !== undefined ? { cause: err } : {}),
                    });
                }
                conf.onRetry?.({ attempt: attempt + 1, delayMs, failureReason: 'network_error', status: res.status });
                await sleepWithAbort(delayMs, attempt);
                continue;
            }
            const attribution = parseAttribution(res, bodyText);
            const reason = attribution?.failure_reason ?? fallbackReasonForStatus(res.status);
            const retryable = attribution
                ? attribution.recoverable && conf.retryableReasons.includes(reason)
                : fallbackRetryableByStatus(res.status);
            const hintMs = attribution?.suggested_next.retryAfterMs ?? parseRetryAfterHeaderMs(res.headers.get('retry-after'));
            if (!retryable || attempt > conf.maxRetries) {
                const upstreamMsg = upstreamMessageOf(bodyText);
                throw new AutoRetryError({
                    kind: 'http',
                    status: res.status,
                    failureReason: reason,
                    attribution,
                    attempts: attempt,
                    bodyText,
                    response: res,
                    ...(hintMs !== undefined ? { retryAfterMs: hintMs } : {}),
                    retryBudgetExhausted: retryable,
                    message: `网关请求失败：HTTP ${res.status} ${reason}` +
                        (retryable ? `（可重试，但 maxRetries=${conf.maxRetries} 已用完）` : '（不可重试，重试不会成功）') +
                        (upstreamMsg !== undefined ? `：${upstreamMsg}` : ''),
                });
            }
            const delayMs = Math.max(0, Math.min(hintMs ?? backoffDelayMs(attempt, conf.backoffBaseMs, conf.backoffMaxMs), conf.maxWaitMs));
            if (deadline !== undefined && Date.now() + delayMs > deadline) {
                throw new AutoRetryError({
                    kind: 'timeout',
                    failureReason: 'upstream_timeout',
                    message: `剩余时间不足以按服务器建议等待 ${delayMs}ms，总超时（timeoutMs=${conf.timeoutMs}ms）放弃`,
                    attempts: attempt,
                    bodyText,
                    response: res,
                    ...(attribution !== undefined ? { attribution } : {}),
                });
            }
            conf.onRetry?.({
                attempt: attempt + 1,
                delayMs,
                failureReason: reason,
                status: res.status,
                ...(attribution !== undefined ? { attribution } : {}),
            });
            await sleepWithAbort(delayMs, attempt);
        }
    }
    finally {
        // S1：所有出口（成功 return / 各类抛错）统一清理总超时定时器。
        // 原先只有成功路径 clearTimeout，抛错路径会让定时器存活到到期（虽无行为副作用，
        // 但会延迟闭包 GC 最多 timeoutMs，且违背资源清理纪律）。用户 signal 监听**不**在此清理
        // （见上方 L377 注释：成功返回后用户 abort 应仍能切断正在读的流式 body）。
        if (timer !== undefined)
            clearTimeout(timer);
    }
}
function headersToRecord(h) {
    if (h === undefined || h === null)
        return {};
    if (h instanceof Headers)
        return Object.fromEntries(h.entries());
    if (Array.isArray(h)) {
        // HeadersInit 的数组形式是 [key, value][]；过滤掉畸形项，不做静默类型断言
        return Object.fromEntries(h.filter((pair) => Array.isArray(pair) && pair.length >= 2));
    }
    return { ...h };
}
/**
 * ```ts
 * const relay = createAutoRetryClient({ baseUrl: 'https://relay.example', apiKey: 'sk-...' });
 * const res = await relay.chat({ model: 'glm-4.7', messages: [{ role: 'user', content: '你好' }] });
 * const data = await res.json();  // 429/5xx 已在幕后按 retryAfterMs 重试过
 * ```
 */
export function createAutoRetryClient(config) {
    const base = (typeof config.baseUrl === 'string' ? config.baseUrl : config.baseUrl.toString()).replace(/\/+$/, '');
    const chatPath = config.chatPath ?? '/v1/chat/completions';
    const mergeHeaders = (init) => ({
        ...(config.apiKey !== undefined ? { authorization: `Bearer ${config.apiKey}` } : {}),
        ...(config.defaultHeaders ?? {}),
        ...headersToRecord(init?.headers),
    });
    return {
        async chat(body, init = {}) {
            if (init.body !== undefined) {
                throw new TypeError('chat() 的请求体通过第一个参数传入（普通对象，可安全重放），请勿另设 init.body');
            }
            return autoRetry(`${base}${chatPath}`, { ...init, method: 'POST', headers: mergeHeaders(init), body: JSON.stringify(body) }, config.retry);
        },
        fetch(path, init = {}) {
            return autoRetry(`${base}${path}`, { ...init, headers: mergeHeaders(init) }, config.retry);
        },
    };
}
//# sourceMappingURL=auto-retry.js.map