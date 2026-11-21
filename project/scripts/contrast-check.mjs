#!/usr/bin/env node
/* 5.3 对比度实测：解析 legacy.css 两个 :root 块的 token，按真实 UI 用到的前景/背景组合
   计算 WCAG 2.1 对比度。正文 <4.5 FAIL；大字号/图表色 <3.0 FAIL。
   用法：node scripts/contrast-check.mjs [--csv] 导出 CSV（带 BOM，Excel 直开） */

import { readFileSync } from "node:fs";

const CSS = readFileSync(new URL("../frontend/src/legacy.css", import.meta.url), "utf8");

/* 解析 :root 块（暗色）与 :root[data-theme="light"]（亮色）的 --token: #hex */
function parseTokens(selector) {
  const m = CSS.match(new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]*)\\}"));
  const out = {};
  if (m) for (const [, k, v] of m[1].matchAll(/--([\w-]+)\s*:\s*(#[0-9a-fA-F]{3,8})/g)) out[k] = v;
  return out;
}
const THEMES = { dark: parseTokens(":root"), light: parseTokens(':root[data-theme="light"]') };

/* WCAG 2.1 相对亮度与对比度 */
const lum = (hex) => {
  const n = hex.replace("#", "");
  const [r, g, b] = (n.length === 3 ? n.split("").map((c) => c + c) : n.match(/../g)).map((c) => parseInt(c, 16) / 255);
  const f = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const ratio = (a, b) => {
  const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
};

/* 真实 UI 色对（前景/背景/最小比值/用途）。token 名与 legacy.css 对齐，改色后跑此脚本即可回归 */
const PAIRS = [
  ["fg", "bg", 4.5, "正文/页面底"],
  ["fg", "panel", 4.5, "正文/卡片"],
  ["fg", "panel2", 4.5, "正文/悬浮行"],
  ["dim", "bg", 4.5, "次要文字/页面底"],
  ["dim", "panel", 4.5, "次要文字/卡片（th、note、hint 都在这）"],
  ["accent", "bg", 4.5, "链接/页面底"],
  ["accent", "panel", 4.5, "链接/卡片"],
  ["ok", "panel", 3.0, "成功态（多为粗体/图标）"],
  ["warn", "panel", 3.0, "警告态"],
  ["err", "panel", 4.5, "错误文字（细体也常见，从严）"],
  ["pur", "panel", 3.0, "紫色标记"],
];

const rows = [];
let fail = 0;
for (const [theme, tokens] of Object.entries(THEMES)) {
  for (const [fg, bg, min, use] of PAIRS) {
    const f = tokens[fg], b = tokens[bg];
    if (!f || !b) { rows.push([theme, fg + "/" + bg, "-", "-", "-", "TOKEN 缺失"]); fail++; continue; }
    const r = ratio(f, b);
    const ok = r >= min;
    if (!ok) fail++;
    rows.push([theme, fg + "/" + bg, f, b, r.toFixed(2) + ":1", ok ? "PASS" : `FAIL(<${min})`, use]);
  }
}

if (process.argv.includes("--csv")) {
  const bom = String.fromCharCode(0xfeff);
  const csv = bom + ["主题,色对,前景,背景,对比度,判定,用途", ...rows.map((r) => r.join(","))].join("\r\n");
  process.stdout.write(csv + "\n");
} else {
  const W = [6, 14, 8, 8, 9, 10];
  console.log(rows.map((r) => r.map((c, i) => String(c).padEnd(W[i] || 2)).join(" ")).join("\n"));
}
console.error(fail ? `\n${fail} 项未达标` : "\n全部达标");
process.exit(fail ? 1 : 0);
