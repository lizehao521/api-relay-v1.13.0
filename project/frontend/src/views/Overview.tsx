import { useEffect, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { api } from "../api";
import type {
  AgentState, KbState, OverviewResp, SeriesResp, Summary, KeySlim,
} from "../types";
import {
  Chip, Empty, HBar, Tile, copyText, cny, dayTime, formatNumber, keyState, ms,
  pct, rateTone, shortLabel, toast, TS,
} from "../ui";
import { windowValue, bucketValue, versionValue, refreshIntervalValue } from "../state";
import { classifyUiError, isRetriable } from "../ui-error";

/* ---------------- statusBanner：一眼看懂现在到底能不能用 ---------------- */

/* 全站唯一失败归因人话词表（设计方案 §6：错误文案不许另造同义词，总览横幅/账本/排障速查共用） */
export const REASON_HINT: Record<string, string> = {
  client_aborted: "客户端中断——客户端侧超时/断流，不是上游故障；优先排查客户端超时与网络（账本里看它断在哪一步）",
  upstream_unavailable: "上游不可用——连接失败或 5xx；看上游页的健康与熔断状态",
  rate_limited: "上游限流——配额/RPM 打满；稍等或降权（可自动重试恢复）",
  quota_exhausted: "上游配额耗尽——去厂商控制台充值，充完清熔断",
  auth_invalid: "上游鉴权失败——密钥无效/过期；去厂商控制台换 key（网关侧改没用）",
  model_not_found: "模型不存在——客户端请求了未声明的模型；配 fallback 或引导客户端（总览页按模型表有「未声明」标记）",
  upstream_timeout: "上游超时——可自动重试；持续超时看上游页的 ewma 延迟",
  network_error: "网络错误——网关到上游的网络问题；看上游页连续失败计数",
  invalid_request: "请求非法——客户端参数错误；引导客户端修请求",
  relay_internal_error: "网关内部错误——看排障页事件日志",
  permission_denied: "上游鉴权通过但无权限——key 没有该模型的访问权；去厂商控制台开权限或换 key",
  model_overloaded: "上游模型过载——厂商容量不足；稍等或切同族备用模型（可自动重试恢复）",
  context_length_exceeded: "上下文超长——请求 token 超过模型上限；引导客户端截断历史或换长上下文模型",
  content_filtered: "内容被过滤——上游安全策略拦截；引导客户端调整 prompt 内容",
  tool_call_invalid: "工具调用非法——客户端 tool/function 定义或参数不合上游 schema；引导客户端修工具定义",
  stream_interrupted: "流式中断——SSE 连接中途断流；看账本断在哪一步，客户端侧重试或切非流式",
  unknown: "未归因失败——失败原因未能自动分类；看排障页事件日志与该条的原始 detail",
};

function Line(props: { kind: string; title: string; body: ComponentChildren; act?: ComponentChildren }) {
  return (
    <div class={"note " + props.kind} style="border-left-width:4px">
      <div style="font-size:var(--fs-base);font-weight:700;color:var(--fg);margin-bottom:3px">{props.title}</div>
      <div>{props.body}</div>
      {props.act ? <div style="margin-top:7px">{props.act}</div> : null}
    </div>
  );
}

function statusBanner(ov: OverviewResp, s: Summary) {
  const provs = ov.providers || [];
  const enabled = provs.filter((p) => !p.disabled);
  const errs = s.overall.errors;
  const reasons = s.byFailureReason || [];
  const authFail = reasons.find((r) => r.reason === "auth_invalid");
  const quotaFail = reasons.find((r) => r.reason === "quota_exhausted");
  const jump = (hash: string, label: string) => <a href={hash}>{label}</a>;

  if (provs.length === 0) {
    return (
      <Line kind="bad" title="⚠ 还没有配置上游"
        body="网关起来了，但没有任何上游可以转发。所有请求都会返回 503。"
        act={<>跑 <span class="mono">node dist/cli.js starter --vendor &lt;厂商&gt;</span> 生成配置，再重启。</>} />
    );
  }
  if (enabled.length === 0) {
    return (
      <Line kind="bad" title={"⚠ 所有上游都被摘除了"}
        body={"当前 " + provs.length + " 个上游全部处于摘除/禁用状态，请求无处可去。"}
        act={<>到{jump("#ch", "「上游」页")}把需要的上游「恢复启用」。</>} />
    );
  }
  if (authFail && authFail.count > 0 && authFail.count >= errs * 0.5) {
    return (
      <Line kind="bad" title="⚠ 上游拒绝了你配置的密钥"
        body={<>
          最近 {authFail.count} 次失败是 <b>上游鉴权失败</b>（密钥无效 / 过期 / 未开通权限），不是请求本身的问题。<br />
          从网关这边改是没用的——要去厂商控制台检查这个 key。
        </>}
        act={<>到{jump("#ledger", "「请求账本」")}点开任意一条失败，能看到上游返回的原始错误文案；{jump("#diag/cheat-reason", "看归因速查（这错误是什么意思）")}。</>} />
    );
  }
  if (quotaFail && quotaFail.count > 0 && quotaFail.count >= errs * 0.5) {
    return (
      <Line kind="bad" title="⚠ 上游账户余额/额度不足"
        body={<>
          最近 {quotaFail.count} 次失败是 <b>上游配额耗尽</b>。请求本身没问题，是账户没钱了。
        </>}
        act={<>去厂商控制台充值；充完到{jump("#ch", "「上游」页")}点一次「清熔断」即可恢复；{jump("#diag/cheat-reason", "看归因速查（这错误是什么意思）")}。</>} />
    );
  }
  const clientAuth = s.clientAuthFailures;
  if (clientAuth && clientAuth.count > 0 && clientAuth.count >= errs * 0.5) {
    return (
      <Line kind="bad" title={"⚠ 客户端提交的 key 不对（" + formatNumber(clientAuth.count) + " 次 401）"}
        body={<>
          网关拒绝了 <b>{formatNumber(clientAuth.count)}</b> 次请求：客户端提交的 key 不是本网关当前签发的（换过 key 后旧的作废了、或拿错了 key）。
          <br />这不是上游故障，网关本身是好的。到{jump("#users", "「客户 Key」页")}粘贴你手上的 key 做自检，或对照已签发 key 的指纹。
        </>} />
    );
  }
  const hotProvs = (s.byProvider || []).filter((p) => (p.requests || 0) >= 10 && (p.errorRate || 0) >= 0.4);
  if (hotProvs.length) {
    return (
      <Line kind="warn" title={"⚠ 上游错误率突告（窗口内）"}
        body={<>窗口内错误率 ≥40% 的上游：{hotProvs.map((p) => <span key={p.key}><b>{p.key}</b> {pct(p.errorRate)}（{p.requests} 次） </span>)}
          <br />先分清是配额限流（等一会 / 降权）还是真故障（摘除换线）——账本里点开失败条看归因。</>} />
    );
  }
  return null;
}

/* ---------------- 值班摘要（对齐旧版 buildShiftBrief 九行结构） ---------------- */

function buildShiftBrief(
  ov: OverviewResp, s: Summary, agentState: AgentState | null, bUp: boolean, kbCount: number, keys: KeySlim[] | null,
): string {
  const NL = String.fromCharCode(10);
  const hm = (ts: number) =>
    new Date(ts).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  const L: string[] = [];
  const ver = versionValue.value;
  L.push("【api-relay 值班摘要】" + hm(Date.now()) + " · 窗口 " + (ov.windowLabel || "-") + (ver ? " · v" + ver : ""));
  const o = s.overall;
  L.push("一、总体：请求 " + formatNumber(o.requests) + "，失败 " + formatNumber(o.errors) + "（" + pct(o.errorRate) + "），token " +
    formatNumber(o.totalTokens) + "，成本 ¥" + Number(o.costCny || 0).toFixed(4) + "，p95 " + ms(o.p95Ms));
  const provs = (s.byProvider || []).map((r) =>
    r.key + " " + pct(r.errorRate || 0) + "（" + r.requests + " 次）" + ((r.requests || 0) >= 10 && (r.errorRate || 0) >= 0.4 ? " ⚠" : ""));
  L.push("二、上游：" + (provs.length ? provs.join("｜") : "窗口内无请求"));
  const mods = (s.byModel || []).slice(0, 5).map((m) => m.key + "×" + m.requests + (m.errors ? "（错" + m.errors + "）" : ""));
  L.push("三、模型：" + (mods.length ? mods.join("｜") + ((s.byModel || []).length > 5 ? "｜等 " + (s.byModel || []).length + " 个" : "") : "窗口内无请求"));
  const reasons = (s.byFailureReason || []).slice(0, 4).map((r) => r.reason + " " + r.count);
  L.push("四、失败主因：" + (reasons.length ? reasons.join("｜") : "无失败"));
  const hot = (s.byProvider || []).filter((r) => (r.requests || 0) >= 10 && (r.errorRate || 0) >= 0.4);
  const openBrk = (ov.providers || []).filter((p) => p.breakerOpen);
  const warns: string[] = [];
  if (hot.length) warns.push(hot.map((r) => r.key + " 窗口错误率 " + pct(r.errorRate)).join("、") + "——先分清配额限流（等一会/降权）还是真故障（摘除）");
  if (openBrk.length) warns.push("熔断中：" + openBrk.map((p) => p.id).join("、") + "——确认恢复后清熔断");
  if (!(ov.providers || []).some((p) => !p.disabled)) warns.push("全部上游被摘除——请求无处可去");
  L.push("五、需要处理：" + (warns.length ? warns.join("；") : "无（窗口内无触发横幅/ chip 的条件）"));
  const lr = s.lossReduction;
  L.push("六、降损层：归因覆盖 " + pct(lr.attributionCoverage || 0) + "｜自动恢复 " + formatNumber(lr.autoRecovered) +
    "｜预检降级 " + formatNumber(lr.precheckDegraded) + "｜重复检测 " + formatNumber(lr.duplicateRetries));
  const lastRun = ((agentState && agentState.runs) || [])[0];
  L.push("七、Agent 最新" + (lastRun
    ? "（" + hm(lastRun.startedAt) + (lastRun.trigger === "manual" ? " 手动" : "") + "）：" + String((lastRun.decision && lastRun.decision.summary) || "").slice(0, 120)
    : "：尚无运行记录"));
  const plat: string[] = [];
  plat.push("B 站（8767）" + (bUp ? "运行中" : "未运行"));
  plat.push("KB " + (kbCount == null ? "-" : kbCount + " 篇"));
  plat.push("Agent " + ((agentState && agentState.status && agentState.status.enabled)
    ? Math.round((agentState.status.intervalMs || 0) / 60000) + " 分钟巡检在网" : "未启用"));
  L.push("八、平台状态：" + plat.join("｜"));
  if (keys) {
    const risky = keys.filter((k) => keyState(k).attention);
    const desc = risky.map((k) => {
      const st = keyState(k);
      const why = st.usedUp ? "额度/预算耗尽" : st.expired ? "已过期" : st.expiringSoon ? st.expDays + " 天后过期" : "将耗尽(≥85%)";
      return k.id + "(" + shortLabel(k.label, 30) + "·" + why + ")";
    });
    L.push("九、Key 预警：" + (risky.length ? risky.length + " 个需关注——" + desc.join("；") : "无（无临期/将耗尽/已过期/已用完的启用 key）"));
  } else {
    L.push("九、Key 预警：（key 列表取数失败，本行省略——请到面板确认，勿据此判断无风险 key）");
  }
  return L.join(NL);
}

/* ---------------- 8767 存活探测（no-cors + 3s 超时） ---------------- */

async function probeHermes(): Promise<boolean> {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 3000);
    try {
      await fetch("http://127.0.0.1:8767/healthz", { mode: "no-cors", signal: c.signal });
      return true;
    } finally {
      clearTimeout(t);
    }
  } catch {
    return false;
  }
}

/* ---------------- 主视图 ---------------- */

export function Overview() {
  const [data, setData] = useState<null | {
    ov: OverviewResp; ser: SeriesResp; kb: KbState | null; agent: AgentState | null; prov: any; bUp: boolean;
    eb: any | null; keys: KeySlim[] | null;
  }>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  /** 首次加载中：骨架只显示一次，刷新时保留旧数据避免闪屏 */
  const [loadingInitial, setLoadingInitial] = useState(true);
  /** 内容渐显：新数据到达时给一个 180ms 的 opacity 过渡，避免整块 swap 的视觉跳变 */
  const [fadeKey, setFadeKey] = useState(0);

  useEffect(() => {
    let alive = true;
    (async () => {
      setErr(null);
      const capSafe = (p: string) =>
        api(p).catch((e: any) => (e && (e.status === 404 || e.status === 503) ? { enabled: false } : Promise.reject(e)));
      try {
        // 错题本搜索（eb）依赖 kb 的启用状态，但**不能**在 Promise.all 的参数数组里读 kb：
        // 数组求值发生在 `const [.., kb, ..] = ...` 解构初始化之前，读它就是 TDZ
        // （ReferenceError: Cannot access 'kb' before initialization — 线上表现为
        //  "数据加载失败：Cannot access 'ge' before initialization"）。
        // 正确做法：把 kb→eb 的依赖装进一条独立 promise 链，仍与主数据并行。
        const kbP = capSafe("kb");
        const ebP = kbP.then((kbState: any) =>
          kbState && kbState.enabled
            ? api<any>("kb/kb-demo/search", { method: "POST", body: JSON.stringify({ query: "迭代 优化 运维", topK: 1 }) })
                .then((r) => (r.results || [])[0] || null)
                .catch(() => null)
            : null,
        );
        const [ov, ser, kb, agent, prov, eb, bUp, keys] = await Promise.all([
          api<OverviewResp>("overview?window=" + windowValue.value + "&slim=1"),
          api<SeriesResp>("series?window=" + windowValue.value + "&bucketMs=" + bucketValue.value),
          kbP,
          capSafe("agent"),
          api<any>("providers?slim=1").catch(() => ({ reachability: [] })),
          ebP,
          probeHermes(),
          (async () => { try { return (await api<any>("keys?slim=1")).keys || []; } catch { return null; } })(),
        ]);
        if (alive) {
          setData({ ov, ser, kb, agent, prov, bUp, eb, keys });
          setLoadingInitial(false);
          setFadeKey((k) => k + 1);
        }
      } catch (e: any) {
        if (alive) {
          setErr(e && e.message ? e.message : String(e));
          setLoadingInitial(false);
        }
      }
    })();
    return () => { alive = false; };
  }, [tick]);

  // 自动刷新策略（P1-1 + P3-1）：
  //   · 面板脚本错误（TDZ / 类型错误等）重试不会自愈 → **不自动重试**
  //   · 可恢复失败（网络 / 网关 5xx / 登录失效）→ **降频到 ≥60s**，减少无效请求与噪声
  const retriable = !err || isRetriable(err);
  useEffect(() => {
    if (!retriable) return;
    const base = refreshIntervalValue.value * 1000;
    const ivMs = err ? Math.max(60_000, base) : base;
    const iv = setInterval(() => setTick((t) => t + 1), ivMs);
    return () => clearInterval(iv);
  }, [retriable, err]);

  const refreshTick = () => setTick((t) => t + 1);

  if (err) {
    // 统一错误分类（P1-1 的消费点）：网络类失败 / 登录失效 / 网关 5xx / 面板脚本错误
    // 各自给不同图标、文案与重试策略——避免把编程错误继续伪装成"网络不可达"。
    const info = classifyUiError(err);
    return (
      <section class="block">
        <h2>总览</h2>
        <Empty icon={info.icon} msg={info.title} hint={info.hint} />
        <div class="row" style="justify-content:center;margin-top:var(--s3)">
          <button class="pri" onClick={refreshTick}>↻ 立即重试</button>
        </div>
      </section>
    );
  }

  // 骨架只在首次加载时显示；15s 自动刷新期间保留旧数据，避免闪屏
  if (loadingInitial && !data) {
    return (
      <div>
        <div class="grid cards">{[0, 1, 2, 3, 4, 5, 6, 7].map((i) => <div class="card" key={i}><div class="k">&nbsp;</div><div class="skel" style="height:28px" /></div>)}</div>
        <section class="block"><h2>请求 / 错误 时间序列</h2><div class="skel" style="height:96px" /></section>
      </div>
    );
  }

  if (!data) {
    return null;
  }

  const { ov, ser, kb, agent, prov, bUp, eb, keys } = data;
  const s = ov.summary;
  const lr = s.lossReduction;
  const open = ov.providers.filter((p) => p.breakerOpen).length;
  void open;

  const points = ser.points || [];
  const maxReq = points.length ? Math.max.apply(null, points.map((p) => p.requests)) || 1 : 1;
  const bucket = bucketValue.value;
  const axisLabel = (ts: number) =>
    bucket >= 86400000
      ? new Date(ts).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" })
      : new Date(ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  const step = Math.max(1, Math.ceil(points.length / 5));

  const kbs = (kb && kb.kbs) || [];
  const kbDocs = kbs.reduce((a: number, k: any) => a + ((k.stats && k.stats.docs) || 0), 0);
  const kbChunks = kbs.reduce((a: number, k: any) => a + ((k.stats && k.stats.chunks) || 0), 0);
  const agSt = (agent && agent.status) || {};
  const agLast = agSt.lastRun || null;
  const agLastTxt = agLast
    ? TS(agLast.startedAt) + " · " + ((agLast.decision && agLast.decision.kind) || "-") + (agLast.fromEvent ? "（重启前·事件重建）" : "")
    : "尚无运行记录";

  const riskyKeys = (keys || []).filter((k) => keyState(k).attention);
  const banner = statusBanner(ov, s);

  const onBrief = async () => {
    try {
      let allKeys: KeySlim[] | null = null;
      try { allKeys = (await api<any>("keys")).keys; } catch { allKeys = null; }
      const txt = buildShiftBrief(ov, s, agent, bUp, kbDocs, allKeys);
      await copyText(txt, "值班摘要已复制到剪贴板（可直接粘贴到 IM/邮件）");
    } catch (e: any) {
      toast("生成摘要失败：" + (e && e.message ? e.message : e), "r");
    }
  };

  return (
    <div key={fadeKey} style="animation: fadeIn 0.18s ease-out">
      {banner}
      <div class="note">
        <button class="bare" style="float:right;margin-left:10px" title="把本页关键读数聚成一段纯文本复制走——交接班/群里通报用" onClick={onBrief}>📋 一键值班摘要</button>
        {riskyKeys.length ? (
          <button class="bare" style="float:right;margin-left:10px;color:var(--warn)"
            title={riskyKeys.map((k) => k.id + "（" + shortLabel(k.label, 30) + "）").join("&#10;")}
            onClick={() => { location.hash = "users"; }}>⚠ {riskyKeys.length} 个 key 需关注 →</button>
        ) : null}
        <b>这张表回答三个问题：</b>现在健康吗？降损层在起作用吗？下一步该优化什么？
        「归因投递率」= 错误被翻译成可执行下一步的比例；「降损层开销」= 预检+归因耗时占总耗时比例（治理层不该超过千分之一）。
      </div>

      <div class="grid cards">
        <Tile k="请求数" v={formatNumber(s.overall.requests)} sub={<>错误 {formatNumber(s.overall.errors)}（<span class={rateTone(s.overall.errorRate)}>{pct(s.overall.errorRate)}</span>）</>} />
        <Tile k="Token 用量" v={formatNumber(s.overall.totalTokens)} sub={<>上游成本 <b>{cny(s.overall.costCny)}</b>（实付）· 牌面价 {cny(s.overall.listCostCny ?? 0)}</>} />
        <Tile k="p95 延迟" v={ms(s.overall.p95Ms)} sub={<>平均 {ms(s.overall.avgTtfbMs)}</>} />
        <Tile k="归因投递率" v={<span class={lr.attributionCoverage >= 0.8 ? "ok" : "warn"}>{pct(lr.attributionCoverage)}</span>} sub={<>错误被翻译成可执行下一步的比例</>} />
        <Tile k="自动恢复" v={<span class="ok">{formatNumber(lr.autoRecovered)}</span>} sub={<>重试后成功，用户少一次人工介入</>} />
        <Tile k="无效重试" v={formatNumber(lr.duplicateRetries)} sub={<>同 key 60s 内重复发送相同请求</>} />
        <Tile k="预检拦截" v={formatNumber(lr.precheckBlocked)} sub={<>畸形调用在上游之前被拦下</>} />
        <Tile k="降损层开销" v={<span class={lr.overheadRatio < 0.001 ? "ok" : "warn"}>{(lr.overheadRatio * 100).toFixed(4)}%</span>} sub={<>预检 {formatNumber(ov.overheadUs.precheck)}µs + 归因 {formatNumber(ov.overheadUs.classify)}µs</>} />
      </div>

      <section class="block" style="margin-top:var(--s4)">
        <h2>平台能力 <span class="spacer" /><span class="muted-xs" style="text-transform:none">知识库与内部 Agent 的实时状态</span></h2>
        <table>
          <thead><tr><th>能力</th><th>状态</th><th>关键读数</th><th>入口</th></tr></thead>
          <tbody>
            <tr>
              <td>知识库（KB）</td>
              <td>{kb && kb.enabled ? <span class="ok">启用</span> : <span class="warn">未启用</span>}</td>
              <td class="mono" title={kb && kb.enabled && kb.config ? kb.config.path + " · 分块 " + kb.config.chunkSize + " 字 / 重叠 " + kb.config.chunkOverlap + " 字" : undefined}>
                {kb && kb.enabled
                  ? formatNumber(kbs.length) + " 个库 · " + formatNumber(kbDocs) + " 文档 · " + formatNumber(kbChunks) + " 分块" + (kb.config ? " · " + kb.config.path : "")
                  : "配置 kb.path 后重启生效"}
              </td>
              <td><a href="#kb">知识库页签</a></td>
            </tr>
            <tr>
              <td>内部 Agent</td>
              <td>{agent && agent.enabled ? (agSt.running ? <span class="ok">运行中</span> : <span class="ok">启用 · 空闲</span>) : <span class="warn">未启用</span>}</td>
              <td class="mono">{agent && agent.enabled ? "模型 " + (agSt.model || "-") + " · " + formatNumber(agSt.runCount) + " 轮 · 最近 " + agLastTxt : "配置 agent.enabled 后重启生效"}</td>
              <td><a href="#agent">Agent 页签</a></td>
            </tr>
            <tr>
              <td>错题本（运维基线）</td>
              <td>{eb ? <span class="ok">在维护</span> : <span class="warn">不可用</span>}</td>
              <td class="mono">{eb ? (eb.docTitle || "-") + " · 检索分 " + eb.score + "（Agent 每轮必读）" : (kb && kb.enabled ? "校准文档未命中 top1——错题本可能失位，需校准" : "配置 kb.path 后重启生效")}</td>
              <td><a href="#kb">知识库页签</a></td>
            </tr>
            <tr>
              <td>聚合站（8767 · B）</td>
              <td>{bUp ? <span class="ok">运行中</span> : <span class="warn">未运行</span>}</td>
              <td class="mono">{bUp ? "hermes 面板可嵌入，渠道/用户/账本在运维页操作" : "停机中——重启前需验证 tokenrhythm key 与余额（门控，见错题本）"}</td>
              <td><a href="#ops">运维页嵌入</a></td>
            </tr>
          </tbody>
        </table>
      </section>

      <div class="grid two" style="margin-top:var(--s4)">
        <section class="block">
          <h2>请求 / 错误 时间序列 <span class="spacer" /><span class="muted-xs" style="text-transform:none">蓝=成功为主，红=该桶有错误</span></h2>
          {points.length ? (
            <div class="bars">
              {points.map((p, i) => (
                <div class="b" key={i} title={TS(p.ts) + " · 请求 " + p.requests + " · 错误 " + p.errors + " · token " + p.tokens + " · 成本 " + cny(p.costCny) + " · 均耗时 " + ms(p.avgDurationMs)}>
                  <div class={"fill" + (p.errors > 0 ? " f" : "")} style={"height:" + Math.max(2, Math.round((p.requests / maxReq) * 84)) + "px"} />
                </div>
              ))}
            </div>
          ) : (
            <Empty icon="📊" msg="窗口内还没有请求" hint="跑一次调用就能看到数据" />
          )}
          {points.length ? (
            <div class="bars-axis">
              {points.map((p, i) => (
                <span key={i}>{i % step === 0 || i === points.length - 1 ? axisLabel(p.ts) : ""}</span>
              ))}
            </div>
          ) : null}
          <div class="dim" style="font-size:var(--fs-xs);margin-top:6px">
            每桶 {bucket >= 86400000 ? bucket / 86400000 + " 天" : bucket / 60000 + " 分钟"} · 共 {points.length} 桶（每桶精确数值 hover 柱子看）
          </div>
        </section>
        <section class="block">
          <h2>降损层收益（P2 / P3 / P8）</h2>
          <table>
            <thead><tr><th>口径</th><th>值</th><th>它决定什么</th></tr></thead>
            <tbody>
              <tr><td>归因投递率</td><td class="mono">{pct(lr.attributionCoverage)}</td><td class="dim">低于 80% 说明有失败模式没被规则覆盖</td></tr>
              <tr><td>自动恢复成功</td><td class="mono ok">{formatNumber(lr.autoRecovered)}</td><td class="dim">用户少一次人工介入</td></tr>
              <tr><td>重复请求（60s）</td><td class="mono">{formatNumber(lr.duplicateRetries)}</td><td class="dim">高 → 引导用户加同轮去重</td></tr>
              <tr><td>预检拦截</td><td class="mono">{formatNumber(lr.precheckBlocked)}</td><td class="dim">每条省一次上游往返</td></tr>
              <tr><td>预检降级放行</td><td class={"mono " + (lr.precheckDegraded ? "warn" : "ok")}>{formatNumber(lr.precheckDegraded)}</td><td class="dim">fail-open 次数，应为 0</td></tr>
            </tbody>
          </table>
        </section>
      </div>

      <div class="grid two" style="margin-top:var(--s4)">
        <section class="block">
          <h2>失败归因分布 <span class="spacer" /><span class="muted-xs" style="text-transform:none">上游错误被翻译成了什么</span></h2>
          {(s.byFailureReason || []).length
            ? (s.byFailureReason || []).map((r) => (
                <HBar key={r.reason} b={{ nm: r.reason, val: r.count, txt: formatNumber(r.count) + " · 可恢复 " + pct(r.recoverablePct) }}
                  max={Math.max.apply(null, (s.byFailureReason || []).map((x) => x.count))} tone="r" />
              ))
            : <Empty icon="✅" msg="窗口内没有失败" hint="这是好消息；有失败时这里会按原因分布" />}
          {(s.byQuickAction || []).length ? (
            <div>
              <h2 style="margin-top:var(--s4)">建议动作分布</h2>
              {(s.byQuickAction || []).map((a) => (
                <HBar key={a.action} b={{ nm: a.action, val: a.count, txt: formatNumber(a.count) }}
                  max={Math.max.apply(null, (s.byQuickAction || []).map((x) => x.count))} />
              ))}
            </div>
          ) : null}
        </section>
        <section class="block">
          <h2>分层 × 客户类型</h2>
          <table>
            <thead><tr><th>分层（档位）</th><th class="num">请求</th><th class="num">错误率</th><th class="num">Token</th><th class="num">成本</th></tr></thead>
            <tbody>
              {(s.byTier || []).map((r) => {
                const tp = (ov.tiers || {})[r.key];
                return (
                  <tr key={r.key}>
                    <td>{tp
                      ? <><b>{tp.label}</b> <span class="dim mono" style="font-size:var(--fs-xs)">{r.key}</span>
                          <div class="muted-xs">预检 {tp.precheck} · 归因 {tp.attribution} · rpm {formatNumber(tp.rpm)} · 并发 {formatNumber(tp.maxConcurrency)}</div></>
                      : r.key}</td>
                    <td class="mono num">{formatNumber(r.requests)}</td>
                    <td class={"mono num " + rateTone(r.errorRate)}>{pct(r.errorRate)}</td>
                    <td class="mono num">{formatNumber(r.totalTokens)}</td>
                    <td class="mono num">{cny(r.costCny)}</td>
                  </tr>
                );
              })}
              <tr><th>客户类型</th><th>请求</th><th>错误率</th><th colSpan={2}>p95</th></tr>
              {(s.byClientKind || []).map((r) => (
                <tr key={r.key}>
                  <td>{r.key}</td>
                  <td class="mono num">{formatNumber(r.requests)}</td>
                  <td class="mono num">{pct(r.errorRate)}</td>
                  <td class="mono num" colSpan={2}>{ms(r.p95Ms)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>

      <section class="block" style="margin-top:var(--s4)">
        <h2>按上游 / 按模型 <span class="spacer" /><span class="muted-xs" style="text-transform:none">窗口内请求量·错误率·成本</span></h2>
        <div class="grid two">
          <section class="block">
            <h2>上游</h2>
            <table>
              <thead><tr><th>上游</th><th class="num">请求</th><th class="num">错误率</th><th class="num">Token</th><th class="num">成本</th></tr></thead>
              <tbody>
                {(s.byProvider || []).map((r) => (
                  <tr key={r.key}>
                    <td class="mono">{r.key}</td>
                    <td class="mono num">{formatNumber(r.requests)}</td>
                    <td class={"mono num " + rateTone(r.errorRate)}>{pct(r.errorRate)}</td>
                    <td class="mono num">{formatNumber(r.totalTokens)}</td>
                    <td class="mono num">{cny(r.costCny)}</td>
                  </tr>
                )) || <tr><td colSpan={5} class="dim">窗口内无请求</td></tr>}
                {!(s.byProvider || []).length ? <tr><td colSpan={5} class="dim">窗口内无请求</td></tr> : null}
              </tbody>
            </table>
          </section>
          <section class="block">
            <h2>模型 <span class="spacer" /><span class="muted-xs" style="text-transform:none">「未声明」= 任何上游与别名都不可路由</span></h2>
            <table>
              <thead><tr><th>模型</th><th class="num">请求</th><th class="num">错误率</th><th class="num">Token</th><th class="num">成本</th></tr></thead>
              <tbody>
                {(s.byModel || []).map((r) => {
                  const routable = ((prov && prov.reachability) || []).some((x: any) => x.model === r.key);
                  return (
                    <tr key={r.key}>
                      <td class="mono">{r.key}{routable ? null : <Chip tone="r" title="没有任何上游声明该模型、也无别名指向它——客户端请求了本网关不存在的模型">未声明</Chip>}</td>
                      <td class="mono num">{formatNumber(r.requests)}</td>
                      <td class={"mono num " + rateTone(r.errorRate)}>{pct(r.errorRate)}</td>
                      <td class="mono num">{formatNumber(r.totalTokens)}</td>
                      <td class="mono num">{cny(r.costCny)}</td>
                    </tr>
                  );
                }) || <tr><td colSpan={5} class="dim">窗口内无请求</td></tr>}
                {!(s.byModel || []).length ? <tr><td colSpan={5} class="dim">窗口内无请求</td></tr> : null}
              </tbody>
            </table>
          </section>
        </div>
      </section>
    </div>
  );
}

/* dayTime 供后续页签（账本）复用；此处显式引用避免 tree-shake 误删导出 */
void dayTime;
