import fs from 'node:fs/promises';
import path from 'node:path';

const MEASURE_TEMPLATE = `export function measure(arr) {
  // not implemented
}`;

const MEASURE_TEST = `import assert from 'node:assert/strict';
import { measure } from '../src/measure.js';

assert.equal(measure([]), 0);
assert.equal(measure([1, 2, 3]), 6);
assert.equal(measure([-1, 1]), 0);
assert.equal(measure([2.5, 0.5]), 3);
`;

const VERDICT_TEMPLATE = `export function verdictLite(value) {
  // not implemented
}`;

const VERDICT_TEST = `import assert from 'node:assert/strict';
import { verdictLite } from '../src/verdict-lite.js';

assert.equal(verdictLite(0.5), true);
assert.equal(verdictLite(0.49), false);
assert.equal(verdictLite(1), true);
assert.equal(verdictLite(0), false);
`;

export const MILESTONES = [
  {
    id: 'microkernel-measure',
    hint: '实现 src/measure.js 的 measure(arr)：对数字数组求和，空数组返回 0；对账：readings 必须包含 pass/fail/total 三项读数，且 total>=4。',
    template: { 'src/measure.js': MEASURE_TEMPLATE, 'test/measure.test.js': MEASURE_TEST },
  },
  {
    id: 'microkernel-verdict',
    hint: '实现 src/verdict-lite.js 的 verdictLite(value)：阈值判据，>=0.5 返回 true 否则 false；对账：readings 必须包含 threshold 读数与布尔比较结果。',
    template: { 'src/verdict-lite.js': VERDICT_TEMPLATE, 'test/verdict-lite.test.js': VERDICT_TEST },
  },
];

export function hintFor(id) {
  const m = MILESTONES.find((x) => x.id === id);
  return m ? m.hint : null;
}

export function nextMilestone(milestonesUsed) {
  const done = new Set(milestonesUsed || []);
  for (const m of MILESTONES) {
    if (!done.has(m.id)) return m;
  }
  return null;
}

export function expandIfSaturated(state) {
  const bestScore = state && state.bestScore;
  if (bestScore === undefined || bestScore === null || bestScore >= 1) return null;
  return nextMilestone(state && state.milestones);
}

export async function applyMilestone(state, milestone, opts = {}) {
  const { dir = 'sandbox', evaluate, commit, rollback } = opts;
  if ((state.milestones || []).includes(milestone.id)) {
    throw new Error('milestone_failure：模板 ' + milestone.id + ' 已应用，重复应用被拒');
  }
  const write = (rel, content) => fs.writeFile(path.join(dir, rel), content, 'utf8');
  for (const [rel, content] of Object.entries(milestone.template)) {
    await fs.mkdir(path.join(dir, path.dirname(rel)), { recursive: true });
    await write(rel, content);
  }
  const evalResult = await evaluate();
  const red = evalResult.fail > 0 || evalResult.exitCode !== 0;
  if (!red) {
    await rollback();
    throw new Error('milestone_failure：新靶子未出红，拒绝入链');
  }
  let commitHash;
  try {
    commitHash = await commit();
  } catch (e) {
    await rollback();
    throw new Error('milestone_failure：提交失败 ' + String(e));
  }
  state.milestones = state.milestones || [];
  state.milestones.push(milestone.id);
  state.bestCommit = commitHash;
  state.bestScore = Math.max(state.bestScore ?? 0, evalResult.score);
  return { entry: { milestone: milestone.id, commitHash, eval: evalResult }, eval: evalResult };
}