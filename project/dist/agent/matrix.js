/**
 * Agent 决策矩阵（Decision Matrix）：把"一句建议 + 一个置信度"变成**可复算的仲裁结果**。
 *
 * 为什么需要它（现状缺口）：
 *   v2 的 Agent 每轮只产出一个 AgentDecision，跑不跑、动不动作全凭 kind/severity 的字面判断。
 *   同一类问题被反复提出（"老问题没修"）时，面板只能看到一堆等价建议，无法区分
 *   「这次值得执行 / 值得排队等人工确认 / 应当驳回」。矩阵把决策拆成 6 个可解释维度
 *   做加权打分，再用 accept/queue/reject 三档 + 四道原创门（G1-G4）收口，
 *   使"为什么采纳/为什么驳回"在审计事件里可以逐项复算。
 *
 * 设计取舍：
 *   - **纯函数为主**：evaluateDecision 不读时间以外的外部状态、不写任何存储，
 *     相同 (decision, config, history) 必然得到相同结果，便于回溯与单测。
 *   - **零新依赖**：只做算术与数组聚合，不引入任何第三方库。
 *   - **risk / effort 是"越高越有利"的方向分**：低风险=高分、低投入=高分，
 *     否则加权求和时会出现"风险越高分越高"的符号错误。
 *   - 权重在 normalize 时归一化到和为 1，使 score 恒落在 0..1，
 *     与 accept/queue 阈值同口径（否则运营改一组相对权重就能悄悄平移阈值）。
 *
 * 安全不变量（单测必须覆盖，改动本文件前先读这一段）：
 *   1. tier === 'reject' 时 effectiveChange **必须是 undefined**——驳回的决策不携带
 *      可执行动作，避免下游把"被驳回的建议"当成待执行清单。
 *   2. 不原地修改传入的 decision：所有打分基于浅/深克隆的只读快照，
 *      runner 后续落事件、写记忆时依赖原始对象不变。
 *   3. 矩阵**只仲裁不扩权**：只会把档位往下压（accept→queue→reject）或剥离动作，
 *      永远不会把 reject/queue 提升为 accept，也不会改写 payload / 扩大目标白名单。
 *      四门任一不通过即强制降档，且保留 rawTier 供复盘。
 */
export const DIMENSIONS = [
    {
        key: 'impact',
        label: '影响面',
        description: '问题有多严重：severity info=0.4 / warn=0.7 / critical=1.0；kind=none 时再乘 0.5（没有动作的问题按信息处理）',
    },
    {
        key: 'confidence',
        label: '置信度',
        description: 'Agent 自评把握（decision.confidence 钳制到 0..1）',
    },
    {
        key: 'evidence',
        label: '证据强度',
        description: '取证条数：0 条=0 / 1 条=0.4 / 2 条=0.7 / ≥3 条=1.0（空串不算证据）',
    },
    {
        key: 'risk',
        label: '安全性',
        description: '动作风险的反向分（低风险=高分）：low=1.0 / medium=0.6 / high=0.2；无 proposedChange=0.8',
    },
    {
        key: 'effort',
        label: '可执行性',
        description: '落地成本的反向分（越省事越高）：provider.disable=0.6 / tier.precheck=0.8 / agent.interval=0.9 / client.quota=0.6；无 proposedChange=0.7',
    },
    {
        key: 'novelty',
        label: '新颖度',
        description: '是否重复已知问题：同 category+target 出现过（未驳回）=0.2 / 被驳回 ≥2 次=0.1 / 否则=1.0；adaptiveNovelty=false 时恒为 1.0',
    },
];
/**
 * 默认矩阵：权重合计 1.0，accept 0.70 / queue 0.45。
 *
 * 取值理由：impact 与 confidence 合计占 55%（决策价值主要看"这事有多大 + 你有多大把握"），
 * 安全性与证据各占 20%/15%（Agent 的动作必须可回滚、有依据），
 * 投入与新意只占 5%（参考项，不该主导结论）。
 * enabled 默认 **false**：未显式开启时 runner 完全不介入，存量部署零行为变化。
 */
export const DEFAULT_MATRIX_CONFIG = {
    enabled: false,
    weights: { impact: 0.3, confidence: 0.25, evidence: 0.15, risk: 0.2, effort: 0.05, novelty: 0.05 },
    acceptThreshold: 0.7,
    queueThreshold: 0.45,
    historyLimit: 50,
    adaptiveNovelty: true,
};
/** historyLimit 合法区间（内存 ring 太小看不出趋势，太大占内存且稀释统计） */
const HISTORY_LIMIT_MIN = 1;
const HISTORY_LIMIT_MAX = 500;
/** 四门（G1-G4）的 id 与中文名，供面板与事件直读 */
export const GATE_LABELS = {
    G1: '复用门',
    G2: '增量门',
    G3: '收益门',
    G4: '回归门',
};
/**
 * 受控动作白名单——与 runner.ts 的 PROPOSED_CHANGE_TARGETS **必须一致**。
 *
 * 这里本地声明而不是 import 那个常量，是为了避免 runner ↔ matrix 的**运行时**循环依赖
 * （runner 需要 import 本模块的 evaluateDecision 等函数）。类型上仍用 ProposedChange['target']
 * 约束，任何一边漏改都会在 typecheck 阶段报错，不会静默放过。
 */
const TARGET_WHITELIST = [
    'provider.disable',
    'tier.precheck',
    'agent.interval',
    'client.quota',
];
/* ------------------------------------------------------------------ *
 * 数值工具
 * ------------------------------------------------------------------ */
function clamp01(v) {
    if (!Number.isFinite(v))
        return 0;
    return v < 0 ? 0 : v > 1 ? 1 : v;
}
/** 保留 3 位小数（矩阵对外所有分值统一 3 位，便于面板展示与断言） */
function round3(v) {
    return Math.round(v * 1000) / 1000;
}
function numInRange(v, fallback, lo, hi) {
    if (typeof v !== 'number' || !Number.isFinite(v))
        return fallback;
    return v < lo ? lo : v > hi ? hi : v;
}
function intInRange(v, fallback, lo, hi) {
    if (typeof v !== 'number' || !Number.isFinite(v))
        return fallback;
    const n = Math.trunc(v);
    return n < lo ? lo : n > hi ? hi : n;
}
/* ------------------------------------------------------------------ *
 * 配置规范化与校验
 * ------------------------------------------------------------------ */
/**
 * 把（可能残缺、可能来自 YAML 的）配置补成完整值。
 *
 * 关键点：weights 视作**相对权重**——补齐缺省维度后按合计重新归一化，
 * 这样运营只改一个维度也能得到稳定的 0..1 分数，而不用手工凑满 1。
 */
export function normalizeMatrixConfig(partial) {
    const p = partial ?? {};
    const weights = { ...DEFAULT_MATRIX_CONFIG.weights };
    if (p.weights) {
        for (const dim of DIMENSIONS) {
            const v = p.weights[dim.key];
            if (typeof v === 'number' && Number.isFinite(v))
                weights[dim.key] = clamp01(v);
        }
        const sum = DIMENSIONS.reduce((n, dim) => n + weights[dim.key], 0);
        if (sum > 0 && Math.abs(sum - 1) > 1e-9) {
            // 归一化后再取 6 位小数：既保留相对比例，又避免浮点尾数污染 score
            for (const dim of DIMENSIONS)
                weights[dim.key] = Math.round((weights[dim.key] / sum) * 1e6) / 1e6;
        }
    }
    return {
        // 只有显式 true 才算开启：YAML 写成 "yes"/1 等非布尔值时按关闭处理（宁可不介入）
        enabled: p.enabled === true,
        weights,
        acceptThreshold: numInRange(p.acceptThreshold, DEFAULT_MATRIX_CONFIG.acceptThreshold, 0, 1),
        queueThreshold: numInRange(p.queueThreshold, DEFAULT_MATRIX_CONFIG.queueThreshold, 0, 1),
        historyLimit: intInRange(p.historyLimit, DEFAULT_MATRIX_CONFIG.historyLimit, HISTORY_LIMIT_MIN, HISTORY_LIMIT_MAX),
        adaptiveNovelty: p.adaptiveNovelty !== false,
    };
}
const KNOWN_KEYS = ['enabled', 'weights', 'acceptThreshold', 'queueThreshold', 'historyLimit', 'adaptiveNovelty'];
/**
 * 校验原始配置（入参用 unknown：它多半直接来自 YAML，形状不受 TS 约束）。
 *
 * 与仓库既有风格一致：**不静默吞**——拼错的字段名、越界阈值都报中文错误，
 * 由 config.ts 的 inspectConfig 汇总成 `配置校验失败: ...` 抛出。
 */
export function validateMatrixConfig(raw) {
    const errors = [];
    if (raw === undefined || raw === null)
        return { ok: true, errors };
    if (typeof raw !== 'object' || Array.isArray(raw)) {
        return { ok: false, errors: [`decisionMatrix 必须是对象，当前值: ${JSON.stringify(raw)}`] };
    }
    const o = raw;
    for (const k of Object.keys(o)) {
        if (!KNOWN_KEYS.includes(k)) {
            errors.push(`含未知字段 "${k}"（可用：${KNOWN_KEYS.join(' / ')}）`);
        }
    }
    if (o['enabled'] !== undefined && typeof o['enabled'] !== 'boolean') {
        errors.push(`enabled 必须是布尔值，当前值: ${JSON.stringify(o['enabled'])}`);
    }
    if (o['adaptiveNovelty'] !== undefined && typeof o['adaptiveNovelty'] !== 'boolean') {
        errors.push(`adaptiveNovelty 必须是布尔值，当前值: ${JSON.stringify(o['adaptiveNovelty'])}`);
    }
    if (o['weights'] !== undefined && o['weights'] !== null) {
        const w = o['weights'];
        if (typeof w !== 'object' || Array.isArray(w)) {
            errors.push('weights 必须是对象（键为维度名，值为 0..1）');
        }
        else {
            const wo = w;
            const knownDims = DIMENSIONS.map((d) => d.key);
            let sum = 0;
            let sawAny = false;
            for (const [k, v] of Object.entries(wo)) {
                if (!knownDims.includes(k)) {
                    errors.push(`weights 含未知维度 "${k}"（可用：${knownDims.join(' / ')}）`);
                    continue;
                }
                if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) {
                    errors.push(`weights.${k} 必须是 0..1 之间的数字，当前值: ${JSON.stringify(v)}`);
                    continue;
                }
                sum += v;
                sawAny = true;
            }
            if (sawAny && sum <= 0)
                errors.push('weights 合计必须大于 0（全 0 权重无法打分）');
        }
    }
    const accept = o['acceptThreshold'];
    const queue = o['queueThreshold'];
    if (accept !== undefined && (typeof accept !== 'number' || !Number.isFinite(accept) || accept < 0 || accept > 1)) {
        errors.push(`acceptThreshold 必须是 0..1 之间的数字，当前值: ${JSON.stringify(accept)}`);
    }
    if (queue !== undefined && (typeof queue !== 'number' || !Number.isFinite(queue) || queue < 0 || queue > 1)) {
        errors.push(`queueThreshold 必须是 0..1 之间的数字，当前值: ${JSON.stringify(queue)}`);
    }
    if (typeof accept === 'number' && typeof queue === 'number' && Number.isFinite(accept) && Number.isFinite(queue)
        && queue >= accept) {
        errors.push(`queueThreshold(${queue}) 必须小于 acceptThreshold(${accept})，否则 accept 档永远不会命中`);
    }
    const hl = o['historyLimit'];
    if (hl !== undefined
        && (typeof hl !== 'number' || !Number.isFinite(hl) || Math.trunc(hl) !== hl
            || hl < HISTORY_LIMIT_MIN || hl > HISTORY_LIMIT_MAX)) {
        errors.push(`historyLimit 必须是 ${HISTORY_LIMIT_MIN}..${HISTORY_LIMIT_MAX} 之间的整数，当前值: ${JSON.stringify(hl)}`);
    }
    return { ok: errors.length === 0, errors };
}
/* ------------------------------------------------------------------ *
 * 维度打分（口径见 DIMENSIONS[].description）
 * ------------------------------------------------------------------ */
const SEVERITY_IMPACT = { info: 0.4, warn: 0.7, critical: 1 };
const RISK_SCORE = { low: 1, medium: 0.6, high: 0.2 };
/** 各 target 的落地成本反向分：改一条上游开关最轻，调巡检周期最重（要重启周期计时） */
const EFFORT_SCORE = {
    'provider.disable': 0.6,
    'tier.precheck': 0.8,
    'agent.interval': 0.9,
    'client.quota': 0.6,
};
function scoreImpact(d) {
    const base = SEVERITY_IMPACT[d.severity] ?? 0.4;
    // kind=none 表示"本轮没有动作"，影响面折半——避免信息型决策靠 severity 刷分挤占队列
    return d.kind === 'none' ? base * 0.5 : base;
}
function countEvidence(evidence) {
    let n = 0;
    for (const e of evidence) {
        if (typeof e === 'string' && e.trim() !== '')
            n++;
    }
    return n;
}
function scoreEvidence(n) {
    if (n <= 0)
        return 0;
    if (n === 1)
        return 0.4;
    if (n === 2)
        return 0.7;
    return 1;
}
function scoreNovelty(category, target, history, adaptive) {
    if (!adaptive)
        return 1;
    // 同 category + 同 target 视为"同一组合"；无 target（纯信息型决策）时按 undefined 相等匹配
    const same = history.filter((h) => h.category === category && h.target === target);
    if (same.length === 0)
        return 1;
    const rejected = same.filter((h) => h.tier === 'reject').length;
    if (rejected >= 2)
        return 0.1; // 反复被驳回组合：强烈降权，防止 Agent 死磕同一件事
    return same.some((h) => h.tier !== 'reject') ? 0.2 : 1;
}
/* ------------------------------------------------------------------ *
 * 四门
 * ------------------------------------------------------------------ */
function isWhitelisted(target) {
    return target !== undefined && TARGET_WHITELIST.includes(target);
}
function gateReuse(target, kind) {
    const pass = isWhitelisted(target) || kind === 'ops' || kind === 'kb';
    const why = target !== undefined
        ? `target=${target} ${isWhitelisted(target) ? '在受控白名单内' : '不在受控白名单内'}`
        : `kind=${kind} 且无受控 target`;
    return { id: 'G1', passed: pass, note: `复用门：${why}${pass ? '' : '（既非白名单动作也非既有运维/知识动作，不予放行）'}` };
}
function gateIncrement(d) {
    const empty = (s) => typeof s !== 'string' || s.trim() === '';
    const missing = [];
    if (empty(d.summary))
        missing.push('summary');
    if (empty(d.analysis))
        missing.push('analysis');
    if (empty(d.recommendation))
        missing.push('recommendation');
    const analysisLen = typeof d.analysis === 'string' ? d.analysis.trim().length : 0;
    const pass = missing.length === 0 && analysisLen >= 20;
    const note = missing.length > 0
        ? `增量门：${missing.join('/')} 为空——没有新增信息，不予放行`
        : analysisLen < 20
            ? `增量门：analysis 仅 ${analysisLen} 字（要求 ≥ 20）——论证太薄，不予放行`
            : `增量门：三要素齐全，analysis ${analysisLen} 字`;
    return { id: 'G2', passed: pass, note };
}
function gateBenefit(impact, evidence) {
    const pass = impact >= 0.7 && evidence >= 0.4;
    return {
        id: 'G3',
        passed: pass,
        note: `收益门：impact=${round3(impact)}（要求 ≥ 0.7）· evidence=${round3(evidence)}（要求 ≥ 0.4）`,
    };
}
function gateRegression(risk, hasChange, whitelisted) {
    const pass = risk >= 0.6 && (!hasChange || whitelisted);
    const why = risk < 0.6
        ? `risk 维度仅 ${round3(risk)}（要求 ≥ 0.6，即动作风险不得为 high）`
        : hasChange && !whitelisted
            ? '动作 target 不在受控白名单内'
            : '风险评估可接受';
    return { id: 'G4', passed: pass, note: `回归门：${why}` };
}
/* ------------------------------------------------------------------ *
 * 主评估函数
 * ------------------------------------------------------------------ */
/**
 * 对一条决策做矩阵仲裁。纯函数：不写历史、不写事件、不修改入参。
 *
 * @param decision 本轮的 Agent 决策（可能带 proposedChange）
 * @param config   矩阵配置（可残缺；内部会先归一化）
 * @param history  既往评估（新的在后）。仅用于 novelty 自适应降权
 */
export function evaluateDecision(decision, config, history) {
    const cfg = normalizeMatrixConfig(config);
    const hist = history ?? [];
    // 只读快照：所有打分基于克隆，绝不原地改动调用方的 decision（安全不变量 2）
    const d = { ...decision, evidence: [...decision.evidence], toolCalls: [...decision.toolCalls] };
    const pc = d.proposedChange
        ? { ...d.proposedChange, payload: { ...d.proposedChange.payload } }
        : undefined;
    const target = pc?.target;
    const values = {
        impact: scoreImpact(d),
        confidence: clamp01(d.confidence),
        evidence: scoreEvidence(countEvidence(d.evidence)),
        risk: pc ? RISK_SCORE[pc.risk] : 0.8,
        effort: pc ? EFFORT_SCORE[pc.target] : 0.7,
        novelty: scoreNovelty(d.category, target, hist, cfg.adaptiveNovelty),
    };
    const dimensions = [];
    let total = 0;
    for (const meta of DIMENSIONS) {
        const value = values[meta.key];
        const weight = cfg.weights[meta.key];
        total += value * weight;
        dimensions.push({ key: meta.key, value: round3(value), weight, contribution: round3(value * weight) });
    }
    const score = round3(total);
    const notes = [];
    // critical 例外：事故类决策时间成本更高，accept 线下调 0.05，但不低于 queue 线
    // （否则会出现 accept 线 < queue 线的荒谬区间，与档位定义冲突）
    const critical = d.severity === 'critical';
    const acceptLine = critical
        ? Math.max(cfg.queueThreshold, round3(cfg.acceptThreshold - 0.05))
        : cfg.acceptThreshold;
    if (critical) {
        notes.push(`critical 决策：accept 线下调 0.05（${cfg.acceptThreshold} → ${acceptLine}），且不低于 queue 线 ${cfg.queueThreshold}`);
    }
    // 可观测性补充（纯描述）：novelty 的降权在维度打分阶段就已经进入 score，
    // 这里只是把"为什么这条不新"写进审计事件，便于复盘时不必反推历史。
    // 只在 novelty < 1 时追加，且**不读也不改** score/tier/gates 的任何输入。
    if (values.novelty < 1) {
        notes.push(`novelty 降权：同 category=${d.category} target=${target ?? '(无)'} 的历史重复或被多次拒绝，novelty=${round3(values.novelty)}`);
    }
    const rawTier = score >= acceptLine ? 'accept' : score >= cfg.queueThreshold ? 'queue' : 'reject';
    const whitelisted = isWhitelisted(target);
    const gates = [
        gateReuse(target, d.kind),
        gateIncrement(d),
        gateBenefit(values.impact, values.evidence),
        gateRegression(values.risk, pc !== undefined, whitelisted),
    ];
    // 四门任一不通过 → 强制降档（只下压，不提升；安全不变量 3）
    let tier = rawTier;
    const failed = gates.filter((g) => !g.passed);
    if (failed.length > 0) {
        if (rawTier === 'accept')
            tier = 'queue';
        else if (rawTier === 'queue')
            tier = 'reject';
        notes.push(`四门未全通过（${failed.map((g) => g.id).join('/')}）：强制降档 ${rawTier} → ${tier}`);
    }
    if (tier === 'reject' && pc) {
        notes.push('reject 档：已剥离 proposedChange（矩阵只仲裁不扩权，被驳回的建议不得被下游执行）');
    }
    const evaluation = {
        schemaVersion: 1,
        at: Date.now(),
        kind: d.kind,
        severity: d.severity,
        category: d.category,
        rawTier,
        tier,
        score,
        dimensions,
        gates,
        notes,
        ...(tier === 'reject' || pc === undefined ? {} : { effectiveChange: pc }),
        ...(target === undefined ? {} : { target }),
    };
    return evaluation;
}
/**
 * 把仲裁结果套回决策对象：返回**新对象**，入参保持不变。
 * reject 时 proposedChange 必定为 undefined（安全不变量 1 的唯一落地出口）。
 */
export function applyMatrixVerdict(decision, evaluation) {
    const next = { ...decision };
    if (evaluation.tier === 'reject' || evaluation.effectiveChange === undefined) {
        delete next.proposedChange;
    }
    else {
        next.proposedChange = { ...evaluation.effectiveChange, payload: { ...evaluation.effectiveChange.payload } };
    }
    return next;
}
/** 纯统计函数（供 MatrixHistory.stats 与管理 API 复用） */
export function computeStats(history) {
    let accept = 0;
    let queue = 0;
    let reject = 0;
    let sum = 0;
    const rejectedByCategory = new Map();
    for (const h of history) {
        if (h.tier === 'accept')
            accept++;
        else if (h.tier === 'queue')
            queue++;
        else {
            reject++;
            rejectedByCategory.set(h.category, (rejectedByCategory.get(h.category) ?? 0) + 1);
        }
        sum += h.score;
    }
    const topRejected = [...rejectedByCategory.entries()]
        .map(([category, count]) => ({ category, count }))
        .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category))
        .slice(0, 5);
    const total = history.length;
    return { total, accept, queue, reject, avgScore: total ? round3(sum / total) : 0, topRejected };
}
/**
 * 内存历史环（默认上限 50，与 runner 的运行历史同口径）。
 *
 * 为什么是内存而不是持久化：矩阵历史只服务于"同一问题是否在重复"的自适应降权与
 * 面板趋势，重启后从 0 重建不影响正确性（AgentMemory 已经用事件流负责跨重启记忆）。
 * 这样矩阵层不需要新增表/新增依赖。
 */
export class MatrixHistory {
    cap;
    items = [];
    constructor(cap = DEFAULT_MATRIX_CONFIG.historyLimit) {
        this.cap = cap;
        this.cap = intInRange(cap, DEFAULT_MATRIX_CONFIG.historyLimit, HISTORY_LIMIT_MIN, HISTORY_LIMIT_MAX);
    }
    /** 配置热更新时同步容量（超出部分裁掉最旧的） */
    setCap(cap) {
        this.cap = intInRange(cap, this.cap, HISTORY_LIMIT_MIN, HISTORY_LIMIT_MAX);
        this.trim();
    }
    push(e) {
        this.items.push(e);
        this.trim();
    }
    /** 新在前（面板/接口习惯） */
    getHistory(limit) {
        const desc = [...this.items].reverse();
        if (limit === undefined)
            return desc;
        const n = intInRange(limit, desc.length, 0, desc.length);
        return desc.slice(0, n);
    }
    /** 内部用：时间正序的只读视图（novelty 计算不需要顺序，但保持稳定） */
    all() {
        return this.items;
    }
    clear() {
        this.items = [];
    }
    get size() {
        return this.items.length;
    }
    stats() {
        return computeStats(this.items);
    }
    trim() {
        if (this.items.length > this.cap)
            this.items.splice(0, this.items.length - this.cap);
    }
}
//# sourceMappingURL=matrix.js.map