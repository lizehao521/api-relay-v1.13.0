import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { finishAborted } from '../runner/one-round.mjs';

describe('finishAborted：超时不许抹账', () => {
  it('中止前已落盘 → 必须评一次、过一次对账、把判定写进账本并推进代数', async () => {
    const calls = [];
    const state = { verdict: { score: 0.5, generation: 1 }, anchorBaseline: { generation: 1 } };
    const res = await finishAborted({
      dir: 'sandbox',
      evaluate: async () => { calls.push('evaluate'); return { exitCode: 0, score: 0.9, pass: 9, fail: 1, total: 10 }; },
      dirtyCheck: async () => { calls.push('dirtyCheck'); return true; },
      reset: async () => { calls.push('reset'); },
      persistLedger: async (ledger) => { calls.push('persistLedger:' + ledger.length); },
      state, round: 7,
    });
    assert.equal(res.aborted, true);
    assert.equal(res.evaluated, true);
    assert.ok(calls.includes('evaluate'), '必须评测一次');
    assert.ok(calls.some((c) => c.startsWith('persistLedger:')), '判定须写进账本');
    assert.equal(state.verdict.aborted, true, 'state.verdict 推进并记 aborted');
    assert.equal(res.generation, 2, '代数从 1 推进到 2');
  });

  it('中止且从未落盘 → 不评测、不动账本', async () => {
    const calls = [];
    const state = { verdict: null };
    const res = await finishAborted({
      dir: 'sandbox',
      evaluate: async () => { calls.push('evaluate'); return { exitCode: 0, score: 1 }; },
      dirtyCheck: async () => { calls.push('dirtyCheck'); return false; },
      reset: async () => { calls.push('reset'); },
      persistLedger: async () => { calls.push('persistLedger'); },
      state, round: 3,
    });
    assert.equal(res.aborted, true);
    assert.equal(res.evaluated, false);
    assert.equal(calls.filter((c) => c === 'evaluate').length, 0, '从未落盘则不评测');
    assert.equal(calls.filter((c) => c === 'persistLedger').length, 0, '不动账本');
  });

  it('模型超时前写了一半 → 对账给出诚实结论而不是静默吞掉', async () => {
    const state = { verdict: { score: 0.4, generation: 1 }, anchorBaseline: { generation: 1 } };
    const res = await finishAborted({
      dir: 'sandbox',
      evaluate: async () => ({ exitCode: 1, score: 0.2, pass: 2, fail: 8, total: 10, killed: true, failure: 'evaluate_timeout' }),
      dirtyCheck: async () => true,
      reset: async () => {},
      persistLedger: async () => {},
      state, round: 16,
    });
    assert.equal(res.aborted, true);
    assert.equal(res.evaluated, true);
    assert.equal(state.verdict.state, 'reverted', '诚实结论：未改进，revert');
    assert.ok(Array.isArray(state.verdict.reasons) && state.verdict.reasons.length > 0, '必须列出拦截原因');
  });
});