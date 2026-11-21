import { useEffect, useState } from "preact/hooks";
import type { JSX } from "preact";
import { api } from "../api";
import type { TraceDetail, TraceDiff, TraceSlim } from "../types";
import {
  CSV_BOM, CRLF, csvCell, dayTime, downloadText, esc, formatNumber, ms, rowA11y, toast, TS, writeErr, copyText,
} from "../ui";
import { closeDrawer, openDrawer } from "../drawer";

type LedgerFilter = "all" | "success" | "upstream_error" | "client_error" | "aborted" | "degraded";
type LedgerTime = "all" | "1h" | "6h" | "24h";

const LEDGER_RANGES: Record<string, number> = { "1h": 3600000, "6h": 6 * 3600000, "24h": 24 * 3600000 };

const FILTER_LABEL: Record<string, string> = {
  all: "全部", success: "成功", upstream_error: "上游错误", client_error: "客户端错误", aborted: "中断", degraded: "降级放行",
};

function ledgerMatch(t: TraceSlim, filter: LedgerFilter, time: LedgerTime, q: string): boolean {
  if (time !== "all" && t.startedAt < Date.now() - LEDGER_RANGES[time]) return false;
  if (filter === "degraded" && !t.degraded) return false;
  if (filter !== "all" && filter !== "degraded" && t.outcome !== filter) return false;
  const lq = q.trim().toLowerCase();
  if (!lq) return true;
  return [t.requestId, t.traceId, t.failedAtStage, t.outcome, t.model || ""].join(" ").toLowerCase().includes(lq);
}

/* ---------------- 请求详情抽屉 ---------------- */

function StepRow(props: { row: { s: any; dur: number; idx: number }; maxDur: number }) {
  const { s, dur, idx } = props.row;
  return (
    <div class="step">
      <span class="dim">+{s.offsetMs}ms</span>
      <span class={s.ok ? "y" : "n"}>{s.ok ? "ok" : "FAIL"}</span>
      <span>
        <b>{s.stage}{idx ? " #" + idx : ""}</b> {s.summary}
        {s.error ? <span class="n"> {s.error}</span> : null}
        {s.detail ? <span class="dim"> {JSON.stringify(s.detail)}</span> : null}
        <span class="muted-xs"> {formatNumber(dur)}ms</span>
        <span style="display:block;height:3px;margin-top:3px;background:var(--chip);border-radius:99px;overflow:hidden">
          <i style={"display:block;height:100%;width:" + (dur / props.maxDur * 100).toFixed(1) + "%;background:var(" + (s.ok ? "--ok" : "--err") + ")"} />
        </span>
      </span>
    </div>
  );
}

function TraceBox(props: { t: TraceDetail }) {
  const t = props.t;
  const [diffOther, setDiffOther] = useState("");
  const [diffOut, setDiffOut] = useState<JSX.Element | null>(null);
  const [diffBusy, setDiffBusy] = useState(false);

  let prevOff = 0;
  const stageCount: Record<string, number> = {};
  for (const s of t.steps || []) stageCount[s.stage] = (stageCount[s.stage] || 0) + 1;
  const seen: Record<string, number> = {};
  const srows = (t.steps || []).map((s) => {
    const dur = Math.max(0, (s.offsetMs || 0) - prevOff);
    prevOff = s.offsetMs || 0;
    seen[s.stage] = (seen[s.stage] || 0) + 1;
    return { s, dur, idx: stageCount[s.stage] > 1 ? seen[s.stage] : 0 };
  });
  const maxDur = Math.max(1, ...srows.map((r) => r.dur));

  const traceText = () =>
    "request-id: " + t.requestId + "\n" +
    "trace-id: " + t.traceId + "\n" +
    "时间: " + TS(t.startedAt) + "\n" +
    "模型: " + (t.model || "-") + "\n" +
    "结果: " + t.outcome + " · 耗时 " + ms(t.durationMs) + (t.failedAtStage ? " · 失败于 " + t.failedAtStage : "") + "\n" +
    "步骤:\n" + srows.map((r) => "  +" + ms(r.s.offsetMs) + " " + (r.s.ok ? "ok  " : "FAIL") + " " + r.s.stage + (r.idx ? " #" + r.idx : "")
      + " (" + ms(r.dur) + ") — " + r.s.summary + (r.s.error ? " | " + r.s.error : "")).join("\n");

  const doDiff = async () => {
    const other = diffOther.trim();
    if (!other) { toast("先贴另一条 trace-id", "y"); return; }
    setDiffBusy(true);
    setDiffOut(<div class="dim">对比中…</div>);
    try {
      const r = await api<any>("traces/" + encodeURIComponent(t.traceId) + "?diff=" + encodeURIComponent(other));
      const df: TraceDiff = r.diff;
      if (!df) { setDiffOut(<div class="dim">对方 trace 不存在，或两步序列无可比阶段</div>); return; }
      setDiffOut(
        <>
          <div class={"note" + (df.sameOutcome ? "" : " warn")}>
            <b>对比</b> · 结果{df.sameOutcome ? "相同" : <b>不同</b>}
            · 耗时差 {(df.durationDeltaMs || 0) >= 0 ? "+" : ""}{formatNumber(df.durationDeltaMs)}ms（本条−对方）
          </div>
          {(df.diverged || []).length ? (
            <table>
              <thead><tr><th>阶段</th><th>对方 {String(df.traceA).slice(0, 8)}</th><th>本条 {String(df.traceB).slice(0, 8)}</th></tr></thead>
              <tbody>
                {(df.diverged || []).map((x, i) => (
                  <tr key={i}>
                    <td class="mono">{x.stage}</td>
                    <td><span class={x.aOk ? "ok" : "n"}>{x.aOk ? "ok" : "FAIL"}</span> {x.a}</td>
                    <td><span class={x.bOk ? "ok" : "n"}>{x.bOk ? "ok" : "FAIL"}</span> {x.b}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <div class="dim">两 trace 的可比步骤摘要完全一致</div>}
          {(df.onlyInA || []).length ? <div class="dim" style="font-size:var(--fs-sm);margin-top:6px">仅对方有的阶段：{(df.onlyInA || []).join("、")}</div> : null}
          {(df.onlyInB || []).length ? <div class="dim" style="font-size:var(--fs-sm);margin-top:6px">仅本条有的阶段：{(df.onlyInB || []).join("、")}</div> : null}
        </>,
      );
    } catch (e: any) {
      setDiffOut(<div class="err">对比失败：{esc(e.message)}</div>);
    } finally {
      setDiffBusy(false);
    }
  };

  return (
    <>
      <div class="note"><b>结果：</b>
        {t.outcome && t.outcome !== "success" ? (
          <a href="#diag/cheat-reason" onClick={closeDrawer} title="这条失败结果对应的人话解释与建议动作">{t.outcome}</a>
        ) : (t.outcome)} · 耗时 {ms(t.durationMs)}{t.failedAtStage ? <> · 失败于 <b>{t.failedAtStage}</b></> : ""}
      </div>
      <div class="kv">
        <div class="k">traceId</div><div class="mono">{t.traceId}</div>
        <div class="k">requestId</div><div class="mono">{t.requestId}</div>
        <div class="k">模型</div><div class="mono">{t.model || "—"}</div>
        <div class="k">开始时间</div><div class="mono">{TS(t.startedAt)}</div>
      </div>
      <h2 style="margin:16px 0 6px">步骤时间线</h2>
      <div class="steps">{srows.map((r, i) => <StepRow key={i} row={r} maxDur={maxDur} />)}</div>
      <div class="note" style="margin-top:var(--s4)">客户端可带 <span class="mono">x-relay-verify-nonce</span> 请求内容 HMAC，
        用同一 nonce 对收到的响应体重算即可自证字节未被篡改。</div>
      <h2 style="margin:16px 0 6px">对比另一条 <span class="muted-xs">（同一客户一成一败时，贴另一条 trace-id 看差在哪一步）</span></h2>
      <div class="hstack">
        <input placeholder="另一条 trace-id" style="flex:1" value={diffOther}
          onInput={(e) => setDiffOther((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); doDiff(); } }} />
        <button class="bare" disabled={diffBusy} onClick={doDiff}>对比</button>
      </div>
      <div style="margin-top:var(--s2)">{diffOut}</div>
      <div class="hstack-end stack-md">
        <button class="bare" onClick={() => copyText(traceText(), "排障摘要已复制（request-id/结果/步骤时间线）")}>复制排障摘要</button>
        <button class="pri" onClick={closeDrawer}>关闭</button>
      </div>
    </>
  );
}

async function showTrace(id: string) {
  let d: any;
  try {
    d = await api("traces/" + encodeURIComponent(id));
  } catch (e: any) {
    const r = writeErr("开详情", e);
    toast(r.text, r.tone);
    return;
  }
  openDrawer({ title: "请求详情 · " + d.trace.requestId, body: <TraceBox t={d.trace} /> });
}

/* ---------------- 主视图 ---------------- */

export function Ledger() {
  const [rows, setRows] = useState<TraceSlim[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [filter, setFilter] = useState<LedgerFilter>("all");
  const [time, setTime] = useState<LedgerTime>("all");
  const [q, setQ] = useState("");
  const [deepNote, setDeepNote] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      setErr(null);
      try {
        const d = await api<any>("traces?limit=100&slim=1");
        if (alive) { setRows(d.traces || []); setDeepNote(null); setLoaded(true); }
      } catch (e: any) {
        if (alive) setErr(e && e.message ? e.message : String(e));
      }
    })();
    return () => { alive = false; };
  }, [tick]);

  const deepSearch = async (text: string) => {
    if (!text) return;
    try {
      const d = await api<any>("traces?limit=5000&q=" + encodeURIComponent(text) + "&slim=1");
      const hits: TraceSlim[] = d.traces || [];
      const win = formatNumber(d.scanned || 0);
      if (!hits.length) {
        toast("最近 " + win + " 条内均无匹配「" + esc(text) + "」——更早的记录已被窗口截断，换关键词或缩小时间范围", "y");
        return;
      }
      setRows(hits);
      setFilter("all");
      setDeepNote("深度命中 " + formatNumber(hits.length) + "（最近 " + win + " 条，点 ↻ 恢复全量）");
      toast("深度搜索命中 " + hits.length + " 条（最近 " + win + " 条，点 ↻ 恢复全量）", "g");
    } catch (e: any) {
      toast("深度搜索失败：" + esc(e.message), "r");
    }
  };

  const counts: Record<string, number> = { all: rows.length, degraded: 0 };
  for (const t of rows) {
    counts[t.outcome] = (counts[t.outcome] || 0) + 1;
    if (t.degraded) counts.degraded++;
  }

  const visible = rows.filter((t) => ledgerMatch(t, filter, time, q));

  const exportCsv = () => {
    const head = ["时间", "request", "trace", "结果", "耗时ms", "失败阶段", "步数", "降级"];
    const data = visible.map((t) => [
      TS(t.startedAt), t.requestId, t.traceId, t.outcome, t.durationMs,
      t.failedAtStage || (t.degraded ? "precheck(degraded)" : ""), t.stepCount == null ? 0 : t.stepCount, t.degraded ? "是" : "",
    ]);
    const csv = CSV_BOM + [head].concat(data as any).map((r) => r.map(csvCell).join(",")).join(CRLF);
    downloadText("api-relay-traces-" + new Date().toISOString().slice(0, 10) + ".csv", csv, "text/csv;charset=utf-8");
    toast("已导出 <b>" + visible.length + "</b> 条账本记录（当前筛选结果）", "g");
  };

  const exportJson = () => {
    const data = visible.map((t) => ({
      startedAt: t.startedAt, requestId: t.requestId, traceId: t.traceId, outcome: t.outcome,
      durationMs: t.durationMs, failedAtStage: t.failedAtStage, stepCount: t.stepCount, degraded: t.degraded,
    }));
    downloadText("api-relay-traces-" + new Date().toISOString().slice(0, 10) + ".json",
      JSON.stringify({ exportedAt: new Date().toISOString(), traces: data }, null, 2), "application/json");
    toast("已导出 <b>" + data.length + "</b> 条账本记录 JSON", "g");
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Enter") return;
    if (visible.length === 1) showTrace(visible[0].traceId);
    else if (visible.length > 1) toast("匹配 " + visible.length + " 条，继续输入以缩小范围", "y");
    else deepSearch(q.trim());
  };

  return (
    <div>
      <div class="note">一次请求内部的完整步骤：鉴权 → 预检 → 指纹 → 路由 → 上游 → 归因 → 重试 → 流 → 度量。
        用户报障时让他给响应头 <span class="mono">x-request-id</span>，在这里点开即可定位卡在哪一步。
        成功响应的字节可被客户端用 <span class="mono">x-relay-content-hmac</span> 自证未被改写（见「信任」页）。</div>

      <section class="block">
        <h2>请求账本 <span class="spacer" />
          <button class="bare" title="导出当前筛选结果的 CSV（异步事故分享用：贴进工单/群的文件；BOM+CRLF，Excel 直接打开）" onClick={exportCsv}>导出 CSV</button>
          <button class="bare" title="导出当前筛选结果的 JSON（备份/审阅用）" onClick={exportJson}>导出 JSON</button>
          <button class="bare" onClick={() => setTick((t) => t + 1)}>↻</button>
        </h2>
        <div class="row filters">
          {(["all", "success", "upstream_error", "client_error", "aborted", "degraded"] as const).map((f) => (
            <button key={f} class={"bare" + (filter === f ? " on" : "")} onClick={() => setFilter(f)}>
              {FILTER_LABEL[f]} · {formatNumber(counts[f] || 0)}
            </button>
          ))}
        </div>
        <div class="row filters" style="margin-top:6px">
          <span class="dim" style="font-size:var(--fs-sm);align-self:center">时间：</span>
          {([["all", "全部时间"], ["1h", "最近 1 小时"], ["6h", "最近 6 小时"], ["24h", "最近 24 小时"]] as [LedgerTime, string][]).map(([v, label]) => (
            <button key={v} class={"bare" + (time === v ? " on" : "")}
              title="按请求发起时间过滤已加载的 100 条；更早的记录用「深搜」"
              onClick={() => setTime(v)}>{label}</button>
          ))}
        </div>
        <div class="row" style="margin-top:var(--s2)">
          <input placeholder="🔍 搜索 request-id / trace-id / 模型 / 失败阶段（客户报障时粘贴他给的 id，回车唯一命中直接打开）"
            style="flex:1" value={q}
            onInput={(e) => setQ((e.target as HTMLInputElement).value)}
            onKeyDown={onKey} />
          <button class="bare" title="深度搜索：在最近 5000 条里按同一字段过滤（本地 100 条零命中按回车也会自动触发）"
            onClick={() => deepSearch(q.trim())}>深搜</button>
          <span class="muted-sm">{deepNote || (formatNumber(visible.length) + " / " + formatNumber(rows.length))}</span>
        </div>
        {err ? <div class="note bad">加载失败：{err}——稍后点 ↻ 重试</div> : !loaded ? (
          <div class="skel" style="height:200px" />
        ) : (
          <table>
            <thead><tr><th>时间</th><th>request / trace</th><th>模型</th><th>结果</th><th class="num">耗时</th><th>失败阶段</th><th>步骤</th></tr></thead>
            <tbody>
              {visible.length ? visible.map((t) => (
                <tr key={t.traceId} {...rowA11y("查看请求轨迹详情")}>
                  <td class="mono fit">
                    <button class="row-act" onClick={() => showTrace(t.traceId)} aria-label="查看请求轨迹详情" />
                    {dayTime(t.startedAt)}
                  </td>
                  <td class="mono">{t.requestId}</td>
                  <td><ChipOutcome t={t} /></td>
                  <td class="mono dim" style="max-width:150px;overflow:hidden;text-overflow:ellipsis" title={t.model || ""}>{t.model || "—"}</td>
                  <td class="mono">{ms(t.durationMs)}</td>
                  <td class="mono dim">{t.failedAtStage || (t.degraded ? "precheck(degraded)" : "-")}</td>
                  <td class="mono dim">{formatNumber(t.stepCount == null ? 0 : t.stepCount)}</td>
                </tr>
              )) : (
                <tr><td colspan={7} class="dim">
                  {q.trim()
                    ? <>没有匹配「{q.trim()}」的请求——换个关键词，或清空搜索框</>
                    : time !== "all"
                      ? <>这个时间范围内没有记录（已加载 100 条约覆盖数小时）——放宽时间范围，或点右上角 ↻ 刷新</>
                      : <>暂无记录；先发几个请求</>}
                </td></tr>
              )}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

/* 结果 chip（成功/中断/上游错误等 + 降级标记） */
function ChipOutcome(props: { t: TraceSlim }) {
  const t = props.t;
  return (
    <>
      <span class={"chip " + (t.outcome === "success" ? "g" : t.outcome === "aborted" ? "y" : "r")}>{t.outcome}</span>
      {t.degraded ? <span class="chip y" title="预检内部异常→fail-open 放行（错题本待查项）">降级</span> : null}
    </>
  );
}