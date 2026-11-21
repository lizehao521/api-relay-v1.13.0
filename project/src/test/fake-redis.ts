/**
 * `RedisCommandRunner` 的**内存替身**（测试用）。
 *
 * 目的：在没有真实 Redis 的前提下，验证 `RedisSharedStateStore` 的语义与原子性。
 * 两个适配实例共享**同一个** `FakeRedis` 实例，即模拟"两个进程连同一个 Redis"，
 * 从而可以对拍"多实例一致性"。
 *
 * 支持本切片用到的命令子集：INCR / INCRBY / INCRBYFLOAT / PEXPIRE / SET(NX PX) /
 * GET / MGET / DEL / HINCRBY / HSET / HGET / HGETALL，以及两个内置 Lua 脚本
 * （EVal 按脚本内容特征分派的极简解释器 —— 只覆盖本文件认可的脚本）。
 *
 * 这是**测试替身**，不追求 Redis 全语义；请勿用于生产。
 */

import type { RedisCommandRunner } from '../store/shared-state.js';

interface Entry {
  /** 标量的字符串值；哈希复用该字段存不存在（哈希内容在 hash 里） */
  value?: string;
  hash?: Map<string, string>;
  expireAt?: number;
}

export class FakeRedis {
  private readonly data = new Map<string, Entry>();

  /** 暴露给 runner 的命令执行入口 */
  readonly run: RedisCommandRunner = async (command: string, args: (string | number)[]): Promise<unknown> => {
    const cmd = command.toUpperCase();
    switch (cmd) {
      case 'INCR':
        return this.incr(String(args[0]), 1);
      case 'INCRBY':
        return this.incr(String(args[0]), Number(args[1]));
      case 'INCRBYFLOAT':
        return this.incrFloat(String(args[0]), Number(args[1]));
      case 'DECRBY':
        return this.incr(String(args[0]), -Number(args[1]));
      case 'PEXPIRE':
        return this.pexpire(String(args[0]), Number(args[1]));
      case 'GET':
        return this.get(String(args[0]));
      case 'MGET':
        return (args as (string | number)[]).map((k) => this.get(String(k)));
      case 'SET':
        return this.set(args as string[]);
      case 'DEL':
        return this.del(args.map((a) => String(a)));
      case 'HINCRBY':
        return this.hincrby(String(args[0]), String(args[1]), Number(args[2]));
      case 'HSET':
        return this.hset(String(args[0]), String(args[1]), String(args[2]));
      case 'HGET':
        return this.hget(String(args[0]), String(args[1]));
      case 'HGETALL':
        return this.hgetall(String(args[0]));
      case 'EVAL':
        return this.evalScript(args);
      default:
        throw new Error(`FakeRedis: 不支持的命令 ${command}`);
    }
  };

  /** 直接读一个标量（测试断言用；等价 GET） */
  peek(key: string): string | null {
    return this.get(key);
  }

  /** 是否仍持有该键（未过期） */
  exists(key: string): boolean {
    this.purge(key);
    const e = this.data.get(key);
    return e !== undefined && (e.value !== undefined || (e.hash?.size ?? 0) > 0);
  }

  private entry(key: string): Entry {
    this.purge(key);
    let e = this.data.get(key);
    if (!e) {
      e = {};
      this.data.set(key, e);
    }
    return e;
  }

  private purge(key: string): void {
    const e = this.data.get(key);
    if (e?.expireAt !== undefined && e.expireAt <= Date.now()) this.data.delete(key);
  }

  private incr(key: string, by: number): number {
    const e = this.entry(key);
    const next = Number(e.value ?? 0) + by;
    e.value = String(next);
    return next;
  }

  private incrFloat(key: string, by: number): string {
    const e = this.entry(key);
    const next = Number(e.value ?? 0) + by;
    e.value = String(next); // 与真实 Redis 类似：以字符串回传浮点
    return e.value;
  }

  private pexpire(key: string, ms: number): number {
    this.purge(key);
    const e = this.data.get(key);
    if (!e) return 0;
    e.expireAt = Date.now() + Math.max(0, ms);
    return 1;
  }

  private get(key: string): string | null {
    this.purge(key);
    return this.data.get(key)?.value ?? null;
  }

  private set(args: string[]): string | null {
    const [key, value, ...rest] = args;
    if (key === undefined || value === undefined) throw new Error('FakeRedis SET: 缺少参数');
    const nx = rest.some((a) => String(a).toUpperCase() === 'NX');
    this.purge(key);
    if (nx && this.data.has(key)) return null; // NX 且已存在 → 失败（返回 nil）
    const e = this.entry(key);
    e.value = String(value);
    const pxIdx = rest.findIndex((a) => String(a).toUpperCase() === 'PX');
    if (pxIdx >= 0 && rest[pxIdx + 1] !== undefined) e.expireAt = Date.now() + Number(rest[pxIdx + 1]);
    return 'OK';
  }

  private del(keys: string[]): number {
    let n = 0;
    for (const k of keys) {
      this.purge(k);
      if (this.data.delete(k)) n++;
    }
    return n;
  }

  private hincrby(key: string, field: string, by: number): number {
    const e = this.entry(key);
    const h = (e.hash ??= new Map<string, string>());
    const next = Number(h.get(field) ?? 0) + by;
    h.set(field, String(next));
    return next;
  }

  private hset(key: string, field: string, value: string): number {
    const e = this.entry(key);
    const h = (e.hash ??= new Map<string, string>());
    const existed = h.has(field);
    h.set(field, value);
    return existed ? 0 : 1;
  }

  private hget(key: string, field: string): string | null {
    this.purge(key);
    return this.data.get(key)?.hash?.get(field) ?? null;
  }

  private hgetall(key: string): string[] {
    this.purge(key);
    const h = this.data.get(key)?.hash;
    if (!h) return [];
    const out: string[] = [];
    for (const [f, v] of h) out.push(f, v);
    return out;
  }

  /**
   * 极简 Lua 解释器：只识别本切片用到的两个脚本（按内容特征分派）。
   * 真实实现里这两个脚本是原子的；这里 FakeRedis 是单线程 JS，天然无交错。
   */
  private evalScript(args: (string | number)[]): unknown {
    const script = String(args[0]);
    const numkeys = Number(args[1]);
    const keys = args.slice(2, 2 + numkeys).map((k) => String(k));
    const argv = args.slice(2 + numkeys);

    if (script.includes('HINCRBY') && script.includes("'fail'")) {
      // LUA_NOTE_FAILURE: KEYS[1]=brk, ARGV=[fatal, threshold, now, cooldownMs, reason]
      const fatal = String(argv[0]) === '1';
      const threshold = Number(argv[1]);
      const now = Number(argv[2]);
      const cooldownMs = Number(argv[3]);
      const reason = String(argv[4]);
      const fail = this.hincrby(keys[0]!, 'fail', 1);
      let openUntil = Number(this.hget(keys[0]!, 'openUntil') ?? 0) || 0;
      if (fatal || fail >= threshold) {
        openUntil = now + cooldownMs;
        this.hset(keys[0]!, 'openUntil', String(openUntil));
      }
      this.hset(keys[0]!, 'lastReason', reason);
      this.pexpire(keys[0]!, cooldownMs * 2);
      return [fail, openUntil];
    }

    if (script.includes('INCRBYFLOAT')) {
      // LUA_CONSUME: KEYS=[tok,cny,req], ARGV=[tok,cny,req,ttl]
      const tok = this.incr(keys[0]!, Number(argv[0]));
      const cny = this.incrFloat(keys[1]!, Number(argv[1]));
      const req = this.incr(keys[2]!, Number(argv[2]));
      const ttl = Number(argv[3]);
      this.pexpire(keys[0]!, ttl);
      this.pexpire(keys[1]!, ttl);
      this.pexpire(keys[2]!, ttl);
      return [tok, cny, req];
    }

    throw new Error('FakeRedis EVAL: 无法识别的脚本');
  }
}

/**
 * 可编程的失败 runner：`failTimes` 次以内抛错，之后正常（或按 `always` 一直失败）。
 * 用于 fail-open 测试。`calls` 记录被调用次数，便于断言"是否真的走了降级"。
 */
export function failingRunner(opts: { failTimes?: number; always?: boolean } = {}): {
  run: RedisCommandRunner;
  calls: () => number;
} {
  let calls = 0;
  const failTimes = opts.failTimes ?? Number.POSITIVE_INFINITY;
  const run: RedisCommandRunner = async () => {
    calls++;
    if (opts.always || calls <= failTimes) throw new Error('redis down (simulated)');
    return null;
  };
  return { run, calls: () => calls };
}

/** 组合 runner：把 FakeRedis 包一层，使前 N 次调用失败（用于"先失败后恢复"）。 */
export function flakyRunner(inner: FakeRedis, failTimes: number): RedisCommandRunner {
  let calls = 0;
  return async (command, args) => {
    calls++;
    if (calls <= failTimes) throw new Error('redis transient error (simulated)');
    return inner.run(command, args);
  };
}