import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  judge, STATE, EXIT_CODE, exitCodeOf,
  anchorGeneration, verifyChain, anchorBaseline,
} from '../runner/verdict.mjs';

const sha = (c) => c;
const M = (g, over = {}) => ({
  producer: 't', generation: g, claim: 'c',
  artifacts: [{ path: 'src/a.js', sha256: 'a'.repeat(64), bytes: 3 }],
  criteria_sha256: 'b'.repeat(64),
  criteria_diff: [],
  readings: [{ metric: 'pass_rate', n: 0.5, basis: 1, direction: 'up' }],
  ...over,
});

describe('R1：结构门', () => {
  it('缺 producer / generation<1 / 产物空 / 指纹坏 → refused', () => {
    const bad = { generation: 0, claim: '', artifacts: [], readings: [] };
    const v = judge(bad, M(1));
    assert.equal(v.state, STATE.refused);
    assert.ok(v.reasons.some((r) => r.startsWith('R1')));
  });
  it('claim 超长与两代 producer 不一致 → refused', () => {
    const v1 = judge(M(1, { claim: 'x'.repeat(501) }), M(2));
    assert.equal(v1.state, STATE.refused);
    const v2 = judge(M(1), M(2, { producer: 'other' }));
    assert.equal(v2.state, STATE.refused);
  });
  it('代际不增 → refused；缺席读数没带理由 → refused', () => {
    const v1 = judge(M(1), M(1));
    assert.equal(v1.state, STATE.refused);
    const v2 = judge(M(1), M(2, { artifacts: [{ path: 'src/a.js', sha256: 'c'.repeat(64), bytes: 9 }], readings: [{ metric: 'pass_rate', basis: 5, direction: 'up' }] }));
    assert.equal(v2.state, STATE.refused);
  });
});

describe('R2：产物指纹门', () => {
  it('指纹集完全相同 → refused（同字节换标签）', () => {
    const v = judge(M(1), M(2));
    assert.equal(v.state, STATE.refused);
    assert.ok(v.reasons.some((r) => r.startsWith('R2')));
  });
});

describe('R3：判据门', () => {
  it('指纹变了没交 diff → refused', () => {
    const v = judge(M(1), M(2, { criteria_sha256: 'd'.repeat(64), artifacts: [{ path: 'src/a.js', sha256: 'c'.repeat(64), bytes: 9 }] }));
    assert.equal(v.state, STATE.refused);
    assert.ok(v.reasons.some((r) => r.startsWith('R3')));
  });
  it('判据放水（loosened）→ refused；指纹没变却报 diff → refused', () => {
    const v1 = judge(M(1), M(2, { criteria_sha256: 'd'.repeat(64), criteria_diff: [{ id: 't1', change: 'loosened' }], artifacts: [{ path: 'src/a.js', sha256: 'c'.repeat(64), bytes: 9 }] }));
    assert.equal(v1.state, STATE.refused);
    const v2 = judge(M(1), M(2, { criteria_diff: [{ id: 't1', change: 'tightened' }], artifacts: [{ path: 'src/a.js', sha256: 'c'.repeat(64), bytes: 9 }] }));
    assert.equal(v2.state, STATE.refused);
  });
});

describe('R4：证据门', () => {
  it('estimated/model_says 冒充证据 → refused', () => {
    const v = judge(M(1), M(2, { artifacts: [{ path: 'src/a.js', sha256: 'c'.repeat(64), bytes: 9 }], readings: [{ metric: 'pass_rate', n: 0.9, basis: 3, direction: 'up' }] }));
    assert.equal(v.state, STATE.refused);
    assert.ok(v.reasons.some((r) => r.startsWith('R4')));
  });
  it('诚实缺席带理由 → undecidable；缺席没带理由 → refused', () => {
    const v1 = judge(M(1), M(2, { artifacts: [{ path: 'src/a.js', sha256: 'c'.repeat(64), bytes: 9 }], readings: [{ metric: 'pass_rate', basis: 5, why_absent: '环境抖动', direction: 'up' }] }));
    assert.equal(v1.state, STATE.undecidable);
    const v2 = judge(M(1), M(2, { artifacts: [{ path: 'src/a.js', sha256: 'c'.repeat(64), bytes: 9 }], readings: [{ metric: 'pass_rate', basis: 5, direction: 'up' }] }));
    assert.equal(v2.state, STATE.refused);
  });
});

describe('R5：改进门', () => {
  it('指标没变好 → not_improved', () => {
    const v = judge(M(1), M(2, { artifacts: [{ path: 'src/a.js', sha256: 'c'.repeat(64), bytes: 9 }], readings: [{ metric: 'pass_rate', n: 0.4, basis: 1, direction: 'up' }] }));
    assert.equal(v.state, STATE.not_improved ?? STATE.notImproved);
  });
  it('一侧带分母另一侧没交 → refused', () => {
    const v = judge(M(1, { readings: [{ metric: 'pass_rate', n: 3, denominator: 4, basis: 1, direction: 'up' }] }), M(2, { artifacts: [{ path: 'src/a.js', sha256: 'c'.repeat(64), bytes: 9 }], readings: [{ metric: 'pass_rate', n: 0.9, basis: 1, direction: 'up' }] }));
    assert.equal(v.state, STATE.refused);
  });
  it('两侧都没有读数 → undecidable', () => {
    const v = judge(M(1, { readings: [] }), M(2, { artifacts: [{ path: 'src/a.js', sha256: 'c'.repeat(64), bytes: 9 }], readings: [] }));
    assert.equal(v.state, STATE.undecidable);
  });
  it('方向 down（fail_count 降）也算改进', () => {
    const prev = M(1, { readings: [{ metric: 'fail_count', n: 8, basis: 1, direction: 'down' }] });
    const next = M(2, { artifacts: [{ path: 'src/a.js', sha256: 'c'.repeat(64), bytes: 9 }], readings: [{ metric: 'fail_count', n: 1, basis: 1, direction: 'down' }] });
    const v = judge(prev, next);
    assert.equal(v.state, STATE.improved);
  });
});

describe('优先级：refused 压过一切', () => {
  it('既放水又冒充证据 → refused', () => {
    const v = judge(M(1), M(2, { criteria_sha256: 'd'.repeat(64), criteria_diff: [{ id: 't1', change: 'removed' }], artifacts: [{ path: 'src/a.js', sha256: 'c'.repeat(64), bytes: 9 }], readings: [{ metric: 'pass_rate', n: 0.9, basis: 4, direction: 'up' }] }));
    assert.equal(v.state, STATE.refused);
  });
});

describe('exitCodeOf 与四态对齐', () => {
  it('improved=0 not_improved=1 refused=2 undecidable=3', () => {
    assert.equal(exitCodeOf(STATE.improved), EXIT_CODE.improved);
    assert.equal(exitCodeOf(STATE.notImproved), EXIT_CODE.not_improved);
    assert.equal(exitCodeOf(STATE.refused), EXIT_CODE.refused);
    assert.equal(exitCodeOf(STATE.undecidable), EXIT_CODE.undecidable);
  });
});

describe('R6：锚定与链', () => {
  const improved = (prev, next) => judge(prev, next);
  it('锚定后链可验；同代异 manifest 重记被拒；链被篡改 Verify 不过', () => {
    const prev = M(1);
    const next = M(2, { artifacts: [{ path: 'src/a.js', sha256: 'c'.repeat(64), bytes: 9 }], readings: [{ metric: 'pass_rate', n: 0.9, basis: 1, direction: 'up' }] });
    const v = improved(prev, next);
    assert.equal(v.state, STATE.improved);
    const r = anchorGeneration([], prev, next, v);
    assert.equal(r.ok, true);
    assert.equal(verifyChain(r.ledger).ok, true);
    const nextAlt = M(2, { artifacts: [{ path: 'src/a.js', sha256: 'd'.repeat(64), bytes: 5 }], readings: [{ metric: 'pass_rate', n: 0.9, basis: 1, direction: 'up' }] });
    const clash = anchorGeneration(r.ledger, prev, nextAlt, v);
    assert.equal(clash.ok, false);
    const tampered = JSON.parse(JSON.stringify(r.ledger));
    tampered[1].h = 'e'.repeat(64);
    assert.equal(verifyChain(tampered).ok, false);
  });
  it('judge 带 ledger 会把重记判成 refused', () => {
    const prev = M(1);
    const next = M(2, { artifacts: [{ path: 'src/a.js', sha256: 'c'.repeat(64), bytes: 9 }], readings: [{ metric: 'pass_rate', n: 0.9, basis: 1, direction: 'up' }] });
    const v = judge(prev, next);
    const r = anchorGeneration([], prev, next, v);
    const nextAlt = M(2, { artifacts: [{ path: 'src/a.js', sha256: 'd'.repeat(64), bytes: 5 }], readings: [{ metric: 'pass_rate', n: 0.9, basis: 1, direction: 'up' }] });
    const v2 = judge(prev, nextAlt, { ledger: r.ledger });
    assert.equal(v2.state, STATE.refused);
    assert.ok(v2.reasons.some((x) => x.startsWith('R6')));
  });
  it('anchorBaseline 锚定基线并可重复确认', () => {
    const m = M(1, { producer: 'rsi-lab' });
    const r1 = anchorBaseline([], m);
    assert.equal(r1.ok, true);
    const r2 = anchorBaseline(r1.ledger, m);
    assert.equal(r2.ok, true);
    assert.equal(r2.ledger.length, 1, '同 manifest 重复锚定不追加');
  });
});