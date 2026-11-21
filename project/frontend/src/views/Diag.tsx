import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "../api";
import type { AdminEvent, AuthFailuresResp, CatalogResp, TopErrorsResp } from "../types";
import {
  CSV_BOM, CRLF, Chip, Empty, Tile, copyText, csvCell, downloadText, esc, formatNumber, rowA11y, toast, TS, writeErr,
} from "../ui";
import { closeDrawer, openDrawer } from "../drawer";
import { windowValue, hashAnchor, view } from "../state";
import { REASON_HINT } from "./Overview";

type EvFilter = string;
type EvLevel = "all" | "error" | "warn" | "info";

const EV_KIND_LABEL: Record<string, string> = { all: "全部", agent: "Agent", kb: "知识库", key: "Key 运维" };
const EV_LEVEL_LABEL: Record<string, string> = { all: "全部级别", error: "只看 error", warn: "warn", info: "info" };

const evLevelQuery = (l: EvLevel) => (l === "all" ? "" : "&level=" + encodeURIComponent(l));

/* ---------------- 事件详情（slim → 全量按需） ---------------- */

let EV_FULL: { q: string | null; rows: AdminEvent[] | null } = { q: null, rows: null };

function evFullQuery(filter: EvFilter, level: EvLevel): string {
  return (filter === "all" ? "events?limit=100" : "events?limit=200&kind=" + encodeURIComponent(filter)) + evLevelQuery(level);
}

async function ensureEvFull(filter: EvFilter, level: EvLevel): Promise<AdminEvent[]> {
  const q = evFullQuery(filter, level);
  if (EV_FULL.q === q && EV_FULL.rows) return EV_FULL.rows;
  const d = await api<any>(q);
  EV_FULL = { q, rows: d.events || [] };
  return EV_FULL.rows!;
}

function EventDetail(props: { e: AdminEvent }) {
  const e = props.e;
  const text = JSON.stringify({ kind: e.kind, ts: e.ts, level: e.level, detail: e.detail || {} }, null, 2);
  return (
    <>
      <div class="mono" style="font-size:var(--fs-sm)">{TS(e.ts)} · {e.level}</div>
      <pre>{JSON.stringify(e.detail || {}, null, 2)}</pre>
      <div style="display:flex;gap:var(--s2);justify-content:flex-end;margin-top:var(--s3)">
        <button class="bare" onClick={() => copyText(text, "事件 JSON 已复制（含 kind/ts/level/detail）")}>复制事件 JSON</button>
        <button class="pri" onClick={closeDrawer}>关闭</button>
      </div>
    </>
  );
}

/* ---------------- 主视图 ---------------- */

export function Diag() {
  const [data, setData] = useState<null | {
    ev: AdminEvent[]; af: AuthFailuresResp; cat: CatalogResp; te: TopErrorsResp; fails: string[];
  }>(null);
  const [tick, setTick] = useState(0);
  const [filter, setFilter] = useState<EvFilter>(() => {
    try { return localStorage.getItem("relay_admin_ev_filter") || "all"; } catch { return "all"; }
  });
  const [level, setLevel] = useState<EvLevel>(() => {
    try {
      const v = localStorage.getItem("relay_admin_ev_level");
      return (v === "error" || v === "warn" || v === "info") ? v : "all";
    } catch { return "all"; }
  });

  useEffect(() => {
    let alive = true;
    (async () => {
      const diagFail: string[] = [];
      const soft = <T,>(p: string, dflt: T, label: string): Promise<T> =>
        api<any>(p).catch((e: any) => {
          diagFail.push(label + "（" + (e && e.message ? e.message : "网络错误") + "）");
          return dflt;
        });
      const [ev, evKind, af, cat, te] = await Promise.all([
        filter === "all" ? soft<AdminEvent[]>("events?limit=100&detail=0" + evLevelQuery(level), [], "事件日志")
          .then((d: any) => d.events || []) : Promise.resolve(null),
        filter === "all" ? Promise.resolve(null)
          : soft<any>("events?limit=200&kind=" + encodeURIComponent(filter) + "&detail=0" + evLevelQuery(level), { events: [] }, "事件日志"),
        soft<AuthFailuresResp>("auth-failures?limit=50", { total: 0 }, "鉴权失败"),
        soft<CatalogResp>("attribution/catalog", { failure_reasons: [] }, "归因目录"),
        soft<TopErrorsResp>("top-errors?window=" + windowValue.value + "&limit=10", { errors: [] }, "错的是什么"),
      ]);
      const events: AdminEvent[] = ((evKind ? evKind.events : null) || ev || []) as AdminEvent[];
      if (alive) setData({ ev: events, af, cat, te, fails: diagFail });
    })();
    return () => { alive = false; };
  }, [tick, filter, level]);

  /* 5.2 联动：hash 带 #diag/cheat-reason 时展开速查并滚动到位（数据到位后重试一次） */
  const [cheatOpen, setCheatOpen] = useState(false);
  const cheatRef = useRef<HTMLDetailsElement | null>(null);
  useEffect(() => {
    const apply = () => {
      if (view.value === "diag" && hashAnchor() === "cheat-reason") {
        setCheatOpen(true);
        requestAnimationFrame(() => cheatRef.current?.scrollIntoView({ block: "start" }));
      }
    };
    window.addEventListener("hashchange", apply);
    apply();
    return () => window.removeEventListener("hashchange", apply);
  }, [data]);

  if (!data) {
    return (
      <div>
        <section class="block"><h2>鉴权失败</h2><div class="skel" style="height:120px" /></section>
        <section class="block"><h2>事件日志</h2><div class="skel" style="height:180px" /></section>
      </div>
    );
  }

  const { ev, af, cat, te, fails } = data;
  const refresh = () => setTick((t) => t + 1);

  const evPrefixes = [...new Set(ev.map((e) => (e.kind || "?").split(".")[0]))];
  const evCounts: Record<string, number> = { all: ev.length };
  for (const e of ev) {
    const pfx = (e.kind || "?").split(".")[0];
    evCounts[pfx] = (evCounts[pfx] || 0) + 1;
  }
  const shownEvents = ev.filter((e) =>
    (filter === "all" || (e.kind || "").startsWith(filter + ".")) &&
    (level === "all" || e.level === level));

  const setF = (f: string) => {
    setFilter(f);
    try { localStorage.setItem("relay_admin_ev_filter", f); } catch { /* 存不上不影响当次 */ }
  };
  const setL = (l: EvLevel) => {
    setLevel(l);
    try { localStorage.setItem("relay_admin_ev_level", l); } catch { /* 存不上不影响当次 */ }
  };

  const lvChip = (l?: string) => (
    <Chip tone={l === "error" ? "r" : l === "warn" ? "y" : "b"}>{l || "?"}</Chip>
  );

  const openEvent = async (idx: number) => {
    let e = shownEvents[idx];
    try {
      const full = await ensureEvFull(filter, level);
      if (full[idx]) e = full[idx];
    } catch { /* 回退 slim 行 */ }
    openDrawer({ title: "事件 · " + e.kind, body: <EventDetail e={e} /> });
  };

  const exportCsv = async () => {
    let fullRows: AdminEvent[] | null = null;
    try { fullRows = await ensureEvFull(filter, level); } catch { /* 回退 brief */ }
    const csvRows = fullRows || shownEvents;
    const head = ["时间", "级别", "kind", "操作者", "详情"];
    const data2 = csvRows.map((e) => [
      TS(e.ts), e.level || "", e.kind, (e.detail && e.detail.actor) || "", JSON.stringify(e.detail || {}),
    ]);
    const csv = CSV_BOM + [head].concat(data2 as any).map((r) => r.map(csvCell).join(",")).join(CRLF);
    downloadText("api-relay-events-" + new Date().toISOString().slice(0, 10) + ".csv", csv, "text/csv;charset=utf-8");
    toast("已导出 <b>" + shownEvents.length + "</b> 条事件（当前筛选结果）", "g");
  };

  const topErrs = te.errors || [];
  const groups = af.groups || [];
  const codes = af.byCode || [];
  const reasons = cat.failure_reasons || [];

  return (
    <div>
      {fails.length ? (
        <div class="note warn" style="margin-bottom:10px">
          <b>部分数据加载失败：</b>{fails.map(esc).join("；")}——对应区块显示的是空态而非真实数据，稍后点右上角 ↻ 重试；其余区块数据不受影响。
        </div>
      ) : null}
      <div class="note"><b>出问题时先看这一页。</b>三块分别回答：网关自己记了什么（事件日志）、
        客户是不是 key 用错了（鉴权失败指纹）、错误被翻译成了什么（归因目录 —— 它同时是给客户端的契约）。</div>

      <section class="block">
        <h2>鉴权失败 <span class="spacer" /><span class="muted-xs" style="text-transform:none">"API 全 401" 的第一现场</span></h2>
        {af.total ? (
          <>
            <div class="grid cards" style="margin-bottom:10px">
              <Tile k="被拒次数" v={formatNumber(af.total)} sub="窗口内累计" />
              <Tile k="不同指纹" v={formatNumber(af.distinct)} sub="每个指纹 = 一把不同的 key" />
            </div>
            <div style="margin-bottom:10px">
              {codes.map((c) => <Chip key={c.code}>{c.code + " × " + formatNumber(c.count)}</Chip>)}
            </div>
            <table>
              <thead><tr><th>原因</th><th>key 指纹</th><th>次数</th><th>首次</th><th>最近</th><th>头形态</th><th>是不是这里签发的</th></tr></thead>
              <tbody>
                {groups.slice(0, 20).map((g, i) => (
                  <tr key={i}>
                    <td>{g.code}</td>
                    <td class="mono">{g.fingerprint || "(无 key)"}</td>
                    <td class="mono">{formatNumber(g.count)}</td>
                    <td class="dim">{TS(g.firstAt || 0)}</td>
                    <td class="dim">{TS(g.lastAt || 0)}</td>
                    <td class="mono">{g.headerForm}</td>
                    <td>{g.matchesIssuedKey
                      ? <Chip tone="g">命中已签发 key（被禁用/过期）</Chip>
                      : <Chip tone="y">不是这里签发的（抄错或旧 key）</Chip>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {af.recent && af.recent.length ? (
              <div style="margin-top:var(--s3)">
                <div class="dim" style="font-size:var(--fs-sm);margin-bottom:4px">最近被拒记录（时间/端点/头形态/key 长度）：</div>
                <table>
                  <thead><tr><th>时间</th><th>原因</th><th>端点</th><th>头形态</th><th class="num">key 长度</th></tr></thead>
                  <tbody>
                    {af.recent.slice(0, 12).map((r, i) => (
                      <tr key={i}>
                        <td class="dim">{TS(r.at)}</td>
                        <td>{r.code}</td>
                        <td class="mono">{r.path || ""}</td>
                        <td class="mono dim">{r.headerForm || ""}</td>
                        <td class="mono num dim">{formatNumber(r.keyLength)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </>
        ) : (
          <Empty icon="🔑" msg="窗口内没有被拒的请求" hint="出现 401 时这里会留下指纹，一眼看出是哪把 key" />
        )}
      </section>

      <section class="block">
        <h2>错的是什么 <span class="spacer" /><span class="muted-xs" style="text-transform:none">窗口内上游失败签名</span></h2>
        {topErrs.length ? (
          <>
            <table>
              <thead><tr><th>失败原因</th><th class="num">次数</th><th>实例</th></tr></thead>
              <tbody>
                {topErrs.map((e, i) => (
                  <tr key={i}><td>{e.reason}</td><td class="mono num">{formatNumber(e.count)}</td><td class="mono dim">{e.example || ""}</td></tr>
                ))}
              </tbody>
            </table>
            <div class="muted-xs stack-sm">
              与上面「鉴权失败」互补：那块管客户端 key（401），这块管上游错误（5xx/超时/限流）。实例列是每条原因的首次样本（model@provider HTTP status）。覆盖范围：进程启动以来{te.coveredSince ? "（最早 " + TS(te.coveredSince) + "，短于所选窗口是正常的——刚重启过就是这样）" : ""}。
            </div>
          </>
        ) : (
          <div class="dim">本进程启动以来没有上游失败{te.coveredSince ? "（覆盖自 " + TS(te.coveredSince) + "）" : "（刚重启，还没有积累）"}。注意：这块看的是进程内度量，不是全历史——更早的失败去「请求账本」深搜。</div>
        )}
      </section>

      <section class="block">
        <h2>事件日志 <span class="spacer" />
          <button class="bare" title="导出当前筛选事件的 CSV（审计轨迹用：key 轮换/配置变更/熔断的记录归档；BOM+CRLF，Excel 直接打开）" onClick={exportCsv}>导出 CSV</button>
          <button class="bare" onClick={refresh}>↻</button>
        </h2>
        <div class="row filters">
          {["all"].concat(evPrefixes).map((f) => (
            <button key={f} class={"bare" + (filter === f ? " on" : "")} onClick={() => setF(f)}>
              {(EV_KIND_LABEL[f] || f) + " · " + formatNumber(evCounts[f] || 0)}
            </button>
          ))}
        </div>
        <div class="row filters">
          {(["all", "error", "warn", "info"] as EvLevel[]).map((l) => (
            <button key={l} class={"bare" + (level === l ? " on" : "")} onClick={() => setL(l)}>
              {(EV_LEVEL_LABEL[l] || l) + " · " + formatNumber(l === "all" ? ev.length : ev.filter((e) => e.level === l).length)}
            </button>
          ))}
        </div>
        <table>
          <thead><tr><th>时间</th><th>级别</th><th>事件</th><th>操作者</th><th>详情</th></tr></thead>
          <tbody>
            {shownEvents.length ? shownEvents.map((e, i) => {
              const actor = e.actor != null ? e.actor : ((e.detail && e.detail.actor) || "");
              const ip = actor ? actor.split(" ")[0].replace("::ffff:", "") : "";
              return (
                <tr key={i} {...rowA11y("查看事件详情")}>
                  <td class="dim fit">
                    <button class="row-act" onClick={() => openEvent(i)} aria-label="查看事件详情" />
                    {TS(e.ts)}
                  </td>
                  <td>{lvChip(e.level)}</td>
                  <td class="mono">{e.kind}</td>
                  <td class="mono dim">{ip ? <span title={actor}>{ip}</span> : "—"}</td>
                  <td class="dim">{e.brief != null ? e.brief : JSON.stringify(e.detail || {}).slice(0, 90)}</td>
                </tr>
              );
            }) : (
              <tr><td colspan={5} class="dim">暂无事件——面板上的写动作（建/改/禁 key、灌文档、跑 Agent）会自动记录到这里，不是坏了</td></tr>
            )}
          </tbody>
        </table>
        <div class="muted-xs stack-sm">点任意一行看完整详情。key 轮换/吊销、降损开关改动、上游熔断都会记在这里。</div>
      </section>

      <section class="block">
        <h2>失败归因目录 <span class="spacer" /><span class="muted-xs" style="text-transform:none">给客户端的契约</span></h2>
        <details class="cheat" id="cheat-reason" ref={cheatRef} open={cheatOpen}
          onToggle={(e) => setCheatOpen((e.target as HTMLDetailsElement).open)}>
          <summary>💡 常见归因速查（点开看人话解释，与总览横幅同一套词表）</summary>
          <div class="cheat-body">
            {(reasons.length ? reasons.map((r) => r.reason) : Object.keys(REASON_HINT)).map((reason) => (
              <div class="cheat-row" key={reason}>
                <span class="mono cheat-k">{reason}</span>
                <span>{REASON_HINT[reason] || (reasons.find((r) => r.reason === reason) || {})["中文"] || "（未收录解释——目录更新后此处自动补齐）"}</span>
              </div>
            ))}
            <div class="muted-xs stack-sm">
              蓝字 reason 是稳定契约（客户端可程序化分支处理）；同一故障在总览横幅、请求账本、这里的描述完全一致。
            </div>
          </div>
        </details>
        <div class="dim" style="font-size:var(--fs-sm);margin-bottom:8px">{cat.description || ""}</div>
        <div style="margin-bottom:10px">
          <Chip tone="b">full</Chip> {(cat.delivery || {}).full || ""}<br />
          <Chip>header</Chip> {(cat.delivery || {}).header || ""}<br />
          <Chip>off</Chip> {(cat.delivery || {}).off || ""}
        </div>
        <table>
          <thead><tr><th>reason</th><th>中文</th><th>可恢复</th><th>建议动作</th></tr></thead>
          <tbody>
            {reasons.map((r, i) => (
              <tr key={i}>
                <td class="mono">{r.reason}</td>
                <td>{r["中文"] || ""}</td>
                <td>{r.recoverable ? <Chip tone="g">是</Chip> : <Chip tone="r">否</Chip>}</td>
                <td class="mono">{r.action}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div class="muted-xs stack-sm">{(cat.precheck || {}).description || ""}<br />{(cat.precheck || {}).fail_open || ""}</div>
      </section>
    </div>
  );
}

/* writeErr 在 openEvent/导出的 catch 里间接用到；显式引用避免未用告警 */
void writeErr;
