import { useEffect, useState } from "preact/hooks";
import type { JSX } from "preact";
import { api } from "../api";
import type { AuthPolicyResp, KeyFull, KeysResp } from "../types";
import {
  CSV_BOM, CRLF, Chip, MiniBar, cny, csvCell, downloadText, esc, formatNumber,
  keyState, pct, shortLabel, toast, TS, writeErr, copyText,
} from "../ui";
import { closeDrawer, openDrawer } from "../drawer";
import { windowValue } from "../state";

/* ---------------- 模型名缓存（60s TTL，datalist 与 whoami 未声明标记共用） ---------------- */

let MODEL_NAMES: string[] = [];
let MODEL_NAMES_AT = 0;

function refreshModelNames(): Promise<void> {
  if (Date.now() - MODEL_NAMES_AT <= 60000) return Promise.resolve();
  MODEL_NAMES_AT = Date.now();
  return api<any>("providers?slim=1").then((d) => {
    MODEL_NAMES = (d.reachability || []).map((r: any) => r.model).filter(Boolean);
  }).catch(() => { MODEL_NAMES_AT = 0; });
}

/* ---------------- 客户接入包（创建/轮换成功后一键组装） ---------------- */

const PUBLIC_BASE = "https://api-relay.tail62168c.ts.net";
const Q = String.fromCharCode(39);
const NL = String.fromCharCode(10);

function customerPackage(secret: string, key: KeyFull | null | undefined): string {
  const base = PUBLIC_BASE + "/v1";
  const models = key && key.allowedModels && key.allowedModels.length
    ? "你这把 key 可用的模型：" + key.allowedModels.map((m) => ". " + m).join("；")
    : "全部可用模型（不带白名单）——调用 GET " + base + "/models 会返回你这把 key 能用的清单";
  const exampleModel = key && key.allowedModels && key.allowedModels.length ? key.allowedModels[0] : "mimo-v2.6-flash";
  const tier = (key && key.tier) || "standard";

  const py = [
    "from openai import OpenAI", "", "client = OpenAI(",
    '    base_url="' + base + '",', '    api_key="' + secret + '",', ")","",
    "resp = client.chat.completions.create(",
    '    model="' + exampleModel + '",',
    '    messages=[{"role": "user", "content": "你好"}],',
    "    max_tokens=512,  # 推理模型请给足：小额 max_tokens 可能只返回推理、可见内容为空",
    ")", "print(resp.choices[0].message.content)",
  ].join(NL);

  const sh = [
    "curl -s -D - -H " + Q + "authorization: Bearer " + secret + Q
      + " -H " + Q + "content-type: application/json" + Q
      + " -d " + Q + '{"model":"' + exampleModel + '","messages":[{"role":"user","content":"你好"}],"max_tokens":256}' + Q
      + " " + base + "/chat/completions",
  ].join(NL);

  return [
    "# API 接入信息（api-relay 网关）", "",
    "- Base URL: " + base, "- API Key: " + secret, "- " + models, "",
    "## 快速开始（Python，OpenAI SDK 只改两行）", "", "~~~python", py, "~~~", "",
    "## 可用端点", "",
    "- POST " + base + "/chat/completions — OpenAI 兼容对话（支持 \"stream\": true 流式）",
    "- POST " + base + "/completions — 旧版文本补全（传 prompt）",
    "- GET " + base + "/models — 你这把 key 可用的模型清单",
    "- POST " + base + "/messages 与 " + base + "/responses — Anthropic / OpenAI Responses 兼容（messages 仅 agnes 系模型，详见运营提供的完整文档）", "",
    "## 常见错误（错误体形状 { error: { message, type, code } }）", "",
    "- 401: missing_key（没带 Authorization 头）/ invalid_key（key 无效）/ key_disabled（已停用）/ expired_key（已过期）",
    "- 403: model_not_allowed（该模型不在这把 key 的白名单里，message 会列出可用模型）",
    "- 404: model_not_found（模型名不存在，先用 GET /models 核对）",
    "- 429: rate_limited（每分钟请求数超限）/ too_many_concurrent（并发超限）/ quota_exhausted（本周期额度用完）——按 error.relay_attribution.suggested_next.retryAfterMs 退避后重试，或控制请求频率；网关对 429 是立即拒绝，不占用额度",
    "- 502/503: upstream_error（上游故障）——可重试；建议客户端超时 >=120s（推理模型首字节可能较慢），或改用流式", "",
    "## 自验（应返回 200 与模型回复）", "", "~~~bash", sh, "~~~", "",
    "用量与额度查询：GET " + base + "/quota（本机默认放开；需要远程访问请联系运营）。",
    "当前档位：" + tier + "（速率/并发上限见 429 错误的 message，或联系运营）。",
    "完整文档（端点表/错误码全表/流式说明）由运营提供。",
  ].join(NL);
}

/* ---------------- 明文 key 抽屉（只显示一次） ---------------- */

function SecretBox(props: { secret: string; notice?: string; keyFull?: KeyFull | null }) {
  return (
    <>
      <div class="note warn"><b>只显示这一次。</b>{props.notice || "服务端只保存哈希，关闭后无法再次查看。"}</div>
      <div class="secret">{props.secret}</div>
      <div style="display:flex;gap:var(--s2);margin-top:var(--s3);flex-wrap:wrap">
        <button
          title="组装一份可直接转发客户的 markdown：地址+key+可用模型+SDK 示例+端点+常见错误+自验命令"
          onClick={() => copyText(customerPackage(props.secret, props.keyFull),
            "客户接入包已复制——直接转发客户即可上手（含地址/key/模型清单/SDK 示例/错误码/自验命令）")}>复制客户接入包</button>
        <button onClick={() => copyText(props.secret)}>复制</button>
        <button class="pri" onClick={closeDrawer}>我已保存</button>
      </div>
    </>
  );
}

function secretDrawer(title: string, secret: string, notice: string | undefined, key: KeyFull | null | undefined) {
  openDrawer({ title, body: <SecretBox secret={secret} notice={notice} keyFull={key || null} /> });
}

/* ---------------- 新建/编辑 Key 表单抽屉 ---------------- */

function KeyForm(props: { k: KeyFull | null; pol: AuthPolicyResp; onDone: () => void }) {
  const k = props.k;
  const isNew = !k;
  const tiers = (props.pol && props.pol.tiers) || {};
  const [tier, setTier] = useState<string>(k ? k.tier : "standard");
  const [label, setLabel] = useState(k ? k.label || "" : "");
  const [tenant, setTenant] = useState("default");
  const [models, setModels] = useState(k && k.allowedModels ? k.allowedModels.join(", ") : "");
  const [quota, setQuota] = useState(k && k.quotaOverride != null ? String(k.quotaOverride) : "");
  const [quotaCny, setQuotaCny] = useState(k && k.quotaCnyOverride != null ? String(k.quotaCnyOverride) : "");
  const [days, setDays] = useState("");
  const [extend, setExtend] = useState("");

  const quotaHint = (() => {
    const t = tiers[tier];
    if (!t || t.periodQuotaTokens == null) return "留空=分层默认";
    return "留空=分层默认（" + t.label + "：" + formatNumber(t.periodQuotaTokens) + " token）";
  })();

  const save = async () => {
    const modelList = models.split(",").map((s) => s.trim()).filter(Boolean);
    try {
      if (isNew) {
        const d = Number(days);
        const r = await api<any>("keys/create", {
          method: "POST",
          body: JSON.stringify({
            label, tier, tenantId: tenant || "default",
            ...(modelList.length ? { allowedModels: modelList } : {}),
            ...(quota.trim() ? { quotaOverride: Number(quota) } : {}),
            ...(quotaCny.trim() ? { quotaCny: Number(quotaCny) } : {}),
            ...(d > 0 ? { expiresInDays: d } : {}),
          }),
        });
        closeDrawer();
        secretDrawer("新 Key（" + r.key.tier + " · " + r.key.id + "）", r.secret, r.secretNotice, r.key);
        if (r.unknownModels && r.unknownModels.length) {
          toast("注意：<b>" + esc(r.unknownModels.join("、")) + "</b> 不是网关已声明的模型——客户调用会 404，确认是故意为之（如预配）再保留", "y");
        }
        props.onDone();
      } else {
        const extDays = extend.trim() === "" ? null : Number(extend);
        if (extDays !== null && (!Number.isFinite(extDays) || extDays < 0)) {
          toast("续期天数必须为 ≥0 的数字", "r");
          return;
        }
        const ur = await api<any>("keys/update", {
          method: "POST",
          body: JSON.stringify({
            keyId: k!.id, label, tier,
            allowedModels: modelList.length ? modelList : null,
            ...(extDays !== null && extDays > 0
              ? { expiresAt: Math.max(Date.now(), k!.expiresAt || 0) + extDays * 86400000 } : {}),
            quotaOverride: quota.trim() === "" ? null : Number(quota),
            quotaCny: quotaCny.trim() === "" ? null : Number(quotaCny),
          }),
        });
        closeDrawer();
        toast("已保存 <b>" + esc(k!.id) + "</b>", "g");
        if (ur.unknownModels && ur.unknownModels.length) {
          toast("注意：<b>" + esc(ur.unknownModels.join("、")) + "</b> 不是网关已声明的模型——客户调用会 404，确认是故意为之（如预配）再保留", "y");
        }
        props.onDone();
      }
    } catch (e: any) {
      const r = writeErr("保存 Key", e);
      toast(r.text, r.tone);
    }
  };

  const enterSave = (e: KeyboardEvent) => {
    if (e.key === "Enter") { e.preventDefault(); save(); }
  };

  return (
    <>
      <div class="note">{isNew ? "明文 key 只在创建后显示一次，服务端只保存 sha256。" : "这里改的是元数据；换 key 请用「轮换」（旧 key 会立即失效）。"}</div>
      <datalist id="f-models-list">{MODEL_NAMES.map((m) => <option key={m} value={m} />)}</datalist>
      <div class="f"><label>备注名</label>
        <input maxlength={64} value={label} placeholder="例如：张三的 Dify 应用（≤64 字）"
          onInput={(e) => setLabel((e.target as HTMLInputElement).value)} onKeyDown={enterSave} /></div>
      <div class="f"><label>分层</label>
        <select value={tier} onChange={(e) => setTier((e.target as HTMLSelectElement).value)}>
          {["free", "standard", "pro"].map((t) => (
            <option key={t} value={t}>{t + (t === "pro" ? "（降损全开）" : t === "free" ? "（纯管道）" : "（按 token）")}</option>
          ))}
        </select></div>
      {isNew ? (
        <div class="f"><label>租户</label>
          <input value={tenant} onInput={(e) => setTenant((e.target as HTMLInputElement).value)} onKeyDown={enterSave} /></div>
      ) : null}
      <div class="f"><label>允许模型</label>
        <input list="f-models-list" value={models}
          placeholder="留空=全部；多个用逗号分隔（输入时从下方清单选，防打错）"
          onInput={(e) => setModels((e.target as HTMLInputElement).value)} /></div>
      <div class="f"><label>额度(token)</label>
        <input type="number" min="0" value={quota} placeholder={quotaHint}
          onInput={(e) => setQuota((e.target as HTMLInputElement).value)} onKeyDown={enterSave} /></div>
      <div class="f"><label>预算(元)</label>
        <input type="number" min="0" step="0.01" value={quotaCny} placeholder="留空=不限。例如 10 = 最多花 ¥10"
          onInput={(e) => setQuotaCny((e.target as HTMLInputElement).value)} onKeyDown={enterSave} /></div>
      {isNew ? (
        <div class="f"><label>有效期(天)</label>
          <input type="number" min="0" value={days} placeholder="留空=长期"
            onInput={(e) => setDays((e.target as HTMLInputElement).value)} onKeyDown={enterSave} /></div>
      ) : k && k.expiresAt ? (() => {
        const dLeft = Math.ceil((k.expiresAt - Date.now()) / 86400000);
        return (
          <>
            <div class="f"><label>当前有效期至</label>
              <div style="align-self:center">{TS(k.expiresAt)}
                {dLeft >= 0
                  ? <span class={dLeft <= 7 ? "warn" : "dim"}>（还剩 {dLeft} 天）</span>
                  : <span class="err">（已过期）</span>}
              </div></div>
            <div class="f"><label>续期(天)</label>
              <input type="number" min="0" value={extend} placeholder="留空=不变；从当前有效期起算"
                onInput={(e) => setExtend((e.target as HTMLInputElement).value)} onKeyDown={enterSave} /></div>
          </>
        );
      })() : null}
      <div class="hstack-end">
        <button class="bare" onClick={closeDrawer}>取消</button>
        <button class="pri" onClick={save}>{isNew ? "创建" : "保存"}</button>
      </div>
    </>
  );
}

/* ---------------- 「更多」抽屉（不可逆动作集中地） ---------------- */

function MoreBox(props: { k: KeyFull; onDone: () => void }) {
  const k = props.k;
  const on = !!k.enabled;
  const act = async (actName: string) => {
    try {
      if (actName === "rotate") {
        if (!confirm("轮换 " + k.id + " 的 key？旧 key 会立即失效，正在使用它的客户端会中断。")) return;
        const r = await api<any>("keys/rotate", { method: "POST", body: JSON.stringify({ keyId: k.id }) });
        secretDrawer("新 Key（轮换 " + k.id + "）", r.secret, r.secretNotice, r.record || r.key);
        props.onDone();
      } else if (actName === "disable") {
        if (!confirm("停用 " + k.id + "？该 key 将立即无法调用（401 key_disabled），可随时重新启用。")) return;
        await api("keys/update", { method: "POST", body: JSON.stringify({ keyId: k.id, enabled: false }) });
        toast("已停用 <b>" + esc(k.id) + "</b>（可重新启用）", "y");
        props.onDone();
      } else if (actName === "enable") {
        await api("keys/update", { method: "POST", body: JSON.stringify({ keyId: k.id, enabled: true }) });
        toast("已启用 <b>" + esc(k.id) + "</b>", "g");
        props.onDone();
      } else if (actName === "revoke") {
        // A1（审查修复）：后端 POST /keys/revoke 一直存在、面板无入口。与「停用」的区别：
        // 吊销是审计意义上的作废（面板 key 会从鉴权索引摘除，需重新启用才可再用），历史度量保留。
        if (!confirm("吊销 " + k.id + "？该 key 将立即失效（历史度量保留）；如需恢复请重新启用。")) return;
        await api("keys/revoke", { method: "POST", body: JSON.stringify({ keyId: k.id }) });
        toast("已吊销 <b>" + esc(k.id) + "</b>（历史度量保留）", "r");
        props.onDone();
      } else if (actName === "delete") {
        if (!confirm("彻底删除 " + k.id + "？该 key 的凭证将立即失效且无法恢复（历史度量与审计事件保留）；配置里来的 key 不会被彻底删除——请改用停用。")) return;
        await api("keys/delete", { method: "POST", body: JSON.stringify({ keyId: k.id }) });
        toast("已彻底删除 <b>" + esc(k.id) + "</b>", "r");
        props.onDone();
      }
    } catch (e: any) {
      const r = writeErr("Key 操作", e);
      toast(r.text, r.tone);
    }
  };
  return (
    <>
      <div class="note warn">
        <b>这两个动作都不可撤销。</b><br />
        「轮换」会让旧 key <b>立即失效</b>，正在用它的客户端马上开始 401；<br />
        「{on ? "停用" : "启用"}」{on ? "会让该 key 立刻无法调用（历史度量保留）。" : "会让该 key 重新可用。"}
      </div>
      <div class="row"><button class="pri" style="width:100%" onClick={() => act("rotate")}>轮换 key（生成新明文，旧的立即作废）</button></div>
      <div class="row"><button class={on ? "danger" : ""} style="width:100%" onClick={() => act(on ? "disable" : "enable")}>{on ? "停用这个 key" : "重新启用这个 key"}</button></div>
      <div class="row"><button class="danger" style="width:100%" onClick={() => act("revoke")}>吊销这个 key（作废但保留度量，可重新启用）</button></div>
      {k.deletable ? (
        <div class="row"><button class="danger" style="width:100%" onClick={() => act("delete")}>彻底删除这个 key（度量与审计事件保留）</button></div>
      ) : null}
      <button class="bare" onClick={closeDrawer}>关闭</button>
    </>
  );
}

/* ---------------- 鉴权自检 ---------------- */

function WhoamiBox(props: { pol: AuthPolicyResp }) {
  const [secret, setSecret] = useState("");
  const [out, setOut] = useState<JSX.Element | null>(null);
  const [busy, setBusy] = useState(false);

  const go = async () => {
    const s = secret.trim();
    if (!s) { toast("请先粘贴要自检的 key", "y"); return; }
    setBusy(true);
    setOut(<div class="dim" style="font-size:var(--fs-sm);margin-top:var(--s2)">核对中…</div>);
    try {
      const [, r] = await Promise.all([
        refreshModelNames(),
        api<any>("keys/whoami", { method: "POST", body: JSON.stringify({ secret: s }) }),
      ]);
      setSecret("");
      const st = r.status === "ok" ? <Chip tone="g">有效</Chip>
        : r.status === "key_disabled" ? <Chip>已禁用</Chip>
        : r.status === "expired_key" ? <Chip tone="y">已过期</Chip>
        : <Chip tone="r">不是本网关签发的 key</Chip>;
      const tiers = (props.pol && props.pol.tiers) || {};
      setOut(
        <div class={"note " + (r.status === "ok" ? "" : r.status === "not_issued" ? "bad" : "warn")} style="margin-top:var(--s2)">
          <b>{st}</b> 指纹 <span class="mono">{r.fingerprint}</span>
          {r.key ? (
            <>
              {" → "}<span class="mono">{r.key.id}</span>（{r.key.label} · {(tiers[r.key.tier] || {}).label || r.key.tier}）
              {r.key.policy ? (
                <div class="dim" style="font-size:var(--fs-xs);margin-top:2px">
                  rpm {formatNumber(r.key.policy.rpm)} · 并发 {formatNumber(r.key.policy.maxConcurrency)}
                  {r.key.policy.periodQuotaTokens != null
                    ? " · 额度 " + formatNumber(r.key.policy.periodQuotaTokens) + " token"
                    : " · 按量计费无周期额度"}
                  {r.key.policy.periodQuotaCny != null ? " · 预算 " + cny(r.key.policy.periodQuotaCny) : ""}
                </div>
              ) : null}
              <div class="dim" style="font-size:var(--fs-xs);margin-top:2px">允许模型：
                {r.key.allowedModels && r.key.allowedModels.length
                  ? r.key.allowedModels.map((m: string) =>
                    MODEL_NAMES.length && !MODEL_NAMES.includes(m)
                      ? <Chip key={m} tone="r" title={m + " 不是网关已声明的模型——客户调用它会 404（model_not_found）；如非故意预配，去编辑修正"}>{m + " ⚠未声明"}</Chip>
                      : <span key={m}>{m}、</span>)
                  : "全部（本网关已声明的均可调）"}
              </div>
            </>
          ) : null}
          <br />{r.explanation || ""}
        </div>,
      );
    } catch (e: any) {
      const r = writeErr("自检", e);
      setOut(null);
      toast(r.text, r.tone);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="f">
      <label>粘贴你手上正在使用的 key</label>
      <div class="hstack">
        <input type="password" placeholder="sk-relay-..." style="flex:1" value={secret}
          onInput={(e) => setSecret((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); go(); } }} />
        <button class="pri" disabled={busy} onClick={go}>自检</button>
      </div>
      {out}
    </div>
  );
}

/* ---------------- 被拒 key 台账 ---------------- */

function AuthFailNote(props: { af: KeysResp["authFailures"]; winAuth?: { count?: number; lastAt?: number } }) {
  const { af, winAuth } = props;
  const win = winAuth && winAuth.count
    ? <> <b>窗口内 {formatNumber(winAuth.count)} 次</b>（落库统计，跨重启仍在；最近 {TS(winAuth.lastAt || 0)}）</>
    : null;
  if (!af || !af.total) {
    return (
      <div class="dim" style="font-size:var(--fs-sm);margin-top:var(--s2)">
        本进程启动以来没有被拒的 key。（指纹台账只在内存里，重启即清空；"被拒了 N 次"这种累计量在「总览」横幅与失败统计里，那份是落库的，跨重启仍在。）{win ? <br /> : null}
        {win ? <>当前窗口：{win}。</> : null}
      </div>
    );
  }
  const g = (af.groups || []).slice(0, 8);
  return (
    <>
      <h2 style="margin-top:var(--s4)">最近被拒的 key <span class="spacer" /><span class="muted-xs" style="text-transform:none">本进程启动以来共 {formatNumber(af.total)} 次 · {formatNumber(af.distinct)} 种 · 指纹与下方「指纹」列同口径，可直接对照</span></h2>
      <table>
        <thead><tr><th>指纹</th><th>原因</th><th>次数</th><th>最后时间</th><th>对照</th><th>提交形态</th></tr></thead>
        <tbody>
          {g.map((x, i) => (
            <tr key={i}>
              <td class="mono">{x.fingerprint || "(没带 key)"}</td>
              <td class="mono">{x.code}</td>
              <td class="mono">{formatNumber(x.count)}</td>
              <td class="mono">{TS(x.lastAt || 0)}</td>
              <td><Chip tone={x.matchesIssuedKey ? "y" : "r"}>{x.matchesIssuedKey ? "命中已签发 key（可能被禁用/过期）" : "非本网关签发"}</Chip></td>
              <td class="mono">{x.headerForm === "none" ? "没带" : x.headerForm === "bearer" ? "Bearer" : "裸 key"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

/* ---------------- 主视图 ---------------- */

type KeyFilter = "on" | "risk" | "off" | "all";

export function Keys() {
  const [data, setData] = useState<null | { d: KeysResp; pol: AuthPolicyResp; winAuth?: { count?: number; lastAt?: number } }>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [filter, setFilter] = useState<KeyFilter>(() => {
    try {
      const v = localStorage.getItem("relay_admin_key_filter");
      if (v && ["on", "off", "risk", "all"].includes(v)) return v as KeyFilter;
    } catch { /* 隐私模式忽略 */ }
    return "on";
  });
  const [q, setQ] = useState(() => {
    try { return localStorage.getItem("relay_admin_key_q") || ""; } catch { return ""; }
  });

  useEffect(() => {
    let alive = true;
    (async () => {
      setErr(null);
      try {
        const [d, pol, ov] = await Promise.all([
          api<KeysResp>("keys"),
          api<AuthPolicyResp>("auth-policy").catch(() => ({ tiers: {} }) as AuthPolicyResp),
          api<any>("overview?window=" + windowValue.value + "&slim=1").catch(() => ({})),
        ]);
        if (alive) {
          setData({ d, pol, winAuth: (ov && ov.summary || {}).clientAuthFailures });
          refreshModelNames();
        }
      } catch (e: any) {
        if (alive) setErr(e && e.message ? e.message : String(e));
      }
    })();
    return () => { alive = false; };
  }, [tick]);

  if (err) {
    return <section class="block"><h2>客户 Key</h2><div class="note bad">加载失败：{err}——稍后点右上角 ↻ 重试</div></section>;
  }
  if (!data) {
    return <section class="block"><h2>客户 Key</h2><div class="skel" style="height:220px" /></section>;
  }

  const { d, pol } = data;
  const all = d.keys || [];
  const refresh = () => setTick((t) => t + 1);

  const applyFilter = (list: KeyFull[]): KeyFull[] => {
    const lq = q.trim().toLowerCase();
    return list.filter((k) => {
      if (filter === "on" && !k.enabled) return false;
      if (filter === "risk" && !keyState(k).attention) return false;
      if (filter === "off" && k.enabled) return false;
      if (!lq) return true;
      return (String(k.id) + " " + String(k.label) + " " + String(k.hashPrefix)).toLowerCase().includes(lq);
    });
  };
  const shown = applyFilter(all);
  const on = all.filter((k) => k.enabled).length;
  const risk = all.filter((k) => keyState(k).attention).length;

  const setF = (f: KeyFilter) => {
    setFilter(f);
    try { localStorage.setItem("relay_admin_key_filter", f); } catch { /* 存不上不影响当次 */ }
  };
  const setQuery = (v: string) => {
    setQ(v);
    try { localStorage.setItem("relay_admin_key_q", v); } catch { /* 存不上不影响当次 */ }
  };

  const exportCsv = () => {
    const head = ["key", "备注", "分层", "来源", "状态", "本周期token", "请求数", "成本CNY", "额度token", "额度CNY", "过期时间"];
    const rows: (string | number)[][] = [head];
    for (const k of all) {
      const u = k.usage || {};
      const expired = k.expiresAt && k.expiresAt < Date.now();
      rows.push([
        k.id, k.label || "", k.tier, k.origin === "panel" ? "面板" : "配置",
        !k.enabled ? "已停用" : expired ? "已过期"
          : (u.quotaCnyUsedPct != null && u.quotaCnyUsedPct >= 1) || (u.quotaUsedPct != null && u.quotaUsedPct >= 1) ? "已用完" : "生效中",
        u.tokens ?? 0, u.requests ?? 0, (u.costCny ?? 0).toFixed(4),
        u.quota ?? "", u.quotaCny ?? "", k.expiresAt ? TS(k.expiresAt) : "",
      ]);
    }
    const csv = CSV_BOM + rows.map((r) => r.map(csvCell).join(",")).join(CRLF);
    downloadText("api-relay-keys-" + new Date().toISOString().slice(0, 10) + ".csv", csv, "text/csv;charset=utf-8");
    toast("已导出 " + (rows.length - 1) + " 个 key 的用量 CSV", "g");
  };

  const exportJson = () => {
    const payload = all.map((k) => ({ id: k.id, label: k.label, tier: k.tier, origin: k.origin, enabled: k.enabled, expiresAt: k.expiresAt, usage: k.usage }));
    downloadText("api-relay-keys-" + new Date().toISOString().slice(0, 10) + ".json",
      JSON.stringify({ exportedAt: new Date().toISOString(), keys: payload }, null, 2), "application/json");
    toast("已导出 " + payload.length + " 个 key 的 JSON", "g");
  };

  const resetQuota = async (k: KeyFull) => {
    try {
      if (!confirm("重置 " + k.id + " 的本周期额度？历史度量保留，但额度从此刻重新起算。")) return;
      const r = await api<any>("keys/reset-quota", { method: "POST", body: JSON.stringify({ keyId: k.id }) });
      toast("已重置 <b>" + esc(k.id) + "</b>：原用量 " + formatNumber(r.before) + " token → 归零", "g");
      refresh();
    } catch (e: any) {
      const w = writeErr("Key 操作", e);
      toast(w.text, w.tone);
    }
  };

  const tierChip = (t: string): "b" | undefined => (t === "standard" ? "b" : undefined);

  return (
    <div>
      <div class="note warn"><b>明文 key 只在创建/轮换时显示一次。</b>服务端只保存 sha256 哈希，无法再次查看——忘了就轮换。
        配置文件里的 key（来源=配置）只能禁用不能删除（删了重启还会回来）。</div>

      <section class="block">
        <h2>鉴权自检 <span class="spacer" /><span class="muted-xs" style="text-transform:none">"API 全 401"通常是 key 不对，不是服务挂了——贴一下就知道</span></h2>
        <WhoamiBox pol={pol} />
        <AuthFailNote af={d.authFailures} winAuth={data.winAuth} />
      </section>

      <section class="block">
        <h2>客户 Key <span class="spacer" />
          <button class="pri" onClick={() => openDrawer({ title: "新建客户 Key", body: <KeyForm k={null} pol={pol} onDone={refresh} /> })}>+ 新建 Key</button>
          <button class="bare" title="导出本周期全部 key 的用量 CSV（对账用；BOM+CRLF，Excel 直接打开）" onClick={exportCsv}>导出 CSV</button>
          <button class="bare" title="导出本周期全部 key 的用量 JSON（备份/审阅用）" onClick={exportJson}>导出 JSON</button>
          <button class="bare" onClick={refresh}>↻</button>
        </h2>
        <div class="row">
          <div class="filters">
            {([["on", "生效中", on], ["risk", "需关注", risk], ["off", "已停用", all.length - on], ["all", "全部", all.length]] as [KeyFilter, string, number][]).map(([id, label, n]) => (
              <button key={id} class={filter === id ? "on" : ""} onClick={() => setF(id)}>{label} <span class="dim">{n}</span></button>
            ))}
          </div>
          <span class="spacer" style="flex:1" />
          <input placeholder="🔍 搜索 id / 备注 / 指纹" style="width:210px" value={q}
            onInput={(e) => setQuery((e.target as HTMLInputElement).value)} />
        </div>
        <table>
          <thead><tr><th>Key</th><th>指纹</th><th>备注</th><th>分层</th><th>来源</th><th>状态</th><th class="num">本周期用量 / 额度</th><th>RPM / 并发</th><th class="act">操作</th></tr></thead>
          <tbody>
            {shown.length ? shown.map((k) => {
              const u = k.usage || {};
              const ks = keyState(k);
              const st = !k.enabled ? <Chip>已禁用</Chip>
                : ks.usedUp ? <Chip tone="r" title="额度/预算已耗尽，请求会被 402 拒掉；充值后在「编辑」里提额或点「重置额度」即可恢复">已用完</Chip>
                : ks.expired ? <Chip tone="y" title="已过有效期，请求会被拒；到「编辑」里续期即可恢复">已过期</Chip>
                : ks.expiringSoon ? <Chip tone="y" title={ks.expDays + " 天后过期——提前通知客户换 key 或到「编辑」里续期"}>{String(ks.expDays) + " 天后过期"}</Chip>
                : ks.nearLimit ? <Chip tone="y" title="本周期额度/预算即将耗尽（≥85%），客户很快会被 402 拒；提前联系充值或提额">将耗尽</Chip>
                : <Chip tone="g">生效中</Chip>;
              return (
                <tr key={k.id}>
                  <td class="mono">{k.id}</td>
                  <td class="mono" style="font-size:var(--fs-xs)">{k.hashPrefix}</td>
                  <td>{shortLabel(k.label, 40)}</td>
                  <td><Chip tone={tierChip(k.tier)}>{k.tier}</Chip></td>
                  <td><Chip tone={k.origin === "panel" ? undefined : "b"}>{k.origin === "panel" ? "面板" : "配置"}</Chip></td>
                  <td>{st}</td>
                  <td class="mono num">
                    <b>{formatNumber(u.tokens)}</b> <span class="dim">/ {u.quota ? formatNumber(u.quota) : "不限"}</span>
                    <MiniBar val={u.quotaUsedPct} />
                    <div class="muted-xs">{formatNumber(u.requests)} 次</div>
                    {u.quotaCny
                      ? <div style="font-size:var(--fs-xs)" class={u.quotaCnyUsedPct! > 0.9 ? "warn" : "dim"}>
                          {cny(u.costCny || 0)} / {cny(u.quotaCny)} <span class="dim">({pct(u.quotaCnyUsedPct)})</span>
                          <MiniBar val={u.quotaCnyUsedPct} />
                        </div>
                      : <div class="muted-xs">{cny(u.costCny || 0)} / 不限</div>}
                  </td>
                  <td class="mono" style="font-size:var(--fs-xs);white-space:nowrap">
                    RPM {k.policy?.rpm == null ? "∞" : k.policy.rpm} · 并发 {k.concurrency?.active || 0}/{k.policy?.maxConcurrency == null ? "∞" : k.policy.maxConcurrency}
                  </td>
                  <td class="act">
                    <button title="改备注 / 分层 / 型号白名单 / 额度"
                      onClick={() => openDrawer({ title: "编辑 Key " + k.id, body: <KeyForm k={k} pol={pol} onDone={refresh} /> })}>编辑</button>
                    <button class="bare" title="本周期已用量清零（历史度量保留）；客户充值后点它立刻恢复"
                      onClick={() => resetQuota(k)}>重置</button>
                    <button class="bare" title="轮换 / 启用停用"
                      onClick={() => openDrawer({ title: "管理 " + k.id, body: <MoreBox k={k} onDone={refresh} /> })}>更多…</button>
                  </td>
                </tr>
              );
            }) : (
              <tr><td colspan={9} class="dim" style="padding:18px;text-align:center">这个筛选下没有 key。换个条件，或点右上角「+ 新建 Key」。</td></tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}
