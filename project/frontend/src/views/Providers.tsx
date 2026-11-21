import { useEffect, useState } from "preact/hooks";
import { api } from "../api";
import type { ProviderFull, ProvidersResp } from "../types";
import { Chip, copyText, esc, formatNumber, ms, pct, rateTone, rowA11y, toast } from "../ui";
import { openDrawer } from "../drawer";
import { windowValue } from "../state";

/* curlFor：模型调用命令（key 占位符口径） */
function curlFor(model: string): string {
  return 'curl -s -D - -H "authorization: Bearer <你的key>" -H "content-type: application/json" '
    + '-d \'{"model":"' + model + '","messages":[{"role":"user","content":"你好"}],"max_tokens":256}\' '
    + location.origin + '/v1/chat/completions';
}

function KV(props: { k: string; v: unknown }) {
  return <><div class="k">{props.k}</div><div class="mono">{String(props.v == null ? "-" : props.v)}</div></>;
}

/* ---------------- 上游详情抽屉 ---------------- */

function ProviderDetail(props: { p: ProviderFull }) {
  const p = props.p;
  const h = p.health || {};
  const breakerOpen = (h.openUntil || 0) > Date.now();
  const cost = p.cost
    ? "输入 ¥" + p.cost.inputPerMTok + " / 输出 ¥" + p.cost.outputPerMTok + " / 缓存 ¥" + (p.cost.cachedInputPerMTok ?? p.cost.inputPerMTok) + " 每百万"
    : "未配置（smart routing 会跳过它）";
  const listCost = p.listCost
    ? "输入 ¥" + p.listCost.inputPerMTok + " / 输出 ¥" + p.listCost.outputPerMTok + " / 缓存 ¥" + (p.listCost.cachedInputPerMTok ?? p.listCost.inputPerMTok)
    : "-";
  return (
    <>
      <div class="kv">
        <KV k="标识" v={p.id} /><KV k="名称" v={p.label} /><KV k="协议" v={p.protocol} /><KV k="baseUrl" v={p.baseUrl} />
        <KV k="模型数" v={(p.models || []).length} /><KV k="标签" v={(p.tags || []).join(", ") || "-"} />
        <KV k="优先级 / 权重" v={p.priority + " / " + p.weight} />
        <KV k="实付成本" v={cost} />
        <KV k="刊例价" v={listCost} />
        {p.modelCosts ? <KV k="按型号实付" v={Object.entries(p.modelCosts).map(([m, c]) => m + " → ¥" + c.inputPerMTok + "/¥" + c.outputPerMTok).join("；")} /> : null}
        {p.modelListCosts ? <KV k="按型号刊例" v={Object.entries(p.modelListCosts).map(([m, c]) => m + " → ¥" + c.inputPerMTok + "/¥" + c.outputPerMTok).join("；")} /> : null}
        <KV k="HTTP/2" v={p.http2 ? "是" : "否"} />
        <KV k="健康" v={breakerOpen ? "熔断中" : h.healthy ? "正常" : "异常"} />
        <KV k="连续失败" v={h.consecutiveFailures} />
        <KV k="熔断剩余" v={h.openUntil && h.openUntil > Date.now() ? ms(h.openUntil - Date.now()) : "未熔断"} />
        <KV k="最近失败原因" v={h.lastFailureReason || "-"} />
        <KV k="ewma 延迟" v={ms(h.ewmaLatencyMs)} />
        <KV k="累计 失败/总" v={(h.totalFailures || 0) + " / " + (h.totalRequests || 0)} />
      </div>
      {p.keyPool ? (
        <>
          <h2 style="margin-top:16px">Key 池</h2>
          <table>
            <thead><tr><th>#</th><th>Key</th><th>状态</th><th>冷却</th><th>失败</th></tr></thead>
            <tbody>
              {p.keyPool.map((k) => (
                <tr key={k.index}>
                  <td class="mono">{k.index}</td>
                  <td class="mono">{k.masked}</td>
                  <td>{k.dead ? <Chip tone="r">报废</Chip> : (k.cooldownMsLeft || 0) > 0 ? <Chip tone="y">冷却</Chip> : <Chip tone="g">可用</Chip>}</td>
                  <td class="mono">{(k.cooldownMsLeft || 0) > 0 ? Math.round((k.cooldownMsLeft || 0) / 1000) + "s" : "-"}</td>
                  <td class="mono">{k.failures}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
    </>
  );
}

/* ---------------- 主视图 ---------------- */

export function Providers() {
  const [data, setData] = useState<null | { d: ProvidersResp; winRate: Record<string, any> }>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    (async () => {
      setErr(null);
      try {
        const [d, ov2] = await Promise.all([
          api<ProvidersResp>("providers"),
          api<any>("overview?window=" + windowValue.value + "&slim=1").catch(() => ({ summary: {} })),
        ]);
        const winRate: Record<string, any> = {};
        for (const bp of ((ov2.summary || {}).byProvider) || []) winRate[bp.key] = bp;
        if (alive) setData({ d, winRate });
      } catch (e: any) {
        if (alive) setErr(e && e.message ? e.message : String(e));
      }
    })();
    return () => { alive = false; };
  }, [tick]);

  if (err) {
    return <section class="block"><h2>上游渠道</h2><div class="note bad">加载失败：{err}——稍后点右上角 ↻ 重试</div></section>;
  }
  if (!data) {
    return <section class="block"><h2>上游渠道</h2><div class="skel" style="height:200px" /></section>;
  }

  const { d, winRate } = data;
  const list = d.providers || [];
  const refresh = () => setTick((t) => t + 1);

  const toggle = async (id: string, dis: boolean) => {
    try {
      if (!confirm((dis ? "摘除" : "恢复启用") + "上游 " + id + "？"
        + (dis ? "流量将立即切到其他上游；仅剩一个上游时请求会直接失败。" : "")
        + "\n\n注意：人工摘除/恢复只对当前运行生效——重启网关后恢复 relay-net.yaml 里的启用态"
        + "（熔断状态相反，会跨重启保持）。要永久下线请改配置。")) return;
      await api("providers/toggle", { method: "POST", body: JSON.stringify({ id, disabled: dis }) });
      toast("上游 <b>" + esc(id) + "</b> " + (dis ? "已摘除，流量将切到其他上游" : "已恢复启用"), dis ? "y" : "g");
      refresh();
    } catch (e: any) {
      toast("操作失败：" + esc(e.message), "r");
    }
  };

  const resetBreaker = async (id: string) => {
    try {
      await api("providers/reset", { method: "POST", body: JSON.stringify({ id }) });
      toast("已清除 <b>" + esc(id) + "</b> 的熔断计数", "g");
      refresh();
    } catch (e: any) {
      toast("操作失败：" + esc(e.message), "r");
    }
  };

  return (
    <div>
      <div class="note">上游故障时：<b>摘除</b>会立刻把流量切走（不重启）；<b>清熔断</b>只重置失败计数，不改变启用状态。
        所有操作都会记入「信任」页之外的运维事件流（配置页可见）。</div>

      <section class="block">
        <h2>上游渠道 <span class="spacer" /><button class="bare" onClick={refresh}>↻</button></h2>
        <table>
          <thead>
            <tr><th>上游</th><th>状态</th><th>模型</th><th>Key</th><th class="num">并发</th><th class="num">延迟</th><th class="num">失败/总</th><th class="num">窗口错误率</th><th class="act">操作</th></tr>
          </thead>
          <tbody>
            {list.map((p) => {
              const wr = winRate[p.id];
              const breakerOpen = ((p.health || {}).openUntil || 0) > Date.now();
              const st = p.disabled ? <Chip>已摘除</Chip>
                : breakerOpen ? <Chip tone="r">熔断中</Chip>
                : (p.health || {}).healthy ? <Chip tone="g">正常</Chip>
                : <Chip tone="y">异常</Chip>;
              const keyCell = p.keyPool
                ? <Chip tone={p.keyPool.filter((k) => !k.dead && (k.cooldownMsLeft || 0) <= 0).length ? undefined : "r"}
                    title={p.keyPool.map((k) => "#" + k.index + " " + k.masked + (k.dead ? "（报废）" : (k.cooldownMsLeft || 0) > 0 ? "（冷却 " + Math.round((k.cooldownMsLeft || 0) / 1000) + "s）" : "")).join("\n")}>
                    {p.keyPool.filter((k) => !k.dead && (k.cooldownMsLeft || 0) <= 0).length + "/" + p.keyPool.length + " 可用"}
                  </Chip>
                : <span class="mono">{p.apiKeyMasked}</span>;
              return (
                <tr key={p.id} {...rowA11y("查看上游详情")}>
                  <td class="mono fit">
                    <button class="row-act" onClick={() => openDrawer({ title: "上游详情 · " + p.id, body: <ProviderDetail p={p} /> })} aria-label="查看上游详情" />
                    {p.id}
                  </td>
                  <td>{st}</td>
                  <td class="muted-sm">{(p.models || []).join(", ").slice(0, 54)}</td>
                  <td>{keyCell}</td>
                  <td class="mono num">
                    {(p.concurrency || {}).active || 0}/{(p.concurrency || {}).limit}
                    {(p.concurrency || {}).waiting ? " +" + (p.concurrency || {}).waiting : ""}
                  </td>
                  <td class="mono num">{(p.health || {}).ewmaLatencyMs ? Math.round((p.health || {}).ewmaLatencyMs!) : "-"}ms</td>
                  <td class="mono num">{(p.health || {}).totalFailures || 0}/{(p.health || {}).totalRequests || 0}</td>
                  <td class="mono num">
                    {wr
                      ? <span class={rateTone(wr.errorRate)} title={"窗口内 " + wr.requests + " 次请求失败 " + wr.errors + " 次（与总览页按上游区块同口径）"}>
                          {pct(wr.errorRate)}（{wr.requests}）
                        </span>
                      : <span class="dim" title="窗口内无请求">-</span>}
                  </td>
                  <td class="act">
                    <button class="bare" onClick={(ev) => { ev.stopPropagation(); toggle(p.id, !p.disabled); }}>{p.disabled ? "恢复启用" : "摘除"}</button>
                    <button class="bare" onClick={(ev) => { ev.stopPropagation(); resetBreaker(p.id); }}>清熔断</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section class="block">
        <h2>模型 × 上游可达性 <span class="spacer" /><span class="muted-xs" style="text-transform:none">右侧为空的模型当前不可用；「复制命令」给可直接执行的调用</span></h2>
        <table>
          <thead><tr><th>模型（客户端可用名）</th><th>可服务上游</th><th>工具调用</th><th class="act">调用</th></tr></thead>
          <tbody>
            {(d.reachability || []).map((r) => (
              <tr key={r.model}>
                <td class="mono">{r.model}</td>
                <td>{r.providers.length
                  ? r.providers.map((x) => <Chip key={x} tone="b">{x}</Chip>)
                  : <Chip tone="r">不可达</Chip>}</td>
                <td>{r.tools
                  ? <Chip tone="g" title="该模型声明支持 tool/function calling（配置 modelCapabilities）">支持</Chip>
                  : <span class="dim" title="未声明工具能力——带 tools 的请求切过去可能失败">—</span>}</td>
                <td class="act">
                  <button class="bare" onClick={() => copyText(curlFor(r.model),
                    "命令已复制——把 <你的key> 换成「客户 Key」页签里的真实 key 即可调用")}>复制命令</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
