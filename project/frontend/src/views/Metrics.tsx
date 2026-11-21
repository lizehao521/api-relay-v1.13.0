import { useEffect, useState } from "preact/hooks";
import { api } from "../api";
import type { HealthResp, MetricsResp } from "../types";
import { Tile, formatNumber, pct } from "../ui";
import { windowValue } from "../state";

const DERIVED_HINT: Record<string, string> = {
  "relay.attribution.coverage": "错误中被归因规则覆盖的比例；低于 80% 说明有失败模式没被规则覆盖（排障页看归因目录）",
  "relay.error.rate": "窗口错误率；持续 >50% 先看总览横幅点名的主因，再到对应页处理",
  "relay.overhead.ratio": "治理层（预检+归因）耗时占总耗时比；<0.1% 为健康——治理层不该成为瓶颈",
};

export function Metrics() {
  const [data, setData] = useState<null | { d: MetricsResp; hx: HealthResp | null }>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [q, setQ] = useState("");

  useEffect(() => {
    let alive = true;
    (async () => {
      setErr(null);
      try {
        const [d, hx] = await Promise.all([
          api<MetricsResp>("metrics?window=" + windowValue.value),
          api<HealthResp>("health").catch(() => null),
        ]);
        if (alive) setData({ d, hx });
      } catch (e: any) {
        if (alive) setErr(e && e.message ? e.message : String(e));
      }
    })();
    return () => { alive = false; };
  }, [tick]);

  if (err) {
    return <section class="block"><h2>指标</h2><div class="note bad">加载失败：{err}——稍后点右上角 ↻ 重试</div></section>;
  }
  if (!data) {
    return (
      <div>
        <div class="grid cards">{[0, 1, 2, 3, 4].map((i) => <div class="card" key={i}><div class="k">&nbsp;</div><div class="skel" style="height:28px" /></div>)}</div>
        <section class="block"><h2>计数器</h2><div class="skel" style="height:180px" /></section>
      </div>
    );
  }

  const { d, hx } = data;
  const inflight = (hx && hx.server && Number(hx.server.inflight)) || 0;
  const reqCount = (hx && hx.server && Number(hx.server.requestCount)) || 0;
  const aaFails = (hx && hx.adminAuth && Number(hx.adminAuth.total)) || 0;
  const hp = (hx && hx.providers) || {};
  const hpTotal = Number(hp.total) || 0, hpDis = Number(hp.disabled) || 0, hpBrk = Number(hp.breakerOpen) || 0;

  const cs = Object.entries(d.counters || {}).sort((a, b) => b[1] - a[1]);
  const ss = Object.entries(d.summaries || {});
  const der = Object.entries(d.derived || {});
  const cls = Object.entries(d.classCounters || {});

  const upS = Number(d.uptimeS) || 0;
  const upTxt = upS >= 3600
    ? Math.floor(upS / 3600) + " 小时 " + Math.floor((upS % 3600) / 60) + " 分"
    : upS >= 60 ? Math.floor(upS / 60) + " 分 " + (upS % 60) + " 秒" : upS + " 秒";

  const st2 = d.store || {};
  const stOk = st2.ok !== false;
  const stDeg = Number(st2.degradedEvents) || 0;
  const stPend = Number(st2.pendingWrites) || 0;
  const stFlush = st2.lastFlushAt ? new Date(st2.lastFlushAt).toLocaleString("zh-CN", { hour12: false }) : "—";

  const lq = q.trim().toLowerCase();
  const csShown = cs.filter(([k]) => k.toLowerCase().includes(lq));
  const overhead = d.derived?.["relay.overhead.ratio"];
  const preflightDegraded = d.classCounters?.["relay.preflight.degraded"];
  const zeroToken = d.zeroTokenCount;

  return (
    <div>
      <div class="note">
        <b>这一页是"原始读数"，不是业务结论。</b>总览回答"业务上怎么样"，这里回答"这个数为什么是这个值"。
        命名对齐 OpenTelemetry GenAI 语义约定（<span class="mono">gen_ai.client.*</span>），<span class="mono">relay.*</span> 是本网关的本地扩展。
      </div>

      <section class="block">
        <h2>降损层自证指标 <span class="spacer" /><span class="muted-xs" style="text-transform:none">治理层不该成为瓶颈，也不该静默失效</span></h2>
        <div class="grid cards">
          <Tile k="治理层开销占比"
            v={<span class={overhead != null && overhead < 0.001 ? "ok" : "warn"}>{overhead != null ? (overhead * 100).toFixed(4) + "%" : "-"}</span>}
            sub="预检+归因耗时 / 总耗时" />
          <Tile k="错误率" v={pct(d.derived?.["relay.error.rate"])} />
          <Tile k="归因覆盖" v={pct(d.derived?.["relay.attribution.coverage"])} sub="错误中带回归因的比例" />
          <Tile k="预检降级放行"
            v={<span class={preflightDegraded ? "warn" : "ok"}>{formatNumber(preflightDegraded)}</span>}
            sub="fail-open 次数，应恒为 0" />
          <Tile k="成功但零 token"
            v={<span class={zeroToken ? "err" : "ok"}>{formatNumber(zeroToken)}</span>}
            sub="静默少记的体温计，应恒为 0；>0 去「排障 → 事件日志」看 meter.zero_token" />
        </div>
      </section>

      <div class="grid two" style="margin-top:var(--s4)">
        <div>
          <div class="note" style="margin-bottom:10px">网关进程已运行 <b>{upTxt}</b> · 累计请求 <b>{formatNumber(reqCount)}</b> · 在途请求 <b>{formatNumber(inflight)}</b> · 上游 <b>{formatNumber(hpTotal)}</b> 个（停用 {formatNumber(hpDis)} / 熔断 {formatNumber(hpBrk)}） · 令牌失败 <span class={aaFails > 0 ? "err" : "ok"}>{formatNumber(aaFails)}</span>——本页计数器都是这个进程启动以来的累计值；刚重启过的话数字偏小是正常的。在途持续偏高=上游响应慢或卡住（比错误率更早的信号）；上游停用/熔断数&gt;0 时去「上游」页看是哪个。令牌失败&gt;0=有人在试管理令牌（本进程累计，重启清零）——持续增长要查来源 IP 并考虑改令牌。</div>
          <div class="note" style="margin-bottom:10px">存储 <b>{st2.driver || "未知"}</b> · 状态 <span class={stOk ? "ok" : "err"}>{stOk ? "正常" : "异常"}</span> · 待写 <span class={stPend > 100 ? "warn" : ""}>{formatNumber(stPend)}</span> · fail-open <span class={stDeg > 0 ? "err" : "ok"}>{formatNumber(stDeg)} 次</span> · 最后刷盘 {stFlush}——待写堆积=落库排队，fail-open&gt;0=存储层曾异常降级（A3 铁律证据，同预检降级放行一个性质）。</div>
        </div>

        <section class="block"><h2>计数器（进程累计，重启清零）<span class="spacer" /><span class="muted-xs" style="text-transform:none">不受上方窗口选择影响</span></h2>
          <input placeholder="🔍 过滤计数器名（如 precheck）" style="width:100%;margin-bottom:8px"
            value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
          <table>
            <thead><tr><th>counter</th><th style="text-align:right">值</th></tr></thead>
            <tbody>
              {csShown.length ? csShown.map(([k, v]) => (
                <tr key={k}><td class="mono">relay.{k}</td><td class="mono" style="text-align:right">{formatNumber(v)}</td></tr>
              )) : <tr><td colspan={2} class="dim">没有匹配的计数器</td></tr>}
            </tbody>
          </table>
          <h2 style="margin-top:var(--s4)">分类计数</h2>
          <table>
            <thead><tr><th>指标</th><th style="text-align:right">值</th></tr></thead>
            <tbody>
              {cls.map(([k, v]) => (
                <tr key={k}><td class="mono">{k}</td><td class="mono" style="text-align:right">{formatNumber(v)}</td></tr>
              ))}
            </tbody>
          </table>
        </section>

        <section class="block"><h2>分布（n / avg / min / max）</h2>
          <table>
            <thead><tr><th>指标</th><th>n</th><th>avg</th><th>min</th><th>max</th></tr></thead>
            <tbody>
              {ss.map(([k, v]) => (
                <tr key={k}>
                  <td class="mono">{k}</td>
                  <td class="mono">{formatNumber(v.count)}</td>
                  <td class="mono">{v.avg < 10 ? v.avg.toFixed(2) : formatNumber(v.avg, 1)}</td>
                  <td class="mono">{formatNumber(v.min, 1)}</td>
                  <td class="mono">{formatNumber(v.max, 1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h2 style="margin-top:var(--s4)">派生比率</h2>
          <table>
            <thead><tr><th>口径</th><th class="num">值</th><th>它决定什么</th></tr></thead>
            <tbody>
              {der.map(([k, v]) => (
                <tr key={k}>
                  <td class="mono">{k}</td>
                  <td class="mono" style="text-align:right">
                    {String(k).includes("ratio") || String(k).includes("rate") || String(k).includes("coverage") ? pct(v) : formatNumber(v, 4)}
                  </td>
                  <td class="dim">{DERIVED_HINT[k] || ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div class="muted-xs stack-sm">{d.nameNote || ""}</div>
        </section>
      </div>
    </div>
  );
}
