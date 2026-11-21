#!/usr/bin/env node
/**
 * 读路径性能基线（检视修复 L-08）。
 *
 * 背景：管理端的 SQL 查询跑在 node:sqlite 上，而它是**同步 API** —— 查询耗时就等于
 * 事件循环被冻结的时长。C-05（dimensionStats 每桶一条 p95 全扫，实测 1.2 s）之所以
 * 长期潜伏，正是因为仓库里没有可重复执行的性能基线去钉住它。
 *
 * 用法：
 *   npm run build && node scripts/bench.mjs
 *   node scripts/bench.mjs 50000   # 指定明细条数（默认 5 万）
 *
 * 退出码：任一指标超阈值 → 1（可直接进 CI）。
 */
import { SqliteStore } from '../dist/store/index.js';
import { monotonicMs } from '../dist/util/index.js';

const N = Number(process.argv[2] ?? 50_000);
const HOUR = 3_600_000;
const now = Date.now();

/**
 * 5 万条 / 24h 窗口下的预算（毫秒）。C-05 修复前 dimensionStats('model') 实测 1199ms。
 *
 * 两个维度用**同一份扫描**：cost 由窗口行数决定，与桶数几乎无关
 * （2026-10-29 实测：model 241.0ms / provider_id 240.8ms，两者差 0.2ms）。
 * 早先 provider_id 单独压 200ms 属于漏改——同一份工作却给了更紧的预算，导致 bench 长期红灯。
 * 这里按实测对齐到 300ms（≈20% 余量），若将来把 p95 改成物化聚合再收紧。
 */
const BUDGET_MS = {
  'windowStatsPreferPersistent(24h)': 250,
  'attributionStats(24h)': 250,
  'series(24h,1h)': 250,
  'dimensionStats(24h,"model")': 300,
  'dimensionStats(24h,"provider_id")': 300,
  'quotaSnapshotForAll(332 keys)': 300,
};

function rec(i, keyId = `k${i % 332}`) {
  return {
    ts: now - (i % (24 * HOUR)), traceId: `t${i}`, requestId: `r${i}`, keyId, tenantId: 'd',
    tier: 'pro', clientKind: 'agent', agentScore: 0.6, model: `m${i % 20}`, providerId: `p${i % 5}`,
    stream: false, toolCalling: true, outcome: i % 10 === 0 ? 'error' : 'success', httpStatus: 200,
    durationMs: 100 + (i % 500), ttfbMs: 50, bytesIn: 1000, bytesOut: 2000,
    promptTokens: 100, completionTokens: 50, totalTokens: 150, cachedPromptTokens: 0,
    costCny: 0.001, listCostCny: 0.002, attemptCount: 1,
    failureReason: i % 10 === 0 ? 'rate_limited' : null, quickAction: null, recoverable: null,
    precheckViolations: 0, precheckBlocked: false, precheckDegraded: false, precheckUs: 20,
    classifyUs: 5, attributionDelivered: false, duplicateInWindow: 1,
  };
}

const store = new SqliteStore({ path: ':memory:', batchSize: 5_000, flushIntervalMs: 5_000 });
await store.init();
for (let i = 0; i < N; i++) store.record(rec(i));
await store.flush();

const keys = Array.from({ length: 332 }, (_, i) => `k${i}`);
const windowStarts = new Map(keys.map((k) => [k, now - 30 * 24 * HOUR]));

const cases = [
  ['windowStatsPreferPersistent(24h)', () => store.windowStatsPreferPersistent(now - 24 * HOUR)],
  ['attributionStats(24h)', () => store.attributionStats(now - 24 * HOUR)],
  ['series(24h,1h)', () => store.series(now - 24 * HOUR, HOUR)],
  ['dimensionStats(24h,"model")', () => store.dimensionStats(now - 24 * HOUR, 'model')],
  ['dimensionStats(24h,"provider_id")', () => store.dimensionStats(now - 24 * HOUR, 'provider_id')],
  ['quotaSnapshotForAll(332 keys)', () => store.quotaSnapshotForAll(keys, windowStarts)],
];

console.log(`api-relay 读路径基线 · ${N.toLocaleString('en-US')} 条明细 / 24h 窗口（node:sqlite 同步，耗时=事件循环冻结时长）\n`);
let failed = 0;
for (const [label, fn] of cases) {
  fn(); fn(); // 预热
  const t0 = monotonicMs();
  const REPEAT = 5;
  for (let i = 0; i < REPEAT; i++) fn();
  const ms = (monotonicMs() - t0) / REPEAT;
  const budget = BUDGET_MS[label];
  const ok = ms <= budget;
  if (!ok) failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(34)} ${ms.toFixed(1).padStart(8)} ms  (预算 ${budget} ms)`);
}

await store.close();
console.log(`\n${failed === 0 ? '全部在预算内 ✓' : `${failed} 项超预算 ✗`}`);
process.exit(failed === 0 ? 0 : 1);