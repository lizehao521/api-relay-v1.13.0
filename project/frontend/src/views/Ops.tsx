import { useEffect, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import { api } from "../api";
import type { AdminEvent, AuthPolicyResp, ConfigResp, EvolutionResp, LossReductionResp } from "../types";
import { cny, copyText, esc, formatNumber, toast, writeErr } from "../ui";
import { windowValue } from "../state";

/* ---------------- 格式化（对齐旧版 dur/kb） ---------------- */

const dur = (v: unknown): string =>
  typeof v !== "number" ? String(v) : v >= 1000 ? v / 1000 + " 秒" : v + " 毫秒";
const kbFmt = (v: unknown): string =>
  typeof v !== "number" ? String(v) : (v / 1048576).toFixed(1) + " MB";

/* ---------------- 降损开关行 ---------------- */

function Sw(props: { on: boolean; set: (on: boolean) => void; label: string; why: string }) {
  return (
    <label style="display:flex;gap:10px;align-items:flex-start;padding:8px 0;border-bottom:1px solid var(--border2)">
      <input
        type="checkbox"
        checked={props.on}
        onChange={(e) => props.set((e.target as HTMLInputElement).checked)}
        style="margin-top:3px"
      />
      <span>
        <b>{props.label}</b>
        <br />
        <span class="muted-xs">{props.why}</span>
      </span>
    </label>
  );
}

/* ---------------- 主视图 ---------------- */

interface SwState {
  pc: boolean;
  at: boolean;
  atEv: boolean;
  atSib: boolean;
  mt: boolean;
  tr: boolean;
  retry: string;
}

export function Ops() {
  const [data, setData] = useState<null | {
    cfg: ConfigResp;
    lr: LossReductionResp;
    pol: AuthPolicyResp;
    evo: EvolutionResp;
    evoLog: { events: AdminEvent[] };
    fails: string[];
  }>(null);
  const [tick, setTick] = useState(0);
  const [sw, setSw] = useState<SwState | null>(null);
  const [evoSetting, setEvoSetting] = useState<EvolutionResp["setting"]>(null);
  const [evoNext, setEvoNext] = useState("");
  const [evoNote, setEvoNote] = useState("");
  const [rp, setRp] = useState("");
  const [rpLoaded, setRpLoaded] = useState(false);
  const [hx, setHx] = useState<"probing" | "up" | "down">("probing");
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    const fails: string[] = [];
    const soft = <T,>(p: string, dflt: T, label: string): Promise<T> =>
      api<T>(p).catch((e) => {
        fails.push(label + "（" + (e && e.message ? e.message : "网络错误") + "）");
        return dflt;
      });
    (async () => {
      // 按块降级（manual#191）：五块独立内容，任一失败显空值、页顶汇总，不整页白屏
      const [cfg, lr, pol, evo, evoLog] = await Promise.all([
        soft<ConfigResp>("config", {} as ConfigResp, "生效配置"),
        soft<LossReductionResp>("loss-reduction", {} as LossReductionResp, "降损开关"),
        soft<AuthPolicyResp>("auth-policy", { tiers: {} } as AuthPolicyResp, "分层策略"),
        soft<EvolutionResp>("evolution-direction", { candidates: [], setting: null } as EvolutionResp, "进化方向"),
        soft<{ events: AdminEvent[] }>("events?limit=3&kind=evolution", { events: [] }, "进化方向变更史"),
      ]);
      if (!aliveRef.current) return;
      setData({ cfg, lr, pol, evo, evoLog, fails });
      setEvoSetting(evo.setting || null);
      const at = lr.attribution || {};
      setSw({
        pc: !!(lr.precheck || {}).enabled,
        at: !!at.enabled,
        atEv: !!at.includeEvidence,
        atSib: !!at.siblingModelFallback,
        mt: !!(lr.meter || {}).enabled,
        tr: !!(lr.trace || {}).enabled,
        retry: String(at.autoRetry ?? 0),
      });
      setEvoNext(((evo.candidates || [])[0] || {}).id || "");
    })();
    return () => {
      aliveRef.current = false;
    };
  }, [tick]);

  // hermes 聚合站（8767）存活探测（manual#85）：跨域 fetch 被 CORS 挡，用 no-cors 只求可达性
  const hxProbe = async () => {
    setHx("probing");
    let up = false;
    try {
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), 3000);
      try {
        await fetch("http://127.0.0.1:8767/healthz", { mode: "no-cors", signal: c.signal });
        up = true;
      } finally {
        clearTimeout(t);
      }
    } catch {
      up = false;
    }
    if (aliveRef.current) setHx(up ? "up" : "down");
  };

  useEffect(() => {
    hxProbe();
  }, []);

  if (!data || !sw) {
    return (
      <section class="block">
        <h2>运维</h2>
        <div class="skel" style="height:220px" />
      </section>
    );
  }

  const refresh = () => setTick((t) => t + 1);
  const { cfg, lr, pol, evo, evoLog, fails } = data;
  const sv = cfg.server || {};
  const st = cfg.storage || {};
  const pc = lr.precheck || {};
  const at = lr.attribution || {};
  const mt = lr.meter || {};
  const fp = lr.fingerprint || {};

  const Row = (k: string, v: JSX.Element | string, why: JSX.Element | string) => (
    <tr key={k}>
      <td>{k}</td>
      <td class="mono">{v}</td>
      <td class="dim">{why}</td>
    </tr>
  );

  // 档位阶梯（manual#265）：ladder 是 fallback 链，渲染成 a → b → c；超长截断+title 全量
  const ladders = cfg.modelLadders || cfg.modelAliases || {};
  const ladderTxt = Object.keys(ladders)
    .map((k) => k + " → " + (Array.isArray(ladders[k]) ? (ladders[k] as string[]).join(" → ") : ladders[k]))
    .join("；");

  const lrSave = async () => {
    const body = {
      precheck: { enabled: sw.pc },
      attribution: { enabled: sw.at, includeEvidence: sw.atEv, siblingModelFallback: sw.atSib, autoRetry: Number(sw.retry) },
      meter: { enabled: sw.mt },
      trace: { enabled: sw.tr },
    };
    try {
      const r = await api<any>("loss-reduction/update", { method: "POST", body: JSON.stringify(body) });
      // 热生效性分级展示（manual#161）：meter/trace 热改静默无效，必须当场看到区别
      const parts = ["已生效：" + esc((r.changed || []).join("、"))];
      if ((r.hot || []).length)
        parts.push('<span class="ok">热生效：' + esc((r.hot || []).join("、")) + "</span>");
      if ((r.needsRestart || []).length)
        parts.push(
          '<span class="warn">需重启才生效（进程启动时捕获，热改无效）：' +
            esc((r.needsRestart || []).join("、")) +
            "——请改 relay-net.yaml 后重启</span>",
        );
      parts.push('<span class="dim">' + esc(r.note || "") + "</span>");
      toast(parts.join("<br>"));
    } catch (e: any) {
      const r = writeErr("保存降损开关", e);
      toast(r.text, r.tone);
    }
  };

  const evoSave = async () => {
    const next = evoNext.trim();
    const note = evoNote.trim();
    if (!next) {
      toast("先选一个方向（或在输入框写自由文本）", "y");
      return;
    }
    try {
      await api("evolution-direction", { method: "POST", body: JSON.stringify({ next, note }) });
      toast("已设为下一轮方向：<b>" + esc(next) + "</b>——引擎下一轮第 0 步生效", "g");
      setEvoSetting({ next, note, updatedAt: Date.now() });
    } catch (e: any) {
      const r = writeErr("设置进化方向", e);
      toast(r.text, r.tone);
    }
  };

  const evoClear = async () => {
    try {
      await api("evolution-direction", { method: "POST", body: JSON.stringify({ clear: true }) });
      toast("已恢复自动排序——引擎按候选队列（杠杆率）推进", "g");
      setEvoSetting(null);
    } catch (e: any) {
      const r = writeErr("恢复自动", e);
      toast(r.text, r.tone);
    }
  };

  const rpLoad = async () => {
    try {
      const r = await api<any>("report?window=" + windowValue.value);
      setRp(r.raw || "");
      setRpLoaded(!!r.raw);
      if (!r.raw) toast("报告为空（窗口内无请求）", "y");
    } catch (e: any) {
      toast("加载失败：" + esc(e.message), "r");
    }
  };

  // 文本报告复制（manual#90）：空报告/未加载给明确提示而非复制占位文本
  const rpCopy = () => {
    if (!rpLoaded || !rp.trim()) return toast("先点「加载」生成报告", "y");
    copyText(rp, "文本报告已复制（window=" + windowValue.value + "）");
  };

  const hist = (evoLog.events || []).slice(0, 3);
  const s = evoSetting;

  return (
    <div>
      {fails.length ? (
        <div class="note warn" style="margin-bottom:10px">
          <b>部分数据加载失败：</b>
          {fails.join("；")}——对应区块显示的是空值而非真实配置，稍后点右上角 ↻ 重试。
        </div>
      ) : null}
      <div class="note">
        <b>这一页回答"网关现在到底按什么参数在跑"。</b>
        2026-09-14 两次误杀（首字节超时 30 秒、消息条数 512）都吃过同一个亏：
        <b>生效值只能去翻配置文件才看得见</b>。
        所以下面列的是<b>进程实际加载的值</b> —— 和文件里写的不一定一样（有的走环境变量覆盖）。
      </div>

      <section class="block">
        <h2>
          生效配置 <span class="spacer" />{" "}
          <span class="muted-xs" style="text-transform:none">来源 {cfg.sourcePath || ""}</span>
        </h2>
        <table>
          <thead>
            <tr>
              <th>项</th>
              <th>生效值</th>
              <th>它决定什么</th>
            </tr>
          </thead>
          <tbody>
            {Row("监听地址", sv.host + ":" + sv.port, "绑 :: 即双栈（IPv4 + IPv6 都收）")}
            {Row("首字节超时 TTFB", dur(sv.upstreamTtfbTimeoutMs), "上游这么久没吐第一个字节就换下一阶 —— 太小会误杀\"慢但能成\"的请求")}
            {Row("整条超时", dur(sv.upstreamTimeoutMs), "单次请求的总上限")}
            {Row("停摆超时", dur(sv.upstreamStallTimeoutMs), "回了响应头却不产出数据 → 按可重试处理（20 秒实测能挡住\"假 200\"）")}
            {Row("请求体上限", kbFmt(sv.maxBodyBytes), "超过直接拒，不进上游")}
            {Row("关停宽限期", dur(sv.shutdownGraceMs), "收到停止信号后等多久让在途请求跑完再关——重启太快会在途请求被硬断")}
            {Row("消息条数上限", formatNumber(pc.maxMessages), "预检拦\"太离谱\"的请求；太小会误杀长轨迹评测")}
            {Row("工具条数上限", formatNumber(pc.maxTools), "同上")}
            {Row("预检动作", pc.onBlock || "", "reject = 拦截；其余 = 只提醒放行")}
            {Row("存储", (st.driver || "") + " · " + (st.path || ""), "度量与轨迹落这里")}
            {Row("日志级别", cfg.logLevel || "", "")}
            {Row(
              "模型别名",
              !ladderTxt ? (
                "无"
              ) : ladderTxt.length > 120 ? (
                <span title={ladderTxt}>{ladderTxt.slice(0, 117)}…</span>
              ) : (
                ladderTxt
              ),
              "请求模型名→实际模型链的映射（前者不可用自动落下一阶），排查路由错位时看这里",
            )}
            {Row("管理令牌", sv.adminTokenSet ? "已设置" : "未设置（本机直连体验模式）", "未设置时 /admin 免令牌，只应出现在本机调试")}
            {Row("指纹脱敏", fp.enabled ? "开（阈值 " + formatNumber(fp.agentThreshold, 2) + "）" : "关", "A4 红线：请求指纹用 HMAC 截断，不落正文；关了对排障影响很大，不建议")}
            {Row(
              "度量留存",
              mt.retentionDays != null ? mt.retentionDays + " 天" : "默认",
              <>
                清理范围<b>仅 meter（度量）+trace（轨迹）两表</b>——『上周的数据怎么没了』先看这里；更早的靠账本深搜兜底。每日按此天数自动清理（manual#319
                兜底：启动时+每 24h 一次，删行记 storage.prune
                审计事件；改天数热生效、下次清理生效）。<b>relay_event 运维事件表不在自动清理内</b>（manual#358
                实证：prune 只删上述两表；事件表当前 ~1276 行 ≈0.4MB、增长慢，自动清理它是签字项——异常暴涨时手动
                DELETE FROM relay_event WHERE ts &lt; 截止毫秒）
              </>,
            )}
            {Row("trustProxy", String(sv.trustProxy), "当前无任何作用（保留字段）：网关不记录客户端 IP——meter 无 IP 列、限流按 key 归属、审计读 socket.remoteAddress")}
            {Row(
              "公开只读端点",
              (sv.publicQuota ? "开" : "关") + " / 允许远程 " + (sv.publicQuotaRemote ? "开" : "关"),
              "/v1/quota 与 /v1/panel；默认只允许 127.0.0.1",
            )}
          </tbody>
        </table>
      </section>

      <section class="block">
        <h2>
          配置文件客户端 <span class="spacer" />{" "}
          <span class="muted-xs" style="text-transform:none">
            relay-net.yaml 里定义的 key——改了配置要重启才生效；面板动态创建的 key 在「客户 Key」页
          </span>
        </h2>
        <table>
          <thead>
            <tr>
              <th>id</th>
              <th>label</th>
              <th>key（脱敏）</th>
              <th>档位</th>
              <th>租户</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            {(cfg.clients || []).length ? (
              (cfg.clients || []).map((c) => (
                <tr key={c.id}>
                  <td class="mono">{c.id}</td>
                  <td>{c.label || "—"}</td>
                  <td class="mono dim">{c.key || "—"}</td>
                  <td>{c.tier || "—"}</td>
                  <td class="mono dim">{c.tenantId || "—"}</td>
                  <td>{c.enabled ? <span class="chip g">启用</span> : <span class="chip r">停用</span>}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td colspan={6} class="dim">
                  无（配置里没有 clients 段）
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <div class="note">配置来源的 key 只能停用不能彻底删除（删了重启还会回来，manual#306）——要下线请改 relay-net.yaml。</div>
      </section>

      <div class="grid two">
        <section class="block">
          <h2>
            降损层开关 <span class="spacer" />{" "}
            <span class="muted-xs" style="text-transform:none">precheck/attribution 热生效 · meter/trace 需重启</span>
          </h2>
          <div>
            <Sw on={sw.pc} set={(v) => setSw({ ...sw, pc: v })} label="P2 预检" why="畸形请求在上游之前拦下，省一次往返" />
            <Sw on={sw.at} set={(v) => setSw({ ...sw, at: v })} label="P3 归因" why="把上游错误翻译成可执行的下一步" />
            <Sw on={sw.atEv} set={(v) => setSw({ ...sw, atEv: v })} label="归因附证据" why="错误体里附原始错误片段（更透明，响应也更大）" />
            <Sw
              on={sw.atSib}
              set={(v) => setSw({ ...sw, atSib: v })}
              label="阶梯兜底"
              why="客户点名某个模型被限流时，横向换供应商耗尽后沿档位阶梯换同档模型（同厂姊妹优先），让任务跑完而不是丢 429 回去；关掉则退回单阶，429 直接回给客户端"
            />
            <Sw on={sw.mt} set={(v) => setSw({ ...sw, mt: v })} label="P8 度量" why="token / 成本 / 延迟落库 —— 关了就没有账" />
            <Sw on={sw.tr} set={(v) => setSw({ ...sw, tr: v })} label="P5 轨迹" why="每个请求的阶段时间线，排障全靠它" />
          </div>
          <div style="display:flex;gap:var(--s2);align-items:center;margin-top:var(--s3);flex-wrap:wrap">
            <span>
              可恢复错误自动重试{" "}
              <select value={sw.retry} onChange={(e) => setSw({ ...sw, retry: (e.target as HTMLSelectElement).value })}>
                {[0, 1, 2, 3, 4, 5].map((n) => (
                  <option key={n} value={n}>
                    {n} 次
                  </option>
                ))}
              </select>
            </span>
            <button onClick={lrSave}>保存</button>
            <span class="muted-xs">
              ⚠ precheck/attribution <b>热生效</b>；meter/trace 开关在进程启动时捕获，热改无效（保存时会分级提示）；所有开关重启后回到
              relay-net.yaml 的值，永久改请改配置
            </span>
          </div>
        </section>
        <section class="block">
          <h2>分层策略</h2>
          <table>
            <thead>
              <tr>
                <th>分层</th>
                <th>名字</th>
                <th>预检</th>
                <th>归因</th>
                <th>rpm</th>
                <th>并发</th>
                <th>计费</th>
                <th>周期额度</th>
                <th>周期预算(¥)</th>
                <th>路由</th>
              </tr>
            </thead>
            <tbody>
              {Object.keys(pol.tiers || {}).length ? (
                Object.keys(pol.tiers || {}).map((id) => {
                  const t = (pol.tiers || {})[id] || {};
                  return (
                    <tr key={id}>
                      <td class="mono">{id}</td>
                      <td>{t.label || ""}</td>
                      <td>{t.precheck || ""}</td>
                      <td>{t.attribution || ""}</td>
                      <td class="mono">{formatNumber(t.rpm)}</td>
                      <td class="mono">{formatNumber(t.maxConcurrency)}</td>
                      <td>{t.billing || ""}</td>
                      <td class="mono">{t.periodQuotaTokens ? formatNumber(t.periodQuotaTokens) : "不限"}</td>
                      <td class="mono">{t.periodQuotaCny != null ? cny(t.periodQuotaCny) : "不限"}</td>
                      <td>
                        {t.smartRouting ? (
                          <span class="chip g" title="按上游价格自动选最便宜可用者（P3 排序链）">
                            智能路由
                          </span>
                        ) : (
                          <span class="dim">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colspan={10} class="dim">
                    没有档位配置——检查 relay-net.yaml 的 tiers 段（没有档位所有 key 都会落默认档）
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <div class="muted-xs stack-sm">
            当前 {formatNumber(pol.activeKeys)} / {formatNumber(pol.keyCount)} 个 key 生效 · 额度周期{" "}
            {Math.round((pol.quotaPeriodMs || 0) / 86400000)} 天
            <br />
            {pol.note || ""}
          </div>
        </section>

        <section class="block">
          <h2>
            进化方向 <span class="spacer" />{" "}
            <span class="muted-xs" style="text-transform:none">manual#372 · 手动设置，引擎每轮第 0 步读取</span>
          </h2>
          <div class="note" style="margin:0 0 var(--s3)">
            网站由进化引擎逐轮推进。<b>这里可以手动指定下一轮方向</b>
            ——设了就跑你选的，清空就回到引擎的候选队列自动排序（按杠杆率）。设置即时落盘（data/evolution-direction.json），引擎下一轮第
            0 步读取并同步进长期目标。
          </div>
          <div style="margin-bottom:10px">
            {s ? (
              <>
                <b>当前手动方向：</b>
                <span class="mono">{String(s.next)}</span>
                {s.note ? <> <span class="dim">—— {String(s.note)}</span></> : null}{" "}
                <span class="muted-xs">
                  （{s.updatedAt ? new Date(s.updatedAt).toLocaleString("zh-CN") : "?"}
                  {s.updatedBy ? " · " + String(s.updatedBy) : ""} 设置）
                </span>
              </>
            ) : (
              <span class="dim">当前未手动设置——按引擎候选队列自动排序（性能优先、白名单内可落项优先）。</span>
            )}
          </div>
          <div style="display:flex;gap:var(--s2);align-items:center;flex-wrap:wrap">
            <select style="min-width:280px" value={evoNext} onChange={(e) => setEvoNext((e.target as HTMLSelectElement).value)}>
              {(evo.candidates || []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
            <input
              placeholder="备注（可选，≤200 字：为什么要这个方向/约束条件）"
              style="flex:1;min-width:220px"
              value={evoNote}
              onInput={(e) => setEvoNote((e.target as HTMLInputElement).value)}
            />
            <button onClick={evoSave}>设为下一轮方向</button>
            <button class="bare" onClick={evoClear}>
              恢复自动
            </button>
          </div>
          <div class="muted-xs stack-sm">
            下拉是引擎本轮的候选队列（驾驶舱 0.2）；也可以直接打字写自由文本。当前设置：
            <span class="mono">{s ? String(s.next) : "（自动）"}</span>
          </div>
          <div style="margin-top:var(--s3)">
            {hist.length ? (
              <>
                <div class="dim" style="font-size:var(--fs-xs);margin-bottom:4px">
                  最近变更（manual#379：设过什么、什么时候设的，不用翻事件页）
                </div>
                {hist.map((e, i) => {
                  const d: any = e.detail || {};
                  return (
                    <div key={i} style="font-size:var(--fs-xs)" class="dim">
                      {new Date(e.ts).toLocaleString("zh-CN")} ·{" "}
                      {d.next ? (
                        <>
                          <span class="mono">{String(d.next)}</span>
                          {d.note ? (
                            <>
                              {" "}
                              <span class="dim">{String(d.note)}</span>
                            </>
                          ) : null}
                        </>
                      ) : (
                        <span class="dim">恢复自动（按队列排序）</span>
                      )}
                    </div>
                  );
                })}
              </>
            ) : null}
          </div>
        </section>
      </div>

      <section class="block">
        <h2>
          文本报告 <span class="spacer" />{" "}
          <button class="bare" onClick={rpCopy}>
            复制
          </button>
          <button class="bare" onClick={rpLoad}>
            ↻ 加载
          </button>
        </h2>
        <div class="dim" style="font-size:var(--fs-xs);margin-bottom:8px">
          同一份数据在命令行也能拿：<span class="mono">node dist/cli.js report --window {windowValue.value}</span>
        </div>
        <pre>{rp || "（点右上角「加载」）"}</pre>
      </section>

      <section class="block">
        <h2>
          hermes 聚合站（8767）<span class="spacer" />{" "}
          <span style="font-size:var(--fs-xs)">
            {hx === "probing" ? "探测中…" : hx === "up" ? <span class="chip g">运行中</span> : <span class="chip r">未运行</span>}
          </span>{" "}
          <a class="bare" href="http://127.0.0.1:8767/admin" target="_blank" rel="noopener">
            ⧉ 新窗口打开
          </a>
        </h2>
        <div class="dim" style="font-size:var(--fs-xs);margin-bottom:8px">
          把 hermes 管理面板整页嵌进来（跨域 iframe · 保留它自己的登录态）。渠道 / 用户 / 账本 /
          度量都在框里操作；8767 的管理令牌在框内单独登一次（浏览器会记住）。
        </div>
        <div>
          {hx === "up" ? (
            <iframe
              src="http://127.0.0.1:8767/admin"
              style="width:100%;min-height:1050px;border:1px solid var(--border);border-radius:var(--r2);background:var(--bg)"
            />
          ) : hx === "down" ? (
            <div class="note warn">
              <b>聚合站 8767 当前未运行</b>，面板嵌入不可用（不是本页的问题）。
              <br />
              排查：<span class="mono">ss -tlnp | grep 8767</span> 看监听；RelayGate 代码在{" "}
              <span class="mono">~/文档/二转moa模型</span>；启动前需先验证 tokenrhythm key
              与余额（重启门控）。启动后点这里{" "}
              <button class="bare" onClick={hxProbe}>
                重试探测
              </button>{" "}
              即可嵌入。
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}
