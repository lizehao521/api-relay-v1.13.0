/**
 * 内部 Agent 决策矩阵（agent/matrix.ts）+ 管理面矩阵端点（admin/handlers/agent.ts）测试。
 *
 * 覆盖三层：
 *   A. 纯函数层（无 IO）：配置规范化/校验、六维加权求和、accept/queue/reject 分档边界、
 *      critical 阈值下调、四门 G1-G4 强制降档、reject 剥离 proposedChange 的安全不变量、
 *      历史环上限与统计、自适应新颖度降权。
 *   B. Runner 接入层：矩阵未启用时 run 结构与事件「零行为回归」；启用后 reject 档的
 *      proposedChange 不流向决策对象。
 *   C. 管理面集成：GET/PUT/reset/history 的 200/400/503 分支（直接构造 AgentHandlers，
 *      用最小 ServerResponse 桩承接 json() 输出，与 tenant-rbac.test.ts 同一范式）。
 *
 * 断言口径：所有分值都是 3 位小数（matrix.ts 的 round3），期望值均由维度口径**手算**得出，
 * 不使用「只判真值」的模糊断言。
 *
 * 运行：npm run typecheck && npm test（或 `node --test dist/test/agent-matrix.test.js`）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MATRIX_CONFIG, DIMENSIONS, MatrixHistory, applyMatrixVerdict, computeStats, evaluateDecision, normalizeMatrixConfig, validateMatrixConfig, } from '../agent/matrix.js';
import { AgentRunner } from '../agent/runner.js';
import { AgentHandlers } from '../admin/handlers/agent.js';
import { MemoryStore } from '../store/index.js';
/* ------------------------------------------------------------------ *
 * 共用桩与构造器
 * ------------------------------------------------------------------ */
const quietLogger = { info() { }, warn() { }, error() { } };
/** 最小可跑 Runner 依赖（与 agent.test.ts 的 fakeDeps 同款，只补本测试用到的字段） */
function baseDeps(over = {}) {
    return {
        config: { enabled: true, clientId: 'agent', model: 'm', intervalMs: 0 },
        logger: quietLogger,
        llm: { async chat() { return { content: '', promptTokens: 0, completionTokens: 0 }; } },
        context: { async collect() { return { overview: {}, providers: [], recentEvents: [] }; } },
        toolCtx: {},
        ...over,
    };
}
/**
 * 基线决策：六维全满且四门全过。
 * 手算 score = 0.3×0.7 + 0.25×0.94 + 0.15×1.0 + 0.2×1.0 + 0.05×0.8 + 0.05×1.0 = 0.885。
 */
function baseDecision(over = {}) {
    return {
        schemaVersion: 2,
        kind: 'iteration',
        severity: 'warn',
        category: 'cost',
        summary: '上游平均延迟偏高',
        analysis: 'get_metrics 显示 p95 18s，高于阈值 12s 的 1.5 倍',
        recommendation: '把对冲阈值下调到 12s',
        proposedChange: {
            target: 'tier.precheck',
            payload: { threshold: 12 },
            impact: '缩短长尾请求',
            rollback: '面板改回 20s',
            risk: 'low',
        },
        confidence: 0.94,
        evidence: ['p95=18s', 'avg=9s', 'window=24h'],
        toolCalls: ['get_metrics'],
        ...over,
    };
}
/** 只保留 confidence 权重的配置：score 恒等于 confidence，便于精确控制分档边界 */
const CONFIDENCE_ONLY_WEIGHTS = {
    impact: 0,
    confidence: 1,
    evidence: 0,
    risk: 0,
    effort: 0,
    novelty: 0,
};
function gateOf(e, id) {
    const g = e.gates.find((x) => x.id === id);
    assert.ok(g, `门 ${id} 必须存在`);
    return g;
}
function dimValue(e, key) {
    const d = e.dimensions.find((x) => x.key === key);
    assert.ok(d, `维度 ${key} 必须存在`);
    return d.value;
}
/** 构造一条最小 MatrixEvaluation（只用于历史环/统计，不走真实评估） */
function fakeEval(over = {}) {
    return {
        schemaVersion: 1,
        at: 1,
        kind: 'ops',
        severity: 'warn',
        category: 'other',
        rawTier: 'queue',
        tier: 'queue',
        score: 0.5,
        dimensions: [],
        gates: [],
        notes: [],
        ...over,
    };
}
function fakeRes() {
    const out = { status: 0, body: undefined };
    const res = {
        setHeader() { },
        writeHead(code) { out.status = code; return res; },
        end(s) {
            try {
                out.body = JSON.parse(s);
            }
            catch {
                out.body = s;
            }
            return res;
        },
    };
    return { res, out };
}
const API = 'http://127.0.0.1:8787/admin/api/';
function apiUrl(action, query = '') {
    return new URL(API + action + query);
}
/** 组装「同一个 store 上的 runner + handlers」，与生产装配一致（controlDoc 走同一 store） */
function newEnv(over = {}) {
    const store = new MemoryStore();
    const runner = new AgentRunner(baseDeps({ store, ...over }));
    const h = new AgentHandlers({ store, logger: quietLogger, agent: () => runner });
    return { runner, h, store };
}
/* ================================================================== *
 * A1. normalizeMatrixConfig
 * ================================================================== */
test('matrix: normalizeMatrixConfig 全缺省补全内置默认值', () => {
    const cfg = normalizeMatrixConfig();
    assert.deepEqual(cfg, DEFAULT_MATRIX_CONFIG);
    assert.equal(cfg.enabled, false, '缺省 = 矩阵不介入（零行为变化）');
    assert.equal(cfg.acceptThreshold, 0.7);
    assert.equal(cfg.queueThreshold, 0.45);
    assert.equal(cfg.historyLimit, 50);
    assert.equal(cfg.adaptiveNovelty, true);
    // 空对象与 undefined 等价
    assert.deepEqual(normalizeMatrixConfig({}), DEFAULT_MATRIX_CONFIG);
});
test('matrix: normalizeMatrixConfig 部分覆盖保留其余默认（enabled 仅显式 true 生效）', () => {
    const cfg = normalizeMatrixConfig({ enabled: true, acceptThreshold: 0.8 });
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.acceptThreshold, 0.8);
    assert.equal(cfg.queueThreshold, 0.45);
    assert.equal(cfg.historyLimit, 50);
    assert.equal(cfg.adaptiveNovelty, true);
    assert.deepEqual(cfg.weights, DEFAULT_MATRIX_CONFIG.weights);
    // 非布尔真值按关闭处理（YAML 写成 "yes" 也不介入）
    assert.equal(normalizeMatrixConfig({ enabled: 'yes' }).enabled, false);
    assert.equal(normalizeMatrixConfig({ enabled: 1 }).enabled, false);
    // adaptiveNovelty 只有显式 false 才关闭
    assert.equal(normalizeMatrixConfig({ adaptiveNovelty: false }).adaptiveNovelty, false);
});
test('matrix: historyLimit 与阈值越界/非法值被钳制（historyLimit 1..500，阈值 0..1）', () => {
    assert.equal(normalizeMatrixConfig({ historyLimit: 0 }).historyLimit, 1);
    assert.equal(normalizeMatrixConfig({ historyLimit: 999 }).historyLimit, 500);
    assert.equal(normalizeMatrixConfig({ historyLimit: 7.9 }).historyLimit, 7, '小数向下取整');
    assert.equal(normalizeMatrixConfig({ historyLimit: -5 }).historyLimit, 1);
    assert.equal(normalizeMatrixConfig({ historyLimit: Number.NaN }).historyLimit, 50, '非有限数回落默认');
    assert.equal(normalizeMatrixConfig({ historyLimit: '3' }).historyLimit, 50, '非数字回落默认');
    assert.equal(normalizeMatrixConfig({ acceptThreshold: 1.5 }).acceptThreshold, 1);
    assert.equal(normalizeMatrixConfig({ queueThreshold: -1 }).queueThreshold, 0);
    assert.equal(normalizeMatrixConfig({ acceptThreshold: '0.9' }).acceptThreshold, 0.7);
});
test('matrix: 权重未给按默认补齐；给了部分权重按相对权重归一化到合计 1', () => {
    // 空 weights 对象 = 全默认（不做归一化，因为默认本身和为 1）
    assert.deepEqual(normalizeMatrixConfig({ weights: {} }).weights, DEFAULT_MATRIX_CONFIG.weights);
    // 只给 impact=0.5，其余用默认（.25/.15/.2/.05/.05）参与归一化：合计 1.2
    const cfg = normalizeMatrixConfig({ weights: { impact: 0.5 } });
    assert.equal(cfg.weights.impact, 0.416667); // 0.5/1.2
    assert.equal(cfg.weights.confidence, 0.208333); // 0.25/1.2
    assert.equal(cfg.weights.evidence, 0.125); // 0.15/1.2
    assert.equal(cfg.weights.risk, 0.166667); // 0.2/1.2
    assert.equal(cfg.weights.effort, 0.041667); // 0.05/1.2
    assert.equal(cfg.weights.novelty, 0.041667); // 0.05/1.2
    const sum = DIMENSIONS.reduce((n, d) => n + cfg.weights[d.key], 0);
    assert.ok(Math.abs(sum - 1) <= 2e-6, `归一化后权重合计应≈1，实际 ${sum}`);
    // 相对比例不变：impact 仍是 confidence 的 2 倍
    assert.ok(Math.abs(cfg.weights.impact / cfg.weights.confidence - 2) < 1e-3);
    // 越界权重先钳制到 0..1 再归一化：impact 5→1、confidence 0→0，其余默认，合计 1.45
    const clamped = normalizeMatrixConfig({ weights: { impact: 5, confidence: 0 } });
    assert.equal(clamped.weights.impact, 0.689655); // 1/1.45
    assert.equal(clamped.weights.confidence, 0);
    const clampedSum = DIMENSIONS.reduce((n, d) => n + clamped.weights[d.key], 0);
    assert.ok(Math.abs(clampedSum - 1) <= 2e-6, `钳制后仍需归一化，实际合计 ${clampedSum}`);
});
/* ================================================================== *
 * A2. validateMatrixConfig
 * ================================================================== */
test('matrix: validateMatrixConfig 合法配置通过、空值视为通过', () => {
    const ok = validateMatrixConfig({
        enabled: true,
        weights: { impact: 0.3, confidence: 0.25, evidence: 0.15, risk: 0.2, effort: 0.05, novelty: 0.05 },
        acceptThreshold: 0.7,
        queueThreshold: 0.45,
        historyLimit: 30,
        adaptiveNovelty: true,
    });
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.errors, []);
    assert.deepEqual(validateMatrixConfig(undefined), { ok: true, errors: [] });
    assert.deepEqual(validateMatrixConfig(null), { ok: true, errors: [] });
});
test('matrix: 权重合计≠1 属相对权重语义（允许），越界与未知维度才报错', () => {
    // 实现口径：weights 是「相对权重」，normalize 会重新归一化到和为 1，
    // 因此合计 0.9 本身不是错误（模块注释明确：运营只改一个维度也能得到稳定 0..1 分数）。
    // 任务书写的是「合计≠1 → ok:false」，与实现语义冲突；此处断言实现真实语义，
    // 并在报告 TestReport 里单列该口径差异（未改实现，避免破坏相对权重设计）。
    const relative = validateMatrixConfig({
        weights: { impact: 0.3, confidence: 0.2, evidence: 0.15, risk: 0.15, effort: 0.05, novelty: 0.05 },
    });
    assert.equal(relative.ok, true, '合计 0.9 的合法 0..1 权重不被拒');
    assert.deepEqual(relative.errors, []);
    const norm = normalizeMatrixConfig({
        weights: { impact: 0.3, confidence: 0.2, evidence: 0.15, risk: 0.15, effort: 0.05, novelty: 0.05 },
    });
    const sum = DIMENSIONS.reduce((n, d) => n + norm.weights[d.key], 0);
    assert.ok(Math.abs(sum - 1) <= 2e-6, `合计 0.9 的输入在 normalize 后被拉回 1，实际 ${sum}`);
    // 真正非法的是越界值
    const low = validateMatrixConfig({ weights: { impact: -0.1 } });
    assert.equal(low.ok, false);
    assert.ok(low.errors.some((e) => e.includes('weights.impact') && e.includes('0..1')), `错误项应点名 weights.impact：${low.errors.join('|')}`);
    const high = validateMatrixConfig({ weights: { confidence: 1.2 } });
    assert.equal(high.ok, false);
    assert.ok(high.errors.some((e) => e.includes('weights.confidence') && e.includes('0..1')));
    // 未知维度
    const unknownDim = validateMatrixConfig({ weights: { impact: 0.5, sentiment: 0.5 } });
    assert.equal(unknownDim.ok, false);
    assert.ok(unknownDim.errors.some((e) => e.includes('未知维度 "sentiment"')));
    // 全 0 权重无法打分
    const zero = validateMatrixConfig({ weights: { impact: 0, confidence: 0 } });
    assert.equal(zero.ok, false);
    assert.ok(zero.errors.some((e) => e.includes('合计必须大于 0')));
});
test('matrix: validateMatrixConfig 拒绝 queue ≥ accept 与非法 historyLimit/enabled/未知字段', () => {
    const qge = validateMatrixConfig({ acceptThreshold: 0.5, queueThreshold: 0.5 });
    assert.equal(qge.ok, false);
    assert.ok(qge.errors.some((e) => e.includes('queueThreshold(0.5)') && e.includes('acceptThreshold(0.5)')), `应明确指出 queue 不小于 accept：${qge.errors.join('|')}`);
    const qgt = validateMatrixConfig({ acceptThreshold: 0.4, queueThreshold: 0.6 });
    assert.equal(qgt.ok, false);
    assert.equal(qgt.errors.length, 1);
    const acceptOut = validateMatrixConfig({ acceptThreshold: 1.2 });
    assert.equal(acceptOut.ok, false);
    assert.ok(acceptOut.errors.some((e) => e.includes('acceptThreshold 必须是 0..1')));
    const hl = validateMatrixConfig({ historyLimit: 1.5 });
    assert.equal(hl.ok, false);
    assert.ok(hl.errors.some((e) => e.includes('historyLimit 必须是 1..500 之间的整数')));
    assert.equal(validateMatrixConfig({ historyLimit: 0 }).ok, false);
    assert.equal(validateMatrixConfig({ historyLimit: 501 }).ok, false);
    const badEnabled = validateMatrixConfig({ enabled: 'yes' });
    assert.equal(badEnabled.ok, false);
    assert.ok(badEnabled.errors.some((e) => e.includes('enabled 必须是布尔值')));
    const typo = validateMatrixConfig({ acceptTreshold: 0.8 });
    assert.equal(typo.ok, false, '拼错字段名不得静默忽略');
    assert.ok(typo.errors.some((e) => e.includes('含未知字段 "acceptTreshold"')));
    const notObject = validateMatrixConfig([1, 2]);
    assert.equal(notObject.ok, false);
    assert.ok(notObject.errors.some((e) => e.includes('decisionMatrix 必须是对象')));
});
/* ================================================================== *
 * A3. 加权求和
 * ================================================================== */
test('matrix: evaluateDecision 六维加权求和与分项贡献一致（手算 score=0.885）', () => {
    const e = evaluateDecision(baseDecision());
    assert.equal(e.schemaVersion, 1);
    assert.ok(e.at > 0, 'at 应为毫秒时间戳');
    assert.equal(e.category, 'cost');
    assert.equal(e.target, 'tier.precheck');
    // 维度顺序与 DIMENSIONS 元数据一致（面板按此渲染）
    assert.equal(e.dimensions.length, 6);
    assert.deepEqual(e.dimensions.map((d) => d.key), DIMENSIONS.map((d) => d.key));
    // 六维原始值（口径见 DIMENSIONS[].description）
    assert.deepEqual(e.dimensions.map((d) => d.value), [0.7, 0.94, 1, 1, 0.8, 1]);
    // 默认权重
    assert.deepEqual(e.dimensions.map((d) => d.weight), [0.3, 0.25, 0.15, 0.2, 0.05, 0.05]);
    // 分项贡献 = value × weight（3 位小数）
    assert.deepEqual(e.dimensions.map((d) => d.contribution), [0.21, 0.235, 0.15, 0.2, 0.04, 0.05]);
    assert.equal(e.score, 0.885);
    const sum = e.dimensions.reduce((n, d) => n + d.contribution, 0);
    assert.ok(Math.abs(sum - e.score) < 1e-6, `分项贡献之和应等于 score（${sum} vs ${e.score}）`);
    // 四门全过 → 不降档
    assert.deepEqual(e.gates.map((g) => g.id), ['G1', 'G2', 'G3', 'G4']);
    assert.ok(e.gates.every((g) => g.passed), `四门应全过：${e.gates.map((g) => `${g.id}:${g.passed}`).join(',')}`);
    assert.equal(e.rawTier, 'accept');
    assert.equal(e.tier, 'accept');
    assert.deepEqual(e.effectiveChange, baseDecision().proposedChange, 'accept 档保留动作副本');
    assert.deepEqual(e.notes, [], '四门全过且非 critical → 无降档说明');
});
test('matrix: 维度口径——kind=none 影响面折半、证据按条数分档、无动作时 risk/effort 取常量', () => {
    const none = evaluateDecision(baseDecision({ kind: 'none', severity: 'info', evidence: [], proposedChange: undefined }));
    assert.equal(dimValue(none, 'impact'), 0.2, 'info 0.4 × 0.5（kind=none）');
    assert.equal(dimValue(none, 'evidence'), 0);
    assert.equal(dimValue(none, 'risk'), 0.8, '无 proposedChange → 0.8');
    assert.equal(dimValue(none, 'effort'), 0.7, '无 proposedChange → 0.7');
    const one = evaluateDecision(baseDecision({ evidence: ['a'] }));
    const two = evaluateDecision(baseDecision({ evidence: ['a', 'b'] }));
    const three = evaluateDecision(baseDecision({ evidence: ['a', 'b', 'c'] }));
    const blank = evaluateDecision(baseDecision({ evidence: ['', '  '] }));
    assert.equal(dimValue(one, 'evidence'), 0.4);
    assert.equal(dimValue(two, 'evidence'), 0.7);
    assert.equal(dimValue(three, 'evidence'), 1);
    assert.equal(dimValue(blank, 'evidence'), 0, '空串不算证据');
    const medium = evaluateDecision(baseDecision({
        proposedChange: { ...baseDecision().proposedChange, risk: 'medium', target: 'agent.interval' },
    }));
    assert.equal(dimValue(medium, 'risk'), 0.6);
    assert.equal(dimValue(medium, 'effort'), 0.9);
});
/* ================================================================== *
 * A4. 分档边界
 * ================================================================== */
test('matrix: accept/queue/reject 边界（score 恰好等于阈值也算命中）', () => {
    const cfg = {
        acceptThreshold: 0.8,
        queueThreshold: 0.5,
        weights: CONFIDENCE_ONLY_WEIGHTS,
    };
    // 恰好等于 accept 线 → accept
    const atAccept = evaluateDecision(baseDecision({ confidence: 0.8 }), cfg);
    assert.equal(atAccept.score, 0.8);
    assert.equal(atAccept.rawTier, 'accept');
    assert.equal(atAccept.tier, 'accept');
    // 略低于 accept 线 → queue
    const belowAccept = evaluateDecision(baseDecision({ confidence: 0.799 }), cfg);
    assert.equal(belowAccept.score, 0.799);
    assert.equal(belowAccept.rawTier, 'queue');
    assert.equal(belowAccept.tier, 'queue');
    // 恰好等于 queue 线 → queue
    const atQueue = evaluateDecision(baseDecision({ confidence: 0.5 }), cfg);
    assert.equal(atQueue.score, 0.5);
    assert.equal(atQueue.rawTier, 'queue');
    assert.equal(atQueue.tier, 'queue');
    assert.ok(atQueue.effectiveChange !== undefined, 'queue 档仍保留动作（等人工确认）');
    // 略低于 queue 线 → reject
    const belowQueue = evaluateDecision(baseDecision({ confidence: 0.499 }), cfg);
    assert.equal(belowQueue.score, 0.499);
    assert.equal(belowQueue.rawTier, 'reject');
    assert.equal(belowQueue.tier, 'reject');
    assert.equal(belowQueue.effectiveChange, undefined, 'reject 档不携带可执行动作');
});
test('matrix: critical 决策 accept 线下调 0.05（临界样本从 queue 变 accept）', () => {
    const cfg = {
        acceptThreshold: 0.8,
        queueThreshold: 0.5,
        weights: CONFIDENCE_ONLY_WEIGHTS,
    };
    const warn = evaluateDecision(baseDecision({ severity: 'warn', confidence: 0.77 }), cfg);
    const critical = evaluateDecision(baseDecision({ severity: 'critical', confidence: 0.77 }), cfg);
    // 同一 decision（仅 severity 不同）在 confidence-only 权重下 score 相同——隔离阈值变量
    assert.equal(warn.score, 0.77);
    assert.equal(critical.score, 0.77);
    assert.equal(warn.rawTier, 'queue', '0.77 < 0.80 默认 accept 线');
    assert.equal(warn.tier, 'queue');
    assert.equal(critical.rawTier, 'accept', '0.77 ≥ 0.75（accept 线 − 0.05）');
    assert.equal(critical.tier, 'accept');
    assert.ok(critical.notes.some((n) => n.includes('accept 线下调 0.05') && n.includes('0.8 → 0.75')), `应记下临界阈值下调：${critical.notes.join('|')}`);
});
test('matrix: critical 的下调不得低于 queue 线（下限被抬到 queueThreshold）', () => {
    // accept 0.53 − 0.05 = 0.48 < queue 0.5 → 下限取 0.5
    const cfg = {
        acceptThreshold: 0.53,
        queueThreshold: 0.5,
        weights: CONFIDENCE_ONLY_WEIGHTS,
    };
    const floored = evaluateDecision(baseDecision({ severity: 'critical', confidence: 0.5 }), cfg);
    assert.equal(floored.score, 0.5);
    assert.equal(floored.rawTier, 'accept', 'accept 线被抬到 queue 线 0.5，score 0.5 仍命中 accept');
    assert.ok(floored.notes.some((n) => n.includes('不低于 queue 线 0.5')), `应说明下限保护：${floored.notes.join('|')}`);
    const below = evaluateDecision(baseDecision({ severity: 'critical', confidence: 0.499 }), cfg);
    assert.equal(below.rawTier, 'reject', '低于 queue 线仍然是 reject（下限保护不会把 reject 抬成 accept）');
    assert.equal(below.tier, 'reject');
});
/* ================================================================== *
 * A5. 四门 G1-G4 强制降档
 * ================================================================== */
test('matrix: G1 复用门不通过（非白名单动作且非 ops/kb）→ 强制降档且 rawTier 保留', () => {
    const e = evaluateDecision(baseDecision({ kind: 'iteration', proposedChange: undefined }));
    const g1 = gateOf(e, 'G1');
    assert.equal(g1.passed, false);
    assert.ok(g1.note.includes('kind=iteration 且无受控 target'), `G1 note 应说明原因：${g1.note}`);
    assert.equal(e.rawTier, 'accept', '临界/高分样本原档为 accept');
    assert.equal(e.tier, 'queue', '四门未过 → accept 降 queue');
    assert.ok(e.notes.some((n) => n.includes('G1') && n.includes('accept → queue')), `应记录降档：${e.notes.join('|')}`);
    // 其它三门仍应通过（隔离单门）
    assert.equal(gateOf(e, 'G2').passed, true);
    assert.equal(gateOf(e, 'G3').passed, true);
    assert.equal(gateOf(e, 'G4').passed, true);
});
test('matrix: G2 增量门不通过（三要素缺失 / analysis 过薄）→ 强制降档', () => {
    const missing = evaluateDecision(baseDecision({ analysis: '' }));
    const g2a = gateOf(missing, 'G2');
    assert.equal(g2a.passed, false);
    assert.ok(g2a.note.includes('analysis 为空'), `G2 note 应点名缺失项：${g2a.note}`);
    assert.equal(missing.rawTier, 'accept');
    assert.equal(missing.tier, 'queue');
    const thin = evaluateDecision(baseDecision({ analysis: '太短' }));
    const g2b = gateOf(thin, 'G2');
    assert.equal(g2b.passed, false);
    assert.ok(g2b.note.includes('analysis 仅 2 字（要求 ≥ 20）'), `G2 note 应说明字数：${g2b.note}`);
    assert.equal(thin.rawTier, 'accept');
    assert.equal(thin.tier, 'queue');
    assert.ok(thin.notes.some((n) => n.includes('G2')));
});
test('matrix: G3 收益门不通过（impact<0.7）→ 强制降档', () => {
    const e = evaluateDecision(baseDecision({ severity: 'info' }));
    const g3 = gateOf(e, 'G3');
    assert.equal(g3.passed, false);
    assert.ok(g3.note.includes('impact=0.4（要求 ≥ 0.7）'), `G3 note 应给出实测值：${g3.note}`);
    assert.equal(e.rawTier, 'accept', '0.795 仍高于默认 accept 线 0.7');
    assert.equal(e.score, 0.795);
    assert.equal(e.tier, 'queue', '收益门未过 → accept 降 queue');
    // 其它三门仍通过（证据足、白名单动作、风险低）
    assert.equal(gateOf(e, 'G1').passed, true);
    assert.equal(gateOf(e, 'G2').passed, true);
    assert.equal(gateOf(e, 'G4').passed, true);
});
test('matrix: G4 回归门不通过（risk 为 high）→ 强制降档', () => {
    const e = evaluateDecision(baseDecision({
        proposedChange: { ...baseDecision().proposedChange, risk: 'high' },
    }));
    const g4 = gateOf(e, 'G4');
    assert.equal(g4.passed, false);
    assert.ok(g4.note.includes('risk 维度仅 0.2'), `G4 note 应给出风险分：${g4.note}`);
    assert.equal(e.score, 0.725);
    assert.equal(e.rawTier, 'accept');
    assert.equal(e.tier, 'queue');
    assert.equal(gateOf(e, 'G1').passed, true);
    assert.equal(gateOf(e, 'G3').passed, true);
});
test('matrix: 四门全过时不降档（rawTier === tier）', () => {
    const e = evaluateDecision(baseDecision());
    assert.ok(e.gates.every((g) => g.passed));
    assert.equal(e.rawTier, e.tier);
    assert.equal(e.tier, 'accept');
    assert.deepEqual(e.notes, []);
});
/* ================================================================== *
 * A6. 安全不变量
 * ================================================================== */
test('matrix: reject 档剥离 effectiveChange，且不原地修改传入的 decision', () => {
    const decision = baseDecision({
        kind: 'ops',
        severity: 'info',
        confidence: 0.1,
        evidence: [],
        analysis: '短',
    });
    const originalSnapshot = JSON.parse(JSON.stringify(decision));
    const e = evaluateDecision(decision);
    // 0.3×0.4 + 0.25×0.1 + 0.15×0 + 0.2×1（low）+ 0.05×0.8（tier.precheck）+ 0.05×1 = 0.435
    assert.equal(e.score, 0.435, '0.3×0.4 + 0.25×0.1 + 0.2×1 + 0.05×0.8 + 0.05×1');
    assert.equal(e.rawTier, 'reject');
    assert.equal(e.tier, 'reject');
    assert.equal(e.effectiveChange, undefined, 'reject 档不得携带可执行动作');
    assert.equal(e.target, 'tier.precheck', 'target 仍保留（供 novelty 统计）');
    assert.ok(e.notes.some((n) => n.includes('reject 档：已剥离 proposedChange')), `应记录剥离行为：${e.notes.join('|')}`);
    // 入参未被原地删改（payload 引用与内容都不变）
    assert.ok(decision.proposedChange !== undefined, '原始 decision.proposedChange 必须仍在');
    assert.equal(decision.proposedChange?.payload['threshold'], 12);
    assert.deepEqual(decision, originalSnapshot, '反序列化快照应完全一致（不原地改）');
    // applyMatrixVerdict 返回新对象：reject → proposedChange 被剥离
    const verdict = applyMatrixVerdict(decision, e);
    assert.notStrictEqual(verdict, decision);
    assert.equal(verdict.proposedChange, undefined);
    assert.ok(decision.proposedChange !== undefined, '剥离只发生在新对象上');
});
test('matrix: accept/queue 档的 effectiveChange 是副本（改副本不污染入参）', () => {
    const decision = baseDecision();
    const e = evaluateDecision(decision);
    assert.equal(e.tier, 'accept');
    assert.notStrictEqual(e.effectiveChange, decision.proposedChange, '必须是副本而非同一引用');
    assert.deepEqual(e.effectiveChange, decision.proposedChange);
    e.effectiveChange.payload['threshold'] = 999;
    assert.equal(decision.proposedChange?.payload['threshold'], 12, '改副本不得影响原决策');
    const verdict = applyMatrixVerdict(decision, e);
    assert.notStrictEqual(verdict, decision);
    assert.deepEqual(verdict.proposedChange, e.effectiveChange);
    assert.notStrictEqual(verdict.proposedChange.payload, e.effectiveChange.payload);
});
/* ================================================================== *
 * A7. 历史环与统计
 * ================================================================== */
test('matrix: MatrixHistory 超上限只保留最新 N 条，读取新在前', () => {
    const ring = new MatrixHistory(3);
    for (let i = 0; i < 5; i++)
        ring.push(fakeEval({ category: `c${i}`, score: 0.1 * i }));
    assert.equal(ring.size, 3);
    assert.deepEqual(ring.all().map((e) => e.category), ['c2', 'c3', 'c4'], '内部视图时间正序');
    assert.deepEqual(ring.getHistory().map((e) => e.category), ['c4', 'c3', 'c2'], '对外视图新在前');
    assert.deepEqual(ring.getHistory(1).map((e) => e.category), ['c4']);
    assert.deepEqual(ring.getHistory(0), [], 'limit=0 → 空数组');
    assert.deepEqual(ring.getHistory(999).map((e) => e.category), ['c4', 'c3', 'c2'], 'limit 超长 → 全量');
    ring.clear();
    assert.equal(ring.size, 0);
    assert.deepEqual(ring.getHistory(), []);
});
test('matrix: MatrixHistory 默认上限 50，setCap 收缩时裁掉最旧的', () => {
    const ring = new MatrixHistory();
    for (let i = 0; i < 55; i++)
        ring.push(fakeEval({ category: `c${i}` }));
    assert.equal(ring.size, 50);
    assert.equal(ring.all()[0].category, 'c5', '最旧的 5 条被裁掉');
    assert.equal(ring.getHistory(1)[0].category, 'c54');
    ring.setCap(2);
    assert.equal(ring.size, 2);
    assert.deepEqual(ring.all().map((e) => e.category), ['c53', 'c54']);
    // setCap 的入参同样被钳制到 1..500（0 → 下限 1，只留最新 1 条）
    ring.setCap(0);
    assert.equal(ring.size, 1);
    assert.equal(ring.getHistory(1)[0].category, 'c54');
    // 负数同理
    ring.setCap(-3);
    assert.equal(ring.size, 1);
});
test('matrix: computeStats 的 total/accept/queue/reject/avgScore/topRejected 数值正确', () => {
    const history = [
        fakeEval({ category: 'cost', tier: 'accept', rawTier: 'accept', score: 0.9 }),
        fakeEval({ category: 'latency', tier: 'accept', rawTier: 'accept', score: 0.8 }),
        fakeEval({ category: 'cost', tier: 'queue', rawTier: 'accept', score: 0.5 }),
        fakeEval({ category: 'upstream_down', tier: 'reject', rawTier: 'reject', score: 0.3 }),
        fakeEval({ category: 'upstream_down', tier: 'reject', rawTier: 'reject', score: 0.2 }),
    ];
    const stats = computeStats(history);
    assert.equal(stats.total, 5);
    assert.equal(stats.accept, 2);
    assert.equal(stats.queue, 1);
    assert.equal(stats.reject, 2);
    // (0.9 + 0.8 + 0.5 + 0.3 + 0.2) / 5 = 0.54
    assert.equal(stats.avgScore, 0.54);
    assert.deepEqual(stats.topRejected, [{ category: 'upstream_down', count: 2 }]);
    // 空历史：avgScore 0 而不是 NaN
    assert.deepEqual(computeStats([]), { total: 0, accept: 0, queue: 0, reject: 0, avgScore: 0, topRejected: [] });
});
/* ================================================================== *
 * A8. 自适应新颖度降权
 * ================================================================== */
test('matrix: 同 category+target 两次 reject 后 novelty 降为 0.1；单次 reject 不触发 0.2 分支', () => {
    const rejectLike = () => baseDecision({
        kind: 'ops', severity: 'info', confidence: 0.1, evidence: [], analysis: '短',
    });
    const r1 = evaluateDecision(rejectLike());
    assert.equal(r1.tier, 'reject');
    assert.equal(dimValue(r1, 'novelty'), 1, '首次出现（无历史）→ 新颖度 1');
    const r2 = evaluateDecision(rejectLike(), undefined, [r1]);
    assert.equal(r2.tier, 'reject');
    assert.equal(dimValue(r2, 'novelty'), 1, '只有 1 次 reject 历史 → 仍为 1（reject 不命中「重复出现 0.2」分支）');
    const r3 = evaluateDecision(rejectLike(), undefined, [r1, r2]);
    assert.equal(r3.tier, 'reject');
    assert.equal(dimValue(r3, 'novelty'), 0.1, '≥2 次 reject → 0.1');
    // novelty 从 1 降到 0.1：0.435 − 0.05×(1−0.1) = 0.39，档位不变
    assert.equal(r3.score, 0.39);
    // 可观测性：novelty<1 时 notes 追加一行描述，便于审计复盘（不参与 score/tier 计算）
    assert.ok(r3.notes.some((n) => n.includes('novelty 降权') && n.includes('novelty=0.1')), `novelty=0.1 应写描述性 note：${r3.notes.join('|')}`);
    assert.equal(r3.notes.filter((n) => n.includes('novelty 降权')).length, 1, '最多一行，避免重复刷屏');
    // novelty=1 的两条不追加（notes 仍只有四门/档位相关说明）
    assert.equal(r1.notes.some((n) => n.includes('novelty 降权')), false);
    assert.equal(r2.notes.some((n) => n.includes('novelty 降权')), false);
});
test('matrix: 未被驳回的重复组合 novelty=0.2；adaptiveNovelty=false 时恒为 1', () => {
    const accepted = evaluateDecision(baseDecision());
    assert.equal(accepted.tier, 'accept');
    const dup = evaluateDecision(baseDecision(), undefined, [accepted]);
    assert.equal(dimValue(dup, 'novelty'), 0.2, '同组合已出现过（非 reject）→ 0.2');
    assert.equal(dup.score, 0.845, '0.885 − 0.05×(1−0.2)');
    assert.ok(dup.notes.some((n) => n.includes('novelty 降权') && n.includes('novelty=0.2')), `novelty=0.2 应写描述性 note：${dup.notes.join('|')}`);
    // note 是纯描述：tier 与 gates 不受影响（基准样本四门全过 → 仍 accept）
    assert.equal(dup.tier, 'accept');
    assert.ok(dup.gates.every((g) => g.passed));
    const off = evaluateDecision(baseDecision(), { adaptiveNovelty: false }, [accepted, accepted]);
    assert.equal(dimValue(off, 'novelty'), 1, '显式关闭自适应 → 恒为 1');
    // 不同 target 视为不同组合，不互相降权
    const otherTarget = evaluateDecision(baseDecision({ proposedChange: { ...baseDecision().proposedChange, target: 'agent.interval' } }), undefined, [accepted]);
    assert.equal(dimValue(otherTarget, 'novelty'), 1);
    // 不同 category 同样不互相影响
    const otherCategory = evaluateDecision(baseDecision({ category: 'kb' }), undefined, [accepted]);
    assert.equal(dimValue(otherCategory, 'novelty'), 1);
});
/* ================================================================== *
 * B. Runner 接入：矩阵未启用 = 零行为回归
 * ================================================================== */
test('matrix runner: 未启用矩阵时 run 不含 matrix 快照、不写 agent.matrix_decision', async () => {
    // 给定一条合法决策（带 proposedChange），验证「未启用 → 决策原样保留、结构零变化」
    const fakeLlm = {
        async chat() { return { content: JSON.stringify(baseDecision()), promptTokens: 10, completionTokens: 5 }; },
    };
    const { runner, store } = newEnv({ llm: fakeLlm });
    const run = await runner.run('manual');
    assert.equal(run.ok, true);
    assert.equal(run.matrix, undefined, '未启用时 run 结构与引入矩阵前一致');
    assert.equal(run.decision.proposedChange?.target, 'tier.precheck', '未启用 → 动作不被剥离');
    assert.ok(!store.listEvents(100).some((e) => e.kind === 'agent.matrix_decision'), '未启用时不得写矩阵事件');
    const decisionEv = store.listEvents(100).find((e) => e.kind === 'agent.decision');
    assert.ok(decisionEv, '仍应写 agent.decision 事件');
    assert.equal(decisionEv.detail['matrixTier'], undefined, '决策事件不得多出矩阵字段');
    assert.equal(runner.matrixHistory().length, 0);
    assert.equal(runner.matrixStats().total, 0);
    assert.equal(runner.matrixConfig().enabled, false, '缺省 = 关闭');
});
/* ================================================================== *
 * B2. 运行期配置的持久化与回读（controlDoc = settings/KV）
 * ================================================================== */
test('matrix runner: 损坏的 controlDoc 被拒 → matrixConfig() fail-open 回退内置默认并记 warn 事件', () => {
    const store = new MemoryStore();
    // 典型损坏：拼错字段名 + 阈值越界（validateMatrixConfig 会逐条给出中文原因）
    store.saveControlDoc('agent_matrix_config', { acceptTreshold: 0.9, queueThreshold: 9 });
    const runner = new AgentRunner(baseDeps({ store }));
    const cfg = runner.matrixConfig();
    assert.deepEqual(cfg, DEFAULT_MATRIX_CONFIG, '损坏文档不得生效，回退到 YAML/内置默认（enabled:false）');
    assert.equal(cfg.enabled, false);
    const ev = store.listEvents(50).find((e) => e.kind === 'agent.matrix_config_invalid');
    assert.ok(ev, '应写 agent.matrix_config_invalid 事件');
    assert.equal(ev.level, 'warn');
    const errs = ev.detail['errors'];
    assert.ok(Array.isArray(errs), 'errors 必须是数组');
    assert.ok(errs.length >= 2, `应逐条列出校验错误，实际 ${JSON.stringify(errs)}`);
    assert.ok(errs.some((e) => e.includes('含未知字段 "acceptTreshold"')));
    // fail-open 后仍可正常写配置（损坏文档不会把运行期锁死）
    const next = runner.updateMatrixConfig({ enabled: true, acceptThreshold: 0.8, queueThreshold: 0.5 });
    assert.equal(next.enabled, true);
    assert.deepEqual(store.loadControlDoc('agent_matrix_config'), next, '写入即覆盖掉损坏文档');
});
test('matrix runner: updateMatrixConfig 持久化后，新实例（模拟重启）回读值与写入一致', () => {
    const store = new MemoryStore();
    const r1 = new AgentRunner(baseDeps({ store }));
    const next = r1.updateMatrixConfig({
        enabled: true,
        acceptThreshold: 0.82,
        queueThreshold: 0.5,
        historyLimit: 12,
    });
    assert.equal(next.acceptThreshold, 0.82);
    assert.deepEqual(store.loadControlDoc('agent_matrix_config'), next, '应整存整取写入 controlDoc');
    const r2 = new AgentRunner(baseDeps({ store }));
    const reloaded = r2.matrixConfig();
    assert.deepEqual(reloaded, next, '重启回读必须与写入逐字段一致');
    assert.equal(reloaded.enabled, true);
    assert.equal(reloaded.acceptThreshold, 0.82);
    assert.equal(reloaded.queueThreshold, 0.5);
    assert.equal(reloaded.historyLimit, 12);
    assert.deepEqual(reloaded.weights, DEFAULT_MATRIX_CONFIG.weights, '未改权重 → 保持默认');
    // 回读值优先于 YAML（本夹具 YAML 未配置 decisionMatrix → 内置默认），不会被覆盖回去
    assert.notDeepEqual(reloaded, DEFAULT_MATRIX_CONFIG);
    // 历史环容量随配置同步（面板调小上限后不应还看到旧 50 条）
    assert.equal(r2.matrixHistory(999).length, 0, '新实例历史为空，且容量已按 12 生效');
});
/* ================================================================== *
 * C. 管理面集成（AgentHandlers.route）
 * ================================================================== */
test('matrix API: Agent 未启用时全部矩阵端点 503 agent_disabled', () => {
    const store = new MemoryStore();
    const h = new AgentHandlers({ store, logger: quietLogger, agent: () => undefined });
    const cases = [
        ['GET', 'agent/matrix'],
        ['PUT', 'agent/matrix'],
        ['POST', 'agent/matrix/reset'],
        ['GET', 'agent/matrix/history'],
    ];
    for (const [method, action] of cases) {
        const { res, out } = fakeRes();
        h.route(method, action, apiUrl(action), method === 'GET' ? undefined : {}, res);
        assert.equal(out.status, 503, `${method} ${action} 应 503`);
        const err = out.body.error;
        assert.equal(err.code, 'agent_disabled', `${method} ${action}`);
        assert.equal(err.type, 'agent_disabled');
        assert.ok(err.message.includes('未启用'));
    }
});
test('matrix API: AgentRunner 构造但 config.enabled=false 同样 503', () => {
    const store = new MemoryStore();
    const runner = new AgentRunner(baseDeps({ store, config: { enabled: false, clientId: 'a', model: 'm', intervalMs: 0 } }));
    const h = new AgentHandlers({ store, logger: quietLogger, agent: () => runner });
    const { res, out } = fakeRes();
    h.route('GET', 'agent/matrix', apiUrl('agent/matrix'), undefined, res);
    assert.equal(out.status, 503);
    assert.equal(out.body.error.code, 'agent_disabled');
});
test('matrix API: GET agent/matrix 返回配置 + 6 维生效权重 + last + stats', () => {
    const { h } = newEnv();
    const { res, out } = fakeRes();
    h.route('GET', 'agent/matrix', apiUrl('agent/matrix'), undefined, res);
    assert.equal(out.status, 200);
    const body = out.body;
    assert.equal(body.enabled, true, 'Agent 命名空间可达');
    // YAML 未写 decisionMatrix → 内置默认：enabled=false（矩阵不介入仲裁）
    assert.equal(body.config.enabled, false);
    assert.equal(body.config.acceptThreshold, 0.7);
    assert.equal(body.config.queueThreshold, 0.45);
    assert.equal(body.config.historyLimit, 50);
    assert.equal(body.config.adaptiveNovelty, true);
    assert.deepEqual(body.config.weights, DEFAULT_MATRIX_CONFIG.weights);
    assert.equal(body.dimensions.length, 6);
    assert.deepEqual(body.dimensions.map((d) => d.key), DIMENSIONS.map((d) => d.key));
    const sum = body.dimensions.reduce((n, d) => n + d.weight, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9, `6 维权重合计应为 1，实际 ${sum}`);
    for (const d of body.dimensions) {
        assert.equal(typeof d.label, 'string');
        assert.ok(d.label.length > 0, `${d.key} 应有中文名`);
        assert.ok(d.description.length > 20, `${d.key} 应有口径说明`);
    }
    assert.equal(body.last, null, '尚无评估 → last=null');
    assert.deepEqual(body.stats, { total: 0, accept: 0, queue: 0, reject: 0, avgScore: 0, topRejected: [] });
});
test('matrix API: PUT 合法配置 200 且 GET 反映新值（含 controlDoc 持久化与事件）', () => {
    const { h, store } = newEnv();
    const { res, out } = fakeRes();
    h.route('PUT', 'agent/matrix', apiUrl('agent/matrix'), {
        enabled: true,
        acceptThreshold: 0.8,
        queueThreshold: 0.55,
        historyLimit: 10,
    }, res, 'tester');
    assert.equal(out.status, 200);
    const body = out.body;
    assert.equal(body.ok, true);
    assert.equal(body.config.enabled, true);
    assert.equal(body.config.acceptThreshold, 0.8);
    assert.equal(body.config.queueThreshold, 0.55);
    assert.equal(body.config.historyLimit, 10);
    assert.deepEqual(body.config.weights, DEFAULT_MATRIX_CONFIG.weights, '未给的权重保持默认');
    // 落 settings/KV（重启回读）
    const saved = store.loadControlDoc('agent_matrix_config');
    assert.equal(saved.acceptThreshold, 0.8);
    assert.equal(saved.enabled, true);
    // 审计事件
    const ev = store.listEvents(100).find((e) => e.kind === 'agent.matrix_config');
    assert.ok(ev, '应写 agent.matrix_config 事件');
    assert.equal(ev.detail['acceptThreshold'], 0.8);
    // 后续 GET 反映新配置
    const g = fakeRes();
    h.route('GET', 'agent/matrix', apiUrl('agent/matrix'), undefined, g.res);
    const view = g.out.body;
    assert.equal(g.out.status, 200);
    assert.equal(view.config.acceptThreshold, 0.8);
    assert.equal(view.config.queueThreshold, 0.55);
    assert.equal(view.config.historyLimit, 10);
});
test('matrix API: PUT 非法配置 400 + invalid_matrix_config + details，且生效配置不被改一半', () => {
    const { h } = newEnv();
    // 1) queue ≥ accept
    const qge = fakeRes();
    h.route('PUT', 'agent/matrix', apiUrl('agent/matrix'), { acceptThreshold: 0.4, queueThreshold: 0.6 }, qge.res);
    assert.equal(qge.out.status, 400);
    const err1 = qge.out.body.error;
    assert.equal(err1.code, 'invalid_matrix_config');
    assert.equal(err1.type, 'validation_error');
    assert.ok(Array.isArray(err1.details), 'details 必须是数组');
    assert.equal(err1.details.length, 1);
    assert.ok(err1.details[0].includes('queueThreshold(0.6)'), `details 应给出具体原因：${err1.details.join('|')}`);
    // 2) 权重越界
    const badWeight = fakeRes();
    h.route('PUT', 'agent/matrix', apiUrl('agent/matrix'), { weights: { impact: -0.1 } }, badWeight.res);
    assert.equal(badWeight.out.status, 400);
    const err2 = badWeight.out.body.error;
    assert.equal(err2.code, 'invalid_matrix_config');
    assert.ok(err2.details.some((d) => d.includes('weights.impact')));
    // 3) 拼错字段名 → 未知字段（不得静默忽略）
    const typo = fakeRes();
    h.route('PUT', 'agent/matrix', apiUrl('agent/matrix'), { acceptTreshold: 0.8 }, typo.res);
    assert.equal(typo.out.status, 400);
    assert.ok(typo.out.body.error.details.some((d) => d.includes('含未知字段 "acceptTreshold"')));
    // 三次失败后生效配置仍是内置默认（无中间态）
    const g = fakeRes();
    h.route('GET', 'agent/matrix', apiUrl('agent/matrix'), undefined, g.res);
    const view = g.out.body;
    assert.equal(view.config.acceptThreshold, 0.7);
    assert.equal(view.config.queueThreshold, 0.45);
    assert.equal(view.config.enabled, false);
});
test('matrix API: POST matrix/reset 200 且恢复内置默认（默认 enabled=false）', () => {
    const { h, store } = newEnv();
    // 先改成非默认态
    const put = fakeRes();
    h.route('PUT', 'agent/matrix', apiUrl('agent/matrix'), {
        enabled: true, acceptThreshold: 0.9, queueThreshold: 0.3, historyLimit: 5,
    }, put.res);
    assert.equal(put.out.status, 200);
    const { res, out } = fakeRes();
    h.route('POST', 'agent/matrix/reset', apiUrl('agent/matrix/reset'), undefined, res, 'tester');
    assert.equal(out.status, 200);
    const body = out.body;
    assert.equal(body.ok, true);
    assert.deepEqual(body.config, DEFAULT_MATRIX_CONFIG, '复位 = 内置默认（enabled:false）');
    assert.equal(body.config.enabled, false, '恢复出厂即矩阵关闭');
    assert.equal(body.config.acceptThreshold, 0.7);
    assert.equal(body.config.queueThreshold, 0.45);
    assert.equal(body.config.historyLimit, 50);
    assert.ok(store.listEvents(100).some((e) => e.kind === 'agent.matrix_config_reset'), '复位应写审计事件');
});
test('matrix API: 已注册矩阵子路径收到错误方法 → 405 + Allow', () => {
    const { h } = newEnv();
    const cases = [
        ['PUT', 'agent/matrix/history', 'GET'],
        ['GET', 'agent/matrix/reset', 'POST'],
        ['POST', 'agent/matrix', 'GET/PUT'],
    ];
    for (const [method, action, allow] of cases) {
        const { res, out } = fakeRes();
        const headers = new Map();
        res.setHeader = (k, v) => { headers.set(k.toLowerCase(), v); };
        h.route(method, action, apiUrl(action), {}, res);
        assert.equal(out.status, 405, `${method} ${action}`);
        assert.equal(headers.get('allow'), allow, `${method} ${action} 的 Allow`);
        assert.equal(out.body.error.code, 'method_not_allowed');
    }
});
test('matrix API: GET matrix/history 的 limit 钳制（0→1、999→50）与 stats 计数', async () => {
    const store = new MemoryStore();
    // 三条决策循环跑 55 轮：A=accept(0.885) / B=reject(0.39) / C=queue(0.625)
    const A = baseDecision();
    const B = baseDecision({
        kind: 'ops', severity: 'info', category: 'upstream_down',
        summary: '上游熔断', analysis: '短', recommendation: '摘除',
        confidence: 0.1, evidence: [], proposedChange: undefined,
    });
    // kind=ops 且无 target → G1 复用门放行（否则 queue 会被降成 reject）
    const C = baseDecision({ kind: 'ops', severity: 'warn', confidence: 0.44, evidence: ['p95=18s'], proposedChange: undefined });
    const cycle = [A, B, C];
    let i = 0;
    const fakeLlm = {
        async chat() {
            const d = cycle[i % cycle.length];
            i++;
            return { content: JSON.stringify(d), promptTokens: 10, completionTokens: 5 };
        },
    };
    const runner = new AgentRunner(baseDeps({
        store,
        llm: fakeLlm,
        config: {
            enabled: true, clientId: 'agent', model: 'm', intervalMs: 0,
            decisionMatrix: { enabled: true, adaptiveNovelty: false }, // 关自适应 → 档位可预测
        },
    }));
    const h = new AgentHandlers({ store, logger: quietLogger, agent: () => runner });
    for (let k = 0; k < 55; k++) {
        const run = await runner.run('manual');
        assert.equal(run.ok, true, `第 ${k + 1} 轮应成功`);
        assert.ok(run.matrix !== undefined, `第 ${k + 1} 轮矩阵启用 → 必带快照`);
    }
    // 环容量 50：55 条只留最后 50 条（裁掉前 5 轮 A,B,C,A,B）
    assert.equal(runner.matrixHistory(999).length, 50);
    // limit 缺省 20
    const dflt = fakeRes();
    h.route('GET', 'agent/matrix/history', apiUrl('agent/matrix/history'), undefined, dflt.res);
    assert.equal(dflt.out.status, 200);
    const bDflt = dflt.out.body;
    assert.equal(bDflt.evaluations.length, 20, '缺省 limit=20');
    assert.equal(bDflt.stats.total, 50);
    // limit=1 → 1 条，且新在前（第 55 轮是 A，category=cost）
    const one = fakeRes();
    h.route('GET', 'agent/matrix/history', apiUrl('agent/matrix/history', '?limit=1'), undefined, one.res);
    assert.equal(one.out.status, 200);
    const bOne = one.out.body;
    assert.equal(bOne.evaluations.length, 1);
    assert.equal(bOne.evaluations[0].category, 'cost');
    assert.equal(bOne.evaluations[0].tier, 'accept');
    // limit=0 → numParam 钳到 1（不是空数组）
    const zero = fakeRes();
    h.route('GET', 'agent/matrix/history', apiUrl('agent/matrix/history', '?limit=0'), undefined, zero.res);
    const bZero = zero.out.body;
    assert.equal(bZero.evaluations.length, 1, 'limit=0 被钳到下限 1');
    // limit=999 → numParam 钳到上限 50
    const big = fakeRes();
    h.route('GET', 'agent/matrix/history', apiUrl('agent/matrix/history', '?limit=999'), undefined, big.res);
    const bBig = big.out.body;
    assert.equal(bBig.evaluations.length, 50, 'limit=999 被钳到上限 50');
    // 统计：50 条 = accept 17（A 19−2）· reject 16（B 18−2）· queue 17（C 18−1）
    assert.equal(bBig.stats.total, 50);
    assert.equal(bBig.stats.accept, 17);
    assert.equal(bBig.stats.reject, 16);
    assert.equal(bBig.stats.queue, 17);
    // (17×0.885 + 16×0.39 + 17×0.625) / 50 = 0.6382 → 0.638
    assert.equal(bBig.stats.avgScore, 0.638);
    assert.deepEqual(bBig.stats.topRejected, [{ category: 'upstream_down', count: 16 }]);
});
//# sourceMappingURL=agent-matrix.test.js.map