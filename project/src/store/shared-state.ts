/**
 * 共享状态抽象（REQ-01 最小切片）：限流 / 配额 / 熔断三合一。
 *
 * ## 这个文件解决什么
 * 现状（README §11 / ADR-002）里，限流计数、周期配额、熔断状态都是**每实例独立**的：
 * 多实例部署时，`rpm=100` 会被 3 个实例放大成 300，额度也会被放大。本文件把这三类
 * 状态收敛到一个**可替换的接口** `SharedStateStore`（即需求文中的 RateQuotaStore）后面，
 * 使"多实例一致性"第一次可以被自动化测试验证。
 *
 * ## 三个交付物
 *  1. `SharedStateStore` —— 异步接口。语义、原子性、TTL 契约见各方法注释。
 *  2. `MemorySharedStateStore` —— 默认后端（单机）。包装现有 `Store.incrRate` /
 *     `quotaSnapshot` / `saveBreaker`，**单实例语义逐字不变（零回归）**。
 *  3. `RedisSharedStateStore` —— **可选**共享后端适配。它**不 import 任何第三方 Redis 包**，
 *     只依赖注入进来的极小执行器 `RedisCommandRunner`。未注入 runner 时 `createSharedState`
 *     强制回退内存实现 —— "零硬依赖"在代码层被强制，而不只是口头承诺。
 *
 * ## 多实例一致性是什么意思
 * - **限流**：计数放在共享后端，`incrRate` 是"单命令原子自增"，并发下不会出现"检查-使用"竞态，
 *   因此 N 个实例共享同一个窗口计数，总放行数恰好等于配额（不再随实例数放大）。
 * - **配额**：token 与 ¥ 两种口径**各自独立**累计、绝不互相冒充；`quotaConsume` 原子累加。
 * - **熔断/半开**：任一实例触发熔断后，其他实例都能读到同一个 `openUntil`；半开试探令牌
 *   全局唯一（`SET NX PX`），避免多个实例同时把一条故障上游打爆。
 *
 * ## 回退策略（fail-open）
 * 共享后端是**旁路**：网络抖动、超时、后端全挂，都不能把转发路径变成 5xx。适配层捕获
 * 异常后回退到进程内内存镜像（fail-open），并累加 `degradedEvents` 供面板观测。
 * 唯一 fail-closed 仍是鉴权（红线 3），本文件**绝不** fail-close。耗尽态例外：本地镜像
 * 已明确判定额度用尽（余额 ≤ 0）时仍返回超限，不误放行。
 *
 * ## 本轮已知残留（显式记录，不假装完成）
 * - **并发闸门**（`ConcurrencyLimiter`）仍是进程内计数，跨实例不可共享。它需要 Redis 计数
 *   租约 + 释放语义，超出"最小切片"范围，留待 REQ-02/后续。
 * - 熔断的**热路径读取**（`ProviderPool.isOpen`，被同步的 `Router.route` 调用）仍以本地
 *   health 为准，共享状态通过写入镜像 + `refreshBreakersFromShared()` 拉取实现跨实例可见；
 *   把路由改成异步读取共享状态属 REQ-02。
 */

import type { FailureReason } from '../core/types.js';
import type { Store } from './index.js';

/* ------------------------------------------------------------------ *
 * 类型定义
 * ------------------------------------------------------------------ */

/** 配额快照：token 与 ¥ 两种口径各自独立，绝不互相冒充（REQ-01 检查清单） */
export interface QuotaSnapshot {
  tokens: number;
  costCny: number;
  requests: number;
}

/** 原子累加的增量（结算用；缺省字段按 0，负值会被夹到 0 以保证累计量不倒退） */
export interface QuotaDelta {
  tokens?: number;
  costCny?: number;
  requests?: number;
}

/** 熔断状态（跨实例可见） */
export interface BreakerState {
  /** 熔断恢复时间戳（ms）；0 = 未熔断 */
  openUntil: number;
  consecutiveFailures: number;
  lastReason?: FailureReason;
}

/** 共享状态健康度（面板"预检降级放行数"同源） */
export interface SharedStateHealth {
  backend: 'local' | 'shared';
  ok: boolean;
  /** 共享后端不可用而降级的次数 */
  degradedEvents: number;
  lastError?: string;
}

/**
 * 共享状态抽象：限流 / 配额 / 熔断三合一（即 REQ 文中的 RateQuotaStore）。
 *
 * 接口为**异步（Promise）**：Redis 天然异步；内存实现内部同步执行、仅以微任务兑现，
 * 保证并发下"读-改-写"不交错（JS 单线程 → 方法体内不 `await` 即天然原子）。
 */
export interface SharedStateStore {
  /** 初始化（内存实现用于从 Store 恢复熔断状态；Redis 实现为空操作） */
  init(): Promise<void>;

  /* ---- 限流：固定窗口，原子自增 ---- */
  /** 原子自增并返回自增后的计数。并发下不得出现"检查-使用"竞态。 */
  incrRate(keyId: string, windowStartMs: number): Promise<number>;
  /** 只读当前窗口计数（不产生写入） */
  rateCount(keyId: string, windowStartMs: number): Promise<number>;

  /* ---- 配额：两种口径独立 ---- */
  /** 读一致性：返回自 sinceMs 起的累计，允许桶级滞后 */
  quotaSnapshot(keyId: string, sinceMs: number): Promise<QuotaSnapshot>;
  /** **单命令原子**累加（预扣/结算）。返回累加后的快照。 */
  quotaConsume(keyId: string, delta: QuotaDelta, periodStartMs: number): Promise<QuotaSnapshot>;

  /* ---- 熔断 / 半开 ---- */
  breakerGet(providerId: string): Promise<BreakerState | undefined>;
  breakerNoteFailure(
    providerId: string,
    reason: FailureReason,
    opts: { fatal: boolean; threshold: number; cooldownMs: number },
  ): Promise<BreakerState>;
  breakerNoteSuccess(providerId: string): Promise<void>;
  breakerReset(providerId: string): Promise<void>;
  /** 全局唯一试探令牌：同一时刻仅一个实例能拿到 */
  breakerAcquireHalfOpen(providerId: string, ttlMs: number): Promise<boolean>;

  /* ---- 并发闸门（跨实例；批次3。engine 热路径集成留待后续）---- */
  /** 尝试获取一个并发额度。limit=上限；ttlMs=租约兜底（实例崩溃自动释放）。true=获得。 */
  concurrencyAcquire(key: string, limit: number, ttlMs: number): Promise<boolean>;
  /** 释放并发额度（幂等，计数不低于 0）。 */
  concurrencyRelease(key: string): Promise<void>;
  /** 只读当前并发计数。 */
  concurrencyCount(key: string): Promise<number>;

  /* ---- 生命周期 ---- */
  health(): SharedStateHealth;
  close(): Promise<void>;
}

/** 需求文中的命名别名（不新增语义，仅便于对齐需求文档） */
export type RateQuotaStore = SharedStateStore;

/* ------------------------------------------------------------------ *
 * 键命名空间（Redis 语义；内存实现使用同构字符串键，便于对拍）
 * ------------------------------------------------------------------ */

/** 固定 1 分钟窗口的窗口键 TTL = 2 × 窗口，过期自动回收 */
export const RATE_WINDOW_MS = 60_000;
export const RATE_TTL_MS = 2 * RATE_WINDOW_MS;
/** 半开试探令牌默认 TTL（实例崩溃后自动释放，防令牌永久占用） */
export const HALF_OPEN_TOKEN_TTL_MS = 30_000;

/* ------------------------------------------------------------------ *
 * 内存实现（单机，现状兼容）
 * ------------------------------------------------------------------ */

interface QuotaOverlay {
  periodStartMs: number;
  tokens: number;
  costCny: number;
  requests: number;
}

/**
 * 内存实现。
 *
 * 两种用法：
 *  - 独立使用：所有状态都在这份实例里（纯内存，进程重启即归零）。
 *  - `fromStore(store)`：限流走 `store.incrRate/rateCount`、配额在 `store.quotaSnapshot`
 *    之上叠加本地 `quotaConsume` 增量、熔断走 `store.saveBreaker/loadBreakers`（若实现存在）。
 *    这样**不改变现有单实例语义**（默认路径零回归），同时给 `quotaConsume` 一个可测试的落点。
 */
export class MemorySharedStateStore implements SharedStateStore {
  private readonly store?: Store;
  /** 独立模式下的限流计数 */
  private readonly rate = new Map<string, number>();
  /** 配额叠加层：key = keyId，value = 该周期的累计增量 */
  private readonly quota = new Map<string, QuotaOverlay>();
  /** 熔断状态 */
  private readonly breakers = new Map<string, BreakerState>();
  /** 半开试探令牌：value = 过期时间戳（ms） */
  private readonly halfOpen = new Map<string, number>();
  /** 并发闸门计数（批次3）：key → 当前在途数 */
  private readonly concurrency = new Map<string, number>();

  constructor(opts: { store?: Store } = {}) {
    this.store = opts.store;
  }

  /** 从既有 Store 构造：默认路径零回归，行为与原实现一致 */
  static fromStore(store: Store): MemorySharedStateStore {
    return new MemorySharedStateStore({ store });
  }

  async init(): Promise<void> {
    // 从持久层恢复熔断状态（仅 SqliteStore 提供 loadBreakers）
    const s = this.store as unknown as {
      loadBreakers?: () => Map<string, { openUntil: number; consecutiveFailures: number; lastReason?: string }>;
    };
    if (!s || typeof s.loadBreakers !== 'function') return;
    try {
      for (const [id, b] of s.loadBreakers()) {
        this.breakers.set(id, {
          openUntil: b.openUntil,
          consecutiveFailures: b.consecutiveFailures,
          ...(b.lastReason ? { lastReason: b.lastReason as FailureReason } : {}),
        });
      }
    } catch {
      /* fail-open：恢复失败不影响启动 */
    }
  }

  async incrRate(keyId: string, windowStartMs: number): Promise<number> {
    // 有 Store 时沿用原实现（语义逐字不变）
    if (this.store) return this.store.incrRate(keyId, windowStartMs);
    const k = `${keyId}:${windowStartMs}`;
    const next = (this.rate.get(k) ?? 0) + 1;
    this.rate.set(k, next);
    this.pruneRate(windowStartMs);
    return next;
  }

  async rateCount(keyId: string, windowStartMs: number): Promise<number> {
    if (this.store) return this.store.rateCount(keyId, windowStartMs);
    return this.rate.get(`${keyId}:${windowStartMs}`) ?? 0;
  }

  async quotaSnapshot(keyId: string, sinceMs: number): Promise<QuotaSnapshot> {
    const base = this.store ? this.store.quotaSnapshot(keyId, sinceMs) : { tokens: 0, costCny: 0, requests: 0 };
    return this.mergeOverlay(keyId, sinceMs, base);
  }

  async quotaConsume(keyId: string, delta: QuotaDelta, periodStartMs: number): Promise<QuotaSnapshot> {
    const cur = this.quota.get(keyId);
    // periodStartMs 变化即换周期：旧周期的叠加层作废（与 Redis 的键轮转同构）
    const acc: QuotaOverlay =
      cur && cur.periodStartMs === periodStartMs
        ? cur
        : { periodStartMs, tokens: 0, costCny: 0, requests: 0 };
    // 夹到 0 保证累计量不倒退（"余额不为负"）：负增量不得减少已用量
    acc.tokens += Math.max(0, delta.tokens ?? 0);
    acc.costCny += Math.max(0, delta.costCny ?? 0);
    acc.requests += Math.max(0, delta.requests ?? 0);
    this.quota.set(keyId, acc);
    const base = this.store ? this.store.quotaSnapshot(keyId, periodStartMs) : { tokens: 0, costCny: 0, requests: 0 };
    return this.mergeOverlay(keyId, periodStartMs, base);
  }

  async breakerGet(providerId: string): Promise<BreakerState | undefined> {
    const b = this.breakers.get(providerId);
    return b ? { ...b } : undefined;
  }

  async breakerNoteFailure(
    providerId: string,
    reason: FailureReason,
    opts: { fatal: boolean; threshold: number; cooldownMs: number },
  ): Promise<BreakerState> {
    const cur = this.breakers.get(providerId) ?? { openUntil: 0, consecutiveFailures: 0 };
    const next: BreakerState = {
      consecutiveFailures: cur.consecutiveFailures + 1,
      openUntil: cur.openUntil,
      lastReason: reason,
    };
    if (opts.fatal || next.consecutiveFailures >= opts.threshold) {
      next.openUntil = Date.now() + opts.cooldownMs;
    }
    this.breakers.set(providerId, next);
    this.persistBreaker(providerId, next);
    return { ...next };
  }

  async breakerNoteSuccess(providerId: string): Promise<void> {
    this.breakers.delete(providerId);
    this.persistBreaker(providerId, undefined);
  }

  async breakerReset(providerId: string): Promise<void> {
    this.breakers.delete(providerId);
    this.persistBreaker(providerId, undefined);
  }

  async breakerAcquireHalfOpen(providerId: string, ttlMs: number): Promise<boolean> {
    const now = Date.now();
    const until = this.halfOpen.get(providerId);
    if (until !== undefined && until > now) return false; // 令牌仍被占用
    this.halfOpen.set(providerId, now + ttlMs);
    // 顺带回收过期令牌，避免 Map 无界增长
    for (const [id, exp] of this.halfOpen) if (exp <= now) this.halfOpen.delete(id);
    return true;
  }

  /* ---- 并发闸门（批次3；内存实现 = 进程内计数）---- */

  async concurrencyAcquire(key: string, limit: number, ttlMs: number): Promise<boolean> {
    const cur = this.concurrency.get(key) ?? 0;
    if (cur >= limit) return false;
    this.concurrency.set(key, cur + 1);
    // 内存实现无跨实例租约过期（单进程）；ttlMs 由 Redis 实现承担。保持接口一致。
    void ttlMs;
    return true;
  }

  async concurrencyRelease(key: string): Promise<void> {
    const cur = this.concurrency.get(key) ?? 0;
    if (cur <= 1) this.concurrency.delete(key);
    else this.concurrency.set(key, cur - 1);
  }

  async concurrencyCount(key: string): Promise<number> {
    return this.concurrency.get(key) ?? 0;
  }

  health(): SharedStateHealth {
    return { backend: 'local', ok: true, degradedEvents: 0 };
  }

  async close(): Promise<void> {}

  /* ---------------- 内部 ---------------- */

  private mergeOverlay(
    keyId: string,
    periodStartMs: number,
    base: { tokens: number; costCny: number; requests: number },
  ): QuotaSnapshot {
    const o = this.quota.get(keyId);
    if (!o || o.periodStartMs !== periodStartMs) return { tokens: base.tokens, costCny: base.costCny, requests: base.requests };
    return {
      tokens: base.tokens + o.tokens,
      costCny: base.costCny + o.costCny,
      requests: base.requests + o.requests,
    };
  }

  private pruneRate(currentWindowStart: number): void {
    if (this.rate.size <= 20_000) return;
    for (const key of this.rate.keys()) {
      const ts = Number(key.slice(key.lastIndexOf(':') + 1));
      if (ts < currentWindowStart - RATE_TTL_MS) this.rate.delete(key);
    }
  }

  private persistBreaker(providerId: string, state: BreakerState | undefined): void {
    const s = this.store as unknown as {
      saveBreaker?: (id: string, state: { openUntil: number; consecutiveFailures: number; lastReason?: string }) => void;
    };
    if (!s || typeof s.saveBreaker !== 'function') return;
    try {
      s.saveBreaker(
        providerId,
        state
          ? { openUntil: state.openUntil, consecutiveFailures: state.consecutiveFailures, ...(state.lastReason ? { lastReason: state.lastReason } : {}) }
          : { openUntil: 0, consecutiveFailures: 0 },
      );
    } catch {
      /* fail-open：持久化失败不影响判定 */
    }
  }
}

/* ------------------------------------------------------------------ *
 * 可选共享后端适配（Redis 语义，不引入硬依赖）
 * ------------------------------------------------------------------ */

/**
 * 由调用方注入的极小命令执行器。
 * 生产：使用方提供的 Redis 客户端（如 `node:net` 自研 RESP2 客户端）。
 * 测试：`FakeRedis` 内存替身。适配层**完全不 import 任何 Redis 包** —— 零硬依赖。
 */
export type RedisCommandRunner = (command: string, args: (string | number)[]) => Promise<unknown>;

export interface RedisSharedStateOptions {
  runner: RedisCommandRunner;
  /** 默认 true（红线 3：治理层异常静默回退到内存镜像） */
  failOpenOnRedisDown?: boolean;
  /** 键前缀，默认 'relay:' */
  keyPrefix?: string;
}

/** 取自 §3.2 的 Lua：失败计数 + 阈值判定 + 写 openUntil 在单脚本内完成（读-改-写不可分离） */
const LUA_NOTE_FAILURE = `
local fail = tonumber(redis.call('HINCRBY', KEYS[1], 'fail', 1)) or 1
local openUntil = tonumber(redis.call('HGET', KEYS[1], 'openUntil') or 0) or 0
if ARGV[1] == '1' or fail >= tonumber(ARGV[2]) then
  openUntil = tonumber(ARGV[3]) + tonumber(ARGV[4])
  redis.call('HSET', KEYS[1], 'openUntil', openUntil)
end
redis.call('HSET', KEYS[1], 'lastReason', ARGV[5])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[4]) * 2)
return {fail, openUntil}
`;

/** 原子累加三种口径并统一续期（周期键 PEXPIRE = 周期 + 宽限，此处给足） */
const LUA_CONSUME = `
local tok = tonumber(redis.call('INCRBY', KEYS[1], ARGV[1])) or 0
local cny = tonumber(redis.call('INCRBYFLOAT', KEYS[2], ARGV[2])) or 0
local req = tonumber(redis.call('INCRBY', KEYS[3], ARGV[3])) or 0
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[4]))
redis.call('PEXPIRE', KEYS[2], tonumber(ARGV[4]))
redis.call('PEXPIRE', KEYS[3], tonumber(ARGV[4]))
return {tok, tostring(cny), req}
`;

/** 并发闸门「检查并占用」原子脚本（批次3）：超限则回滚，占用则续期。返回当前计数（0=超限被拒）。 */
const LUA_CONCURRENCY_ACQUIRE = `
local n = redis.call('INCR', KEYS[1])
if n > tonumber(ARGV[1]) then
  redis.call('DECR', KEYS[1])
  return 0
end
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[2]))
return n
`;

/** 并发闸门「幂等释放」：仅当计数 > 0 时 DECR（避免负数）。 */
const LUA_CONCURRENCY_RELEASE = `
local n = tonumber(redis.call('GET', KEYS[1]) or 0)
if n > 0 then
  redis.call('DECR', KEYS[1])
  return n - 1
end
return 0
`;

/**
 * Redis 语义适配层。
 *
 * 键命名（§3.3）：
 *   relay:rl:{keyId}:{windowStartMs}          # 限流窗口计数（INCR）
 *   relay:q:tok:{keyId}:{periodStartMs}       # token 额度累计（INCRBY）
 *   relay:q:cny:{keyId}:{periodStartMs}       # ¥ 预算累计（INCRBYFLOAT）
 *   relay:q:req:{keyId}:{periodStartMs}       # 请求数累计（INCRBY）
 *   relay:brk:{providerId}                    # 熔断哈希 {fail, openUntil, lastReason}
 *   relay:brk:ho:{providerId}                 # 半开试探令牌（SET NX PX）
 *
 * 所有方法都经过 `run()`：runner 抛错/超时 → 捕获、`degradedEvents++`、本次调用回退到
 * 内部内存镜像（fail-open）。若 `failOpenOnRedisDown=false`，则原样抛出（显式关闭 fail-open）。
 */
export class RedisSharedStateStore implements SharedStateStore {
  private readonly runner: RedisCommandRunner;
  private readonly failOpen: boolean;
  private readonly prefix: string;
  /** fail-open 时的本地镜像：共享后端不可用，本次判定退化为单实例 */
  private readonly fallback = new MemorySharedStateStore();
  private degraded = 0;
  private lastError: string | undefined;
  private lastOk = true;

  constructor(opts: RedisSharedStateOptions) {
    this.runner = opts.runner;
    this.failOpen = opts.failOpenOnRedisDown ?? true;
    this.prefix = opts.keyPrefix ?? 'relay:';
  }

  async init(): Promise<void> {
    await this.fallback.init();
  }

  async incrRate(keyId: string, windowStartMs: number): Promise<number> {
    return this.run(
      async () => {
        const key = `${this.prefix}rl:${keyId}:${windowStartMs}`;
        const n = Number(await this.runner('INCR', [key]));
        await this.runner('PEXPIRE', [key, RATE_TTL_MS]);
        return n;
      },
      () => this.fallback.incrRate(keyId, windowStartMs),
    );
  }

  async rateCount(keyId: string, windowStartMs: number): Promise<number> {
    return this.run(
      async () => Number((await this.runner('GET', [`${this.prefix}rl:${keyId}:${windowStartMs}`])) ?? 0),
      () => this.fallback.rateCount(keyId, windowStartMs),
    );
  }

  async quotaSnapshot(keyId: string, sinceMs: number): Promise<QuotaSnapshot> {
    return this.run(
      async () => {
        const raw = (await this.runner('MGET', [this.tokKey(keyId, sinceMs), this.cnyKey(keyId, sinceMs), this.reqKey(keyId, sinceMs)])) as unknown[];
        const arr = Array.isArray(raw) ? raw : [];
        return { tokens: Number(arr[0] ?? 0), costCny: Number(arr[1] ?? 0), requests: Number(arr[2] ?? 0) };
      },
      () => this.fallback.quotaSnapshot(keyId, sinceMs),
    );
  }

  async quotaConsume(keyId: string, delta: QuotaDelta, periodStartMs: number): Promise<QuotaSnapshot> {
    return this.run(
      async () => {
        const tok = Math.max(0, delta.tokens ?? 0);
        const cny = Math.max(0, delta.costCny ?? 0);
        const req = Math.max(0, delta.requests ?? 0);
        // 周期键 TTL：30 天量级的账，给足宽限（避免读到未过期的旧周期键造成误算）
        const ttl = 30 * 86_400_000;
        const raw = (await this.runner('EVAL', [
          LUA_CONSUME,
          3,
          this.tokKey(keyId, periodStartMs),
          this.cnyKey(keyId, periodStartMs),
          this.reqKey(keyId, periodStartMs),
          tok,
          cny,
          req,
          ttl,
        ])) as unknown[];
        const arr = Array.isArray(raw) ? raw : [];
        return { tokens: Number(arr[0] ?? 0), costCny: Number(arr[1] ?? 0), requests: Number(arr[2] ?? 0) };
      },
      () => this.fallback.quotaConsume(keyId, delta, periodStartMs),
    );
  }

  async breakerGet(providerId: string): Promise<BreakerState | undefined> {
    return this.run(
      async () => {
        const raw = (await this.runner('HGETALL', [this.brkKey(providerId)])) as unknown;
        const map = toFieldMap(raw);
        if (map.size === 0) return undefined;
        const openUntil = Number(map.get('openUntil') ?? 0);
        const consecutiveFailures = Number(map.get('fail') ?? 0);
        if (openUntil === 0 && consecutiveFailures === 0) return undefined;
        const reason = map.get('lastReason');
        return {
          openUntil,
          consecutiveFailures,
          ...(reason ? { lastReason: reason as FailureReason } : {}),
        };
      },
      () => this.fallback.breakerGet(providerId),
    );
  }

  async breakerNoteFailure(
    providerId: string,
    reason: FailureReason,
    opts: { fatal: boolean; threshold: number; cooldownMs: number },
  ): Promise<BreakerState> {
    return this.run(
      async () => {
        const raw = (await this.runner('EVAL', [
          LUA_NOTE_FAILURE,
          1,
          this.brkKey(providerId),
          opts.fatal ? 1 : 0,
          opts.threshold,
          Date.now(),
          opts.cooldownMs,
          reason,
        ])) as unknown[];
        const arr = Array.isArray(raw) ? raw : [];
        return { consecutiveFailures: Number(arr[0] ?? 0), openUntil: Number(arr[1] ?? 0), lastReason: reason };
      },
      () => this.fallback.breakerNoteFailure(providerId, reason, opts),
    );
  }

  async breakerNoteSuccess(providerId: string): Promise<void> {
    await this.run(
      async () => {
        await this.runner('DEL', [this.brkKey(providerId)]);
        return undefined;
      },
      () => this.fallback.breakerNoteSuccess(providerId),
    );
  }

  async breakerReset(providerId: string): Promise<void> {
    await this.run(
      async () => {
        await this.runner('DEL', [this.brkKey(providerId)]);
        return undefined;
      },
      () => this.fallback.breakerReset(providerId),
    );
  }

  async breakerAcquireHalfOpen(providerId: string, ttlMs: number): Promise<boolean> {
    return this.run(
      async () => (await this.runner('SET', [this.hoKey(providerId), '1', 'NX', 'PX', ttlMs])) !== null,
      () => this.fallback.breakerAcquireHalfOpen(providerId, ttlMs),
    );
  }

  /* ---- 并发闸门（批次3，跨实例）---- */

  async concurrencyAcquire(key: string, limit: number, ttlMs: number): Promise<boolean> {
    return this.run(
      async () => {
        // 原子「检查并占用」：超限回滚、占用续期，返回当前计数（0=被拒）
        const n = Number(await this.runner('EVAL', [LUA_CONCURRENCY_ACQUIRE, 1, this.concKey(key), limit, ttlMs]));
        return n > 0;
      },
      () => this.fallback.concurrencyAcquire(key, limit, ttlMs),
    );
  }

  async concurrencyRelease(key: string): Promise<void> {
    await this.run(
      async () => {
        await this.runner('EVAL', [LUA_CONCURRENCY_RELEASE, 1, this.concKey(key)]);
        return undefined;
      },
      () => this.fallback.concurrencyRelease(key),
    );
  }

  async concurrencyCount(key: string): Promise<number> {
    return this.run(
      async () => Number((await this.runner('GET', [this.concKey(key)])) ?? 0),
      () => this.fallback.concurrencyCount(key),
    );
  }

  health(): SharedStateHealth {
    return {
      backend: 'shared',
      ok: this.lastOk,
      degradedEvents: this.degraded,
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  async close(): Promise<void> {
    await this.fallback.close();
  }

  /* ---------------- 内部 ---------------- */

  private tokKey(keyId: string, periodStartMs: number): string {
    return `${this.prefix}q:tok:${keyId}:${periodStartMs}`;
  }
  private cnyKey(keyId: string, periodStartMs: number): string {
    return `${this.prefix}q:cny:${keyId}:${periodStartMs}`;
  }
  private reqKey(keyId: string, periodStartMs: number): string {
    return `${this.prefix}q:req:${keyId}:${periodStartMs}`;
  }
  private brkKey(providerId: string): string {
    return `${this.prefix}brk:${providerId}`;
  }
  private hoKey(providerId: string): string {
    return `${this.prefix}brk:ho:${providerId}`;
  }
  private concKey(key: string): string {
    return `${this.prefix}conc:${key}`;
  }

  /**
   * 统一执行壳：成功即标记健康；失败时按 `failOpen` 决定降级（回退内存镜像）还是抛出。
   * 注意：**状态层异常绝不 fail-close**（红线 3）。
   */
  private async run<T>(body: () => Promise<T>, degrade: () => Promise<T>): Promise<T> {
    try {
      const out = await body();
      this.lastOk = true;
      this.lastError = undefined;
      return out;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastOk = false;
      this.lastError = msg;
      this.degraded++;
      if (!this.failOpen) throw err;
      return degrade();
    }
  }
}

/** HGETALL 返回值（扁平数组或对象）→ Map */
function toFieldMap(raw: unknown): Map<string, string> {
  const map = new Map<string, string>();
  if (Array.isArray(raw)) {
    for (let i = 0; i + 1 < raw.length; i += 2) {
      map.set(String(raw[i]), String(raw[i + 1]));
    }
  } else if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (v !== null && v !== undefined) map.set(k, String(v));
    }
  }
  return map;
}

/* ------------------------------------------------------------------ *
 * 工厂：按配置装配，未注入 runner 时强制回退内存（零硬依赖在此被强制）
 * ------------------------------------------------------------------ */

/** 最小日志接口（避免为日志引入额外依赖） */
export interface SharedStateLogger {
  warn(event: string, fields?: Record<string, unknown>): void;
}

export interface SharedStateDeps {
  /** 既有存储：内存实现据此保持单实例语义零回归 */
  store?: Store;
  /** 可选注入的 Redis 命令执行器；未提供时共享后端不可用（强制回退内存） */
  redisRunner?: RedisCommandRunner;
  logger?: SharedStateLogger;
}

export interface SharedStateOptionsLike {
  state?: {
    backend: 'local' | 'redis';
    failOpenOnRedisDown: boolean;
    keyPrefix?: string;
  };
}

/**
 * 依据 `config.state.backend` 决定返回内存实现还是 Redis 适配：
 *  - `backend !== 'redis'` → 内存实现（默认路径，零回归）
 *  - `backend === 'redis'` 且注入了 `redisRunner` → Redis 适配
 *  - `backend === 'redis'` 但**未注入 runner** → 告警 + 回退内存实现（硬依赖在代码层不可达）
 */
export function createSharedState(config: SharedStateOptionsLike, deps: SharedStateDeps = {}): SharedStateStore {
  const backend = config.state?.backend ?? 'local';
  if (backend === 'redis') {
    if (deps.redisRunner) {
      return new RedisSharedStateStore({
        runner: deps.redisRunner,
        failOpenOnRedisDown: config.state?.failOpenOnRedisDown ?? true,
        ...(config.state?.keyPrefix ? { keyPrefix: config.state.keyPrefix } : {}),
      });
    }
    deps.logger?.warn('state.redis_runner_missing', {
      hint: 'config.state.backend=redis 但未注入 RedisCommandRunner，已回退内存实现（多实例一致性不生效）',
    });
  }
  return deps.store ? MemorySharedStateStore.fromStore(deps.store) : new MemorySharedStateStore();
}