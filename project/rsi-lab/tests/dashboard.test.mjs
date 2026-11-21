import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  JUDGMENT_LABEL, JUDGMENT_TAG,
  ledgerSummary, getSummary, listRoundDirs, getRoundDetail, roundSummary,
} from '../dashboard/data.mjs';

describe('JUDGMENT 四态映射', () => {
  it('全部有中文标签与样式类', () => {
    assert.equal(JUDGMENT_LABEL.accept, '对账通过（accept）');
    assert.equal(JUDGMENT_LABEL.revert, '对账拒绝（revert）');
    assert.equal(JUDGMENT_LABEL.timeout, '轮次超时（timeout）');
    assert.equal(JUDGMENT_LABEL.milestone_failure, '里程碑失败（milestone_failure）');
    assert.equal(JUDGMENT_TAG.accept, 'tag-accept');
    assert.equal(JUDGMENT_TAG.revert, 'tag-revert');
    assert.equal(JUDGMENT_TAG.timeout, 'tag-timeout');
    assert.equal(JUDGMENT_TAG.milestone_failure, 'tag-milestone');
  });
});

describe('ledgerSummary（对真实账本）', () => {
  it('逐条结构完整且 Verify 通过', () => {
    const s = ledgerSummary([
      { round: 15, verdict: 'improved', generation: 2, score: 0.833, ts: '2026-11-08T08:00:00.000Z' },
      { round: 16, verdict: 'reverted', blockers: ['finish_reason_not_stop'], aborted: true },
    ]);
    assert.equal(s.count, 2);
    assert.equal(s.verify.ok, true);
    assert.equal(s.verify.count, 2);
    assert.equal(s.list[0].round, 15);
    assert.equal(s.list[1].verdict, 'reverted');
    assert.equal(s.list[1].reason, 'finish_reason_not_stop');
    assert.equal(s.list[0].ts, '2026-11-08T08:00:00.000Z');
  });
});

describe('getSummary 字段暴露', () => {
  it('判定与里程碑已暴露给前端', async () => {
    const s = await getSummary('tests/fixtures/rounds', 'tests/fixtures/no-such.jsonl', 'tests/fixtures/no-such.json');
    assert.equal(s.rounds.length, 3);
    assert.equal(s.lastRound, 3);
    assert.equal(s.lastVerdict, 'improved');
    assert.equal(s.lastGeneration, 3);
    assert.equal(s.lastDirty, false);
    assert.equal(s.ledger.count, 0);
    assert.equal(s.state.bestScore, undefined);
    assert.deepEqual(s.rounds[1].targets, ['src/stats.js']);
    assert.equal(s.rounds[1].score, 0.375);
  });
  it('空目录返回骨架', async () => {
    const s = await getSummary('tests/fixtures/no-such-dir', 'tests/fixtures/no-such.jsonl', 'tests/fixtures/no-such.json');
    assert.deepEqual(s.rounds, []);
    assert.equal(s.lastRound, 0);
    assert.equal(s.lastVerdict, null);
  });
});

describe('roundSummary：失败轮也保留 verdict 留痕', () => {
  it('超时轮不许抹账', () => {
    const s = roundSummary({ round: 4, decision: 'revert', failure: 'round_timeout', verdict: 'timeout', generation: 4, dirty: true, targets: ['src/stats.js'] });
    assert.equal(s.verdict, 'timeout');
    assert.equal(s.decision, 'revert');
    assert.equal(s.dirty, true);
    assert.equal(s.failure, 'round_timeout');
    assert.equal(s.generation, 4);
  });
});

describe('listRoundDirs', () => {
  it('全数字且升序', async () => {
    assert.deepEqual(await listRoundDirs('tests/fixtures/rounds'), [1, 2, 3]);
  });
});

describe('getRoundDetail', () => {
  it('存在的轮返回 report/sse/eval 字段', async () => {
    const d = await getRoundDetail('tests/fixtures/rounds', 2);
    assert.equal(d.round, 2);
    assert.ok('report' in d);
    assert.ok('sse' in d);
    assert.ok('eval' in d);
    assert.equal(d.report.round, 2);
    assert.equal(d.report.failure, 'round_timeout');
  });
});