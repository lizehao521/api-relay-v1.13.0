/**
 * M-05 拆分后的单元测试：FailurePresenter（`src/gateway/presenter.ts`）。
 *
 * 这是"抽出纯函数模块可单测"的证明——此前这段逻辑埋在 1800 行的 Engine 里，
 * 只能靠 e2e 间接覆盖（一个 HTTP 往返才能验一个错误头的拼法），成本高、覆盖窄。
 * 现在可以直接断言每个映射/拼装/开关组合。
 *
 * 重要：presenter 的两个依赖以**取值函数**注入，因此"配置刷新即时生效"也一并在此锁定。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FailurePresenter } from '../gateway/presenter.js';
import { PRECHECK_CODES } from '../loss/precheck.js';
import { memoryConfig } from '../app.js';
import { hmacHex } from '../util/index.js';
const cfg = memoryConfig();
const baseLr = cfg.lossReduction;
function presenter(opts = {}) {
    return new FailurePresenter({
        lr: () => opts.lr ?? baseLr,
        hideUpstream: () => opts.hideUpstream ?? false,
    });
}
function card(reason, extra = {}) {
    return {
        failure_reason: reason,
        message: '测试消息',
        suggested_next: { action: 'fix_request' },
        recoverable: true,
        upstream: 'p1',
        confidence: 1,
        ...extra,
    };
}
const policy = (id) => cfg.tiers[id];
/* ==================== 错误码映射 ==================== */
test('presenter.errorCodeFor：失败原因 → OpenAI 兼容错误码', () => {
    const p = presenter();
    const cases = [
        ['rate_limited', 'rate_limit_error'],
        ['model_overloaded', 'rate_limit_error'],
        ['quota_exhausted', 'insufficient_quota'],
        ['auth_invalid', 'upstream_error'],
        ['permission_denied', 'upstream_error'],
        ['model_not_found', 'model_not_found'],
        ['upstream_timeout', 'upstream_timeout'],
        ['network_error', 'upstream_timeout'],
        ['context_length_exceeded', 'invalid_request_error'],
        ['tool_call_invalid', 'invalid_request_error'],
        ['relay_internal_error', 'relay_internal_error'],
        ['stream_interrupted', 'relay_internal_error'],
        ['unknown', 'upstream_error'],
    ];
    for (const [reason, expected] of cases) {
        assert.equal(p.errorCodeFor(card(reason)), expected, `reason=${reason}`);
    }
});
/* ==================== 归因附加（applyAttribution / errorBody） ==================== */
test('presenter.applyAttribution：full 附加 / header 与 off 原样 / disabled 关闭', () => {
    const p = presenter();
    const body = () => ({ error: { message: '原始文案', code: 'x' } });
    // pro = attribution:'full' → 附加 relay_attribution，且不改动 error.message
    const full = p.applyAttribution(body(), card('rate_limited'), policy('pro'));
    const err = full['error'];
    assert.ok(err['relay_attribution'], 'full 模式必须附加 relay_attribution');
    assert.equal(err['message'], '原始文案', '归因绝不改写原文');
    assert.equal(err['relay_attribution']['upstream'], 'p1');
    // standard = 'header' → 错误体保持原样
    assert.equal(p.applyAttribution(body(), card('rate_limited'), policy('standard'))['error']['relay_attribution'], undefined);
    // free = 'off' → 原样
    assert.equal(p.applyAttribution(body(), card('rate_limited'), policy('free'))['error']['relay_attribution'], undefined);
    // 全局关闭 → 原样
    const disabled = { ...baseLr, attribution: { ...baseLr.attribution, enabled: false } };
    assert.equal(presenter({ lr: disabled }).applyAttribution(body(), card('rate_limited'), policy('pro'))['error']['relay_attribution'], undefined);
    // 无 card → 原样
    assert.equal(p.applyAttribution(body(), undefined, policy('pro'))['error'] !== undefined, true);
});
test('presenter：依赖以取值函数注入 —— 配置刷新即时生效（非快照）', () => {
    let lr = baseLr;
    let hide = false;
    const p = new FailurePresenter({ lr: () => lr, hideUpstream: () => hide });
    const body = () => ({ error: {} });
    assert.equal(p.applyAttribution(body(), card('rate_limited'), policy('pro'))['error']['relay_attribution'] !== undefined, true);
    // 运行期把归因关掉 → 立即生效
    lr = { ...baseLr, attribution: { ...baseLr.attribution, enabled: false } };
    assert.equal(p.applyAttribution(body(), card('rate_limited'), policy('pro'))['error']['relay_attribution'], undefined);
    // hideUpstream 立即生效
    hide = true;
    assert.equal(p.modeHeader({ client: { tier: 'pro' }, fingerprint: { kind: 'agent' }, requestedModel: 'm', routes: [{ upstreamModel: 'up', providerId: 'p1' }] }, policy('pro'))['x-relay-upstream'], undefined);
});
test('presenter.errorBody：schema 补齐 + relay_details + 归因附加', () => {
    const out = presenter().errorBody('rate_limit_error', '限流了', { code: 'rate_limited' }, undefined, policy('pro'), { hint: '稍后重试' });
    const parsed = JSON.parse(out);
    assert.equal(parsed.error['message'], '限流了');
    assert.equal(parsed.error['type'], 'rate_limit_error');
    assert.equal(parsed.error['code'], 'rate_limited');
    assert.deepEqual(parsed.error['relay_details'], { hint: '稍后重试' });
    assert.equal(parsed.error['param'], null, '缺失字段必须补齐为 null');
});
/* ==================== 响应头 ==================== */
test('presenter.attributionHeaders：Retry-After / x-relay-attribution / 各开关', () => {
    const p = presenter();
    // 可恢复 + retryAfterMs → retry-after（秒，向上取整，下限 1）
    const c = card('rate_limited', { suggested_next: { action: 'retry_with_backoff', retryAfterMs: 2_500 } });
    const h = p.attributionHeaders(c, policy('pro'));
    assert.equal(h['retry-after'], '3');
    assert.match(h['x-relay-attribution'] ?? '', /rate_limited;next=retry_with_backoff;retry_after_ms=2500;recoverable=true;upstream=p1/);
    // 不可恢复 → 无 retry-after
    assert.equal(p.attributionHeaders(card('invalid_request', { recoverable: false }), policy('pro'))['retry-after'], undefined);
    // 无 card → 空
    assert.deepEqual(p.attributionHeaders(undefined, policy('pro')), {});
    // off → 只有 retry-after（标准信号不受归因策略影响）
    const off = p.attributionHeaders(c, policy('free'));
    assert.equal(off['retry-after'], '3');
    assert.equal(off['x-relay-attribution'], undefined);
    // hideUpstream → upstream 折叠为 relay
    const hidden = presenter({ hideUpstream: true }).attributionHeaders(c, policy('pro'));
    assert.match(hidden['x-relay-attribution'] ?? '', /upstream=relay/);
});
test('presenter.attributionHeadersForSuccess / modeHeader', () => {
    const p = presenter();
    assert.equal(p.attributionHeadersForSuccess(policy('pro'))['x-relay-loss-reduction'], 'precheck=enforce;attribution=full');
    assert.deepEqual(p.attributionHeadersForSuccess(policy('free')), {});
    const ctx = {
        client: { tier: 'standard' },
        fingerprint: { kind: 'agent' },
        requestedModel: '旗舰',
        routes: [{ upstreamModel: 'm-flash', providerId: 'p1', ladderStep: { index: 0, total: 2 } }],
    };
    const h = p.modeHeader(ctx, policy('standard'));
    assert.match(h['x-relay-mode'] ?? '', /tier=standard;precheck=observe;attribution=header;meter=on;client=agent/);
    assert.equal(h['x-relay-model-requested'], '%E6%97%97%E8%88%B0', '非 ASCII 头值必须百分号编码');
    assert.equal(h['x-relay-model-served'], 'm-flash');
    assert.equal(h['x-relay-upstream'], 'p1');
    assert.equal(h['x-relay-ladder'], '1/2');
    assert.equal(h['x-relay-switched'], '%E6%97%97%E8%88%B0->m-flash');
    // hideUpstream → 不回显上游身份与阶梯
    const hidden = presenter({ hideUpstream: true }).modeHeader(ctx, policy('standard'));
    assert.equal(hidden['x-relay-model-served'], undefined);
    assert.equal(hidden['x-relay-upstream'], undefined);
    assert.equal(hidden['x-relay-ladder'], undefined);
});
test('presenter.verificationHeaders：无 nonce 为空；有 nonce 回 HMAC 四件套', () => {
    const p = presenter();
    assert.deepEqual(p.verificationHeaders({ headers: {} }, 'body', 'req1'), {});
    const h = p.verificationHeaders({ headers: { 'x-relay-verify-nonce': 'n0nce' } }, 'body-text', 'req-42');
    assert.equal(h['x-relay-content-hmac-alg'], 'hmac-sha256');
    assert.equal(h['x-relay-content-hmac'], hmacHex('n0nce', 'body-text'));
    assert.equal(h['x-relay-content-hmac-nonce'], 'n0nce');
    assert.equal(h['x-relay-content-hmac-request-id'], 'req-42');
});
/* ==================== 归因卡片构造 ==================== */
test('presenter：precheckCard / abortedCard / simpleError 形状稳定', () => {
    const p = presenter();
    const modelCard = p.precheckCard(PRECHECK_CODES.MODEL_UNKNOWN, ['detail-1'], 'm');
    assert.equal(modelCard.failure_reason, 'model_not_found');
    assert.equal(modelCard.suggested_next.action, 'switch_model', 'model_ 前缀 → 换模型');
    assert.equal(modelCard.upstream, 'relay');
    assert.deepEqual(modelCard.evidence, ['detail-1']);
    assert.equal(p.precheckCard(PRECHECK_CODES.MESSAGES_TOO_MANY, [], 'm').failure_reason, 'context_length_exceeded');
    const other = p.precheckCard('whatever_else', [], 'm');
    assert.equal(other.failure_reason, 'invalid_request');
    assert.equal(other.suggested_next.action, 'fix_request');
    const aborted = p.abortedCard('p9');
    assert.equal(aborted.failure_reason, 'client_aborted');
    assert.equal(aborted.recoverable, false);
    assert.equal(aborted.upstream, 'p9');
    const se = p.simpleError('invalid_request_error', '参数不对', ['ev'], 400);
    assert.equal(se.kind, 'json');
    assert.equal(se.status, 400);
    assert.match(se.headers['x-relay-attribution'] ?? '', /invalid_request;next=fix_request;recoverable=true;upstream=relay/);
    const body = JSON.parse(se.body);
    assert.equal(body.error['message'], '参数不对');
    assert.equal(body.error['code'], 'invalid_request_error');
    assert.ok(body.error['relay_attribution']);
});
//# sourceMappingURL=presenter.test.js.map