/**
 * REQ-01 共享状态切片 · 单实例 / 内存实现 / 装配工厂 单元测试。
 *
 * 覆盖范围（对应 .codeartsdoer/plans/req01-shared-state/plan.md §5.2）：
 *  - 内存实现限流：窗口内单调自增、跨窗口独立重置、rateCount 只读；
 *  - 配额双口径独立（token / ¥ 互不冒充）、负增量夹零、换周期作废；
 *  - 熔断：达阈值开启、fatal 立即开启、noteSuccess / reset 清零、半开令牌唯一与 TTL；
 *  - fromStore 适配（委托既有 Store，零回归）与 init 恢复 / 容错；
 *  - createSharedState 装配分支（local / redis+runner / redis 缺 runner 回退）；
 *  - RedisSharedStateStore 单实例基础语义与 HGETALL 两种返回形态兼容。
 *
 * 运行：npm run build 后 `node --test "dist/test/shared-state.test.js"`（Node ≥ 22.5）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MemorySharedStateStore,
  RedisSharedStateStore,
  createSharedState,
  RATE_TTL_MS,
} from '../store/shared-state.js';
import type { RedisCommandRunner } from '../store/shared-state.js';
import type { Store } from '../store/index.js';
import { FakeRedis } from './fake-redis.js';

/* ------------------------------------------------------------------ *
 * 测试用最小 Store 桩：只实现 shared-state 依赖到的方法
 * ------------------------------------------------------------------ */
interface BreakerRow {
  openUntil: number;
  consecutiveFailures: number;
  lastReason?: string;
}

function makeStubStore() {
  const rate = new Map<string, number>();
  const breakers = new Map<string, BreakerRow>();
  let snapshot = { tokens: 10, costCny: 2, requests: 1 };
  const store = {
    incrRate(keyId: string, windowStartMs: number): number {
      const k = `${keyId}:${windowStartMs}`;
      const n = (rate.get(k) ?? 0) + 1;
      rate.set(k, n);
      return n;
    },
    rateCount(keyId: string, windowStartMs: number): number {
      return rate.get(`${keyId}:${windowStartMs}`) ?? 0;
    },
    quotaSnapshot(): { tokens: number; costCny: number; requests: number } {
      return { ...snapshot };
    },
    saveBreaker(id: string, s: BreakerRow): void {
      breakers.set(id, s);
    },
    loadBreakers(): Map<string, BreakerRow> {
      return new Map(breakers);
    },
  };
  return {
    store: store as unknown as Store,
    breakers,
    setSnapshot: (s: { tokens: number; costCny: number; requests: number }) => {
      snapshot = s;
    },
  };
}

/* ------------------------------------------------------------------ *
 * 内存实现 · 限流
 * ------------------------------------------------------------------ */
test('内存实现：限流窗口内原子自增，跨窗口独立重置', async () => {
  const s = new MemorySharedStateStore();
  const w1 = 1_000_000;
  const w2 = w1 + 60_000;
  assert.equal(await s.rateCount('k1', w1), 0, '初始计数为 0');
  assert.equal(await s.incrRate('k1', w1), 1);
  assert.equal(await s.incrRate('k1', w1), 2);
  assert.equal(await s.incrRate('k1', w1), 3);
  assert.equal(await s.rateCount('k1', w1), 3);
  // 跨窗口：计数独立，互不影响
  assert.equal(await s.incrRate('k1', w2), 1, '新窗口从 1 起算');
  assert.equal(await s.rateCount('k1', w1), 3, '旧窗口计数不受新窗口写入影响');
  assert.equal(await s.rateCount('k1', w2), 1);
});

test('内存实现：rateCount 只读，不产生计数副作用', async () => {
  const s = new MemorySharedStateStore();
  const w = 5;
  assert.equal(await s.rateCount('k', w), 0);
  assert.equal(await s.rateCount('k', w), 0, '多次只读仍为 0');
  await s.incrRate('k', w);
  assert.equal(await s.rateCount('k', w), 1, 'incrRate 后才反映到只读计数');
});

test('内存实现：限流计数超过上限（2 万）时按窗口回收过期键', async () => {
  const s = new MemorySharedStateStore();
  const oldWindow = 0;
  // 制造 >20000 个不同键，触发 pruneRate 的深层分支
  for (let i = 0; i < 20_001; i++) await s.incrRate(`bulk-${i}`, oldWindow);
  // 以明显更晚的窗口写入一次 → 触发回收
  await s.incrRate('bulk-current', oldWindow + RATE_TTL_MS + 1);
  assert.equal(await s.rateCount('bulk-1', oldWindow), 0, '过旧窗口的计数应被回收');
  assert.equal(
    await s.rateCount('bulk-current', oldWindow + RATE_TTL_MS + 1),
    1,
    '新窗口计数保留',
  );
});

/* ------------------------------------------------------------------ *
 * 内存实现 · 配额
 * ------------------------------------------------------------------ */
test('内存实现：配额 token 与 ¥ 双口径独立累加，互不冒充', async () => {
  const s = new MemorySharedStateStore();
  const p = 0;
  const a = await s.quotaConsume('kq', { tokens: 100 }, p);
  assert.equal(a.tokens, 100);
  assert.equal(a.costCny, 0, 'token 增量不得冒充 ¥ 口径');
  assert.equal(a.requests, 0);
  const b = await s.quotaConsume('kq', { costCny: 1.5 }, p);
  assert.equal(b.tokens, 100, '¥ 增量不得冒充 token 口径');
  assert.equal(b.costCny, 1.5);
  const c = await s.quotaConsume('kq', { requests: 3 }, p);
  assert.deepEqual(c, { tokens: 100, costCny: 1.5, requests: 3 });
});

test('内存实现：负增量被夹到 0，累计量不倒退（余额不为负）', async () => {
  const s = new MemorySharedStateStore();
  const p = 0;
  await s.quotaConsume('k', { tokens: 50, costCny: 2 }, p);
  const after = await s.quotaConsume('k', { tokens: -100, costCny: -5, requests: -1 }, p);
  assert.equal(after.tokens, 50, '负 token 不得减少已用量');
  assert.equal(after.costCny, 2, '负 ¥ 不得减少已用量');
  assert.equal(after.requests, 0, '负 requests 夹到 0');
});

test('内存实现：periodStartMs 变化即换周期，旧叠加层作废', async () => {
  const s = new MemorySharedStateStore();
  await s.quotaConsume('k', { tokens: 10 }, 1000);
  assert.equal((await s.quotaSnapshot('k', 1000)).tokens, 10);
  const rotated = await s.quotaConsume('k', { tokens: 7 }, 2000);
  assert.equal(rotated.tokens, 7, '新周期从 0 起算');
  assert.equal((await s.quotaSnapshot('k', 1000)).tokens, 0, '旧周期快照已作废');
  assert.equal((await s.quotaSnapshot('k', 2000)).tokens, 7);
});

/* ------------------------------------------------------------------ *
 * 内存实现 · 熔断 / 半开
 * ------------------------------------------------------------------ */
test('内存实现：熔断达阈值开启，noteSuccess 完全清零', async () => {
  const s = new MemorySharedStateStore();
  const opts = { fatal: false, threshold: 3, cooldownMs: 10_000 };
  const f1 = await s.breakerNoteFailure('p1', 'upstream_timeout', opts);
  assert.equal(f1.consecutiveFailures, 1);
  assert.equal(f1.openUntil, 0, '未达阈值不熔断');
  assert.equal(f1.lastReason, 'upstream_timeout');
  await s.breakerNoteFailure('p1', 'upstream_timeout', opts);
  const f3 = await s.breakerNoteFailure('p1', 'upstream_timeout', opts);
  assert.equal(f3.consecutiveFailures, 3);
  assert.ok(f3.openUntil > Date.now(), '达阈值应立即熔断');
  const got = await s.breakerGet('p1');
  assert.equal(got?.openUntil, f3.openUntil);
  assert.equal(got?.consecutiveFailures, 3);
  await s.breakerNoteSuccess('p1');
  assert.equal(await s.breakerGet('p1'), undefined, '成功探针应完全清零');
});

test('内存实现：fatal 失败立即熔断（不等待阈值）', async () => {
  const s = new MemorySharedStateStore();
  const f = await s.breakerNoteFailure('p', 'auth_invalid', {
    fatal: true,
    threshold: 99,
    cooldownMs: 5000,
  });
  assert.ok(f.openUntil > Date.now(), 'fatal 应立即熔断');
  assert.equal(f.consecutiveFailures, 1);
  const got = await s.breakerGet('p');
  assert.equal(got?.lastReason, 'auth_invalid');
});

test('内存实现：breakerReset 清空熔断状态', async () => {
  const s = new MemorySharedStateStore();
  await s.breakerNoteFailure('p', 'upstream_unavailable', {
    fatal: true,
    threshold: 1,
    cooldownMs: 1000,
  });
  assert.ok((await s.breakerGet('p')) !== undefined);
  await s.breakerReset('p');
  assert.equal(await s.breakerGet('p'), undefined, 'reset 后读不到状态');
});

test('内存实现：半开令牌实例内唯一，TTL 过期后可再取', async () => {
  const s = new MemorySharedStateStore();
  assert.equal(await s.breakerAcquireHalfOpen('p', 5), true);
  assert.equal(await s.breakerAcquireHalfOpen('p', 5), false, '令牌仍被占用时不得再取');
  await new Promise((r) => setTimeout(r, 12));
  assert.equal(await s.breakerAcquireHalfOpen('p', 5), true, '令牌过期后应可再取');
});

test('内存实现：health 报告 local/ok，close 幂等可重入', async () => {
  const s = new MemorySharedStateStore();
  const h = s.health();
  assert.equal(h.backend, 'local');
  assert.equal(h.ok, true);
  assert.equal(h.degradedEvents, 0);
  await s.close();
  await s.close();
});

/* ------------------------------------------------------------------ *
 * fromStore 适配（零回归）+ init
 * ------------------------------------------------------------------ */
test('MemorySharedStateStore.fromStore：限流/配额/熔断委托既有 Store', async () => {
  const stub = makeStubStore();
  const s = MemorySharedStateStore.fromStore(stub.store);
  const w = 42;
  assert.equal(await s.incrRate('k', w), 1);
  assert.equal(await s.incrRate('k', w), 2);
  assert.equal(await s.rateCount('k', w), 2, '限流走 Store.incrRate/rateCount');
  const base = await s.quotaSnapshot('kq', 0);
  assert.deepEqual(base, { tokens: 10, costCny: 2, requests: 1 }, '无本地增量时即 Store 快照');
  await s.quotaConsume('kq', { tokens: 5 }, 0);
  assert.equal((await s.quotaSnapshot('kq', 0)).tokens, 15, '叠加层与 Store 快照合并');
  await s.breakerNoteFailure('p', 'upstream_timeout', {
    fatal: true,
    threshold: 1,
    cooldownMs: 1000,
  });
  assert.ok(stub.breakers.has('p'), '熔断状态应经 saveBreaker 持久化回 Store');
});

test('MemorySharedStateStore.init：从 Store.loadBreakers 恢复熔断状态', async () => {
  const stub = makeStubStore();
  stub.breakers.set('p9', { openUntil: 999, consecutiveFailures: 2, lastReason: 'upstream_timeout' });
  const s = MemorySharedStateStore.fromStore(stub.store);
  await s.init();
  const got = await s.breakerGet('p9');
  assert.equal(got?.openUntil, 999);
  assert.equal(got?.consecutiveFailures, 2);
  assert.equal(got?.lastReason, 'upstream_timeout');
});

test('MemorySharedStateStore.init：Store.loadBreakers 抛错时不阻断启动（fail-open）', async () => {
  const bad = {
    loadBreakers: () => {
      throw new Error('boom');
    },
  } as unknown as Store;
  const s = new MemorySharedStateStore({ store: bad });
  await s.init(); // 不应抛出
  assert.equal(await s.breakerGet('x'), undefined);
});

test('内存实现：saveBreaker 抛错时不阻断熔断判定（persist fail-open）', async () => {
  const bad = {
    saveBreaker: () => {
      throw new Error('disk full');
    },
  } as unknown as Store;
  const s = new MemorySharedStateStore({ store: bad });
  const f = await s.breakerNoteFailure('p', 'upstream_timeout', {
    fatal: true,
    threshold: 1,
    cooldownMs: 1000,
  });
  assert.ok(f.openUntil > Date.now(), '持久化失败不得影响熔断判定');
  assert.ok((await s.breakerGet('p')) !== undefined);
  await s.breakerNoteSuccess('p'); // 不应抛出
  assert.equal(await s.breakerGet('p'), undefined, '清除后读不到状态');
});

/* ------------------------------------------------------------------ *
 * createSharedState 装配工厂
 * ------------------------------------------------------------------ */
test('createSharedState：默认与显式 local 均返回内存实现', () => {
  assert.equal(createSharedState({}).health().backend, 'local');
  assert.equal(
    createSharedState({ state: { backend: 'local', failOpenOnRedisDown: true } }).health().backend,
    'local',
  );
});

test('createSharedState：backend=redis 但未注入 runner → 告警并强制回退内存', () => {
  const warns: string[] = [];
  const s = createSharedState(
    { state: { backend: 'redis', failOpenOnRedisDown: true } },
    { logger: { warn: (event) => warns.push(event) } },
  );
  assert.equal(s.health().backend, 'local', '缺 runner 时硬依赖在代码层不可达');
  assert.ok(warns.includes('state.redis_runner_missing'), '应发出缺失 runner 的告警');
});

test('createSharedState：backend=redis 且注入 runner → Redis 适配（keyPrefix 生效）', async () => {
  const redis = new FakeRedis();
  const s = createSharedState(
    { state: { backend: 'redis', failOpenOnRedisDown: true, keyPrefix: 't:' } },
    { redisRunner: redis.run },
  );
  assert.equal(s.health().backend, 'shared');
  assert.equal(await s.incrRate('k', 0), 1);
  assert.ok(redis.exists('t:rl:k:0'), 'keyPrefix 应作用于键命名空间');
});

test('createSharedState：注入 store 时走 fromStore 适配（委托既有 Store）', async () => {
  const stub = makeStubStore();
  const s = createSharedState(
    { state: { backend: 'local', failOpenOnRedisDown: true } },
    { store: stub.store },
  );
  assert.equal(await s.incrRate('k', 1), 1);
  assert.equal(await s.incrRate('k', 1), 2);
});

/* ------------------------------------------------------------------ *
 * RedisSharedStateStore · 单实例基础语义
 * ------------------------------------------------------------------ */
test('RedisSharedStateStore：单实例限流/配额/熔断基本语义', async () => {
  const redis = new FakeRedis();
  const s = new RedisSharedStateStore({ runner: redis.run });
  await s.init();

  const w = 1000;
  assert.equal(await s.incrRate('k', w), 1);
  assert.equal(await s.incrRate('k', w), 2);
  assert.equal(await s.rateCount('k', w), 2);

  const q1 = await s.quotaConsume('kq', { tokens: 30, costCny: 0.5, requests: 1 }, 0);
  assert.deepEqual(q1, { tokens: 30, costCny: 0.5, requests: 1 });
  const q2 = await s.quotaConsume('kq', { tokens: 20 }, 0);
  assert.equal(q2.tokens, 50);
  assert.equal(q2.requests, 1, '未传 requests 不增加');
  const snap = await s.quotaSnapshot('kq', 0);
  assert.equal(snap.tokens, 50);
  assert.equal(snap.costCny, 0.5);

  const f = await s.breakerNoteFailure('p', 'upstream_timeout', {
    fatal: true,
    threshold: 5,
    cooldownMs: 8000,
  });
  assert.ok(f.openUntil > Date.now());
  const got = await s.breakerGet('p');
  assert.equal(got?.openUntil, f.openUntil, '熔断状态跨命令可读');
  assert.equal(got?.lastReason, 'upstream_timeout');

  assert.equal(await s.breakerAcquireHalfOpen('p', 1000), true);
  assert.equal(await s.breakerAcquireHalfOpen('p', 1000), false);

  await s.breakerNoteSuccess('p');
  assert.equal(await s.breakerGet('p'), undefined);

  await s.close();
  const h = s.health();
  assert.equal(h.backend, 'shared');
  assert.equal(h.ok, true);
});

test('RedisSharedStateStore：breakerGet 对未记录/零值状态返回 undefined', async () => {
  const redis = new FakeRedis();
  const s = new RedisSharedStateStore({ runner: redis.run });
  assert.equal(await s.breakerGet('none'), undefined, '空哈希 → undefined');
  await redis.run('HSET', ['relay:brk:zero', 'fail', '0']);
  await redis.run('HSET', ['relay:brk:zero', 'openUntil', '0']);
  assert.equal(await s.breakerGet('zero'), undefined, 'fail=0 且 openUntil=0 视为未熔断');
});

test('RedisSharedStateStore：HGETALL 返回对象形态也能解析（toFieldMap 兼容）', async () => {
  const objRunner: RedisCommandRunner = async (command) => {
    if (command.toUpperCase() === 'HGETALL') {
      return { fail: '2', openUntil: '123456', lastReason: 'upstream_timeout' };
    }
    if (command.toUpperCase() === 'DEL') return 1;
    return null;
  };
  const s = new RedisSharedStateStore({ runner: objRunner });
  const got = await s.breakerGet('p');
  assert.equal(got?.consecutiveFailures, 2);
  assert.equal(got?.openUntil, 123456);
  assert.equal(got?.lastReason, 'upstream_timeout');
  await s.breakerReset('p'); // 覆盖 DEL 成功路径
});