import { signal } from "@preact/signals";
import { nextTheme, type Theme } from "./ui-logic";

/* ---------------- 全局 UI 状态（signal） ---------------- */

export const TABS: [string, string][] = [
  ["ov", "总览"], ["met", "指标"], ["users", "客户 Key"], ["ch", "上游"], ["tenants", "租户"], ["billing", "套餐与账单"],
  ["kb", "知识库"], ["agent", "Agent"], ["agent-matrix", "决策矩阵"], ["agentchat", "Agent 对话"],
  ["ledger", "请求账本"], ["diag", "排障"],
  ["ops", "运维"], ["trust", "信任"],
];
export const TAB_IDS = TABS.map(([id]) => id);

/* 侧栏导航分组：按「先看状态 → 再改配置 → 后看自动化 → 底层系统」的值班心智排序 */
export const NAV_GROUPS: { label: string; items: [string, string][] }[] = [
  { label: "监控", items: [["ov", "总览"], ["met", "指标"], ["ledger", "请求账本"], ["diag", "排障"]] },
  { label: "配置", items: [["users", "客户 Key"], ["ch", "上游"], ["tenants", "租户"], ["billing", "套餐与账单"]] },
  {
    label: "智能",
    items: [["kb", "知识库"], ["agent", "Agent"], ["agent-matrix", "决策矩阵"], ["agentchat", "Agent 对话"]],
  },
  { label: "系统", items: [["ops", "运维"], ["trust", "信任"]] },
];

/* 移动端侧栏抽屉开关 */
export const navOpen = signal(false);

/* ---- 暗/亮主题：localStorage 持久化；首次访问跟随系统偏好（初始化读 index.html 内联脚本已写好的
   documentElement.dataset.theme，单一样式来源，不重复解析） ---- */
export type { Theme };
export const theme = signal<Theme>(document.documentElement.dataset.theme === "light" ? "light" : "dark");

export function toggleTheme() {
  const next = nextTheme(theme.value);
  theme.value = next;
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("relay_admin_theme", next); } catch { /* 隐私模式存不上不影响当次会话 */ }
}

/* hash 解析：支持 #tab 与 #tab/anchor 两段（5.2 速查联动：#diag/cheat-reason） */
const hashParts = () => location.hash.slice(1).split("/");
const hashTab = () => {
  const t = hashParts()[0];
  return TAB_IDS.includes(t) ? t : "ov";
};

/* 第二段锚点（当前仅 diag 用；其他页签带上锚点也不影响切页） */
export const hashAnchor = () => hashParts()[1] || "";

export const view = signal<string>(hashTab());
export const windowValue = signal<string>("24h");
export const bucketValue = signal<number>(3600000);
export const autoRefresh = signal<boolean>(true);
export const refreshIntervalValue = signal<number>(15);
export const versionValue = signal<string>("");
export const lastFresh = signal<number | null>(null);

export function goto(v: string, anchor?: string) {
  view.value = v;
  location.hash = anchor ? v + "/" + anchor : v;
  navOpen.value = false; /* 切换页签后收起移动端抽屉 */
}

window.addEventListener("hashchange", () => {
  const t = hashTab();
  if (t !== view.value) view.value = t;
});

/* 窗口选择 → 桶粒度（对齐旧版 win()/bucket() 映射） */
export function setWindow(w: string) {
  windowValue.value = w;
  bucketValue.value = w === "5m" ? 60000 : w === "1h" ? 300000 : w === "24h" ? 3600000 : 86400000;
}
