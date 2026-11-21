import { signal } from "@preact/signals";
import type { JSX } from "preact";
import type { Bucket, KeySlim, KeyStateInfo } from "./types";

/* ---------------- 格式化工具（对齐旧版 esc/formatNumber/pct/ms 语义） ---------------- */

export const formatNumber = (n: number | null | undefined, d?: number): string =>
  n == null ? "-" : Number(n).toLocaleString("zh-CN", { maximumFractionDigits: d == null ? 0 : d });

export const pct = (x: number | null | undefined): string =>
  x == null ? "-" : (x * 100).toFixed(2) + "%";

export const cny = (x: number | null | undefined): string => "¥" + Number(x || 0).toFixed(4);

export const ms = (n: number | null | undefined): string =>
  n == null || n === 0 ? "-" : n >= 1000 ? (n / 1000).toFixed(2) + "s" : Math.round(n) + "ms";

export const TS = (ts: number): string => new Date(ts).toLocaleString("zh-CN", { hour12: false });

export const dayTime = (ts: number): string => {
  const d = new Date(ts), n = new Date();
  const sameDay =
    d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  return sameDay
    ? d.toLocaleTimeString("zh-CN")
    : d.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" }) +
        " " +
        d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
};

/* 错误率色标：>20% err / >5% warn / 其余 ok。全站一个口径。 */
export const rateTone = (r: number | undefined): string => (r != null && r > 0.2 ? "err" : r != null && r > 0.05 ? "warn" : "ok");

/* ---------------- Toast（signal 驱动，替代旧版 #toast DOM 直插） ---------------- */

export interface ToastItem {
  id: number;
  text: string;
  tone?: "g" | "y" | "r";
}

export const toasts = signal<ToastItem[]>([]);
let toastSeq = 0;

export function toast(text: string, tone?: "g" | "y" | "r") {
  const id = ++toastSeq;
  toasts.value = [...toasts.value, { id, text, tone }];
  setTimeout(() => {
    toasts.value = toasts.value.filter((t) => t.id !== id);
  }, tone === "r" ? 9000 : 4200);
}

export function ToastHost() {
  return (
    <div id="toast">
      {toasts.value.map((t) => (
        <div key={t.id} class={t.tone || ""} dangerouslySetInnerHTML={{ __html: t.text }} />
      ))}
    </div>
  );
}

/* HTML 转义：toast 走 dangerouslySetInnerHTML，数据字段必须先过这层 */
export const esc = (s: unknown): string =>
  String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));

/* 写动作错误分类：400/404/409 是输入或状态问题（黄），5xx/网络才是系统故障（红） */
export function writeErr(action: string, e: any): { text: string; tone: "g" | "y" | "r" } {
  const st = e && e.status;
  const CODE_HINT: Record<string, string> = {
    kb_exists: "该 id 的知识库已存在——换个 id，或去知识库页编辑原库",
    agent_running: "上一轮 Agent 仍在运行——LLM 一轮 10-20 秒，稍后再点",
    agent_disabled: "Agent 未启用——在配置里开 agent.enabled 后重启",
    payload_too_large: "请求体超限——批量灌入单次上限 50 篇，请分批",
    kb_unavailable: "知识库未启用或存储故障——检查配置里的 kb.path 与 data/ 目录权限",
    kb_error: "写入期失败（分块或落库异常）——稍后重试；持续失败看「排障 → 事件日志」",
  };
  if (e && e.code && CODE_HINT[e.code]) {
    return { text: action + "未完成：" + esc(e.message) + "——" + CODE_HINT[e.code], tone: "y" };
  }
  if (st === 409) return { text: action + "冲突：" + esc(e.message) + "（刷新状态后重试，或换个标识）", tone: "y" };
  if (st === 400 || st === 404) return { text: action + "未完成（输入问题）：" + esc(e.message), tone: "y" };
  return { text: action + "失败：" + esc(e.message), tone: "r" };
}

/* ---------------- 复制（clipboard 失败 execCommand 兜底，fail-open） ---------------- */

export async function copyText(text: string, okMsg?: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    } catch {
      toast("复制失败，请手动选中复制", "y");
      return;
    }
  }
  toast(okMsg || "已复制到剪贴板", "g");
}

/* ---------------- 展示组件 ---------------- */

export function Tile(props: { k: string; v: JSX.Element | string; sub?: JSX.Element | string }) {
  return (
    <div class="card">
      <div class="k">{props.k}</div>
      <div class="v">{props.v}</div>
      {props.sub ? <div class="sub">{props.sub}</div> : null}
    </div>
  );
}

export function Chip(props: { tone?: "b" | "g" | "y" | "r"; title?: string; children: JSX.Element | string }) {
  return (
    <span class={"chip" + (props.tone ? " " + props.tone : "")} title={props.title}>
      {props.children}
    </span>
  );
}

export function Empty(props: { icon: string; msg: string; hint?: string }) {
  return (
    <div class="empty">
      <div class="ic">{props.icon}</div>
      <div>{props.msg}</div>
      {props.hint ? <div class="dim" style="font-size:var(--fs-sm)">{props.hint}</div> : null}
    </div>
  );
}

export function HBar(props: { b: Bucket; max: number; tone?: string }) {
  const w = props.max > 0 ? Math.min(100, (props.b.val / props.max) * 100).toFixed(1) : "0";
  return (
    <div class="hbar">
      <span class="nm" title={props.b.nm}>{props.b.nm}</span>
      <span class="track">
        <i class={"in " + (props.tone || "")} style={`width:${w}%`} />
      </span>
      <span class="vl">{props.b.txt}</span>
    </div>
  );
}

export function Note(props: { warn?: boolean; bad?: boolean; children: JSX.Element | string }) {
  return <div class={"note" + (props.bad ? " bad" : props.warn ? " warn" : "")}>{props.children}</div>;
}

/* ---------------- Key 状态（与旧版 keyState 同阈值） ---------------- */

export function keyState(k: KeySlim): KeyStateInfo {
  const u = k.usage || {};
  const now = Date.now();
  const expired = k.expiresAt != null && k.expiresAt < now;
  const expDays = k.expiresAt != null ? Math.ceil((k.expiresAt - now) / 86400000) : null;
  const expiringSoon = !expired && expDays != null && expDays <= 7;
  const usedUp =
    (u.quotaCnyUsedPct != null && u.quotaCnyUsedPct >= 1) || (u.quotaUsedPct != null && u.quotaUsedPct >= 1);
  const nearLimit =
    !usedUp &&
    ((u.quotaUsedPct != null && u.quotaUsedPct >= 0.85) || (u.quotaCnyUsedPct != null && u.quotaCnyUsedPct >= 0.85));
  return {
    expired, expDays, expiringSoon, usedUp, nearLimit,
    attention: !!k.enabled && (expired || expiringSoon || usedUp || nearLimit),
  };
}

export const shortLabel = (l: string | undefined, n: number): string => {
  const s = (l || "").trim();
  if (!s) return "-";
  return s.length > n ? s.slice(0, n) + "…" : s;
};

/* 行内迷你进度条（用量/预算占比，>90% 红 >70% 黄 其余绿） */
export function MiniBar(props: { val: number | null | undefined }) {
  if (props.val == null) return null;
  const tone = props.val > 0.9 ? "r" : props.val > 0.7 ? "y" : "g";
  return (
    <span class="bar">
      <i class={tone} style={`width:${Math.min(100, props.val * 100).toFixed(1)}%`} />
    </span>
  );
}

/* 文本落文件下载（CSV/JSON 导出共用；CSV 由调用方自行加 BOM） */
export function downloadText(filename: string, text: string, mime: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: mime }));
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* CSV 单元格转义（与旧版同规则：逗号/引号/换行 → 引号包裹+双写引号） */
export function csvCell(c: unknown): string {
  const s = String(c == null ? "" : c);
  const need = s.indexOf(",") >= 0 || s.indexOf('"') >= 0 || s.indexOf("\n") >= 0 || s.indexOf("\r") >= 0;
  return need ? '"' + s.split('"').join('""') + '"' : s;
}

export const CSV_BOM = String.fromCharCode(0xfeff);
export const CRLF = String.fromCharCode(13, 10);

/* ---------------- 可点击表格行（行语义 = 撑满整行的真实按钮，设计方案 §5 无障碍待办） ----------------
   旧实现是 tr role="button"（WAI-ARIA 允许、键盘可达），但屏读不会把行内容当按钮文字播报。
   现改为：每行首列放一个 .row-act 按钮，CSS 让它绝对定位撑满整行（见 styles.css），
   行内真实按钮靠 z-index 浮在其上；键盘可达性由原生 button 天然保证。
   rowA11y 退化为纯属性生成器（只给 tr 加 hover 类与 title）。
   5 处点击行（账本/排障/上游/知识库×2）统一走这里，样式 tr.click:hover 不变。 */
export function rowA11y(title?: string) {
  /* 显式 JSX 属性类型：title 等需匹配 Preact HTMLAttributes 的字面量类型，宽泛 string 会报 TS2322 */
  return { class: "click" as const, title: title as string | undefined };
}
