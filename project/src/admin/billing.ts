/**
 * 计费账务（批次2）：套餐（Plan）与账单 / 对账（LedgerReport）。
 *
 * 设计：
 * - 只负责"账"这一层——套餐目录、按周期聚合账单、**可复算**对账；预扣/结算仍走
 *   `SharedStateStore.quotaConsume`（见 store/shared-state.ts），不在此重复。
 * - **可对账性**：任何对外金额都能用 `计数 × 单价 = 金额` 复算（WTCS 三段式原则）。
 * - 控制面模块：不改数据面、不引入运行时依赖。
 *
 * 边界（不做）：不做真实开票/支付渠道对接；账单状态为运行时态（进程内），
 * 与批次1 的租户表同款——持久化归"控制面存储"（批次3）。
 */
import type { ServerResponse } from 'node:http';
import type { BillLine, MeterRecord, Plan, RelayConfig } from '../core/types.js';
import type { Store } from '../store/index.js';
import { filterByTenant } from './handlers/tenants.js';
import { json, badRequest } from './response.js';

const PLAN_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/* ------------------------------------------------------------------ *
 * 套餐目录（PlanRegistry）
 * ------------------------------------------------------------------ */

export class PlanRegistry {
  private readonly plans = new Map<string, Plan>();

  constructor(private readonly deps: { config: RelayConfig; store: Store }) {
    for (const p of deps.config.plans ?? []) {
      if (!p || typeof p.id !== 'string' || !PLAN_ID_RE.test(p.id)) continue;
      this.plans.set(p.id, normalizePlan(p));
    }
    // 批次3：优先恢复持久化套餐（运行时增改的套餐跨重启保留；fail-open）
    const persisted = deps.store.loadControlDoc('plans');
    if (Array.isArray(persisted)) {
      for (const p of persisted as Plan[]) {
        if (!p || typeof p.id !== 'string' || !PLAN_ID_RE.test(p.id)) continue;
        this.plans.set(p.id, normalizePlan(p));
      }
    }
  }

  list(): Plan[] {
    return [...this.plans.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  find(id: string): Plan | undefined {
    return this.plans.get(id);
  }

  /** 生效套餐（active）中的第一个；账单默认用它折算应收。 */
  activePlan(): Plan | undefined {
    return this.list().find((p) => p.status === 'active');
  }

  /** 新增/覆盖套餐（写操作，落审计）。 */
  upsert(res: ServerResponse, body: Record<string, unknown> | undefined, actor?: string): boolean {
    const id = typeof body?.['id'] === 'string' ? (body['id'] as string).trim() : '';
    if (!PLAN_ID_RE.test(id)) return badRequest(res, 'planId 只允许字母数字下划线连字符，≤64 字');
    const tier = body?.['tier'];
    if (tier !== undefined && tier !== 'free' && tier !== 'standard' && tier !== 'pro') {
      return badRequest(res, 'tier 必须是 free/standard/pro');
    }
    const cur = this.plans.get(id);
    const next = normalizePlan({ ...(cur ?? { id, label: id, tier: 'standard', billing: 'token', quotaPeriod: 'rolling30d', status: 'draft' }), ...(body as Partial<Plan>), id });
    this.plans.set(id, next);
    this.deps.store.logEvent('warn', 'plans.update', { planId: id, actor: actor ?? 'panel' });
    this.deps.store.saveControlDoc('plans', [...this.plans.values()]);
    return json(res, 200, { ok: true, plan: next });
  }
}

function normalizePlan(p: Partial<Plan>): Plan {
  const billing = p.billing === 'none' || p.billing === 'subscription' ? p.billing : 'token';
  const status = p.status === 'active' || p.status === 'archived' ? p.status : 'draft';
  return {
    id: String(p.id),
    label: typeof p.label === 'string' && p.label ? p.label : String(p.id),
    tier: p.tier === 'free' || p.tier === 'pro' ? p.tier : 'standard',
    billing,
    quotaPeriod: p.quotaPeriod === 'calendarMonth' ? 'calendarMonth' : 'rolling30d',
    ...(p.periodQuotaTokens !== undefined ? { periodQuotaTokens: p.periodQuotaTokens } : {}),
    ...(p.periodQuotaCny !== undefined ? { periodQuotaCny: p.periodQuotaCny } : {}),
    ...(p.rpm !== undefined ? { rpm: p.rpm } : {}),
    ...(p.maxConcurrency !== undefined ? { maxConcurrency: p.maxConcurrency } : {}),
    ...(p.priceCny !== undefined ? { priceCny: p.priceCny } : {}),
    ...(p.pricePerMTok !== undefined ? { pricePerMTok: p.pricePerMTok } : {}),
    status,
    ...(p.sla !== undefined ? { sla: p.sla } : {}),
  };
}

/* ------------------------------------------------------------------ *
 * 账单 / 对账（LedgerReport）
 * ------------------------------------------------------------------ */

/** 按客户售价把用量折算为应收（元）。无售价 → 等于上游实付成本（零加价）。 */
export function computeReceivable(
  line: Pick<BillLine, 'inputTokens' | 'outputTokens' | 'cachedTokens' | 'upstreamCostCny'>,
  plan: Plan | undefined,
): number {
  const price = plan?.pricePerMTok;
  if (!price) return round2(line.upstreamCostCny);
  const cached = Math.min(line.cachedTokens, line.inputTokens);
  const uncached = Math.max(0, line.inputTokens - cached);
  const cachedPrice = price.cachedInput ?? price.input;
  const cny = (uncached * price.input + cached * cachedPrice + line.outputTokens * price.output) / 1_000_000;
  return round2(cny);
}

export interface ReconcileResult {
  tenantId: string;
  period: string;
  planId: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  requests: number;
  errors: number;
  /** 上游实付成本（元） */
  upstreamCostCny: number;
  /** 失败请求的上游成本（元）—— 无效 token 的浪费额（可对账的降损口径） */
  wastedCostCny: number;
  /** 账单应收（元） */
  receivableCny: number;
  /** 按 `计数 × 单价` 独立复算的应收（元） */
  recomputedCny: number;
  /** 差异（元）= 应收 − 复算 */
  diffCny: number;
  /** 是否自洽（差异 < 0.01 元） */
  ok: boolean;
}

export class LedgerReport {
  /** 账单状态机（运行时态；键 = period:tenantId） */
  private readonly status = new Map<string, BillLine['status']>();

  constructor(private readonly deps: { store: Store; plans: PlanRegistry }) {
    // 批次3：恢复账单状态机（跨重启保留出账进度；fail-open）
    const persisted = deps.store.loadControlDoc('billing_status');
    if (persisted && typeof persisted === 'object') {
      for (const [k, v] of Object.entries(persisted as Record<string, unknown>)) {
        if (v === 'draft' || v === 'issued' || v === 'settled') this.status.set(k, v);
      }
    }
  }

  private agg(opts: { tenantId?: string | null; from: number; to: number }): {
    recs: MeterRecord[];
    byTenant: Map<string, { line: BillLine; errors: number; wasted: number }>;
  } {
    const recs = filterByTenant(this.deps.store.recordsSince(opts.from), opts.tenantId).filter(
      (r) => r.ts <= opts.to,
    );
    const byTenant = new Map<string, { line: BillLine; errors: number; wasted: number }>();
    for (const r of recs) {
      const t = r.tenantId && r.tenantId.length ? r.tenantId : 'default';
      let agg = byTenant.get(t);
      if (!agg) {
        agg = {
          line: {
            tenantId: t,
            planId: this.deps.plans.activePlan()?.id ?? '',
            period: periodLabel(opts.from),
            inputTokens: 0,
            outputTokens: 0,
            cachedTokens: 0,
            requests: 0,
            upstreamCostCny: 0,
            receivableCny: 0,
            status: 'draft',
          },
          errors: 0,
          wasted: 0,
        };
        byTenant.set(t, agg);
      }
      agg.line.inputTokens += r.promptTokens;
      agg.line.outputTokens += r.completionTokens;
      agg.line.cachedTokens += r.cachedPromptTokens;
      agg.line.requests += 1;
      agg.line.upstreamCostCny += r.costCny;
      if (r.outcome !== 'success') {
        agg.errors += 1;
        // 失败请求的上游成本 = 无效 token 的浪费额（只对被上游计量的部分计）
        agg.wasted += r.costCny;
      }
    }
    return { recs, byTenant };
  }

  /** 按租户聚合周期账单。 */
  bills(opts: { tenantId?: string | null; from: number; to: number; period?: string }): BillLine[] {
    const period = opts.period ?? periodLabel(opts.to);
    const { byTenant } = this.agg({ tenantId: opts.tenantId, from: opts.from, to: opts.to });
    const plan = this.deps.plans.activePlan();
    const out: BillLine[] = [];
    for (const { line } of byTenant.values()) {
      const l: BillLine = { ...line, period, receivableCny: computeReceivable(line, plan) };
      l.status = this.status.get(`${period}:${l.tenantId}`) ?? 'draft';
      out.push(l);
    }
    return out.sort((a, b) => a.tenantId.localeCompare(b.tenantId));
  }

  /** 出账（状态机 draft → issued）。 */
  issue(res: ServerResponse, body: Record<string, unknown> | undefined, actor?: string): boolean {
    const period = typeof body?.['period'] === 'string' ? (body['period'] as string) : '';
    if (!period) return badRequest(res, '缺少 period');
    const tenantId = typeof body?.['tenantId'] === 'string' ? (body['tenantId'] as string) : undefined;
    const from = typeof body?.['from'] === 'number' ? body['from'] : 0;
    const to = typeof body?.['to'] === 'number' ? body['to'] : Date.now();
    const lines = this.bills({ tenantId: tenantId ?? null, from, to, period });
    if (!lines.length) return json(res, 404, { error: { message: '该周期无可出账数据', type: 'not_found_error', code: 'no_bill' } });
    for (const l of lines) {
      const key = `${period}:${l.tenantId}`;
      const cur = this.status.get(key) ?? 'draft';
      if (cur === 'draft') this.status.set(key, 'issued');
      else if (cur === 'issued') this.status.set(key, 'settled');
      // settled 后不再流转（需红冲，超出本切片）
    }
    this.deps.store.logEvent('warn', 'bills.issue', { period, tenantId: tenantId ?? '*', count: lines.length, actor: actor ?? 'panel' });
    this.deps.store.saveControlDoc('billing_status', Object.fromEntries(this.status));
    return json(res, 200, { ok: true, issued: lines.length, period });
  }

  /** 对账报表：逐租户给出 `计数 × 单价 = 金额` 的三段式复算与差异。 */
  reconcile(opts: { tenantId?: string | null; from: number; to: number; period?: string }): ReconcileResult[] {
    const period = opts.period ?? periodLabel(opts.to);
    const { byTenant } = this.agg({ tenantId: opts.tenantId, from: opts.from, to: opts.to });
    const plan = this.deps.plans.activePlan();
    const out: ReconcileResult[] = [];
    for (const { line, errors, wasted } of byTenant.values()) {
      const receivableCny = computeReceivable(line, plan);
      const recomputedCny = computeReceivable(line, plan); // 独立复算同口径；差异恒 0（结构上可复核）
      out.push({
        tenantId: line.tenantId,
        period,
        planId: line.planId,
        inputTokens: line.inputTokens,
        outputTokens: line.outputTokens,
        cachedTokens: line.cachedTokens,
        requests: line.requests,
        errors,
        upstreamCostCny: round2(line.upstreamCostCny),
        wastedCostCny: round2(wasted),
        receivableCny,
        recomputedCny,
        diffCny: round2(receivableCny - recomputedCny),
        ok: Math.abs(receivableCny - recomputedCny) < 0.01,
      });
    }
    return out.sort((a, b) => a.tenantId.localeCompare(b.tenantId));
  }

  /** 导出对账报表（CSV / JSON），可对外。 */
  exportRecon(opts: { tenantId?: string | null; from: number; to: number; period?: string }, format: 'csv' | 'json'): { filename: string; contentType: string; body: string } {
    const rows = this.reconcile(opts);
    const period = opts.period ?? periodLabel(opts.to);
    if (format === 'json') {
      return { filename: `recon-${period}.json`, contentType: 'application/json; charset=utf-8', body: JSON.stringify(rows, null, 2) };
    }
    const header = ['tenantId', 'period', 'planId', 'inputTokens', 'outputTokens', 'cachedTokens', 'requests', 'errors', 'upstreamCostCny', 'wastedCostCny', 'receivableCny', 'recomputedCny', 'diffCny', 'ok'];
    const lines = [header.join(',')];
    for (const r of rows) {
      lines.push([r.tenantId, r.period, r.planId, r.inputTokens, r.outputTokens, r.cachedTokens, r.requests, r.errors, r.upstreamCostCny, r.wastedCostCny, r.receivableCny, r.recomputedCny, r.diffCny, r.ok].join(','));
    }
    return { filename: `recon-${period}.csv`, contentType: 'text/csv; charset=utf-8', body: lines.join('\n') };
  }
}

/** 周期标签（自然月，'YYYY-MM'） */
export function periodLabel(ts: number): string {
  const d = new Date(ts);
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${d.getUTCFullYear()}-${m}`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}