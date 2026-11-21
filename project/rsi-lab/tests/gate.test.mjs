import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  stableStringify, payloadHashOf, nextGeneration, buildManifest, scoreOf,
  decideAcceptance, saveLedger, loadLedger, anchorGeneration, verifyChain,
} from '../runner/gate.mjs';

const sha = (c) => c; // 指纹桩：buildGeneration 用真实 sha256，测试只关心集合差异
const M = (g, over = {}) => ({
  producer: 't', generation: g, claim: 'c',
  artifacts: [{ path: 'src/a.js', sha256: 'a'.repeat(64), bytes: 3 }],
  criteria_sha256: 'b'.repeat(64),
  criteria_diff: [],
  readings: [{ metric: 'pass_rate', n: 0.5, basis: 1, direction: 'up' }],
  ...over,
});

describe('stableStringify 与 payloadHashOf 对键顺序不敏感', () => {
  it('键序不同哈希一致', () => {
    assert.equal(stableStringify({ b: 1, a: 2 }), stableStringify({ a: 2, b: 1 }));
    assert.equal(payloadHashOf({ b: 1, a: 2 }), payloadHashOf({ a: 2, b: 1 }));
  });
});

describe('nextGeneration', () => {
  it('空态从 1 起，缺 generation 时回落到 manifest.generation，state 优先', () => {
    assert.equal(nextGeneration(undefined, undefined), 1);
    assert.equal(nextGeneration(undefined, { generation: 3 }), 4);
    assert.equal(nextGeneration({ generation: 5 }, { generation: 1 }), 6);
  });
});

describe('buildManifest', () => {
  it('产物收 src、判据指纹来自 test 目录、producer 固定', () => {
    const m = buildManifest({ dir: 'tests/fixtures/manifest', generation: 1, claim: '基线' });
    assert.equal(m.producer, 'rsi-lab');
    assert.ok(m.artifacts.some((a) => a.path === 'src/a.js'));
    assert.ok(m.criteria_sha256 && m.criteria_sha256.length === 64);
    assert.deepEqual(m.criteria_diff, []);
  });
  it('有上一代才算 diff，且新增判据标记 added', () => {
    const prev = { producer: 'rsi-lab', generation: 1, claim: 'p', meta: { criteria_files: [] } };
    const m = buildManifest({ dir: 'tests/fixtures/manifest', generation: 2, claim: '扩靶子', prevManifest: prev });
    assert.equal(m.generation, 2);
    assert.ok(Array.isArray(m.criteria_diff) && m.criteria_diff.some((d) => d.id === 'test/x.test.js' && d.change === 'added'));
  });
});

describe('scoreOf', () => {
  it('只认 score 读数，failure 归零', () => {
    assert.equal(scoreOf({ score: 0.75 }), 0.75);
    assert.equal(scoreOf({ failure: 'evaluate_timeout' }), 0);
    assert.equal(scoreOf(undefined), 0);
  });
});

describe('decideAcceptance（judge 四态映射）', () => {
  it('正对照：产物变了且指标严格变好 → accept', () => {
    const prev = M(1);
    const next = M(2, { artifacts: [{ path: 'src/a.js', sha256: 'c'.repeat(64), bytes: 9 }], readings: [{ metric: 'pass_rate', n: 0.9, basis: 1, direction: 'up' }] });
    const d = decideAcceptance(prev, next);
    assert.equal(d.accept, true);
    assert.equal(d.state, 'improved');
  });
  it('指标没变好 → 拒绝（not_improved）', () => {
    const prev = M(1);
    const next = M(2, { artifacts: [{ path: 'src/a.js', sha256: 'c'.repeat(64), bytes: 9 }], readings: [{ metric: 'pass_rate', n: 0.5, basis: 1, direction: 'up' }] });
    const d = decideAcceptance(prev, next);
    assert.equal(d.accept, false);
    assert.equal(d.state, 'not_improved');
  });
  it('一侧带分母另一侧没交 → refused', () => {
    const prev = M(1, { readings: [{ metric: 'pass_rate', n: 3, denominator: 4, basis: 1, direction: 'up' }] });
    const next = M(2, { artifacts: [{ path: 'src/a.js', sha256: 'c'.repeat(64), bytes: 9 }], readings: [{ metric: 'pass_rate', n: 0.9, basis: 1, direction: 'up' }] });
    const d = decideAcceptance(prev, next);
    assert.equal(d.accept, false);
    assert.equal(d.state, 'refused');
  });
});

describe('ledger 往复与链', () => {
  it('saveLedger/loadLedger 往复一致', async () => {
    const p = 'tests/fixtures/ledger-tmp.jsonl';
    await saveLedger(p, [{ round: 1, verdict: 'improved' }]);
    const list = await loadLedger(p);
    assert.equal(list.length, 1);
    assert.equal(list[0].round, 1);
  });
  it('anchorGeneration 入链后 verifyChain ok，篡改即断', async () => {
    const prev = M(1);
    const next = M(2, { artifacts: [{ path: 'src/a.js', sha256: 'c'.repeat(64), bytes: 9 }], readings: [{ metric: 'pass_rate', n: 0.9, basis: 1, direction: 'up' }] });
    const verdict = { state: 'improved', reasons: [], metrics: [] };
    const r1 = anchorGeneration([], prev, next, verdict);
    assert.equal(r1.ok, true);
    const v1 = verifyChain(r1.ledger);
    assert.equal(v1.ok, true);
    const tampered = JSON.parse(JSON.stringify(r1.ledger));
    tampered[2].h = '0'.repeat(64);
    const v2 = verifyChain(tampered);
    assert.equal(v2.ok, false);
  });
  it('同代同 manifest 重记去重，同代异 manifest 拒绝', async () => {
    const prev = M(1);
    const next = M(2, { artifacts: [{ path: 'src/a.js', sha256: 'c'.repeat(64), bytes: 9 }], readings: [{ metric: 'pass_rate', n: 0.9, basis: 1, direction: 'up' }] });
    const verdict = { state: 'improved', reasons: [], metrics: [] };
    const first = anchorGeneration([], prev, next, verdict);
    const again = anchorGeneration(first.ledger, prev, next, verdict);
    assert.equal(again.ok, true);
    assert.equal(again.ledger.length, first.ledger.length, '同 manifest 去重不入链');
    const nextAlt = M(2, { artifacts: [{ path: 'src/a.js', sha256: 'd'.repeat(64), bytes: 5 }], readings: [{ metric: 'pass_rate', n: 0.9, basis: 1, direction: 'up' }] });
    const clash = anchorGeneration(first.ledger, prev, nextAlt, verdict);
    assert.equal(clash.ok, false);
  });
});