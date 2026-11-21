/**
 * 批次3 · 并发闸门原语（SharedStateStore.concurrency*）单元测试。
 *
 * 覆盖内存实现的跨实例闸门语义（Redis 实现走同一接口，差异仅在"共享后端"）：
 *  - acquire 到 limit 前放行、达 limit 后拒绝；
 *  - release 幂等、计数不低于 0；
 *  - count 只读；不同 key 独立。
 *
 * 说明：内存实现为**进程内**计数（单实例语义）；跨实例共享需 `state.backend=redis` 且注入
 * RedisCommandRunner（Lua 原子脚本见 store/shared-state.ts）。
 *
 * 运行：npm run build 后 `node --test "dist/test/concurrency-lease.test.js"`。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemorySharedStateStore, createSharedState } from '../store/shared-state.js';
import { ConcurrencyLimiter } from '../upstream/pool.js';
test('并发闸门：达 limit 前放行，达 limit 后拒绝', async () => {
    const s = new MemorySharedStateStore();
    assert.equal(await s.concurrencyAcquire('k', 2, 30_000), true);
    assert.equal(await s.concurrencyAcquire('k', 2, 30_000), true);
    assert.equal(await s.concurrencyAcquire('k', 2, 30_000), false, '已达上限应拒绝');
    assert.equal(await s.concurrencyCount('k'), 2);
});
test('并发闸门：release 幂等且计数不低于 0', async () => {
    const s = new MemorySharedStateStore();
    await s.concurrencyAcquire('k', 4, 30_000);
    await s.concurrencyAcquire('k', 4, 30_000);
    assert.equal(await s.concurrencyCount('k'), 2);
    await s.concurrencyRelease('k');
    assert.equal(await s.concurrencyCount('k'), 1);
    await s.concurrencyRelease('k');
    await s.concurrencyRelease('k'); // 多释放一次（幂等）
    assert.equal(await s.concurrencyCount('k'), 0, '空计数保持 0（不产生负数）');
});
test('并发闸门：不同 key 独立计数', async () => {
    const s = new MemorySharedStateStore();
    await s.concurrencyAcquire('a', 1, 30_000);
    assert.equal(await s.concurrencyAcquire('a', 1, 30_000), false);
    assert.equal(await s.concurrencyAcquire('b', 1, 30_000), true, '另一个 key 不受影响');
    assert.equal(await s.concurrencyCount('a'), 1);
    assert.equal(await s.concurrencyCount('b'), 1);
});
test('并发闸门：释放后可再次获得（名额回收）', async () => {
    const s = new MemorySharedStateStore();
    assert.equal(await s.concurrencyAcquire('k', 1, 30_000), true);
    assert.equal(await s.concurrencyAcquire('k', 1, 30_000), false);
    await s.concurrencyRelease('k');
    assert.equal(await s.concurrencyAcquire('k', 1, 30_000), true, '释放后名额可复用');
});
test('createSharedState：backend=local 返回内存实现，具备并发闸门接口', async () => {
    const s = createSharedState({ state: { backend: 'local', failOpenOnRedisDown: true } });
    assert.equal(typeof s.concurrencyAcquire, 'function');
    assert.equal(await s.concurrencyAcquire('x', 1, 30_000), true);
    assert.equal(await s.concurrencyAcquire('x', 1, 30_000), false);
});
/* ---------------- ConcurrencyLimiter 共享排队（REQ-01） ---------------- */
test('ConcurrencyLimiter 共享排队：全局满则等待，释放后获得', async () => {
    const store = new MemorySharedStateStore();
    const lim = new ConcurrencyLimiter(2, { store, key: 'k', ttlMs: 30_000 });
    const r1 = await lim.acquire();
    const r2 = await lim.acquire();
    assert.equal(await store.concurrencyCount('k'), 2, '全局计数 = 2');
    let acquired = false;
    const p3 = lim.acquire().then((r) => {
        acquired = true;
        return r;
    });
    await new Promise((res) => setTimeout(res, 150));
    assert.equal(acquired, false, '全局满 → 排队等待（未获得）');
    r1();
    const r3 = await p3;
    assert.equal(acquired, true, '释放一个名额后排队者获得');
    assert.equal(await store.concurrencyCount('k'), 2);
    r2();
    r3();
    await new Promise((res) => setTimeout(res, 20));
    assert.equal(await store.concurrencyCount('k'), 0, '全部释放后归零');
});
test('ConcurrencyLimiter 共享排队：signal 中断抛 aborted', async () => {
    const store = new MemorySharedStateStore();
    const lim = new ConcurrencyLimiter(1, { store, key: 'k2', ttlMs: 30_000 });
    const r1 = await lim.acquire();
    const ac = new AbortController();
    const p = lim.acquire(ac.signal);
    await new Promise((res) => setTimeout(res, 70));
    ac.abort();
    await assert.rejects(p, /aborted/, '排队期间中断应抛 aborted');
    r1();
});
test('ConcurrencyLimiter：未注入共享后端时保持进程内排队（零回归）', async () => {
    const lim = new ConcurrencyLimiter(1);
    const r1 = await lim.acquire();
    assert.equal(lim.stats().active, 1);
    let acquired = false;
    const p2 = lim.acquire().then((r) => {
        acquired = true;
        return r;
    });
    await new Promise((res) => setTimeout(res, 20));
    assert.equal(acquired, false, '本地排队等待');
    r1();
    const r2 = await p2;
    assert.equal(acquired, true);
    r2();
});
//# sourceMappingURL=concurrency-lease.test.js.map