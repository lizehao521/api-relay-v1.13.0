import { useEffect, useState } from "preact/hooks";
import { api } from "../api";
import { esc, formatNumber } from "../ui";

/**
 * 计费账务（批次2）：套餐目录 + 账单 + 对账报表。
 *
 * 数据来自 `/admin/api/plans`、`/admin/api/bills`、`/admin/api/recon`；
 * 对账可导出 CSV/JSON（`/admin/api/recon/export`）。零 CDN、内联 Preact。
 */

interface Plan {
  id: string;
  label: string;
  tier: string;
  billing: string;
  quotaPeriod: string;
  status: string;
  priceCny?: number;
  pricePerMTok?: { input: number; output: number; cachedInput?: number };
}

interface BillLine {
  tenantId: string;
  period: string;
  planId: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  requests: number;
  upstreamCostCny: number;
  receivableCny: number;
  status: string;
}

interface ReconLine {
  tenantId: string;
  period: string;
  requests: number;
  errors: number;
  upstreamCostCny: number;
  wastedCostCny: number;
  receivableCny: number;
  recomputedCny: number;
  diffCny: number;
  ok: boolean;
}

const money = (n: number) => "¥" + (Math.round(n * 100) / 100).toFixed(2);

export function Billing() {
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [bills, setBills] = useState<BillLine[] | null>(null);
  const [recon, setRecon] = useState<ReconLine[] | null>(null);
  const [fail, setFail] = useState("");
  const [msg, setMsg] = useState("");
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    (async () => {
      setFail("");
      try {
        const [p, b, r] = await Promise.all([
          api<{ plans: Plan[] }>("plans"),
          api<{ bills: BillLine[] }>("bills?window=24h"),
          api<{ lines: ReconLine[] }>("recon?window=24h"),
        ]);
        if (alive) {
          setPlans(p.plans || []);
          setBills(b.bills || []);
          setRecon(r.lines || []);
        }
      } catch (e: any) {
        // 取数失败不静默
        if (alive) {
          setFail(e && e.message ? e.message : "网络错误");
          setPlans([]);
          setBills([]);
          setRecon([]);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [tick]);

  const exportRecon = async (format: "csv" | "json") => {
    setMsg("");
    try {
      const d = await api<{ raw?: string }>("recon/export?window=24h&format=" + format);
      const text = d && typeof d.raw === "string" ? d.raw : JSON.stringify(d);
      const blob = new Blob([text], { type: format === "csv" ? "text/csv" : "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "recon-24h." + format;
      a.click();
      URL.revokeObjectURL(a.href);
      setMsg("已导出对账报表（" + format.toUpperCase() + "）");
    } catch (e: any) {
      setMsg(e && e.message ? e.message : "导出失败");
    }
  };

  return (
    <div>
      <div class="note">
        <b>计费账务（批次2）。</b>
        套餐目录把内置档位变成可售卖套餐；账单按租户聚合用量；对账报表给出{" "}
        <span class="mono">计数 × 单价 = 金额</span> 的三段式复算与差异（可对外）。预扣/结算复用共享状态层{" "}
        <span class="mono">quotaConsume</span>。
      </div>

      {fail ? (
        <div class="note warn" style="margin:0 0 var(--s3)">
          <b>取数失败：</b>
          {esc(fail)}
          ——下方表格是空占位，不是真实数据。稍后点右上角 ↻ 重试。
        </div>
      ) : null}
      {msg ? (
        <div class="note" style="margin:0 0 var(--s3)">
          {esc(msg)}
        </div>
      ) : null}

      <section class="block">
        <h2>
          套餐目录 <span class="spacer" />{" "}
          <button class="bare" onClick={() => setTick((t) => t + 1)} title="刷新">
            ↻
          </button>
        </h2>
        <table>
          <thead>
            <tr>
              <th>套餐</th>
              <th>档位</th>
              <th>计费</th>
              <th>周期</th>
              <th>售价(元/百万)</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            {plans && plans.length ? (
              plans.map((p) => (
                <tr key={p.id}>
                  <td class="mono">{esc(p.id)}</td>
                  <td>{esc(p.tier)}</td>
                  <td>{esc(p.billing)}</td>
                  <td>{esc(p.quotaPeriod)}</td>
                  <td class="mono">
                    {p.pricePerMTok ? `入${p.pricePerMTok.input}/出${p.pricePerMTok.output}` : "按实付(零加价)"}
                  </td>
                  <td>
                    {p.status === "active" ? (
                      <span class="chip g">生效</span>
                    ) : p.status === "archived" ? (
                      <span class="chip">归档</span>
                    ) : (
                      <span class="chip y">草稿</span>
                    )}
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colspan={6} class="dim">
                  {fail ? "取数失败，未加载" : "暂无套餐（账单将按上游实付成本计，零加价）"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <div class="muted-xs stack-sm">
          新增/修改套餐走 <span class="mono">POST /admin/api/plans/update</span>（需{" "}
          <span class="mono">billing.write</span>）；写操作进审计事件 <span class="mono">plans.update</span>。
        </div>
      </section>

      <section class="block">
        <h2>账单（近 24h）</h2>
        <table>
          <thead>
            <tr>
              <th>租户</th>
              <th>周期</th>
              <th>输入 token</th>
              <th>输出 token</th>
              <th>缓存命中</th>
              <th>请求数</th>
              <th>上游成本</th>
              <th>应收</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            {bills && bills.length ? (
              bills.map((b) => (
                <tr key={b.tenantId}>
                  <td class="mono">{esc(b.tenantId)}</td>
                  <td>{esc(b.period)}</td>
                  <td class="mono">{formatNumber(b.inputTokens)}</td>
                  <td class="mono">{formatNumber(b.outputTokens)}</td>
                  <td class="mono">{formatNumber(b.cachedTokens)}</td>
                  <td class="mono">{b.requests}</td>
                  <td class="mono">{money(b.upstreamCostCny)}</td>
                  <td class="mono">{money(b.receivableCny)}</td>
                  <td>{esc(b.status)}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td colspan={9} class="dim">
                  {fail ? "取数失败，未加载" : "近 24h 无用量"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <section class="block">
        <h2>
          对账报表（近 24h） <span class="spacer" />{" "}
          <button class="bare" onClick={() => exportRecon("csv")} title="导出 CSV">
            导出 CSV
          </button>{" "}
          <button class="bare" onClick={() => exportRecon("json")} title="导出 JSON">
            导出 JSON
          </button>
        </h2>
        <table>
          <thead>
            <tr>
              <th>租户</th>
              <th>请求数</th>
              <th>失败数</th>
              <th>上游成本</th>
              <th>浪费成本</th>
              <th>应收</th>
              <th>复算</th>
              <th>差异</th>
              <th>自洽</th>
            </tr>
          </thead>
          <tbody>
            {recon && recon.length ? (
              recon.map((r) => (
                <tr key={r.tenantId}>
                  <td class="mono">{esc(r.tenantId)}</td>
                  <td class="mono">{r.requests}</td>
                  <td class="mono">{r.errors}</td>
                  <td class="mono">{money(r.upstreamCostCny)}</td>
                  <td class="mono">{money(r.wastedCostCny)}</td>
                  <td class="mono">{money(r.receivableCny)}</td>
                  <td class="mono">{money(r.recomputedCny)}</td>
                  <td class="mono">{money(r.diffCny)}</td>
                  <td>
                    {r.ok ? <span class="chip g">✓</span> : <span class="chip">✗</span>}
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colspan={9} class="dim">
                  {fail ? "取数失败，未加载" : "近 24h 无可用对账数据"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <div class="muted-xs stack-sm">
          「浪费成本」= 失败请求的上游已计量成本（无效 token 的浪费额，可对账的降损口径）。
          任何金额都可用 <span class="mono">计数 × 单价 = 金额</span> 自行复算。
        </div>
      </section>
    </div>
  );
}