import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { SEMANTICS, pendingTargets, renderTaskPrompt, TASK_PROMPT, evaluateSandbox, sandboxDirty } from '../runner/lib.mjs';

describe('SEMANTICS 语义表', () => {
  it('覆盖 stats.js 三函数语义', () => {
    const s = SEMANTICS['src/stats.js'];
    assert.ok(s.includes('mode'));
    assert.ok(s.includes('variance'));
    assert.ok(s.includes('correlation'));
  });
});

describe('pendingTargets', () => {
  it('只认 src 下仍含 not implemented 的代码文件', async () => {
    const files = pendingTargets('tests/fixtures');
    assert.ok(files.includes('src/calc.js'), 'calc.js 含 not implemented 应入选');
    assert.ok(!files.some((f) => f.startsWith('test/')), '测试目录不入选');
  });
  it('干净目录返回空', () => {
    assert.deepEqual(pendingTargets('tests/fixtures/rounds'), []);
  });
});

describe('renderTaskPrompt', () => {
  it('文件与语义一一对应', () => {
    const prompt = renderTaskPrompt(['src/stats.js']);
    assert.ok(prompt.includes('src/stats.js'));
    assert.ok(prompt.includes('mode'));
    assert.ok(prompt.includes('禁止修改 test/'), '护栏必须进提示词');
    assert.ok(prompt.includes('node --test'), '评测命令必须进提示词');
  });
  it('TASK_PROMPT 非空', () => {
    assert.ok(TASK_PROMPT.length > 100);
  });
});

describe('evaluateSandbox 超时守卫', () => {
  it('真实评测沙箱：返回结构齐全且分数与 HEAD 一致（23/24）', async () => {
    const r = await evaluateSandbox(30000);
    assert.equal(typeof r.exitCode, 'number');
    assert.equal(r.total, 24);
    assert.equal(r.pass, 23);
    assert.equal(r.fail, 1);
    assert.ok(Math.abs(r.score - 0.958) < 0.01);
    assert.ok(r.log.includes('# tests 24'));
  });
});

describe('sandboxDirty', () => {
  it('干净沙箱返回 false', async () => {
    assert.equal(await sandboxDirty(), false);
  });
});