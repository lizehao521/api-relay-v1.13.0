/**
 * 2026-10-20 代码检视修复的回归锚点。
 *
 * 每一条对应 `修复清单-api-relay.md` 的一个编号。之所以要专门补这一批：这些缺陷此前
 * **都没有测试覆盖**，正是它们长期潜伏的原因 ——
 *   · C-01 清理条件（fails>0 的条目永不回收）
 *   · C-02 “同一不变量在多个入口下等价”（create 有、update 没有）
 *   · C-06 fail-open 降级路径的资源行为（buffer 无界增长）
 *   · M-08 流包装器的取消传导（tee 两支都取消才销毁上游流）
 *   · M-09/M-11 内存上限与原型链安全的标识符白名单
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdminAuth } from '../admin/auth.js';
import { KeyRegistry } from '../gateway/keys.js';
import { MemoryStore, SqliteStore } from '../store/index.js';
import { Logger } from '../core/logger.js';
import { memoryConfig } from '../app.js';
import { dropUsageOnlyFrames, rewriteSseModel } from '../upstream/client.js';
import { timeSafeEqual } from '../util/index.js';
const enc = new TextEncoder();
function meterRec(i, keyId = 'k1') {
    return {
        ts: Date.now(),
        traceId: `t${i}`,
        requestId: `r${i}`,
        keyId,
        tenantId: 'default',
        tier: 'standard',
        clientKind: 'agent',
        agentScore: 0.6,
        model: `m${i % 10}`,
        providerId: `p${i % 3}`,
        stream: false,
        toolCalling: true,
        outcome: 'success',
        httpStatus: 200,
        durationMs: 100 + (i % 50),
        ttfbMs: 50,
        bytesIn: 100,
        bytesOut: 200,
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        cachedPromptTokens: 0,
        costCny: 0.001,
        listCostCny: 0.002,
        attemptCount: 1,
        failureReason: null,
        quickAction: null,
        recoverable: null,
        precheckViolations: 0,
        precheckBlocked: false,
        precheckDegraded: false,
        precheckUs: 10,
        classifyUs: 2,
        attributionDelivered: false,
        duplicateInWindow: 1,
    };
}
function fakeReq(ip) {
    return { socket: { remoteAddress: ip } };
}
test('管理面账号密码登录签发有时限的会话令牌', () => {
    const configured = {
        adminLogin: { username: 'ops-admin', password: 's3cret-pass' },
    };
    const auth = new AdminAuth(undefined, configured);
    const req = fakeReq('10.0.0.9');
    assert.equal(auth.authorize(req, {}).ok, false);
    assert.equal(auth.login(req, 'ops-admin', 'wrong').ok, false);
    const session = auth.login(req, 'ops-admin', 's3cret-pass');
    assert.equal(session.ok, true);
    assert.match(session.token ?? '', /^[a-f0-9]{64}$/);
    assert.equal(auth.authorize(req, { 'x-admin-token': session.token }).ok, true);
    assert.equal(auth.authorize(req, { 'x-admin-token': 'admin' }).ok, false);
});
test('P0: 未显式配置 adminLogin 时不得用默认 admin/admin 登录（fail-closed）', () => {
    const req = fakeReq('10.0.0.9');
    // 即便配了 adminToken，账号密码通道也不能回落到默认凭据
    for (const auth of [new AdminAuth('strong-admin-token'), new AdminAuth(undefined)]) {
        const r = auth.login(req, 'admin', 'admin');
        assert.equal(r.ok, false, '默认 admin/admin 必须被拒绝');
        assert.equal(r.token, undefined);
    }
    // 只配一半（只有用户名或只有密码）同样不启用，避免弱口令入口
    for (const partial of [{ username: 'root' }, { password: 'p' }]) {
        const auth = new AdminAuth(undefined, { adminLogin: partial });
        assert.equal(auth.login(req, partial.username ?? '', partial.password ?? '').ok, false, '半配置账号不得登录');
    }
});
/* ============================ C-01 ============================ */
test('C-01: 鉴权失败表在解锁后必须被回收（fails>0 也不例外）', () => {
    const auth = new AdminAuth('correct-admin-token');
    const rl = auth.rateLimits;
    let now = 1_700_000_000_000;
    const realNow = Date.now;
    Date.now = () => now;
    try {
        assert.equal(auth.authorize(fakeReq('10.0.0.1'), {}).ok, false);
        assert.equal(rl.get('10.0.0.1')?.fails, 1);
        assert.equal(rl.size, 1);
        // 跨过一个 CLEANUP_MS 后再来一次失败 → 触发清理分支
        now += 11 * 60 * 1000;
        assert.equal(auth.authorize(fakeReq('10.0.0.2'), {}).ok, false);
        assert.equal(rl.has('10.0.0.1'), false, 'fails=1、lockedUntil=0 的条目解锁后必须可回收（旧条件 rl.fails===0 让它永久驻留）');
        assert.equal(rl.size, 1);
    }
    finally {
        Date.now = realNow;
    }
});
test('C-01: 失败表有硬上限，分布式爆破不能无界撑大', () => {
    const auth = new AdminAuth('correct-admin-token');
    const rl = auth.rateLimits;
    for (let i = 0; i < 50_050; i++) {
        auth.authorize(fakeReq(`10.1.${(i >> 8) & 255}.${i & 255}`), {});
    }
    assert.ok(rl.size <= 50_000, `rateLimits 必须在硬上限内（实际 ${rl.size}）`);
});
/* ==================== C-02 / M-02 / M-07 ==================== */
test('C-02: label 唯一性在 create 与 update 两个入口必须等价', () => {
    const store = new MemoryStore();
    const keys = new KeyRegistry({ config: memoryConfig(), store, logger: new Logger('error') });
    const a = keys.create({ tier: 'standard', tenantId: 'default', label: 'team-a' });
    const b = keys.create({ tier: 'standard', tenantId: 'default', label: 'team-b' });
    assert.throws(() => keys.create({ tier: 'standard', tenantId: 'default', label: 'team-a' }), /已存在/, 'create 的 label 约束（既有行为）');
    keys.update(a.record.id, { label: 'team-a2' });
    assert.throws(() => keys.update(b.record.id, { label: 'team-a2' }), /已存在/, 'update 必须与 create 同约束 —— 旧实现从这里可以绕过唯一性');
    // 改成自己原本的 label 不该报错（exceptId 口径）
    keys.update(b.record.id, { label: 'team-b' });
});
test('M-02: 自定义 secret 过短必须报错，不能静默换成随机值', () => {
    const store = new MemoryStore();
    const keys = new KeyRegistry({ config: memoryConfig(), store, logger: new Logger('error') });
    assert.throws(() => keys.create({ tier: 'standard', tenantId: 'default', secret: 'short' }), /至少 8/);
    const ok = keys.create({ tier: 'standard', tenantId: 'default', secret: 'a-sufficiently-long-secret' });
    assert.equal(ok.secret, 'a-sufficiently-long-secret', '合法 secret 必须被原样采用');
});
/* ==================== C-06 / M-09 ==================== */
test('C-06: SQLite 降级为内存时不得再往落盘缓冲里堆（否则无界增长）', () => {
    // 故意不 init() → this.db === undefined，模拟 SQLite 打不开、fail-open 降级为内存
    const s = new SqliteStore({ path: 'review-unused.db', batchSize: 10, flushIntervalMs: 1000 });
    for (let i = 0; i < 5_000; i++)
        s.record(meterRec(i));
    const buf = s.buffer;
    assert.equal(buf.length, 0, 'db 不可用时 buffer 必须保持为空（旧实现一直 push 且 flush 永不 splice）');
    assert.ok(s.records.length <= 50_000);
});
test('M-09: MemoryStore 明细有上限（driver=memory 不得无界增长）', () => {
    const m = new MemoryStore();
    for (let i = 0; i < 60_000; i++)
        m.record(meterRec(i));
    assert.equal(m.records.length, 50_000);
});
/* ============================ M-08 ============================ */
test('M-08: dropUsageOnlyFrames 必须把 cancel 传导到底层源流', async () => {
    let cancelled = false;
    const src = new ReadableStream({
        start(c) { c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"x"}}]}\n\n')); },
        cancel() { cancelled = true; },
    });
    const rd = dropUsageOnlyFrames(src).getReader();
    await rd.read();
    await rd.cancel('test');
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(cancelled, true, '包装流不传导 cancel → 上游流不会被销毁（继续付费）');
});
test('M-08: rewriteSseModel 必须把 cancel 传导到底层源流', async () => {
    let cancelled = false;
    const src = new ReadableStream({
        start(c) { c.enqueue(enc.encode('data: {"model":"other","choices":[]}\n\n')); },
        cancel() { cancelled = true; },
    });
    const rd = rewriteSseModel(src, 'm-target').getReader();
    await rd.read();
    await rd.cancel('test');
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(cancelled, true, '包装流不传导 cancel → 上游流不会被销毁');
});
/* ============================ M-11 ============================ */
test('M-11: dimensionStats 的维度白名单对原型链键也安全', async () => {
    const s = new SqliteStore({ path: ':memory:', batchSize: 1000, flushIntervalMs: 1000 });
    await s.init();
    for (let i = 0; i < 50; i++)
        s.record(meterRec(i));
    await s.flush();
    try {
        // 'constructor' 不在白名单 → 回落 'model'；绝不能把 Object.prototype 的函数当列名拼进 SQL
        const r = s.dimensionStats(Date.now() - 3_600_000, 'constructor');
        assert.ok(r === undefined || r instanceof Map, '不得抛异常、不得注入');
    }
    finally {
        await s.close();
    }
});
/* ============================ L-01 ============================ */
test('L-01: timeSafeEqual 行为不变（长度不等也返回 false）', () => {
    assert.equal(timeSafeEqual('abc', 'abc'), true);
    assert.equal(timeSafeEqual('abc', 'abcd'), false);
    assert.equal(timeSafeEqual('', ''), true);
});
//# sourceMappingURL=review-fixes.test.js.map