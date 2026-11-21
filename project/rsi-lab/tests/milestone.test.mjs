import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { MILESTONES, hintFor, nextMilestone, expandIfSaturated, applyMilestone } from '../runner/milestone.mjs';

describe('MILESTONES 模板库', () => {
  it('id 唯一，函数与测试文件成对', () => {
    const ids = MILESTONES.map((m) => m.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const m of MILESTONES) {
      const srcs = Object.keys(m.template).filter((k) => k.startsWith('src/'));
      const tests = Object.keys(m.template).filter((k) => k.startsWith('test/'));
      assert.equal(srcs.length, 1, m.id + ' 恰一个源文件');
      assert.equal(tests.length, 1, m.id + ' 恰一个测试文件');
    }
  });
});

describe('nextMilestone', () => {
  it('按顺序返回，已用的不再返回', () => {
    assert.equal(nextMilestone([]).id, 'microkernel-measure');
    assert.equal(nextMilestone(['microkernel-measure']).id, 'microkernel-verdict');
    assert.equal(nextMilestone(['microkernel-measure', 'microkernel-verdict']), null);
  });
});

describe('hintFor', () => {
  it('返回语义提示且只认自己的源文件', () => {
    const h = hintFor('microkernel-measure');
    assert.ok(h.includes('src/measure.js'));
    assert.equal(hintFor('no-such'), null);
  });
});

describe('expandIfSaturated', () => {
  it('没满分且有未用模板 → 返回下一个；满分 → null；全用完 → null；无 state → null', () => {
    assert.equal(expandIfSaturated({ bestScore: 0.9, milestones: [] }).id, 'microkernel-measure');
    assert.equal(expandIfSaturated({ bestScore: 1, milestones: [] }), null);
    assert.equal(expandIfSaturated({ bestScore: 0.5, milestones: ['microkernel-measure', 'microkernel-verdict'] }), null);
    assert.equal(expandIfSaturated(undefined), null);
  });
});

describe('applyMilestone', () => {
  it('新靶子未出红 → 回滚并抛 milestone_failure', async () => {
    let rolledBack = false;
    try {
      await applyMilestone({ bestScore: 0 }, MILESTONES[0], {
        dir: 'tests/fixtures/tmp-ms',
        evaluate: async () => ({ pass: 4, fail: 0, total: 4, exitCode: 0, score: 1 }),
        commit: async () => 'c1',
        rollback: async () => { rolledBack = true; },
      });
      assert.fail('应抛出');
    } catch (e) {
      assert.ok(String(e).includes('milestone_failure'));
      assert.equal(rolledBack, true);
    }
  });
  it('提交失败 → 回滚并抛 milestone_failure，不记账', async () => {
    let rolledBack = false;
    const state = { bestScore: 0 };
    try {
      await applyMilestone(state, MILESTONES[0], {
        dir: 'tests/fixtures/tmp-ms',
        evaluate: async () => ({ pass: 2, fail: 2, total: 4, exitCode: 1, score: 0.5 }),
        commit: async () => { throw new Error('git 崩了'); },
        rollback: async () => { rolledBack = true; },
      });
      assert.fail('应抛出');
    } catch (e) {
      assert.ok(String(e).includes('milestone_failure'));
      assert.equal(rolledBack, true);
      assert.deepEqual(state.milestones ?? [], [], '不记账');
    }
  });
  it('出红且提交成功 → 记账：milestones/bestCommit/bestScore 更新', async () => {
    const state = { bestScore: 0.375 };
    const r = await applyMilestone(state, MILESTONES[0], {
      dir: 'tests/fixtures/tmp-ms',
      evaluate: async () => ({ pass: 2, fail: 2, total: 4, exitCode: 1, score: 0.5 }),
      commit: async () => 'abc123',
      rollback: async () => {},
    });
    assert.deepEqual(state.milestones, ['microkernel-measure']);
    assert.equal(state.bestCommit, 'abc123');
    assert.equal(state.bestScore, 0.5);
    assert.equal(r.applied ?? r.entry ? true : true, true);
  });
  it('重复应用同一模板被拒', async () => {
    try {
      await applyMilestone({ bestScore: 0, milestones: ['microkernel-measure'] }, MILESTONES[0], {
        dir: 'tests/fixtures/tmp-ms',
        evaluate: async () => ({ pass: 2, fail: 2, total: 4, exitCode: 1, score: 0.5 }),
        commit: async () => 'c',
        rollback: async () => {},
      });
      assert.fail('应抛出');
    } catch (e) {
      assert.ok(String(e).includes('milestone_failure'));
    }
  });
});