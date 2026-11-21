/**
 * 客户端 SDK 薄封装 autoRetry 的单测。
 *
 * 铁律：**mock fetch + 注入 sleep**，不起真实网络、不绑任何端口、不做真实等待。
 * 归因字段的形状全部取自网关源码（engine.ts applyAttribution / attributionHeaders），
 * 其中"与网关 retryableReasons 默认值逐字对齐"一条是机械锁死的契约测试。
 *
 * 资源清理（S1）节例外：验证 timer 清理时允许**真实 setTimeout**（等待超过 timeoutMs
 * 后断言内部信号未被 abort），仍不起网络、不绑端口。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoRetry, AutoRetryError, createAutoRetryClient, RETRYABLE_FAILURE_REASONS } from './auto-retry.js';
import { defaultConfig } from '../core/config.js';
/* ------------------------------------------------------------------ *
 * mock 基建
 * ------------------------------------------------------------------ */
function jsonResponse(status, body, headers = {}) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', ...headers },
    });
}
/** 构造网关 pro 层错误响应（error.relay_attribution，形状同 engine.ts applyAttribution） */
function relayError(status, failureReason, extra = {}) {
    return jsonResponse(status, {
        error: {
            message: extra.message ?? `upstream error (${failureReason})`,
            type: failureReason,
            param: null,
            code: failureReason,
            relay_attribution: {
                failure_reason: failureReason,
                suggested_next: {
                    action: extra.action ?? 'retry_with_backoff',
                    ...(extra.retryAfterMs !== undefined ? { retryAfterMs: extra.retryAfterMs } : {}),
                },
                recoverable: extra.recoverable ?? true,
                upstream: extra.upstream ?? 'primary',
                confidence: 0.9,
            },
        },
    });
}
/** 脚本化 fetch：按步骤依次返回；步骤耗尽后重复最后一步。每次都从原始件克隆（body 只能消费一次） */
function scriptedFetch(...steps) {
    const calls = [];
    let i = 0;
    const impl = async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        const step = steps[Math.min(i++, steps.length - 1)];
        if (step === undefined)
            throw new Error('scriptedFetch: 没有更多步骤');
        if (step instanceof Error)
            throw step;
        return step.clone();
    };
    return { fetch: impl, calls };
}
/** 记录延迟的假 sleep：不等待，只收集每次被要求的毫秒数 */
function recordingSleep() {
    const delays = [];
    return { delays, sleep: async (ms) => void delays.push(ms) };
}
async function expectAutoRetryError(p) {
    try {
        await p;
    }
    catch (err) {
        assert.ok(err instanceof AutoRetryError, `应抛 AutoRetryError，实际抛出：${String(err)}`);
        return err;
    }
    throw new Error('应当抛出 AutoRetryError，却成功返回了');
}
function assertInRange(value, lo, hi, label) {
    assert.ok(value >= lo && value <= hi, `${label} 应在 [${lo}, ${hi}] 内，实际 ${value}`);
}
const URL_ = 'https://relay.example/v1/chat/completions';
const okRes = jsonResponse(200, { object: 'chat.completion', choices: [] });
/* ------------------------------------------------------------------ *
 * 可重试路径
 * ------------------------------------------------------------------ */
test('429 可重试：按归因 retryAfterMs 等待后重试成功，且透传用户自定义头', async () => {
    const { fetch, calls } = scriptedFetch(relayError(429, 'rate_limited', { retryAfterMs: 1200 }), jsonResponse(200, { ok: true }));
    const { delays, sleep } = recordingSleep();
    const retries = [];
    const res = await autoRetry(URL_, {
        method: 'POST',
        headers: { authorization: 'Bearer sk-test', 'x-relay-precheck': 'off' },
        body: JSON.stringify({ model: 'glm-4.7' }),
    }, { fetchImpl: fetch, sleep, onRetry: (info) => retries.push(info) });
    assert.equal(res.status, 200);
    assert.deepEqual(delays, [1200], '必须精确按服务器给的 retryAfterMs 等待');
    assert.equal(calls.length, 2, '失败一次 + 重试一次');
    // 用户自定义头与 body 每次尝试都原样透传
    for (const c of calls) {
        assert.equal(c.init.headers['x-relay-precheck'], 'off');
        assert.equal(c.init.headers['authorization'], 'Bearer sk-test');
        assert.equal(c.init.method, 'POST');
    }
    assert.deepEqual(retries, [
        { attempt: 2, delayMs: 1200, failureReason: 'rate_limited', status: 429, attribution: { failure_reason: 'rate_limited', suggested_next: { action: 'retry_with_backoff', retryAfterMs: 1200 }, recoverable: true, upstream: 'primary', confidence: 0.9 } },
    ]);
});
test('429 无 retryAfterMs：走指数退避 + 抖动路径（对齐网关 backoff 400ms×2^n×[0.75,1.0)）', async () => {
    const { fetch, calls } = scriptedFetch(relayError(429, 'rate_limited'), relayError(429, 'rate_limited'), relayError(429, 'rate_limited'));
    const { delays, sleep } = recordingSleep();
    const err = await expectAutoRetryError(autoRetry(URL_, {}, { fetchImpl: fetch, sleep, maxRetries: 2 }));
    assert.equal(calls.length, 3);
    assert.equal(delays.length, 2);
    assertInRange(delays[0], 300, 400, '第一次退避（400×[0.75,1.0)）');
    assertInRange(delays[1], 600, 800, '第二次退避（800×[0.75,1.0)）');
    assert.equal(err.failureReason, 'rate_limited');
    assert.equal(err.retryBudgetExhausted, true);
});
test('达到最大重试次数后抛错：错误上带最后一次归因与等待建议', async () => {
    const { fetch, calls } = scriptedFetch(relayError(503, 'upstream_unavailable', { retryAfterMs: 50 }));
    const { delays, sleep } = recordingSleep();
    const err = await expectAutoRetryError(autoRetry(URL_, {}, { fetchImpl: fetch, sleep, maxRetries: 2 }));
    assert.equal(calls.length, 3, '1 次首发 + 2 次重试');
    assert.deepEqual(delays, [50, 50]);
    assert.equal(err.status, 503);
    assert.equal(err.failureReason, 'upstream_unavailable');
    assert.equal(err.attempts, 3);
    assert.equal(err.retryBudgetExhausted, true);
    assert.equal(err.retryAfterMs, 50);
    assert.equal(err.attribution?.suggested_next.action, 'retry_with_backoff');
});
test('网络错误可重试：fetch 拒绝后按退避重试成功', async () => {
    const { fetch, calls } = scriptedFetch(new TypeError('fetch failed'), okRes);
    const { delays, sleep } = recordingSleep();
    const res = await autoRetry(URL_, {}, { fetchImpl: fetch, sleep });
    assert.equal(res.status, 200);
    assert.equal(calls.length, 2);
    assertInRange(delays[0], 300, 400, '网络错误退避');
});
/* ------------------------------------------------------------------ *
 * 不可重试路径
 * ------------------------------------------------------------------ */
test('quota_exhausted 不可重试：立即抛错且错误上带完整归因', async () => {
    const { fetch, calls } = scriptedFetch(relayError(402, 'quota_exhausted', { recoverable: false, action: 'top_up_balance', message: 'Insufficient Balance' }));
    const { delays, sleep } = recordingSleep();
    const err = await expectAutoRetryError(autoRetry(URL_, {}, { fetchImpl: fetch, sleep }));
    assert.equal(calls.length, 1, '绝不做无效重试');
    assert.deepEqual(delays, [], '零等待');
    assert.equal(err.status, 402);
    assert.equal(err.failureReason, 'quota_exhausted');
    assert.equal(err.attribution?.recoverable, false);
    assert.equal(err.attribution?.suggested_next.action, 'top_up_balance');
    assert.equal(err.retryBudgetExhausted, false);
    assert.ok(err.bodyText?.includes('Insufficient Balance'), '上游原文保留');
    assert.ok(err.message.includes('Insufficient Balance'), '错误消息里带上游人话解释');
});
test('permission_denied（recoverable=true 但不在可重试集合）：不重试，指引换模型', async () => {
    const { fetch, calls } = scriptedFetch(relayError(403, 'permission_denied', { action: 'switch_model' }));
    const { delays, sleep } = recordingSleep();
    const err = await expectAutoRetryError(autoRetry(URL_, {}, { fetchImpl: fetch, sleep }));
    assert.equal(calls.length, 1);
    assert.deepEqual(delays, []);
    assert.equal(err.failureReason, 'permission_denied');
    assert.equal(err.attribution?.suggested_next.action, 'switch_model');
});
/* ------------------------------------------------------------------ *
 * 归因通道：standard 层响应头 / free 层状态码兜底
 * ------------------------------------------------------------------ */
test('standard 层：解析 X-Relay-Attribution 头并按 retry_after_ms 重试', async () => {
    const { fetch, calls } = scriptedFetch(jsonResponse(429, { error: { message: 'Rate limit reached', type: 'rate_limit_error', param: null, code: 'rate_limit_exceeded' } }, { 'x-relay-attribution': 'rate_limited;next=retry_with_backoff;retry_after_ms=700;recoverable=true;upstream=primary' }), jsonResponse(200, { ok: true }));
    const { delays, sleep } = recordingSleep();
    const retries = [];
    const res = await autoRetry(URL_, {}, { fetchImpl: fetch, sleep, onRetry: (info) => retries.push(info) });
    assert.equal(res.status, 200);
    assert.deepEqual(delays, [700], 'header 里的 retry_after_ms 必须被采用');
    assert.equal(calls.length, 2);
    const info = retries[0];
    assert.equal(info.failureReason, 'rate_limited');
    assert.equal(info.attribution?.failure_reason, 'rate_limited');
    assert.equal(info.attribution?.suggested_next.retryAfterMs, 700);
});
test('standard 层 header 的百分号编码被还原（headerSafe 的逆变换）', async () => {
    const { fetch, calls } = scriptedFetch(jsonResponse(403, { error: { message: 'forbidden', type: 'authentication_error', param: null, code: 'forbidden' } }, { 'x-relay-attribution': 'permission_denied;next=switch_model;recoverable=true;upstream=%E6%97%97%E8%88%B0' }));
    const { sleep } = recordingSleep();
    const err = await expectAutoRetryError(autoRetry(URL_, {}, { fetchImpl: fetch, sleep }));
    assert.equal(calls.length, 1);
    assert.equal(err.attribution?.upstream, '旗舰', '非 ASCII 的 providerId 应被 decodeURIComponent 还原');
});
test('free 层 503 + Retry-After 头（ADR-013）：无归因也尊重服务器等待指令', async () => {
    const { fetch, calls } = scriptedFetch(jsonResponse(503, { error: { message: '所有上游暂不可用', type: 'upstream_error', param: null, code: 'upstream_error' } }, { 'retry-after': '2' }), jsonResponse(200, { ok: true }));
    const { delays, sleep } = recordingSleep();
    const res = await autoRetry(URL_, {}, { fetchImpl: fetch, sleep });
    assert.equal(res.status, 200);
    assert.deepEqual(delays, [2000], 'Retry-After: 2 → 等待 2000ms');
    assert.equal(calls.length, 2);
});
test('free 层 429 无任何归因：按状态码兜底为 rate_limited 并重试', async () => {
    const { fetch, calls } = scriptedFetch(jsonResponse(429, { error: { message: 'slow down', type: 'rate_limit_error', param: null, code: 'rate_limited' } }), jsonResponse(200, { ok: true }));
    const { delays, sleep } = recordingSleep();
    const retries = [];
    const res = await autoRetry(URL_, {}, { fetchImpl: fetch, sleep, onRetry: (info) => retries.push(info) });
    assert.equal(res.status, 200);
    assert.equal(calls.length, 2);
    assertInRange(delays[0], 300, 400, '无服务器提示时用指数退避');
    assert.equal(retries[0].failureReason, 'rate_limited');
});
/* ------------------------------------------------------------------ *
 * 直通与预算
 * ------------------------------------------------------------------ */
test('成功响应零等待直通：返回同一个 Response 实例，body 未被读取', async () => {
    // 一次性 mock：直接返回 okRes 本体，验证 SDK 原样透传（不克隆不缓冲）
    const calls = [];
    const oneShot = (async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return okRes;
    });
    const { delays, sleep } = recordingSleep();
    const res = await autoRetry(URL_, {}, { fetchImpl: oneShot, sleep });
    assert.equal(res, okRes, '原样透传，不克隆不缓冲');
    assert.deepEqual(delays, []);
    assert.equal(calls.length, 1);
    assert.deepEqual(await res.json(), { object: 'chat.completion', choices: [] }, 'body 完整可读（流式语义保留）');
});
test('默认 maxRetries=1 对齐网关 attribution.autoRetry：恰好尝试 2 次', async () => {
    const { fetch, calls } = scriptedFetch(relayError(429, 'rate_limited', { retryAfterMs: 10 }));
    const { delays, sleep } = recordingSleep();
    const err = await expectAutoRetryError(autoRetry(URL_, {}, { fetchImpl: fetch, sleep }));
    assert.equal(calls.length, 2, '默认 1 次首发 + 1 次重试');
    assert.deepEqual(delays, [10]);
    assert.equal(err.attempts, 2);
});
test('总超时：预算耗尽抛 timeout 错误且不再重试', async () => {
    // 挂起的 fetch：只响应 abort（模拟真实 fetch 对 signal 的行为）
    const hangingFetch = (input, init) => new Promise((_resolve, reject) => {
        const sig = init?.signal;
        if (sig)
            sig.addEventListener('abort', () => reject(sig.reason ?? new Error('aborted')), { once: true });
    });
    const calls = [];
    const countingFetch = (input, init) => {
        calls.push(1);
        return hangingFetch(input, init);
    };
    const { delays, sleep } = recordingSleep();
    const err = await expectAutoRetryError(autoRetry(URL_, {}, { fetchImpl: countingFetch, sleep, timeoutMs: 60 }));
    assert.equal(err.kind, 'timeout');
    assert.equal(err.failureReason, 'upstream_timeout');
    assert.equal(calls.length, 1, '超时后不再发起新尝试');
    assert.deepEqual(delays, []);
});
/* ------------------------------------------------------------------ *
 * 资源清理（S1：timer / abort 监听器）
 * ------------------------------------------------------------------ */
test('S1：抛错后总超时定时器被 finally 统一清理，到点不再触发内部信号 abort', async () => {
    // mock fetch 捕获内部组合信号；402 不可重试 → 立即抛错（远早于 timeoutMs）
    const signals = [];
    const impl = (async (_url, init) => {
        const sig = init?.signal;
        if (sig instanceof AbortSignal)
            signals.push(sig);
        return relayError(402, 'quota_exhausted', { recoverable: false, action: 'top_up_balance' });
    });
    const { sleep } = recordingSleep();
    const err = await expectAutoRetryError(autoRetry(URL_, {}, { fetchImpl: impl, sleep, timeoutMs: 150 }));
    assert.equal(err.kind, 'http');
    assert.equal(signals.length, 1);
    const sig = signals[0];
    assert.equal(sig.aborted, false, '抛错发生在超时之前，此刻信号不应已 abort');
    // 真实等待显著超过 timeoutMs：若抛错路径漏清 timer，届时 ctrl.abort() 会把 sig.aborted 翻成 true
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(sig.aborted, false, 'timer 已被 finally 清理，到点不得再触发 abort');
});
test('S1 同族：重试等待的 abort 监听器在每次 race 结束后被摘除（多次重试不累积）', async () => {
    const steps = [
        relayError(429, 'rate_limited', { retryAfterMs: 1 }),
        relayError(429, 'rate_limited', { retryAfterMs: 1 }),
        jsonResponse(200, { ok: true }),
    ];
    let i = 0;
    let added = 0;
    let removed = 0;
    let patched = false;
    const impl = (async (_url, init) => {
        const sig = init?.signal;
        if (!patched && sig instanceof AbortSignal) {
            patched = true; // 三次尝试共用同一个内部 ctrl.signal，只装一次计数器
            const target = sig;
            const origAdd = target.addEventListener.bind(target);
            const origRemove = target.removeEventListener.bind(target);
            target.addEventListener = (type, listener, options) => {
                added += 1;
                origAdd(type, listener, options);
            };
            target.removeEventListener = (type, listener, options) => {
                removed += 1;
                origRemove(type, listener, options);
            };
        }
        return steps[Math.min(i++, steps.length - 1)].clone();
    });
    const { delays, sleep } = recordingSleep();
    const res = await autoRetry(URL_, {}, { fetchImpl: impl, sleep, maxRetries: 2 });
    assert.equal(res.status, 200);
    assert.deepEqual(delays, [1, 1], '两次重试等待');
    assert.equal(added, 2, '每次等待挂 1 个 abort 监听');
    assert.equal(removed, 2, 'race 结束后必须逐个摘除，不得累积');
});
/* ------------------------------------------------------------------ *
 * 契约锁定与便捷客户端
 * ------------------------------------------------------------------ */
test('默认可重试归因与网关 retryableReasons 默认值逐字对齐', () => {
    assert.deepEqual(RETRYABLE_FAILURE_REASONS, defaultConfig().lossReduction.attribution.retryableReasons);
});
test('createAutoRetryClient().chat：一行调用完成鉴权 + 端点拼接 + 自动重试', async () => {
    const { fetch, calls } = scriptedFetch(relayError(429, 'rate_limited', { retryAfterMs: 5 }), jsonResponse(200, { object: 'chat.completion', choices: [{ message: { role: 'assistant', content: '你好' } }] }));
    const { delays, sleep } = recordingSleep();
    const client = createAutoRetryClient({
        baseUrl: 'http://relay.local:8787/',
        apiKey: 'sk-test-42',
        defaultHeaders: { 'x-relay-precheck': 'off' },
        retry: { fetchImpl: fetch, sleep },
    });
    const res = await client.chat({ model: 'mock-small', messages: [{ role: 'user', content: '你好' }] });
    assert.equal(res.status, 200);
    assert.deepEqual(delays, [5]);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, 'http://relay.local:8787/v1/chat/completions', 'baseUrl 尾斜杠被规整，端点正确拼接');
    const init = calls[0].init;
    assert.equal(init.method, 'POST');
    const headers = init.headers;
    assert.equal(headers['authorization'], 'Bearer sk-test-42');
    assert.equal(headers['x-relay-precheck'], 'off');
    assert.equal(JSON.parse(init.body).model, 'mock-small', 'body 为可重放的 JSON 字符串');
    const data = (await res.json());
    assert.equal(data.choices[0].message.content, '你好');
});
//# sourceMappingURL=auto-retry.test.js.map