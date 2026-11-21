import { useEffect, useRef, useState } from "preact/hooks";
import {
  ApiError,
  getAgentMatrix,
  getAgentMatrixHistory,
  resetAgentMatrix,
  updateAgentMatrix,
} from "../api";
import type {
  AgentMatrixView,
  MatrixConfig,
  MatrixDimension,
  MatrixDimensionScore,
  MatrixEffectiveChange,
  MatrixEvaluation,
  MatrixGate,
  MatrixGateId,
  MatrixStats,
  MatrixTier,
  MatrixWeightKey,
  MatrixWeights,
} from "../types";
import { Chip, Empty, HBar, Tile, esc, formatNumber, pct, toast, TS } from "../ui";
import { classifyUiError, type UiErrorInfo } from "../ui-error";

/* ============================================================================
 * 内部 Agent · 决策矩阵（确定性仲裁）
 *
 * 职责：把「六维加权分 + G1-G4 四道门禁」这条仲裁链路的配置、最近一次裁决结果、
 * 历史证据完整暴露给值班人。三条硬约束：
 *   1. 后端是唯一真源——保存/重置后一律重新 GET，不做乐观更新（否则后端 400 校验失败
 *      会被前端的"已生效"假象掩盖）；
 *   2. 未启用 Agent（503 agent_disabled）与普通请求失败分流：前者是配置态，后者才是故障；
 *   3. 徽标不只靠颜色——每个分档/门禁都带文字与符号，色盲与黑白打印仍可读。
 * ========================================================================== */

/* ---------------- 阈值与口径常量 ---------------- */

/** 六维固定顺序（与后端 dimensions 的语义顺序一致；后端 label 缺失时用下面的中文兜底） */
const WEIGHT_KEYS: readonly MatrixWeightKey[] = ["impact", "confidence", "evidence", "risk", "effort", "novelty"];

/** 六维中文标签兜底（正常情况用后端 dimensions[].label，这里只在字段缺失时兜底；
 *  后端当前把 risk 标为"安全性"，label 缺省时才回落到契约用词"安全度"） */
const FALLBACK_LABEL: Record<MatrixWeightKey, string> = {
  impact: "影响面",
  confidence: "置信度",
  evidence: "证据强度",
  risk: "安全度",
  effort: "可执行性",
  novelty: "新颖度",
};

/** 六维释义兜底（用于滑杆 title，鼠标悬停能解释"这维到底在评什么"） */
const FALLBACK_DESC: Record<MatrixWeightKey, string> = {
  impact: "建议落地后影响的请求/租户范围——影响越大分越高",
  confidence: "Agent 对结论的把握程度；与证据强度互补，不互相替代",
  evidence: "支撑结论的实测数据/事件证据是否充分",
  risk: "安全度：风险越低分越高（高危变更降分）",
  effort: "可执行性：改动成本越低、回滚越简单分越高",
  novelty: "新颖度：与历史建议/知识库的重复度越低分越高（可自适应降权）",
};

/** 分档徽标：文字 + 符号 + 颜色三重编码，色觉障碍与黑白打印下不丢信息 */
const TIER_META: Record<MatrixTier, { tone: "g" | "y" | "r"; mark: string; text: string; hint: string }> = {
  accept: { tone: "g", mark: "✔", text: "接受", hint: "分数达接受阈值且 G1-G4 全过——建议进入执行候选" },
  queue: { tone: "y", mark: "⏸", text: "排队", hint: "未达接受阈值或门禁存疑——进待办队列，下一轮/人工确认" },
  reject: { tone: "r", mark: "✖", text: "拒绝", hint: "分数低于排队阈值或门禁硬拦——本轮丢弃，受控变更被剥离" },
};

/** 评估严重度徽标 */
const SEVERITY_META: Record<MatrixEvaluation["severity"], { tone: "b" | "y" | "r"; mark: string; text: string }> = {
  info: { tone: "b", mark: "ⓘ", text: "信息" },
  warn: { tone: "y", mark: "⚠", text: "告警" },
  critical: { tone: "r", mark: "⛔", text: "严重" },
};

/** 门禁展示顺序（契约固定 G1-G4） */
const GATE_ORDER: readonly MatrixGateId[] = ["G1", "G2", "G3", "G4"];

/** 权重合计容差：与 1 偏差 ≤0.001 视为合法（允许 0.1667×6=1.0002 这类四位小数分配） */
const WEIGHT_SUM_TOLERANCE = 0.001;

/** 平均分配的单维权重：0.1667×6 = 1.0002，落在容差内且可读 */
const UNIFORM_WEIGHT = 0.1667;

/** 历史拉取条数：不跟随 config.historyLimit 的编辑值走（那是后端环形缓冲上限） */
const HISTORY_LIMIT = 20;

/** 阈值/分数统一为 0..1 */
const RANGE_MIN = 0;
const RANGE_MAX = 1;

/** 统计缺省值：后端字段缺失时也不让页面出现 NaN */
const EMPTY_STATS: MatrixStats = { total: 0, accept: 0, queue: 0, reject: 0, avgScore: 0, topRejected: [] };

/* ---------------- 纯工具函数（无副作用，便于目测校验） ---------------- */

/** 夹到 0..1；非有限值（空输入框的 NaN、Infinity）一律归零，避免污染合计 */
function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(RANGE_MAX, Math.max(RANGE_MIN, v)) : RANGE_MIN;
}

/** 保留三位小数，消除 0.1+0.2 这类浮点噪声（仅用于展示与提交前的收口） */
function round3(v: number): number {
  return Number.isFinite(v) ? Math.round(v * 1000) / 1000 : 0;
}

/** 历史保留条数夹到 1..200 的整数 */
function clampHistory(v: number): number {
  if (!Number.isFinite(v)) return 20;
  return Math.min(200, Math.max(1, Math.round(v)));
}

/** 六维合计（缺失维按 0 计） */
function sumWeights(w: MatrixWeights): number {
  return WEIGHT_KEYS.reduce((s, k) => s + (Number.isFinite(w[k]) ? w[k] : 0), 0);
}

/** 把后端/任意来源的权重对象规整成六维齐备的结构 */
function normalizeWeights(w: Partial<Record<MatrixWeightKey, number>> | undefined): MatrixWeights {
  const out = {} as MatrixWeights;
  for (const k of WEIGHT_KEYS) out[k] = clamp01(Number(w?.[k] ?? 0));
  return out;
}

/** 服务端配置 → 编辑草稿（防御后端字段缺失，保证滑杆拿到的永远是有限数） */
function toDraft(c: MatrixConfig): MatrixConfig {
  return {
    enabled: !!c.enabled,
    weights: normalizeWeights(c.weights),
    acceptThreshold: clamp01(Number(c.acceptThreshold)),
    queueThreshold: clamp01(Number(c.queueThreshold)),
    historyLimit: clampHistory(Number(c.historyLimit)),
    adaptiveNovelty: !!c.adaptiveNovelty,
  };
}

/** 任意异常 → 可展示文本（不引入 any） */
function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e ?? "");
}

/** 任意异常 → HTTP 状态码（0 = 网络/超时） */
function apiStatus(e: unknown): number {
  return e instanceof ApiError ? e.status : 0;
}

/** 400 invalid_matrix_config 的逐条原因（后端放在 error.details: string[]） */
function apiDetails(e: unknown): string[] {
  if (!(e instanceof ApiError)) return [];
  const body = e.body as { error?: { details?: unknown } } | undefined;
  const details = body?.error?.details;
  return Array.isArray(details) ? details.map((d) => String(d)) : [];
}

/** 503 + agent_disabled：是"没开功能"的配置态，不是故障 */
function isAgentDisabled(e: unknown): boolean {
  if (!(e instanceof ApiError)) return false;
  return e.code === "agent_disabled" || e.status === 503;
}

/** payload 是 JSON 值；序列化失败（循环引用/异常对象）也不能让整页崩掉 */
function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2) ?? "—";
  } catch {
    return String(v);
  }
}

/** 分档中文名（用于降档说明里的纯文字表述） */
function tierText(t: MatrixTier): string {
  return TIER_META[t] ? TIER_META[t].text : String(t);
}

/** 维度 key → 中文标签（优先后端 label） */
function labelFor(key: string, dimensions: MatrixDimension[]): string {
  const hit = dimensions.find((d) => d.key === key);
  if (hit && hit.label) return hit.label;
  return FALLBACK_LABEL[key as MatrixWeightKey] || key;
}

/** 维度 key → 释义（优先后端 description） */
function descFor(key: string, dimensions: MatrixDimension[]): string {
  const hit = dimensions.find((d) => d.key === key);
  if (hit && hit.description) return hit.description;
  return FALLBACK_DESC[key as MatrixWeightKey] || "";
}

/** 得分 → 条色：≥0.7 绿 / ≥0.4 黄 / 其余红（数字同时给出，不靠颜色单通道） */
function scoreTone(v: number): "g" | "y" | "r" {
  return v >= 0.7 ? "g" : v >= 0.4 ? "y" : "r";
}

/**
 * 贡献占比文本：后端 contribution 可能是 0..1 的比例，也可能是 0..100 的百分数
 * （契约未写死量纲）。按量级自动识别，两种口径都不会出现 1640% 这种荒唐数字。
 */
function contributionText(c: number): string {
  if (!Number.isFinite(c)) return "-";
  return Math.abs(c) <= 1 ? pct(c) : c.toFixed(1) + "%";
}

/**
 * 右列的紧凑写法：得分 / 权重 / 贡献占比。
 * .hbar .vl 固定 150px 且 nowrap，写成"得分 0.85 · 权重 0.25 · 贡献 21.25%"会被省略号截断，
 * 所以这里只放数字，列含义由区块上方的图例交代（title 里仍给完整带单位的长文本）。
 */
function compactScoreLine(value: number, weight: number, contribution: number): string {
  const v = (Number(value) || 0).toFixed(2);
  const w = (Number(weight) || 0).toFixed(2);
  return v + " / " + w + " / " + contributionText(Number(contribution));
}

/* ---------------- 展示型子组件 ---------------- */

/** 分档徽标：✔/⏸/✖ + 文字 + 颜色 */
function TierChip(props: { tier: MatrixTier; prefix?: string; title?: string }) {
  const meta = TIER_META[props.tier];
  const tone = meta ? meta.tone : "b";
  const mark = meta ? meta.mark : "·";
  const text = meta ? meta.text : String(props.tier);
  return (
    <Chip tone={tone} title={props.title || (meta ? meta.hint : String(props.tier))}>
      {mark + " " + (props.prefix ? props.prefix + " " : "") + text}
    </Chip>
  );
}

/** 严重度徽标 */
function SeverityChip(props: { severity: MatrixEvaluation["severity"] }) {
  const meta = SEVERITY_META[props.severity];
  const tone = meta ? meta.tone : "b";
  const mark = meta ? meta.mark : "ⓘ";
  const text = meta ? meta.text : String(props.severity);
  return (
    <Chip tone={tone} title={"评估严重度：" + text}>
      {mark + " " + text}
    </Chip>
  );
}

/** 六维横向得分条：value 与 contribution 同列（右列 = 得分 · 权重 · 贡献占比） */
function ScoreBars(props: { scores: MatrixDimensionScore[]; dimensions: MatrixDimension[] }) {
  const scores = props.scores || [];
  if (!scores.length) return <div class="muted-sm">本次评估未附带维度得分</div>;
  return (
    <div>
      {scores.map((s) => {
        const label = labelFor(s.key, props.dimensions);
        const desc = descFor(s.key, props.dimensions);
        const width = (clamp01(Number(s.value) || 0) * 100).toFixed(1);
        const line = compactScoreLine(s.value, s.weight, s.contribution);
        const full =
          "得分 " +
          (Number(s.value) || 0).toFixed(2) +
          " · 权重 " +
          (Number(s.weight) || 0).toFixed(2) +
          " · 贡献占比 " +
          contributionText(Number(s.contribution));
        return (
          <div class="hbar" key={s.key}>
            <span class="nm" title={desc || label}>
              {label}
            </span>
            <span class="track" title={full}>
              <i class={"in " + scoreTone(Number(s.value) || 0)} style={"width:" + width + "%"} />
            </span>
            <span class="vl" title={full}>
              {line}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** G1-G4 门禁徽标：✔ 通过 / ✖ 未通过（缺项也显式标注，不静默省略） */
function GateChips(props: { gates: MatrixGate[] }) {
  const gates = props.gates || [];
  return (
    <div style="display:flex;gap:6px;flex-wrap:wrap">
      {GATE_ORDER.map((id) => {
        const g = gates.find((x) => x.id === id);
        if (!g) {
          return (
            <span class="chip" key={id} title="后端未下发该门禁结果——可能是更早的评估记录">
              ? {id} 无结果
            </span>
          );
        }
        return (
          <span
            class={"chip " + (g.passed ? "g" : "r")}
            key={id}
            title={g.note || (g.passed ? id + " 门禁通过" : id + " 门禁未通过")}
          >
            {(g.passed ? "✔ " : "✖ ") + id + (g.passed ? " 通过" : " 未通过")}
          </span>
        );
      })}
    </div>
  );
}

/** 门禁说明：徽标之外的逐条 note（悬浮不够用时可直接读） */
function GateNotes(props: { gates: MatrixGate[] }) {
  const gates = (props.gates || []).filter((g) => !!g.note);
  if (!gates.length) return null;
  return (
    <div class="dim" style="font-size:var(--fs-xs);margin-top:5px;line-height:1.6">
      {gates.map((g) => (
        <div key={g.id}>
          <span class="mono">{g.id}</span>
          {"：" + g.note}
        </div>
      ))}
    </div>
  );
}

/** 裁决说明（notes） */
function NotesList(props: { notes: string[] }) {
  const notes = props.notes || [];
  if (!notes.length) return null;
  return (
    <div class="dim" style="font-size:var(--fs-sm);margin-top:var(--s2);line-height:1.65">
      <b>裁决说明</b>
      {notes.map((n, i) => (
        <div key={i} style="margin-top:2px">
          {"· " + n}
        </div>
      ))}
    </div>
  );
}

/** 受控变更明细；reject 时后端已剥离 → 显式告知"本次无受控变更" */
function ChangeDetail(props: { change?: MatrixEffectiveChange }) {
  const c = props.change;
  if (!c) return <div class="dim" style="font-size:var(--fs-sm);margin-top:var(--s2)">本次无受控变更</div>;
  return (
    <div style="margin-top:var(--s2)">
      <div class="dim" style="font-size:var(--fs-xs);margin-bottom:4px">
        受控变更明细（门禁已放行的候选；矩阵只做准入判定，不执行变更）
      </div>
      <div class="kv">
        <div class="k">目标</div>
        <div class="mono" style="word-break:break-all">{c.target || "-"}</div>
        <div class="k">风险</div>
        <div>{c.risk || "-"}</div>
        <div class="k">影响面</div>
        <div>{c.impact || "-"}</div>
        <div class="k">回滚</div>
        <div>{c.rollback || "-"}</div>
        <div class="k">变更载荷</div>
        <div>
          <pre style="max-height:200px;margin:0">{safeJson(c.payload)}</pre>
        </div>
      </div>
    </div>
  );
}

/** 最近一次评估卡：大分数 + 分档 + 降档提示 + 六维条 + 四门 + 说明 + 变更明细 */
function EvaluationCard(props: { ev: MatrixEvaluation; dimensions: MatrixDimension[] }) {
  const ev = props.ev;
  const downgraded = ev.rawTier !== ev.tier;
  const tone = ev.tier === "accept" ? "ok" : ev.tier === "queue" ? "warn" : "err";
  return (
    <div class="card" style="margin-bottom:10px">
      <div style="display:flex;align-items:flex-end;gap:16px;flex-wrap:wrap">
        <div>
          <div class="k">综合得分</div>
          <div class={"mono " + tone} style="font-size:42px;line-height:1.05;font-weight:700">
            {(Number(ev.score) || 0).toFixed(3)}
          </div>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;min-width:0">
          <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
            <TierChip tier={ev.tier} />
            {downgraded ? (
              <span
                class="chip y"
                title={"原始分档 " + tierText(ev.rawTier) + " 被 G1-G4 门禁强制下调为 " + tierText(ev.tier)}
              >
                {"⚑ 已因门禁降档（" + tierText(ev.rawTier) + " → " + tierText(ev.tier) + "）"}
              </span>
            ) : null}
            <SeverityChip severity={ev.severity} />
          </div>
          <div class="mono dim" style="font-size:var(--fs-xs)">
            {TS(ev.at) + " · " + (ev.kind || "-") + " · " + (ev.category || "-")}
          </div>
        </div>
      </div>

      <div style="margin-top:12px">
        <div class="dim" style="font-size:var(--fs-xs);margin-bottom:2px">六维得分（右列依次：得分 / 权重 / 贡献占比）</div>
        <ScoreBars scores={ev.dimensions} dimensions={props.dimensions} />
      </div>

      <div style="margin-top:var(--s3)">
        <div class="dim" style="font-size:var(--fs-xs);margin-bottom:4px">四道门禁 G1-G4</div>
        <GateChips gates={ev.gates} />
        <GateNotes gates={ev.gates} />
      </div>

      <NotesList notes={ev.notes} />
      <ChangeDetail change={ev.effectiveChange} />
    </div>
  );
}

/** 单维权重编辑行：滑杆（步进 0.01）+ 数值框（步进 0.001，给平均分配留精度）+ 贡献占比 */
function WeightRow(props: {
  dimKey: MatrixWeightKey;
  label: string;
  desc: string;
  weight: number;
  share: number;
  disabled: boolean;
  onChange: (v: number) => void;
}) {
  const rangeId = "mx-w-" + props.dimKey;
  const numId = "mx-wn-" + props.dimKey;
  const value = clamp01(props.weight);
  return (
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:6px">
      <label for={rangeId} class="dim" style="flex:0 0 92px;font-size:var(--fs-sm)" title={props.desc}>
        {props.label}
      </label>
      <input
        id={rangeId}
        type="range"
        min={RANGE_MIN}
        max={RANGE_MAX}
        step={0.01}
        value={String(value)}
        disabled={props.disabled}
        aria-label={props.label + "权重（0 到 1，步进 0.01）"}
        aria-valuetext={value.toFixed(3)}
        onInput={(e) => props.onChange(Number((e.target as HTMLInputElement).value))}
        style="flex:1 1 140px;min-width:110px;padding:0;accent-color:var(--accent)"
      />
      <label class="dim" style="display:inline-flex;align-items:center;gap:4px;font-size:var(--fs-xs);flex:0 0 auto">
        权重
        <input
          id={numId}
          type="number"
          min={RANGE_MIN}
          max={RANGE_MAX}
          step={0.001}
          value={String(value)}
          disabled={props.disabled}
          aria-label={props.label + "权重数值（0 到 1）"}
          title={props.desc}
          onInput={(e) => props.onChange(Number((e.target as HTMLInputElement).value))}
          style="width:76px"
        />
      </label>
      <span class="mono dim" style="flex:0 0 108px;text-align:right;font-size:var(--fs-xs)">
        {"贡献 " + pct(props.share)}
      </span>
    </div>
  );
}

/** 历史表：时间 / kind / severity / category / 得分 / rawTier→tier；点行展开完整维度与门禁 */
function HistoryTable(props: {
  rows: MatrixEvaluation[];
  dimensions: MatrixDimension[];
  openRows: number[];
  onToggle: (index: number) => void;
}) {
  return (
    <table>
      <thead>
        <tr>
          <th>时间</th>
          <th>类型</th>
          <th>严重度</th>
          <th>分类</th>
          <th class="num">得分</th>
          <th>分档</th>
        </tr>
      </thead>
      {props.rows.map((ev, i) => {
        const open = props.openRows.includes(i);
        const score = (Number(ev.score) || 0).toFixed(3);
        return (
          <tbody key={String(ev.at) + "-" + i}>
            <tr class="click">
              <td>
                {/* 行语义 = 撑满整行的真实按钮（沿用 .row-act 约定），键盘可达、屏读可播报 */}
                <button
                  class="row-act"
                  aria-expanded={open}
                  aria-label={
                    (open ? "收起" : "展开") +
                    TS(ev.at) +
                    " 的评估详情（" +
                    (ev.category || "未分类") +
                    "，得分 " +
                    score +
                    "）"
                  }
                  onClick={() => props.onToggle(i)}
                />
                <span class="mono dim" style="font-size:var(--fs-xs)">
                  {TS(ev.at)}
                </span>
              </td>
              <td class="mono">{ev.kind || "-"}</td>
              <td>
                <SeverityChip severity={ev.severity} />
              </td>
              <td>{ev.category || "-"}</td>
              <td class="mono num">{score}</td>
              <td style="white-space:nowrap">
                {ev.rawTier !== ev.tier ? (
                  <span style="display:inline-flex;gap:5px;align-items:center">
                    <TierChip tier={ev.rawTier} prefix="原" />
                    <span class="dim" aria-hidden="true">
                      →
                    </span>
                    <TierChip tier={ev.tier} />
                  </span>
                ) : (
                  <TierChip tier={ev.tier} />
                )}
              </td>
            </tr>
            {open ? (
              <tr>
                <td colSpan={6} style="background:var(--panel2)">
                  <div style="padding:2px 0 10px">
                    <div class="dim" style="font-size:var(--fs-xs);margin-bottom:2px">
                      六维得分（右列依次：得分 / 权重 / 贡献占比）
                    </div>
                    <ScoreBars scores={ev.dimensions} dimensions={props.dimensions} />
                    <div class="dim" style="font-size:var(--fs-xs);margin:10px 0 4px">
                      四道门禁 G1-G4
                    </div>
                    <GateChips gates={ev.gates} />
                    <GateNotes gates={ev.gates} />
                    <NotesList notes={ev.notes} />
                    <ChangeDetail change={ev.effectiveChange} />
                  </div>
                </td>
              </tr>
            ) : null}
          </tbody>
        );
      })}
    </table>
  );
}

/* ---------------- 主视图 ---------------- */

export function AgentMatrix() {
  const [data, setData] = useState<AgentMatrixView | null>(null);
  const [draft, setDraft] = useState<MatrixConfig | null>(null);
  const [history, setHistory] = useState<MatrixEvaluation[] | null>(null);
  /** Agent 未启用（503 agent_disabled）：配置态，不是故障 */
  const [disabled, setDisabled] = useState(false);
  const [err, setErr] = useState<UiErrorInfo | null>(null);
  /** 保存/重置失败的原地错误条（与 toast 并存：toast 会消失，错误条留到下次成功） */
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  /** 重置的二次确认：第一次点只"上膛"，第二次才发 POST */
  const [resetArmed, setResetArmed] = useState(false);
  const [openRows, setOpenRows] = useState<number[]>([]);
  const [tick, setTick] = useState(0);
  const alive = useRef(true);
  const firstLoad = useRef(true);
  const resetTimer = useRef<number | null>(null);

  /* 拉取：配置 + 最近评估 + 历史。历史失败不阻塞主视图（配置与最新评估仍可操作）。 */
  const load = async () => {
    try {
      const view = await getAgentMatrix();
      if (!alive.current) return;
      setData(view);
      setDraft(toDraft(view.config));
      setDisabled(false);
      setErr(null);
      setOpenRows([]);
      let evs: MatrixEvaluation[] = [];
      try {
        const hist = await getAgentMatrixHistory(HISTORY_LIMIT);
        evs = Array.isArray(hist.evaluations) ? hist.evaluations : [];
      } catch {
        evs = []; /* 历史端点异常不影响配置编辑与最新评估 */
      }
      if (!alive.current) return;
      setHistory(evs);
    } catch (e) {
      if (!alive.current) return;
      setHistory([]);
      if (isAgentDisabled(e)) {
        setDisabled(true);
        setData(null);
        setDraft(null);
        setErr(null);
      } else {
        setErr(classifyUiError(e));
      }
    } finally {
      if (alive.current) {
        setLoading(false);
        firstLoad.current = false;
      }
    }
  };

  useEffect(() => {
    alive.current = true;
    if (firstLoad.current) setLoading(true);
    setSaveErr(null);
    void load();
    return () => {
      alive.current = false;
    };
    // 依赖仅为刷新计数：load 内部只用 setState 与模块常量
  }, [tick]);

  /* 组件卸载时清掉重置"上膛"的定时器，避免卸载后 setState */
  useEffect(
    () => () => {
      if (resetTimer.current != null) clearTimeout(resetTimer.current);
    },
    [],
  );

  const refresh = () => setTick((t) => t + 1);

  const serverDraft = data ? toDraft(data.config) : null;
  const weightSum = draft ? sumWeights(draft.weights) : 0;
  const weightOk = Math.abs(weightSum - 1) <= WEIGHT_SUM_TOLERANCE;
  const acceptOk = draft ? draft.acceptThreshold >= RANGE_MIN && draft.acceptThreshold <= RANGE_MAX : false;
  const queueOk = draft ? draft.queueThreshold >= RANGE_MIN && draft.queueThreshold <= RANGE_MAX : false;
  const orderOk = draft ? draft.queueThreshold < draft.acceptThreshold : false;
  const historyLimitOk = draft
    ? Number.isInteger(draft.historyLimit) && draft.historyLimit >= 1 && draft.historyLimit <= 200
    : false;
  const dirty = !!draft && !!serverDraft && JSON.stringify(draft) !== JSON.stringify(serverDraft);

  /* 校验问题清单：既是按钮禁用的依据，也是给值班人看的具体原因（不靠"保存灰色"猜） */
  const problems: string[] = [];
  if (draft && !weightOk) problems.push("权重合计须为 1.000（当前 " + weightSum.toFixed(3) + "）");
  if (draft && !acceptOk) problems.push("接受阈值须在 0..1 之间");
  if (draft && !queueOk) problems.push("排队阈值须在 0..1 之间");
  if (draft && acceptOk && queueOk && !orderOk) problems.push("排队阈值须小于接受阈值（否则排队区间为空）");
  if (draft && !historyLimitOk) problems.push("历史保留条数须为 1..200 的整数");

  const canSave =
    !!draft && dirty && weightOk && acceptOk && queueOk && orderOk && historyLimitOk && !saving && !resetting;

  const patchDraft = (patch: Partial<MatrixConfig>) =>
    setDraft((cur) => (cur ? { ...cur, ...patch } : cur));

  const setWeight = (key: MatrixWeightKey, v: number) =>
    setDraft((cur) => (cur ? { ...cur, weights: { ...cur.weights, [key]: round3(clamp01(v)) } } : cur));

  /** 平均分配：每维 0.1667（合计 1.0002，在 ±0.001 容差内），避免 0.17×6=1.02 直接非法 */
  const uniformWeights = () => {
    const w = {} as MatrixWeights;
    for (const k of WEIGHT_KEYS) w[k] = UNIFORM_WEIGHT;
    setDraft((cur) => (cur ? { ...cur, weights: { ...w } } : cur));
  };

  const save = async () => {
    if (!canSave || !draft) return;
    setSaving(true);
    setSaveErr(null);
    try {
      const resp = await updateAgentMatrix({
        enabled: draft.enabled,
        weights: draft.weights,
        acceptThreshold: round3(draft.acceptThreshold),
        queueThreshold: round3(draft.queueThreshold),
        historyLimit: draft.historyLimit,
        adaptiveNovelty: draft.adaptiveNovelty,
      });
      toast("决策矩阵配置已保存（权重合计 " + sumWeights(resp.config.weights).toFixed(3) + "）", "g");
      setResetArmed(false);
      await load(); /* 重新 GET：以服务端归一化后的值为准，不做乐观更新 */
    } catch (e) {
      const details = apiDetails(e);
      const text = "保存失败：" + errorMessage(e) + (details.length ? "——" + details.join("；") : "");
      setSaveErr(text);
      const tone = apiStatus(e) === 400 || apiStatus(e) === 409 ? "y" : "r";
      toast(esc(text), tone);
    } finally {
      setSaving(false);
    }
  };

  const doReset = async () => {
    if (resetting || saving) return;
    if (!resetArmed) {
      /* 第一次点击：上膛，6 秒内不确认自动撤销 */
      setResetArmed(true);
      if (resetTimer.current != null) clearTimeout(resetTimer.current);
      resetTimer.current = window.setTimeout(() => setResetArmed(false), 6000);
      return;
    }
    if (resetTimer.current != null) clearTimeout(resetTimer.current);
    setResetting(true);
    setSaveErr(null);
    try {
      const resp = await resetAgentMatrix();
      toast("已恢复默认配置（权重合计 " + sumWeights(resp.config.weights).toFixed(3) + "）", "g");
      setResetArmed(false);
      await load();
    } catch (e) {
      const details = apiDetails(e);
      const text = "重置失败：" + errorMessage(e) + (details.length ? "——" + details.join("；") : "");
      setSaveErr(text);
      const tone = apiStatus(e) === 400 || apiStatus(e) === 409 ? "y" : "r";
      toast(esc(text), tone);
      setResetArmed(false);
    } finally {
      setResetting(false);
    }
  };

  const toggleRow = (index: number) =>
    setOpenRows((prev) => (prev.includes(index) ? prev.filter((x) => x !== index) : [...prev, index]));

  /* ---------------- 状态分支：骨架 / 未启用 / 加载失败 ---------------- */

  if (loading && !data && !disabled && !err) {
    return (
      <div>
        <div class="skel" style="height:56px;margin-bottom:12px" />
        <section class="block">
          <div class="skel" style="height:96px" />
        </section>
        <section class="block">
          <div class="skel" style="height:180px" />
        </section>
      </div>
    );
  }

  if (disabled) {
    return (
      <div>
        <div class="note">
          <b>决策矩阵（确定性仲裁）。</b>把 Agent 的每条建议按六维加权打分，再过 G1-G4 四道门禁，裁定进入接受 /
          排队 / 拒绝。
        </div>
        <section class="block">
          <h2>
            决策矩阵 <span class="spacer" />
            <button class="bare" onClick={refresh} aria-label="刷新决策矩阵数据" title="重新拉取">
              ↻
            </button>
          </h2>
          <Empty
            icon="⚙"
            msg="内部 Agent 未启用，决策矩阵暂不可用（agent_disabled）"
            hint="在配置里把 agent.enabled 设为 true（即 config.agent.enabled），并配好 agent.clientId 与 agent.model 后重启网关；矩阵只在 Agent 产出决策时才写入评估记录。"
          />
        </section>
      </div>
    );
  }

  if (err) {
    return (
      <div>
        <div class="note">
          <b>决策矩阵（确定性仲裁）。</b>把 Agent 的每条建议按六维加权打分，再过 G1-G4 四道门禁，裁定进入接受 /
          排队 / 拒绝。
        </div>
        <section class="block">
          <h2>
            决策矩阵 <span class="spacer" />
            <button class="bare" onClick={refresh} aria-label="刷新决策矩阵数据" title="重新拉取">
              ↻
            </button>
          </h2>
          <div class="note bad">
            <b>{err.icon + " " + err.title}</b>
            <div style="margin-top:4px">{err.hint}</div>
            {!err.retriable ? (
              <div style="margin-top:4px">这是面板/网关自身的错误，自动重试不会让它自愈；请把上面的原文上报。</div>
            ) : (
              <div style="margin-top:4px">本页不做定时轮询：点下方「重试」或顶栏 ↻ 重新拉取。</div>
            )}
            <div style="margin-top:var(--s2)">
              <button onClick={refresh}>重试</button>
            </div>
          </div>
        </section>
      </div>
    );
  }

  if (!data || !draft) return null;

  const stats: MatrixStats = data.stats || EMPTY_STATS;
  const dimensions = data.dimensions || [];
  const top = stats.topRejected || [];
  const topMax = top.reduce((m, t) => Math.max(m, Number(t.count) || 0), 0);
  const shareOf = (n: number) => (stats.total > 0 ? pct(n / stats.total) : "—");

  return (
    <div>
      <div class="note">
        <b>决策矩阵（确定性仲裁）。</b>把 Agent 的每条建议按六维加权打分，再过 G1-G4 四道门禁，裁定进入接受 / 排队 /
        拒绝。分数与门禁只做准入判定，不执行变更；被拒绝的受控变更会在仲裁时被剥离。
      </div>

      {/* 顶层 enabled 只表示"矩阵能力可用"（Agent 已启用）；真正决定是否介入仲裁的是 config.enabled */}
      {!data.config.enabled ? (
        <div class="note warn">
          <b>矩阵当前未启用（config.enabled = false）。</b>Agent 仍会产出决策，但不经矩阵仲裁；下面的历史与"最近一次评估"是启用期间的记录。改开关后点「保存配置」即刻生效。
        </div>
      ) : null}

      {/* ---------------- KPI ---------------- */}
      <section class="block">
        <h2>
          判定概览 <span class="spacer" />
          <button class="bare" onClick={refresh} aria-label="刷新决策矩阵数据" title="重新拉取配置 / 最近评估 / 历史">
            ↻
          </button>
        </h2>
        <div class="grid cards" style="grid-template-columns:repeat(auto-fit,minmax(190px,1fr))">
          <Tile
            k="评估总数"
            v={formatNumber(stats.total)}
            sub={"统计窗口：后端内存环形缓冲（historyLimit " + formatNumber(data.config.historyLimit) + "）"}
          />
          <Tile
            k="平均分"
            v={stats.total ? (Number(stats.avgScore) || 0).toFixed(3) : "—"}
            sub="已评估记录的综合得分均值"
          />
          <Tile k="接受" v={<span class="ok">{formatNumber(stats.accept)}</span>} sub={"占已评估 " + shareOf(stats.accept)} />
          <Tile k="排队" v={<span class="warn">{formatNumber(stats.queue)}</span>} sub={"占已评估 " + shareOf(stats.queue)} />
          <Tile k="拒绝" v={<span class="err">{formatNumber(stats.reject)}</span>} sub={"占已评估 " + shareOf(stats.reject)} />
        </div>
      </section>

      {/* ---------------- 被拒组合 Top ---------------- */}
      <section class="block">
        <h2>
          最常被拒组合 <span class="spacer" />
          <span class="muted-xs" style="text-transform:none">按 category 聚合，条长按最大值归一</span>
        </h2>
        {top.length ? (
          top.map((t) => (
            <HBar
              key={t.category}
              b={{ nm: t.category || "未分类", val: Number(t.count) || 0, txt: formatNumber(t.count) + " 次" }}
              max={topMax}
              tone="r"
            />
          ))
        ) : (
          <div class="muted-sm">
            暂无被拒记录
          </div>
        )}
      </section>

      {/* ---------------- 最近一次评估 ---------------- */}
      <section class="block">
        <h2>
          最近一次评估 <span class="spacer" />
          <span class="muted-xs" style="text-transform:none">六维得分 + G1-G4 门禁</span>
        </h2>
        {data.last ? (
          <EvaluationCard ev={data.last} dimensions={dimensions} />
        ) : (
          <Empty
            icon="◌"
            msg="尚无评估记录"
            hint="矩阵在 Agent 每轮产出决策后写入；去「Agent」页点「立即跑一轮」即可产生第一条。"
          />
        )}
      </section>

      {/* ---------------- 权重编辑 ---------------- */}
      <section class="block">
        <h2>
          六维权重 <span class="spacer" />
          <button class="bare" onClick={uniformWeights} disabled={saving || resetting} title="六维各 0.1667（合计 1.0002，在 ±0.001 容差内）">
            平均分配
          </button>
        </h2>
        <div class="dim" style="font-size:var(--fs-xs);margin-bottom:8px">
          滑杆步进 0.01、数值框步进 0.001；贡献占比 = 本维权重 ÷ 权重合计，随编辑实时变化。
        </div>
        {WEIGHT_KEYS.map((k) => (
          <WeightRow
            key={k}
            dimKey={k}
            label={labelFor(k, dimensions)}
            desc={descFor(k, dimensions)}
            weight={draft.weights[k]}
            share={weightSum > 0 ? draft.weights[k] / weightSum : 0}
            disabled={saving || resetting}
            onChange={(v) => setWeight(k, v)}
          />
        ))}
        <div class={"note" + (weightOk ? "" : " bad")} style="margin:10px 0 0" role="status" aria-live="polite">
          {weightOk
            ? "权重合计 " + weightSum.toFixed(3) + " ✔（与 1 的偏差须 ≤ " + WEIGHT_SUM_TOLERANCE.toFixed(3) + "）"
            : "权重合计须为 1.000（当前 " + weightSum.toFixed(3) + "）"}
        </div>
      </section>

      {/* ---------------- 阈值与开关 ---------------- */}
      <section class="block">
        <h2>分档阈值与开关</h2>
        <div class="f">
          <label for="mx-accept">接受阈值（得分 ≥ 该值进入接受）</label>
          <input
            id="mx-accept"
            type="number"
            min={RANGE_MIN}
            max={RANGE_MAX}
            step={0.01}
            value={String(draft.acceptThreshold)}
            disabled={saving || resetting}
            aria-label="接受阈值（0 到 1，步进 0.01）"
            onInput={(e) => patchDraft({ acceptThreshold: clamp01(Number((e.target as HTMLInputElement).value)) })}
            style="max-width:180px"
          />
          <label for="mx-queue">排队阈值（得分 ≥ 该值进入排队）</label>
          <input
            id="mx-queue"
            type="number"
            min={RANGE_MIN}
            max={RANGE_MAX}
            step={0.01}
            value={String(draft.queueThreshold)}
            disabled={saving || resetting}
            aria-label="排队阈值（0 到 1，步进 0.01）"
            onInput={(e) => patchDraft({ queueThreshold: clamp01(Number((e.target as HTMLInputElement).value)) })}
            style="max-width:180px"
          />
          <label for="mx-limit">历史保留条数（1..200）</label>
          <input
            id="mx-limit"
            type="number"
            min={1}
            max={200}
            step={1}
            value={String(draft.historyLimit)}
            disabled={saving || resetting}
            aria-label="历史保留条数（1 到 200 的整数）"
            onInput={(e) => patchDraft({ historyLimit: Math.round(Number((e.target as HTMLInputElement).value)) })}
            style="max-width:180px"
          />
          <label for="mx-enabled">启用决策矩阵</label>
          <label class="sub" style="display:inline-flex;align-items:center;gap:var(--s2);color:var(--fg)">
            <input
              id="mx-enabled"
              type="checkbox"
              checked={draft.enabled}
              disabled={saving || resetting}
              onChange={(e) => patchDraft({ enabled: (e.target as HTMLInputElement).checked })}
            />
            <span class="muted-sm">关闭后 Agent 决策不经矩阵仲裁</span>
          </label>
          <label for="mx-adaptive">自适应新颖度降权</label>
          <label class="sub" style="display:inline-flex;align-items:center;gap:var(--s2);color:var(--fg)">
            <input
              id="mx-adaptive"
              type="checkbox"
              checked={draft.adaptiveNovelty}
              disabled={saving || resetting}
              onChange={(e) => patchDraft({ adaptiveNovelty: (e.target as HTMLInputElement).checked })}
            />
            <span class="muted-sm">重复建议的 novelty 维自动降权</span>
          </label>
        </div>
        <div class="dim" style="font-size:var(--fs-xs);margin-top:4px">
          区间口径：得分 ≥ 接受阈值 → 接受；≥ 排队阈值 → 排队；其余 → 拒绝。阈值顺序反了会让排队区间为空。
        </div>

        {problems.length ? (
          <div class="note bad" style="margin-top:var(--s3)" role="alert">
            <b>暂不能保存：</b>
            {problems.map((p, i) => (
              <div key={i} style="margin-top:2px">
                {"· " + p}
              </div>
            ))}
          </div>
        ) : null}

        {saveErr ? (
          <div class="note bad" style="margin-top:var(--s3)" role="alert">
            <b>服务端拒绝了这次写入：</b>
            <div style="margin-top:2px">{saveErr}</div>
            <div style="margin-top:4px">上面的编辑内容仍保留，按提示修改后再保存（页面不会假装已生效）。</div>
          </div>
        ) : null}

        <div class="row" style="margin-top:12px;gap:var(--s2);align-items:center">
          <button class="pri" disabled={!canSave} onClick={save} aria-describedby="mx-save-state">
            {saving ? "保存中…" : "保存配置"}
          </button>
          <button
            class={resetArmed ? "danger" : ""}
            disabled={saving || resetting}
            onClick={doReset}
            title="恢复后端内置默认权重/阈值/开关"
          >
            {resetting ? "重置中…" : resetArmed ? "确认重置为默认" : "重置为默认"}
          </button>
          {resetArmed ? (
            <button class="bare" onClick={() => setResetArmed(false)}>
              取消
            </button>
          ) : null}
          <span class="dim" id="mx-save-state" style="font-size:var(--fs-xs)" role="status" aria-live="polite">
            {saving
              ? "正在写入服务端…"
              : resetting
                ? "正在恢复默认…"
                : dirty
                  ? canSave
                    ? "有未保存的修改"
                    : "存在校验问题，暂不能保存"
                  : "配置与服务端一致"}
          </span>
          {resetArmed ? (
            <span class="muted-xs" role="status" aria-live="polite">
              再次点击将覆盖全部自定义配置（6 秒内不确认自动撤销）
            </span>
          ) : null}
        </div>
      </section>

      {/* ---------------- 历史 ---------------- */}
      <section class="block">
        <h2>
          评估历史 <span class="spacer" />
          <span class="muted-xs" style="text-transform:none">
            {"最近 " + HISTORY_LIMIT + " 条 · 点行展开维度与门禁"}
          </span>
        </h2>
        {history === null ? (
          <div class="skel" style="height:180px" />
        ) : history.length ? (
          <HistoryTable rows={history} dimensions={dimensions} openRows={openRows} onToggle={toggleRow} />
        ) : (
          <Empty icon="▤" msg="暂无历史评估" hint="第一轮 Agent 决策经矩阵仲裁后，这里会出现记录。" />
        )}
      </section>
    </div>
  );
}