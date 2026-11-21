export interface Overall {
  requests: number;
  errors: number;
  errorRate: number;
  totalTokens: number;
  costCny: number;
  listCostCny?: number;
  p95Ms: number;
  avgTtfbMs: number;
}

export interface LossReduction {
  attributionCoverage: number;
  autoRecovered: number;
  duplicateRetries: number;
  precheckBlocked: number;
  precheckDegraded: number;
  overheadRatio: number;
}

export interface Bucket {
  nm: string;
  val: number;
  txt: string;
}

export interface FailureReasonRow {
  reason: string;
  count: number;
  recoverablePct: number;
}

export interface QuickActionRow {
  action: string;
  count: number;
}

export interface TierRow {
  key: string;
  requests: number;
  errorRate: number;
  totalTokens: number;
  costCny: number;
}

export interface ProviderRow extends TierRow {
  errors: number;
}

export interface ClientKindRow extends TierRow {
  p95Ms: number;
}

export interface Summary {
  overall: Overall;
  lossReduction: LossReduction;
  byFailureReason?: FailureReasonRow[];
  byQuickAction?: QuickActionRow[];
  byTier?: TierRow[];
  byClientKind?: ClientKindRow[];
  byProvider?: ProviderRow[];
  byModel?: (TierRow & { errors?: number })[];
  clientAuthFailures?: { count: number };
}

export interface ProviderSlim {
  id: string;
  label?: string;
  disabled?: boolean;
  breakerOpen?: boolean;
}

export interface SeriesPoint {
  ts: number;
  requests: number;
  errors: number;
  tokens: number;
  costCny: number;
  avgDurationMs: number;
}

export interface OverviewResp {
  windowLabel?: string;
  summary: Summary;
  providers: ProviderSlim[];
  tiers?: Record<string, { label: string; precheck: string; attribution: string; rpm: number; maxConcurrency: number }>;
  overheadUs: { precheck: number; classify: number };
}

export interface SeriesResp {
  points?: SeriesPoint[];
}

export interface KbInfo {
  stats?: { docs?: number; chunks?: number };
}

export interface KbState {
  enabled?: boolean;
  kbs?: KbInfo[];
  config?: { path: string; chunkSize: number; chunkOverlap: number };
}

export interface AgentRun {
  startedAt: number;
  trigger?: string;
  fromEvent?: boolean;
  decision?: { kind?: string; summary?: string };
}

export interface AgentState {
  enabled?: boolean;
  status?: {
    enabled?: boolean;
    running?: boolean;
    model?: string;
    runCount?: number;
    intervalMs?: number;
    lastRun?: AgentRun;
  };
  runs?: AgentRun[];
}

export interface KeySlim {
  id: string;
  label?: string;
  enabled?: boolean;
  hashPrefix?: string;
  expiresAt?: number | null;
  usage?: {
    quotaUsedPct?: number | null;
    quotaCnyUsedPct?: number | null;
  };
}

export interface KeyStateInfo {
  expired: boolean;
  expDays: number | null;
  expiringSoon: boolean;
  usedUp: boolean;
  nearLimit: boolean;
  attention: boolean;
}

/* ============ 指标（met） ============ */

export interface MetricsResp {
  counters?: Record<string, number>;
  summaries?: Record<string, { count: number; avg: number; min: number; max: number }>;
  derived?: Record<string, number>;
  classCounters?: Record<string, number>;
  uptimeS?: number;
  zeroTokenCount?: number;
  nameNote?: string;
  store?: {
    driver?: string; ok?: boolean; pendingWrites?: number; degradedEvents?: number; lastFlushAt?: number;
  };
}

export interface HealthResp {
  server?: { inflight?: number; requestCount?: number };
  adminAuth?: { total?: number };
  providers?: { total?: number; disabled?: number; breakerOpen?: number };
}

/* ============ 客户 Key（users） ============ */

export interface KeyFull {
  id: string;
  label?: string;
  tier: string;
  origin?: string;
  enabled?: boolean;
  hashPrefix?: string;
  expiresAt?: number | null;
  deletable?: boolean;
  allowedModels?: string[];
  quotaOverride?: number | null;
  quotaCnyOverride?: number | null;
  concurrency?: { active?: number };
  policy?: {
    rpm?: number | null; maxConcurrency?: number | null;
    periodQuotaTokens?: number | null; periodQuotaCny?: number | null;
  };
  usage?: {
    tokens?: number; requests?: number; costCny?: number; quota?: number | null;
    quotaUsedPct?: number | null; quotaCny?: number | null; quotaCnyUsedPct?: number | null;
  };
}

export interface AuthFailureGroup {
  fingerprint?: string;
  code: string;
  count: number;
  firstAt?: number;
  lastAt?: number;
  matchesIssuedKey?: boolean;
  headerForm?: string;
}

export interface KeysResp {
  keys: KeyFull[];
  authFailures?: { total?: number; distinct?: number; groups?: AuthFailureGroup[] };
}

export interface AuthPolicyTier {
  label?: string; precheck?: string; attribution?: string; rpm?: number;
  maxConcurrency?: number; billing?: string;
  periodQuotaTokens?: number | null; periodQuotaCny?: number | null; smartRouting?: boolean;
}

export interface AuthPolicyResp {
  tiers?: Record<string, AuthPolicyTier>;
  activeKeys?: number; keyCount?: number; quotaPeriodMs?: number; note?: string;
}

export interface WhoamiResp {
  status: string;
  fingerprint?: string;
  key?: KeyFull;
  explanation?: string;
}

/* ============ 上游（ch） ============ */

export interface ProviderKeyPoolItem {
  index: number; masked: string; dead?: boolean; cooldownMsLeft?: number; failures?: number;
}

export interface ProviderFull {
  id: string; label?: string; protocol?: string; baseUrl?: string; disabled?: boolean;
  models?: string[]; tags?: string[]; priority?: number; weight?: number; http2?: boolean;
  apiKeyMasked?: string;
  keyPool?: ProviderKeyPoolItem[];
  concurrency?: { active?: number; limit?: number; waiting?: number };
  health?: {
    healthy?: boolean; openUntil?: number; consecutiveFailures?: number;
    ewmaLatencyMs?: number; totalFailures?: number; totalRequests?: number; lastFailureReason?: string;
  };
  cost?: { inputPerMTok?: number; outputPerMTok?: number; cachedInputPerMTok?: number };
  listCost?: { inputPerMTok?: number; outputPerMTok?: number; cachedInputPerMTok?: number };
  modelCosts?: Record<string, { inputPerMTok: number; outputPerMTok: number }>;
  modelListCosts?: Record<string, { inputPerMTok: number; outputPerMTok: number }>;
}

export interface ProvidersResp {
  providers: ProviderFull[];
  reachability?: { model: string; providers: string[]; tools?: boolean }[];
}

/* ============ 请求账本（ledger） ============ */

export interface TraceSlim {
  traceId: string; requestId: string; startedAt: number; outcome: string;
  durationMs?: number; failedAtStage?: string; stepCount?: number; degraded?: boolean; model?: string;
}

export interface TraceStep {
  stage: string; summary?: string; ok?: boolean; offsetMs?: number; error?: string; detail?: unknown;
}

export interface TraceDetail extends TraceSlim {
  steps?: TraceStep[];
}

export interface TraceDiff {
  sameOutcome?: boolean; durationDeltaMs?: number; traceA?: string; traceB?: string;
  diverged?: { stage: string; a: string; aOk: boolean; b: string; bOk: boolean }[];
  onlyInA?: string[]; onlyInB?: string[];
}

/* ============ 排障（diag） ============ */

export interface AdminEvent {
  ts: number; kind: string; level?: string; brief?: string; detail?: any; actor?: string | null;
}

export interface AuthFailuresResp {
  total?: number; distinct?: number;
  groups?: AuthFailureGroup[];
  byCode?: { code: string; count: number }[];
  recent?: { at: number; code: string; path?: string; headerForm?: string; keyLength?: number }[];
}

export interface CatalogResp {
  description?: string;
  delivery?: { full?: string; header?: string; off?: string };
  failure_reasons?: { reason: string; "中文"?: string; recoverable?: boolean; action?: string }[];
  precheck?: { description?: string; fail_open?: string };
}

export interface TopErrorsResp {
  errors?: { reason: string; count: number; example?: string }[];
  coveredSince?: number;
}

/* ============ 运维（ops） ============ */

export interface ConfigResp {
  sourcePath?: string;
  server?: {
    host?: string; port?: number; upstreamTtfbTimeoutMs?: number; upstreamTimeoutMs?: number;
    upstreamStallTimeoutMs?: number; maxBodyBytes?: number; shutdownGraceMs?: number;
    adminTokenSet?: boolean; trustProxy?: boolean; publicQuota?: boolean; publicQuotaRemote?: boolean;
  };
  storage?: { driver?: string; path?: string };
  logLevel?: string;
  modelLadders?: Record<string, string[]>;
  modelAliases?: Record<string, string[]>;
  clients?: { id: string; label?: string; key?: string; tier?: string; tenantId?: string; enabled?: boolean }[];
}

export interface LossReductionResp {
  precheck?: { enabled?: boolean; maxMessages?: number; maxTools?: number; onBlock?: string };
  attribution?: { enabled?: boolean; includeEvidence?: boolean; siblingModelFallback?: boolean; autoRetry?: number };
  meter?: { enabled?: boolean; retentionDays?: number | null };
  trace?: { enabled?: boolean };
  fingerprint?: { enabled?: boolean; agentThreshold?: number };
}

export interface EvolutionResp {
  candidates?: { id: string; label: string }[];
  setting?: { next?: string; note?: string; updatedAt?: number; updatedBy?: string } | null;
}

/* ============ 知识库（kb） ============ */

export interface KbFull {
  id: string; name: string; description?: string; allowedKeys?: string; owner?: string;
  createdAt?: number;
  stats?: { docs?: number; chunks?: number; bytes?: number };
}

export interface KbStateFull {
  enabled?: boolean;
  kbs?: KbFull[];
  config?: { path: string; chunkSize: number; chunkOverlap: number };
  health?: unknown;
}

export interface KbDoc {
  id: string | number; title: string; source?: string; content?: string; chunkCount?: number; createdAt?: number;
}

export interface KbSearchHit {
  seq: number; docId: string | number; docTitle: string; score: number; text: string;
}

/* ============ Agent ============ */

export interface AgentDecision {
  kind?: string; summary?: string; recommendation?: string; evidence?: string[];
  confidence?: number; kbNote?: { title?: string; content?: string };
}

export interface AgentRunFull {
  startedAt: number; trigger?: string; durationMs?: number; promptTokens?: number; completionTokens?: number;
  model?: string; fromEvent?: boolean; error?: string; decision?: AgentDecision;
}

export interface AgentStateFull {
  enabled?: boolean;
  status?: {
    enabled?: boolean; model?: string; clientId?: string; intervalMs?: number | null;
    kbId?: string; autoWriteKb?: boolean; running?: boolean; runCount?: number; baseUrl?: string;
  };
}

/* ============ 内部 Agent 决策矩阵（matrix） ============
 * 字段名与后端契约逐字一致（全 camelCase）；分数与阈值统一为 0..1 的比例值，
 * 展示层再做百分比换算，避免前端出现"0-100 还是 0-1"的第二套口径。 */

/** 六维权重的键名（与后端 weights 对象的键一一对应） */
export type MatrixWeightKey = "impact" | "confidence" | "evidence" | "risk" | "effort" | "novelty";

/** 六维权重：每维 0..1，六维合计须为 1.000 */
export type MatrixWeights = Record<MatrixWeightKey, number>;

/** 仲裁分档：接受 / 排队 / 拒绝 */
export type MatrixTier = "accept" | "queue" | "reject";

/** 门禁编号（G1-G4 确定性四门） */
export type MatrixGateId = "G1" | "G2" | "G3" | "G4";

/** 矩阵配置（PUT 体即本对象的子集） */
export interface MatrixConfig {
  enabled: boolean;
  weights: MatrixWeights;
  acceptThreshold: number;
  queueThreshold: number;
  historyLimit: number;
  adaptiveNovelty: boolean;
}

/** 维度定义（后端下发的展示口径，label/description 直接用于 UI） */
export interface MatrixDimension {
  key: string;
  label: string;
  description: string;
  weight: number;
}

/** 单维得分（value 与 contribution 同列展示） */
export interface MatrixDimensionScore {
  key: string;
  value: number;
  weight: number;
  contribution: number;
}

/** 门禁结果 */
export interface MatrixGate {
  id: MatrixGateId;
  passed: boolean;
  note: string;
}

/** 受控变更明细（仅非 reject 分档保留；reject 时后端已剥离） */
export interface MatrixEffectiveChange {
  target: string;
  payload: unknown;
  impact: string;
  rollback: string;
  risk: string;
}

/** 一次矩阵评估 */
export interface MatrixEvaluation {
  schemaVersion: 1;
  at: number;
  kind: string;
  severity: "info" | "warn" | "critical";
  category: string;
  rawTier: MatrixTier;
  tier: MatrixTier;
  score: number;
  dimensions: MatrixDimensionScore[];
  gates: MatrixGate[];
  notes: string[];
  effectiveChange?: MatrixEffectiveChange;
}

/** 被拒组合（category + 次数） */
export interface MatrixTopRejected {
  category: string;
  count: number;
}

/** 矩阵统计（GET /matrix 与 GET /matrix/history 同形） */
export interface MatrixStats {
  total: number;
  accept: number;
  queue: number;
  reject: number;
  avgScore: number;
  topRejected: MatrixTopRejected[];
}

/** GET /admin/api/agent/matrix */
export interface AgentMatrixView {
  enabled: boolean;
  config: MatrixConfig;
  dimensions: MatrixDimension[];
  last: MatrixEvaluation | null;
  stats: MatrixStats;
}

/** GET /admin/api/agent/matrix/history?limit=N */
export interface MatrixHistoryResp {
  evaluations: MatrixEvaluation[];
  stats: MatrixStats;
}

/** PUT /admin/api/agent/matrix 与 POST /admin/api/agent/matrix/reset 的成功体 */
export interface MatrixConfigResp {
  ok: boolean;
  config: MatrixConfig;
}
