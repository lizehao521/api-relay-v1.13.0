/**
 * REQ-01 共享状态切片 · 双实例一致性 / fail-open / 边界 单元测试。
 *
 * 覆盖范围（对应 .codeartsdoer/plans/req01-shared-state/plan.md §5.3 / §5.4）：
 *  - 双实例共享同一 FakeRedis（模拟"两进程连同一 Redis"）下的限流 / 配额 / 熔断状态一致性；
 *  - 熔断跨实例可见、半开令牌全局唯一（含并发抢占）；
 *  - 重启后状态（共享后端保留 vs 内存实现归零）；
 *  - fail-open 降级（全挂 / 短暂抖动后恢复）与 fail-close（显式关闭时抛出）；
 *  - 边界：并发无超发、超限第 rpm+1 次被拒。
 *
 * 运行：npm run build 后 `node --test "dist/test/shared-state-multi.test.js"`（Node ≥ 22.5）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemorySharedStateStore, RedisSharedStateStore } from '../store/shared-state.js';
import { FakeRedis, failingRunner, flakyRunner } from './fake-redis.js';
const WINDOW = 1_700_000_000_000;
const PERIOD = 1_700_000_000_000;
/* ------------------------------------------------------------------ *
 * 双实例 · 限流一致性（AC-01）
 * ------------------------------------------------------------------ */
test('双实例 · 限流对拍：共享后端下总放行数恰好等于 rpm（不随实例数放大）', async () => {
    const redis = new FakeRedis();
    const a = new RedisSharedStateStore({ runner: redis.run });
    const b = new RedisSharedStateStore({ runner: redis.run });
    const rpm = 100;
    const attempts = 200;
    const results = await Promise.all(Array.from({ length: attempts }, (_, i) => (i % 2 === 0 ? a : b).incrRate('shared-key', WINDOW)));
    const allowed = results.filter((n) => n <= rpm).length;
    assert.equal(allowed, rpm, `恰好放行 rpm=${rpm} 次（多实例不放大）`);
    assert.equal(results.filter((n) => n > rpm).length, attempts - rpm, '其余全部被拒');
    assert.equal(new Set(results).size, attempts, '并发下每次自增返回唯一计数（无竞态）');
    // 两个实例读到同一窗口计数
    assert.equal(await a.rateCount('shared-key', WINDOW), attempts);
    assert.equal(await b.rateCount('shared-key', WINDOW), attempts);
});
test('双实例 · 限流计数跨实例可见：A 写入，B 只读即见', async () => {
    const redis = new FakeRedis();
    const a = new RedisSharedStateStore({ runner: redis.run });
    const b = new RedisSharedStateStore({ runner: redis.run });
    assert.equal(await b.rateCount('k', WINDOW), 0, '初始 B 读到 0');
    await a.incrRate('k', WINDOW);
    await a.incrRate('k', WINDOW);
    assert.equal(await b.rateCount('k', WINDOW), 2, 'B 立即读到 A 写入的共享计数');
});
/* ------------------------------------------------------------------ *
 * 双实例 · 配额一致性（AC-02）
 * ------------------------------------------------------------------ */
test('双实例 · 配额对拍：A 消费，B 立即读到同一余额（token / ¥ 双口径）', async () => {
    const redis = new FakeRedis();
    const a = new RedisSharedStateStore({ runner: redis.run });
    const b = new RedisSharedStateStore({ runner: redis.run });
    const budgetTokens = 1000;
    await a.quotaConsume('qk', { tokens: 300, costCny: 1 }, PERIOD);
    await b.quotaConsume('qk', { tokens: 300, costCny: 1 }, PERIOD);
    await a.quotaConsume('qk', { tokens: 300, costCny: 1 }, PERIOD);
    const fromB = await b.quotaSnapshot('qk', PERIOD);
    assert.equal(fromB.tokens, 900, '跨实例 token 余额一致');
    assert.equal(fromB.costCny, 3, '跨实例 ¥ 余额一致');
    assert.ok(fromB.tokens <= budgetTokens, '余额未越预算');
    // 模拟闸门判定：再消费 200 会越过预算 → 网关应拒绝（快照判定）
    assert.equal(fromB.tokens + 200 > budgetTokens, true, '临界判定：下一次应被拒');
});
test('双实例 · 配额并发消费：余额不为负且累计精确等于消费总量', async () => {
    const redis = new FakeRedis();
    const a = new RedisSharedStateStore({ runner: redis.run });
    const b = new RedisSharedStateStore({ runner: redis.run });
    const perCall = { tokens: 10, costCny: 0.5 };
    const callsPerInstance = 50;
    await Promise.all(Array.from({ length: callsPerInstance * 2 }, (_, i) => (i % 2 === 0 ? a : b).quotaConsume('qk', perCall, PERIOD)));
    const snap = await b.quotaSnapshot('qk', PERIOD);
    assert.equal(snap.tokens, 10 * callsPerInstance * 2, '并发累加后 token 精确无丢失');
    assert.equal(snap.costCny, 0.5 * callsPerInstance * 2, '并发累加后 ¥ 精确无丢失');
    assert.ok(snap.tokens >= 0 && snap.costCny >= 0, '余额不为负');
});
/* ------------------------------------------------------------------ *
 * 双实例 · 熔断 / 半开一致性（AC-05 / AC-06）
 * ------------------------------------------------------------------ */
test('双实例 · 熔断全局生效：A 触发熔断，B 立即感知同一 openUntil', async () => {
    const redis = new FakeRedis();
    const a = new RedisSharedStateStore({ runner: redis.run });
    const b = new RedisSharedStateStore({ runner: redis.run });
    const opts = { fatal: false, threshold: 2, cooldownMs: 20_000 };
    await a.breakerNoteFailure('prov', 'upstream_unavailable', opts);
    const seenByB = await b.breakerGet('prov');
    assert.equal(seenByB?.consecutiveFailures, 1, 'B 能看到 A 的失败累积');
    assert.equal(seenByB?.openUntil, 0, '未达阈值不熔断');
    const f2 = await b.breakerNoteFailure('prov', 'upstream_unavailable', opts);
    assert.ok(f2.openUntil > Date.now(), '跨实例累加后达阈值熔断');
    const aView = await a.breakerGet('prov');
    assert.equal(aView?.openUntil, f2.openUntil, 'A、B 读到同一 openUntil');
    assert.ok((aView?.openUntil ?? 0) > 0);
});
test('双实例 · 半开令牌全局唯一：同一时刻仅一个实例拿到试探令牌', async () => {
    const redis = new FakeRedis();
    const a = new RedisSharedStateStore({ runner: redis.run });
    const b = new RedisSharedStateStore({ runner: redis.run });
    assert.equal(await a.breakerAcquireHalfOpen('prov', 30), true, 'A 先抢到');
    assert.equal(await b.breakerAcquireHalfOpen('prov', 30), false, 'B 不得同时抢到');
    await new Promise((r) => setTimeout(r, 45));
    assert.equal(await b.breakerAcquireHalfOpen('prov', 30), true, '令牌过期后 B 可再抢');
});
test('双实例 · 半开令牌并发抢占：恰好一个实例成功（SET NX 原子）', async () => {
    const redis = new FakeRedis();
    const a = new RedisSharedStateStore({ runner: redis.run });
    const b = new RedisSharedStateStore({ runner: redis.run });
    const grants = await Promise.all([
        a.breakerAcquireHalfOpen('prov', 1000),
        b.breakerAcquireHalfOpen('prov', 1000),
    ]);
    assert.equal(grants.filter(Boolean).length, 1, '全局仅一个试探令牌');
});
/* ------------------------------------------------------------------ *
 * 重启后状态（边界）
 * ------------------------------------------------------------------ */
test('重启边界：新建适配实例读同一共享后端，限流/熔断仍在（对照：内存归零）', async () => {
    const redis = new FakeRedis();
    const first = new RedisSharedStateStore({ runner: redis.run });
    await first.incrRate('k', 5);
    await first.incrRate('k', 5);
    await first.breakerNoteFailure('prov', 'upstream_timeout', {
        fatal: true,
        threshold: 1,
        cooldownMs: 60_000,
    });
    // 模拟进程重启：新建适配实例，指向同一 FakeRedis
    const restarted = new RedisSharedStateStore({ runner: redis.run });
    assert.equal(await restarted.rateCount('k', 5), 2, '限流计数在重启后仍在');
    const brk = await restarted.breakerGet('prov');
    assert.ok(brk !== undefined && brk.openUntil > 0, '熔断状态在重启后仍在');
    // 对照：纯内存实现无共享，重启即归零
    const m1 = new MemorySharedStateStore();
    await m1.incrRate('k', 5);
    await m1.breakerNoteFailure('prov', 'upstream_timeout', {
        fatal: true,
        threshold: 1,
        cooldownMs: 60_000,
    });
    const m2 = new MemorySharedStateStore();
    assert.equal(await m2.rateCount('k', 5), 0, '内存实现重启后归零');
    assert.equal(await m2.breakerGet('prov'), undefined);
});
/* ------------------------------------------------------------------ *
 * fail-open / fail-close
 * ------------------------------------------------------------------ */
test('fail-open：共享后端全挂时降级放行，degradedEvents 递增且健康度不 ok', async () => {
    const fr = failingRunner({ always: true });
    const s = new RedisSharedStateStore({ runner: fr.run }); // failOpenOnRedisDown 默认 true
    assert.equal(await s.incrRate('k', WINDOW), 1, '降级到本地镜像，计数为 1');
    assert.equal(await s.incrRate('k', WINDOW), 2, '本地镜像持续可用，不抛错');
    assert.equal(await s.rateCount('k', WINDOW), 2);
    const h = s.health();
    assert.equal(h.backend, 'shared');
    assert.equal(h.ok, false, '后端不可用 → 健康度下降');
    assert.ok(h.degradedEvents >= 3, '每次失败调用都应计一次降级');
    assert.ok((h.lastError ?? '').includes('redis down'));
    assert.ok(fr.calls() > 0, '确认底层 runner 被真实调用');
});
test('fail-open：配额消费降级到本地镜像，累计不丢且余额不为负', async () => {
    const fr = failingRunner({ always: true });
    const s = new RedisSharedStateStore({ runner: fr.run });
    const q1 = await s.quotaConsume('qk', { tokens: 40, costCny: 2 }, PERIOD);
    const q2 = await s.quotaConsume('qk', { tokens: 10 }, PERIOD);
    assert.equal(q1.tokens, 40);
    assert.equal(q2.tokens, 50, '降级期间本地镜像仍持续累加');
    assert.equal(q2.costCny, 2);
    assert.ok(q2.tokens >= 0, '余额不为负');
    assert.ok(s.health().degradedEvents >= 2);
});
test('fail-open：熔断写入降级到本地镜像，仍返回可判定状态', async () => {
    const fr = failingRunner({ always: true });
    const s = new RedisSharedStateStore({ runner: fr.run });
    const f = await s.breakerNoteFailure('prov', 'upstream_timeout', {
        fatal: true,
        threshold: 1,
        cooldownMs: 5000,
    });
    assert.ok(f.openUntil > Date.now(), '降级后仍基于本地镜像判定熔断');
    assert.equal(f.lastReason, 'upstream_timeout');
    const got = await s.breakerGet('prov');
    assert.ok(got !== undefined && got.openUntil > 0);
});
test('fail-open 恢复：短暂抖动后自动恢复，lastError 清空且健康归位', async () => {
    const redis = new FakeRedis();
    const runner = flakyRunner(redis, 2); // 前 2 次底层调用失败
    const s = new RedisSharedStateStore({ runner });
    assert.equal(await s.incrRate('k', WINDOW), 1, '首次降级放行');
    assert.equal(s.health().ok, false, '降级期间健康度下降');
    assert.ok(s.health().degradedEvents >= 1);
    await s.incrRate('k', WINDOW); // 第 2 次仍失败 → 继续降级
    assert.ok(s.health().degradedEvents >= 2);
    const n = await s.incrRate('k', WINDOW); // 之后恢复
    assert.equal(n, 1, '恢复后走真实共享后端，计数从 1 开始（此前只写本地镜像）');
    const h = s.health();
    assert.equal(h.ok, true, '恢复后健康度归位');
    assert.equal(h.lastError, undefined, 'lastError 应被清空');
});
test('fail-open：熔断清除与半开令牌在降级下仍可用（本地镜像，不抛错）', async () => {
    const fr = failingRunner({ always: true });
    const s = new RedisSharedStateStore({ runner: fr.run });
    assert.equal(await s.breakerAcquireHalfOpen('prov', 1000), true, '降级后由本地镜像发放令牌');
    assert.equal(await s.breakerAcquireHalfOpen('prov', 1000), false, '本地镜像内仍保持唯一');
    await s.breakerNoteSuccess('prov'); // 降级路径，不应抛错
    await s.breakerReset('prov');
    assert.equal(await s.breakerGet('prov'), undefined);
    assert.ok(s.health().degradedEvents >= 4, '上述调用均计入降级次数');
});
test('fail-close（显式关闭）：共享后端不可用时原样抛出，绝不静默放行', async () => {
    const fr = failingRunner({ always: true });
    const s = new RedisSharedStateStore({ runner: fr.run, failOpenOnRedisDown: false });
    await assert.rejects(() => s.incrRate('k', WINDOW), /redis down/);
    const h = s.health();
    assert.equal(h.ok, false);
    assert.ok(h.degradedEvents >= 1, '失败仍被记录');
});
/* ------------------------------------------------------------------ *
 * 边界 · 并发无超发 / 超限第 rpm+1 被拒
 * ------------------------------------------------------------------ */
test('并发边界：两实例并发 incrRate 无超发，计数唯一且总放行恰好 rpm', async () => {
    const redis = new FakeRedis();
    const a = new RedisSharedStateStore({ runner: redis.run });
    const b = new RedisSharedStateStore({ runner: redis.run });
    const rpm = 20;
    const attempts = 100;
    const results = await Promise.all(Array.from({ length: attempts }, (_, i) => (i % 2 ? a : b).incrRate('c', 999)));
    assert.equal(new Set(results).size, attempts, '并发下每次自增返回唯一值（无竞态）');
    assert.equal(results.filter((n) => n <= rpm).length, rpm, '恰好 rpm 次通过闸门');
    assert.equal(await a.rateCount('c', 999), attempts, '共享计数精确等于尝试总数');
});
test('超限边界：第 rpm+1 次恰好被拒（固定窗口）', async () => {
    const s = new MemorySharedStateStore();
    const rpm = 5;
    const decisions = [];
    for (let i = 0; i < rpm + 1; i++) {
        const n = await s.incrRate('k', 12345);
        decisions.push(n <= rpm);
    }
    assert.deepEqual(decisions, [true, true, true, true, true, false], '前 rpm 次放行，第 rpm+1 次拒绝');
    assert.equal(await s.rateCount('k', 12345), rpm + 1, '计数仍被如实记录');
});
//# sourceMappingURL=shared-state-multi.test.js.map