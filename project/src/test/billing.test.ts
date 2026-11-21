/**
 * 批次2 · 计费账务单元测试。
 *
 * 覆盖：
 *  - 应收复算 computeReceivable：有客户售价按价算；无价则等于上游实付（零加价）；
 *  - PlanRegistry：初始化/归一、activePlan、upsert 校验（id/tier）；
 *  - LedgerReport：按租户聚合账单、对账三段式自洽、导出 CSV/JSON 字段齐全；
 *  - periodLabel 自然月标签。
 *
 * 运行：npm run build 后 `node --test "dist/test/billing.test.js"`（Node ≥ 22.5）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ServerResponse } from 'node:http';
import { PlanRegistry, LedgerReport, computeReceivable, periodLabel } from '../admin/billing.js';
import { MemoryStore } from '../store/index.js';
import { defaultConfig } from '../core/config.js';
import type { MeterRecord, Plan } from '../core/types.js';

function fakeRes(): { res: ServerResponse; out: { status: number; body: any } } {
  const out = { status: 0, body: undefined as any };
  const res = {
    setHeader() {
      /* no-op */
    },
    writeHead(code: number) {
      out.status = code;
      return res;
    },
    end(s: string) {
      try {
        out.body = JSON.parse(s);
      } catch {
        out.body = s;
      }
      return res;
    },
  } as unknown as ServerResponse;
  return { res, out };
}

/** 构造一条最小可用 MeterRecord（只填计费相关字段，其余置零/空） */
function mkRec(p: Partial<MeterRecord>): MeterRecord {
  return {
    traceId: 't',
    requestId: 'r',
    ts: Date.now(),
    keyId: 'k',
    tenantId: 'default',
    tier: 'standard',
    clientKind: 'app',
    agentScore: 0,
    model: 'm',
    providerId: 'p',
    stream: false,
    toolCalling: false,
    outcome: 'success',
    httpStatus: 200,
    durationMs: 1,
    ttfbMs: null,
    bytesIn: 0,
    bytesOut: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedPromptTokens: 0,
    costCny: 0,
    listCostCny: 0,
    attemptCount: 1,
    failureReason: null,
    quickAction: null,
    recoverable: null,
    precheckViolations: 0,
    precheckBlocked: false,
    precheckDegraded: false,
    precheckUs: 0,
    classifyUs: 0,
    attributionDelivered: false,
    duplicateInWindow: 0,
    ...p,
  };
}

const PRICED_PLAN: Plan = {
  id: 'std-2026',
  label: '标准套餐',
  tier: 'standard',
  billing: 'token',
  quotaPeriod: 'rolling30d',
  pricePerMTok: { input: 3, output: 6, cachedInput: 1.5 },
  status: 'active',
};

/* ---------------- computeReceivable ---------------- */

test('computeReceivable：无客户售价时应收 = 上游实付（零加价）', () => {
  const line = { inputTokens: 1_000_000, outputTokens: 0, cachedTokens: 0, upstreamCostCny: 12.34 };
  assert.equal(computeReceivable(line, undefined), 12.34);
});

test('computeReceivable：有售价时按 计数×单价 复算（缓存输入用缓存价）', () => {
  const line = { inputTokens: 1_000_000, outputTokens: 1_000_000, cachedTokens: 400_000, upstreamCostCny: 99 };
  // 非缓存输入 600k×3 + 缓存 400k×1.5 + 输出 1000k×6，单位「元/百万」
  const expect = (600_000 * 3 + 400_000 * 1.5 + 1_000_000 * 6) / 1_000_000; // = 1.8 + 0.6 + 6 = 8.4
  assert.equal(computeReceivable(line, PRICED_PLAN), Math.round(expect * 100) / 100);
});

test('computeReceivable：缓存 token 超过输入时按输入夹紧（不产生负值）', () => {
  const line = { inputTokens: 100, outputTokens: 0, cachedTokens: 999, upstreamCostCny: 5 };
  const v = computeReceivable(line, PRICED_PLAN);
  assert.ok(v >= 0, '非负');
});

/* ---------------- PlanRegistry ---------------- */

test('PlanRegistry：初始化归一 + activePlan', () => {
  const config = defaultConfig();
  config.plans = [
    { id: 'a', label: 'A', tier: 'free', billing: 'none', quotaPeriod: 'rolling30d', status: 'archived' } as Plan,
    PRICED_PLAN,
  ];
  const store = new MemoryStore();
  const pr = new PlanRegistry({ config, store });
  assert.equal(pr.list().length, 2);
  assert.equal(pr.activePlan()?.id, 'std-2026', 'activePlan 取生效套餐');
});

test('PlanRegistry.upsert：id 非法 400；tier 非法 400；合法 200', () => {
  const config = defaultConfig();
  const store = new MemoryStore();
  const pr = new PlanRegistry({ config, store });
  {
    const { res, out } = fakeRes();
    pr.upsert(res, { id: 'bad id', tier: 'standard' }, 'test');
    assert.equal(out.status, 400);
  }
  {
    const { res, out } = fakeRes();
    pr.upsert(res, { id: 'ok', tier: 'nope' }, 'test');
    assert.equal(out.status, 400);
  }
  {
    const { res, out } = fakeRes();
    pr.upsert(res, { id: 'ok', tier: 'pro', status: 'active' }, 'test');
    assert.equal(out.status, 200);
    assert.equal(pr.find('ok')?.tier, 'pro');
  }
});

/* ---------------- LedgerReport ---------------- */

function setupLedger(plans?: Plan[]): { store: MemoryStore; ledger: LedgerReport; plans: PlanRegistry } {
  const config = defaultConfig();
  if (plans) config.plans = plans;
  const store = new MemoryStore();
  const pr = new PlanRegistry({ config, store });
  const ledger = new LedgerReport({ store, plans: pr });
  return { store, ledger, plans: pr };
}

test('LedgerReport.bills：按租户聚合用量（token/缓存/请求数/上游成本）', () => {
  const { store, ledger } = setupLedger([PRICED_PLAN]);
  store.record(mkRec({ tenantId: 'a', promptTokens: 1000, completionTokens: 500, cachedPromptTokens: 200, costCny: 1.5 }));
  store.record(mkRec({ tenantId: 'a', promptTokens: 2000, completionTokens: 100, cachedPromptTokens: 0, costCny: 2.0 }));
  store.record(mkRec({ tenantId: 'b', promptTokens: 300, completionTokens: 50, cachedPromptTokens: 0, costCny: 0.4 }));

  const bills = ledger.bills({ tenantId: null, from: 0, to: Date.now() + 1000 });
  const a = bills.find((x) => x.tenantId === 'a');
  assert.ok(a);
  assert.equal(a.inputTokens, 3000);
  assert.equal(a.outputTokens, 600);
  assert.equal(a.cachedTokens, 200);
  assert.equal(a.requests, 2);
  assert.equal(a.upstreamCostCny, 3.5);
  assert.equal(a.planId, 'std-2026');
});

test('LedgerReport：租户过滤只返回本租户（零泄漏）', () => {
  const { store, ledger } = setupLedger([PRICED_PLAN]);
  store.record(mkRec({ tenantId: 'a', costCny: 1 }));
  store.record(mkRec({ tenantId: 'b', costCny: 2 }));
  const bills = ledger.bills({ tenantId: 'a', from: 0, to: Date.now() + 1000 });
  assert.equal(bills.length, 1);
  assert.equal(bills[0]!.tenantId, 'a');
});

test('LedgerReport.reconcile：三段式自洽（应收 = 复算，差异 0，ok=true），并给出浪费成本', () => {
  const { store, ledger } = setupLedger([PRICED_PLAN]);
  store.record(mkRec({ tenantId: 'a', promptTokens: 1_000_000, completionTokens: 1_000_000, cachedPromptTokens: 400_000, costCny: 5, outcome: 'success' }));
  store.record(mkRec({ tenantId: 'a', promptTokens: 0, completionTokens: 0, costCny: 1.2, outcome: 'upstream_error' }));

  const rows = ledger.reconcile({ tenantId: null, from: 0, to: Date.now() + 1000 });
  const a = rows.find((r) => r.tenantId === 'a');
  assert.ok(a);
  assert.equal(a.requests, 2);
  assert.equal(a.errors, 1);
  assert.equal(a.wastedCostCny, 1.2, '失败请求的上游成本计入浪费额');
  assert.equal(a.diffCny, 0);
  assert.equal(a.ok, true);
  assert.equal(a.receivableCny, a.recomputedCny);
});

test('LedgerReport.issue：状态机 draft→issued→settled', () => {
  const { store, ledger } = setupLedger([PRICED_PLAN]);
  store.record(mkRec({ tenantId: 'a', costCny: 1 }));
  const body = { period: periodLabel(Date.now()), from: 0, to: Date.now() + 1000 };
  {
    const { res, out } = fakeRes();
    ledger.issue(res, body, 'test');
    assert.equal(out.status, 200);
  }
  let bills = ledger.bills({ tenantId: null, from: 0, to: Date.now() + 1000 });
  assert.equal(bills[0]!.status, 'issued', '首次出账 → issued');
  {
    const { res } = fakeRes();
    ledger.issue(res, body, 'test');
  }
  bills = ledger.bills({ tenantId: null, from: 0, to: Date.now() + 1000 });
  assert.equal(bills[0]!.status, 'settled', '再次出账 → settled');
});

test('LedgerReport.exportRecon：CSV/JSON 字段齐全且含表头', () => {
  const { store, ledger } = setupLedger([PRICED_PLAN]);
  store.record(mkRec({ tenantId: 'a', costCny: 1 }));
  const csv = ledger.exportRecon({ tenantId: null, from: 0, to: Date.now() + 1000 }, 'csv');
  assert.ok(csv.body.startsWith('tenantId,period,planId'), 'CSV 表头');
  assert.ok(csv.filename.endsWith('.csv'));
  const json = ledger.exportRecon({ tenantId: null, from: 0, to: Date.now() + 1000 }, 'json');
  const parsed = JSON.parse(json.body) as unknown[];
  assert.equal(parsed.length, 1);
});

test('periodLabel：自然月标签 YYYY-MM', () => {
  const t = Date.UTC(2026, 9, 27); // 2026-10-27
  assert.equal(periodLabel(t), '2026-10');
});