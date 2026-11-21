import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "../api";
import type { AgentRunFull, AgentStateFull } from "../types";
import { copyText, esc, formatNumber, toast, TS } from "../ui";

/* ---------------- 决策卡（最近一轮与历史共用） ---------------- */

function RunCard(props: { r: AgentRunFull; kbId?: string }) {
  const r = props.r;
  const d = r.decision || {};
  const n = d.kbNote;
  // 一键写入 KB 的防连点状态（写入中禁用；成功后停在「已写入 ✓」）
  const [wst, setWst] = useState<"idle" | "busy" | "done">("idle");

  // 复制整轮（manual#91）：摘要+建议+证据（+知识沉淀+错误）序列化成文本
  const copyRun = () => {
    const text =
      "[" +
      (r.trigger === "auto" ? "自动巡检" : "手动触发") +
      "] · " +
      (d.kind || "none") +
      " · 置信 " +
      d.confidence +
      (r.model ? " · 模型 " + r.model : "") +
      "\n" +
      "时间: " +
      TS(r.startedAt) +
      " · " +
      r.durationMs +
      "ms · " +
      r.promptTokens +
      "/" +
      r.completionTokens +
      " tok\n" +
      "摘要: " +
      (d.summary || "") +
      "\n" +
      "建议: " +
      (d.recommendation || "") +
      (d.evidence && d.evidence.length ? "\n证据: " + d.evidence.join(" | ") : "") +
      (n ? "\n知识沉淀建议: " + (n.title || "") + "\n" + (n.content || "") : "") +
      (r.error ? "\n错误: " + r.error : "");
    copyText(text, "Agent 决策已复制（摘要+建议+证据" + (n ? "+知识沉淀" : "") + "）");
  };

  // 一键写入 KB（manual#185 + v2·D7 修复）：agent→kbNote→KB 知识回流链。
  // v1 缺陷 D7：固定 POST kb-demo/docs（addDoc 无判重，且库名与后端默认 kb_demo 不一致）——
  // 服务端修好的堆积问题在这个按钮上开口子。v2：kbId 从 Agent status 动态取，body 带
  // upsert:true 走 upsertDoc（同源同题原地更新）；source='agent' 在文档表区分来源并留痕。
  const writeKb = async () => {
    if (wst !== "idle") return;
    setWst("busy");
    try {
      const kbId = props.kbId || "kb_demo";
      const resp = await api<any>(`kb/${kbId}/docs`, {
        method: "POST",
        body: JSON.stringify({
          title: (n && n.title) || "(agent 建议)",
          content: (n && n.content) || "",
          source: "agent",
          upsert: true,
        }),
      });
      toast(
        "已写入知识库：文档 #" + (resp.doc && resp.doc.id) + "（" + esc((n && n.title) || "") + "，source=agent，" +
          (resp.mode === "upsert" ? "同题原地更新" : "新增") + "）",
        "g",
      );
      setWst("done");
    } catch (e: any) {
      toast("写入失败：" + esc(e.message), "r");
      setWst("idle");
    }
  };

  return (
    <div class="card" style="margin-bottom:10px">
      <div style="display:flex;justify-content:space-between;margin-bottom:6px;gap:var(--s2);flex-wrap:wrap">
        <b>
          {(r.trigger === "auto" ? "自动巡检" : "手动触发") + " · " + (d.kind || "none") + " · 置信 "}
          {formatNumber(d.confidence)}
          {r.fromEvent ? (
            <span
              class="chip y"
              style="font-size:var(--fs-2xs)"
              title="进程重启过——内存里的运行记录已清空，这一轮由事件库的 agent.decision 重建；耗时与 token 为 0（事件不记）"
            >
              重启前·事件重建
            </span>
          ) : null}
          {r.model ? (
            <span class="chip" style="font-size:var(--fs-2xs)" title="本轮决策所用模型（换模型后对比效果时看这里）">
              {r.model}
            </span>
          ) : null}
        </b>
        <span class="hstack">
          <span class="mono dim" style="font-size:var(--fs-xs)">
            {TS(r.startedAt)} · {r.durationMs}ms · {formatNumber(r.promptTokens)}/{formatNumber(r.completionTokens)} tok
          </span>
          <button class="bare" title="复制本轮决策（摘要+建议+证据）" onClick={copyRun}>
            复制
          </button>
        </span>
      </div>
      <div class="note" style="margin:0 0 6px">{d.summary || ""}</div>
      <div style="font-size:var(--fs-body);margin-bottom:6px">
        <b>建议：</b>
        {d.recommendation || ""}
      </div>
      {d.evidence && d.evidence.length ? (
        <div class="dim" style="font-size:var(--fs-sm);margin-bottom:6px">
          <b>证据：</b>
          {d.evidence.join(" | ")}
        </div>
      ) : null}
      {n ? (
        <div class="note" style="margin:0 0 6px">
          <b>知识沉淀建议</b>（agent 建议写入 KB 的内容）
          <div style="margin-top:4px">
            <b>{n.title || ""}</b>
          </div>
          <div class="dim" style="font-size:var(--fs-sm);margin-top:2px;white-space:pre-wrap">{n.content || ""}</div>
          <button
            class="bare"
            style="margin-top:4px"
            title="复制标题+正文，可直接贴进 KB 灌入表单"
            onClick={() => copyText("# " + (n.title || "") + "\n" + (n.content || ""), "知识沉淀建议已复制（标题+正文）")}
          >
            复制
          </button>{" "}
          <button
            class="bare"
            style="margin-top:4px"
            title="一键写入知识库 kb-demo（错题本）——source 标 agent，事件日志留痕；与复制并存，习惯哪个用哪个"
            disabled={wst !== "idle"}
            onClick={writeKb}
          >
            {wst === "busy" ? "写入中…" : wst === "done" ? "已写入 ✓" : "写入 KB"}
          </button>
        </div>
      ) : null}
      {r.error ? (
        <div class="note" style="border-color:var(--err);color:var(--err);margin:0">
          出错：{r.error}
        </div>
      ) : null}
    </div>
  );
}

/* ---------------- 主视图 ---------------- */

export function Agent() {
  const [state, setState] = useState<AgentStateFull | null>(null);
  const [last, setLast] = useState<AgentRunFull | null | undefined>(undefined);
  const [runs, setRuns] = useState<AgentRunFull[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [firing, setFiring] = useState(false);
  // A3/A4（审查修复）：Agent 自身指标与发现项——后端 /agent/metrics、/agent/findings 已建、面板此前无入口。
  const [metrics, setMetrics] = useState<any | null>(null);
  const [findings, setFindings] = useState<any[] | null>(null);
  const [markBusy, setMarkBusy] = useState<string | null>(null);
  /** 首次加载中：骨架只显示一次，刷新时保留旧数据避免闪屏 */
  const [loadingInitial, setLoadingInitial] = useState(true);
  /** 内容渐显：新数据到达时给一个 180ms 的 opacity 过渡，避免整块 swap 的视觉跳变 */
  const [fadeKey, setFadeKey] = useState(0);
  const aliveRef = useRef(true);

  const refreshLast = async () => {
    try {
      const d = await api<any>("agent/last");
      if (aliveRef.current) setLast(d.last || null);
    } catch {
      if (aliveRef.current) setLast(null);
    }
  };

  const refreshRuns = async () => {
    try {
      const d = await api<any>("agent/runs?limit=15");
      if (aliveRef.current) setRuns(d.runs || []);
    } catch {
      /* 轮询失败静默——自动刷新仍会兜底 */
    }
  };

  // A3：Agent 自身指标（成功率/p50/p95/token/工具调用/发现项/降级）
  const refreshMetrics = async () => {
    try {
      const d = await api<any>("agent/metrics");
      if (aliveRef.current) setMetrics(d);
    } catch {
      /* 未启用或轮询失败静默 */
    }
  };

  // A4：发现项（默认只看未闭环）；打标走 POST agent/findings/{id}/mark
  const refreshFindings = async () => {
    try {
      const d = await api<any>("agent/findings?onlyOpen=1");
      if (aliveRef.current) setFindings(d.findings || []);
    } catch {
      /* 静默 */
    }
  };

  const markFinding = async (id: string, status: "acknowledged" | "resolved" | "ignored") => {
    if (markBusy) return;
    setMarkBusy(id);
    try {
      await api(`agent/findings/${encodeURIComponent(id)}/mark`, { method: "POST", body: JSON.stringify({ status }) });
      toast("已标记：「" + esc(id) + "」→ " + status, "g");
      await refreshFindings();
      await refreshMetrics();
    } catch (e: any) {
      toast("标记失败：" + esc(e.message), "r");
    } finally {
      setMarkBusy(null);
    }
  };

  useEffect(() => {
    aliveRef.current = true;
    (async () => {
      setErr(null);
      let st: AgentStateFull;
      try {
        st = await api<AgentStateFull>("agent");
      } catch (e: any) {
        if (e && (e.status === 404 || e.status === 503)) {
          if (aliveRef.current) setState({ enabled: false });
          setLoadingInitial(false);
          return;
        }
        if (aliveRef.current) setErr(e && e.message ? e.message : String(e));
        setLoadingInitial(false);
        return;
      }
      if (!aliveRef.current) return;
      setState(st);
      setLoadingInitial(false);
      if (!st.enabled) return;
      await refreshLast();
      await refreshRuns();
      await refreshMetrics();
      await refreshFindings();
      setFadeKey((k) => k + 1);
    })();
    return () => {
      aliveRef.current = false;
    };
  }, [tick]);

  if (err) {
    return (
      <section class="block">
        <h2>Agent</h2>
        <div class="note bad">加载失败：{err}——稍后点右上角 ↻ 重试</div>
      </section>
    );
  }
  // 骨架只在首次加载时显示；15s 自动刷新期间保留旧数据，避免闪屏
  if (loadingInitial && !state) {
    return (
      <section class="block">
        <h2>Agent</h2>
        <div class="skel" style="height:220px" />
      </section>
    );
  }
  if (!state) {
    return null;
  }

  const refresh = () => setTick((t) => t + 1);

  if (!state.enabled) {
    return (
      <div key={fadeKey} style="animation: fadeIn 0.18s ease-out">
        <div class="note">
          <b>内部 Agent 系统未启用。</b>在配置里加 <span class="mono">agent.enabled: true</span> 并指定{" "}
          <span class="mono">agent.clientId</span>（本网关 clients 里的一条 key）与 <span class="mono">agent.model</span>{" "}
          后重启网关即可。 Agent 会周期性（或手动）读网关运营快照 → 调网关自身 LLM 分析 → 产出运维/迭代建议 → 沉淀到知识库
          → 记审计事件。
        </div>
        <div class="muted-sm">当前：{esc(JSON.stringify(state || {}))}</div>
      </div>
    );
  }

  const status = state.status || {};

  // 手动触发 + 短轮询链（manual#201/#332）：8/16/24/32/40/48s 六次覆盖 LLM p95+（report p95 已
  // 28.4s），切页即停（aliveRef 守卫）；48s 仍无结果交给自动刷新兜底。
  const doRun = async () => {
    if (firing || status.running) return;
    setFiring(true);
    try {
      await api("agent", { method: "POST", body: JSON.stringify({}) });
      toast("已触发，本轮结果稍后自动出现（LLM 一轮 10-20 秒）");
      setTimeout(refresh, 400);
      for (const delay of [8000, 16000, 24000, 32000, 40000, 48000]) {
        setTimeout(async () => {
          if (!aliveRef.current) return;
          try {
            await refreshLast();
            await refreshRuns();
          } catch {
            /* 轮询失败静默——自动刷新仍会兜底 */
          }
        }, delay);
      }
    } catch (e: any) {
      // 409=上一轮仍在运行（manual#192）：后端防重入的预期语义，黄色告知即可
      if (e && e.status === 409) toast("上一轮 Agent 还在跑，稍后再点（LLM 一轮 10-20 秒）", "y");
      else if (e && e.status === 503) toast("Agent 系统未启用（配置里开 agent.enabled）", "y");
      else toast("触发失败：" + esc(e.message), "r");
    } finally {
      setFiring(false);
    }
  };

  return (
    <div key={fadeKey} style="animation: fadeIn 0.18s ease-out">
      <div class="note">
        <b>内部 Agent 系统。</b>自托管运维/迭代决策环：网关读自身运营数据 → 调网关自身 LLM → 产出建议 → 写 KB +
        审计。 安全边界：Agent 只产"建议"不执行配置变更；LLM 调用走完整计量链路（client_kind=agent 可识别）。
      </div>
      <section class="block">
        <h2>
          Agent 状态 <span class="spacer" /> <button class="bare" onClick={refresh}>↻</button>
        </h2>
        <table>
          <thead>
            <tr>
              <th>启用</th>
              <th>模型</th>
              <th>clientId</th>
              <th>巡检周期</th>
              <th>KB 沉淀</th>
              <th>自动写 KB</th>
              <th>运行中</th>
              <th>历史轮数</th>
              <th>baseURL</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>{status.enabled ? "是" : "否"}</td>
              <td class="mono">{status.model}</td>
              <td class="mono">{status.clientId}</td>
              <td class="mono">{status.intervalMs ? Math.round(status.intervalMs / 60000) + " min" : "仅手动"}</td>
              <td class="mono">{status.kbId || "-"}</td>
              <td>{status.autoWriteKb ? "是" : "否"}</td>
              <td class="mono">{status.running ? "运行中" : "空闲"}</td>
              <td class="mono">{formatNumber(status.runCount)}</td>
              <td class="mono dim" style="font-size:var(--fs-xs)">{status.baseUrl}</td>
            </tr>
          </tbody>
        </table>
        <div style="margin-top:var(--s3)">
          <button disabled={!!status.running || firing} onClick={doRun}>
            {status.running ? "运行中…（LLM 一轮 10-20 秒）" : firing ? "触发中…" : "立即跑一轮"}
          </button>
        </div>
      </section>
      {/* A3（审查修复）：Agent 自身指标——后端 /agent/metrics 已建、面板此前无入口 */}
      <section class="block">
        <h2>巡检指标 <span class="spacer" /> <button class="bare" onClick={refresh}>↻</button></h2>
        {metrics === null ? (
          <div class="skel" style="height:90px" />
        ) : (
          <table>
            <tbody>
              <tr>
                <td class="dim">运行总轮数</td><td class="mono">{formatNumber(metrics.runs?.total)}</td>
                <td class="dim">失败</td><td class="mono">{formatNumber(metrics.runs?.failures)}</td>
                <td class="dim">成功率</td><td class="mono">{metrics.runs?.successRate ?? 0}%</td>
              </tr>
              <tr>
                <td class="dim">延迟 p50</td><td class="mono">{metrics.latencyMs?.p50 ?? 0}ms</td>
                <td class="dim">p95</td><td class="mono">{metrics.latencyMs?.p95 ?? 0}ms</td>
                <td class="dim">token 合计</td><td class="mono">{formatNumber(metrics.tokens?.total)}</td>
              </tr>
              <tr>
                <td class="dim">工具调用</td><td class="mono">{formatNumber(metrics.toolCalls)}</td>
                <td class="dim">发现项（未闭环/总）</td><td class="mono">{(metrics.findings?.open ?? 0) + "/" + (metrics.findings?.total ?? 0)}</td>
                <td class="dim">已降级</td><td class="mono">{metrics.degraded ? "是" : "否"}</td>
              </tr>
            </tbody>
          </table>
        )}
      </section>
      {/* A4（审查修复）：发现项清单 + 人在环打标——后端 /agent/findings[/{id}/mark] 已建、面板此前无入口 */}
      <section class="block">
        <h2>发现项（未闭环） <span class="spacer" /> <button class="bare" onClick={refresh}>↻</button></h2>
        {findings === null ? (
          <div class="skel" style="height:90px" />
        ) : findings.length ? (
          findings.map((f) => (
            <div class="card" style="margin-bottom:8px" key={f.id}>
              <div style="display:flex;justify-content:space-between;gap:var(--s2);flex-wrap:wrap">
                <b>
                  <span class="chip" title="严重度" style="font-size:var(--fs-2xs)">{f.severity}</span>{" "}{f.category}
                </b>
                <span class="mono dim" style="font-size:var(--fs-xs)">
                  出现 {formatNumber(f.seenCount)} 次 · 最近 {TS(f.lastSeenAt)}
                </span>
              </div>
              <div style="margin-top:4px">{f.summary}</div>
              {f.recommendation ? <div class="dim" style="font-size:var(--fs-sm);margin-top:2px">建议：{f.recommendation}</div> : null}
              <div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">
                <button class="bare" disabled={markBusy === f.id} onClick={() => markFinding(f.id, "acknowledged")}>标记已阅</button>
                <button class="bare" disabled={markBusy === f.id} onClick={() => markFinding(f.id, "resolved")}>标记已解决</button>
                <button class="bare" disabled={markBusy === f.id} onClick={() => markFinding(f.id, "ignored")}>忽略</button>
              </div>
            </div>
          ))
        ) : (
          <div class="dim">暂无未闭环发现项</div>
        )}
      </section>
      <section class="block">
        <h2>最近一轮决策</h2>
        {last === undefined ? (
          <div class="skel" style="height:110px" />
        ) : last ? (
          <RunCard r={last} kbId={status.kbId as string | undefined} />
        ) : (
          <div class="dim">尚无运行记录，点"立即跑一轮"触发</div>
        )}
      </section>
      <section class="block">
        <h2>决策历史</h2>
        {runs === null ? (
          <div class="skel" style="height:110px" />
        ) : runs.length ? (
          runs.map((r, i) => <RunCard key={i} r={r} kbId={status.kbId as string | undefined} />)
        ) : (
          <div class="dim">尚无运行记录</div>
        )}
      </section>
    </div>
  );
}
