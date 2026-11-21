/**
 * L-05：不变量「全入口等价」参数化矩阵。
 *
 * 修复清单 L-05 的要求：为「唯一性 / 上限 / 幂等」类不变量补**参数化**测试，
 * 枚举所有会触及该不变量的入口（create / update / rotate / revoke / del(remove) /
 * 直接 register），而不是只测某一个入口。
 *
 * 为什么必须"全入口"：历史缺陷 C-02 正是「create 有唯一性约束、update 没有」——
 * 单入口用例看不见，只有把同一不变量在**每个入口**各跑一遍，才能一眼发现谁漏检。
 *
 * 覆盖三类不变量：
 *   ① 唯一性：label 在 create / update / register 三个能"设 label"的入口上等价去重；
 *              并验证 rotate / revoke / remove 对"label 占用"这一状态的转移一致。
 *   ② 幂等：revoke / update 同值 / remove / rotate / resetQuota 可安全重放，状态稳定。
 *   ③ 上限与校验：未知 tier、过短 secret、清除语义（null / 空数组）在各入口一致。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { KeyRegistry } from '../gateway/keys.js';
import { MemoryStore } from '../store/index.js';
import { Logger } from '../core/logger.js';
import { memoryConfig } from '../app.js';
import type { ClientKeyConfig, TierId } from '../core/types.js';

const silent = new Logger('error');
const badTier = 'nope' as unknown as TierId;
const bearer = (secret: string) => ({ authorization: `Bearer ${secret}`, path: '/v1/chat/completions' });

function makeRegistry() {
  const keys = new KeyRegistry({ config: memoryConfig(), store: new MemoryStore(), logger: silent });
  return { keys };
}

/* ==================== ① 唯一性 ==================== */

test('L-05① 唯一性：label 去重在【全入口】等价（create / update / register）', () => {
  const { keys } = makeRegistry();
  keys.create({ tier: 'standard', tenantId: 't', label: 'taken' });
  const b = keys.create({ tier: 'standard', tenantId: 't', label: 'other' });

  // 参数化：每个"能设置 label"的入口都尝试占用已被使用的 'taken'，必须同样报错。
  const entries: { name: string; apply: () => void }[] = [
    {
      name: 'create',
      apply: () => { keys.create({ tier: 'standard', tenantId: 't', label: 'taken' }); },
    },
    {
      name: 'update',
      apply: () => { keys.update(b.record.id, { label: 'taken' }); },
    },
    {
      name: 'register（配置装载入口）',
      apply: () => {
        const dup: ClientKeyConfig = { id: 'cfg-dup', label: 'taken', key: 'sk-cfg-dup-key', tier: 'standard', tenantId: 't', enabled: true };
        keys.register(dup);
      },
    },
  ];
  for (const e of entries) {
    assert.throws(e.apply, /已存在/, `入口【${e.name}】必须与 create 等价地拒绝重复 label`);
  }

  // 边界 1：改回自己原本的 label 不报错（exceptId 口径）
  keys.update(b.record.id, { label: 'other' });
  // 边界 2：同一 id 重复注册（配置热重载）不算冲突
  keys.register({ id: b.record.id, label: 'other', key: 'sk-cfg-other-key', tier: 'standard', tenantId: 't', enabled: true });
  assert.equal(keys.hasLabel('other'), true);
});

test('L-05① 唯一性：label 占用状态在 rotate / revoke / remove 下的转移一致', async () => {
  const { keys } = makeRegistry();
  const a = keys.create({ tier: 'standard', tenantId: 't', label: 'life' });

  // rotate：label 不变、不与自身冲突，可连续重放；旧 secret 立即失效
  const r1 = keys.rotate(a.record.id);
  const r2 = keys.rotate(a.record.id);
  assert.equal(r2.record.label, 'life', 'rotate 不得改变 label');
  assert.notEqual(r1.secret, r2.secret);
  assert.equal((await keys.authenticate(bearer(r1.secret))).ok, false, '轮换后旧 secret 必须立即失效');
  assert.equal((await keys.authenticate(bearer(r2.secret))).ok, true, '最新 secret 必须可用');

  // revoke：撤销 ≠ 释放 label（仍占用）
  keys.revoke(a.record.id);
  assert.equal(keys.hasLabel('life'), true, 'revoke 后 label 仍被占用');
  assert.throws(() => keys.create({ tier: 'standard', tenantId: 't', label: 'life' }), /已存在/);

  // remove（del）：删除后释放 label，可复用
  assert.equal(keys.remove(a.record.id), true);
  assert.equal(keys.hasLabel('life'), false, 'remove 后 label 应释放');
  assert.ok(keys.create({ tier: 'standard', tenantId: 't', label: 'life' }).record.id);
});

/* ==================== ② 幂等 ==================== */

test('L-05② 幂等：revoke / update 同值 / remove / resetQuota 可安全重放', async () => {
  const { keys } = makeRegistry();
  const a = keys.create({ tier: 'standard', tenantId: 't', label: 'idem' });

  // update 同值两次：稳定、不抛错
  keys.update(a.record.id, { label: 'idem', tier: 'standard', enabled: true });
  const v = keys.update(a.record.id, { label: 'idem', tier: 'standard', enabled: true });
  assert.equal(v.label, 'idem');
  assert.equal(v.tier, 'standard');

  // create 相同 secret 第二次必须拒绝（重复创建的显式屏障，而非静默覆盖）
  const fixed = keys.create({ tier: 'standard', tenantId: 't', secret: 'sk-fixed-secret-1234' });
  assert.throws(
    () => keys.create({ tier: 'standard', tenantId: 't', secret: 'sk-fixed-secret-1234' }),
    /已存在/,
  );

  // revoke 两次：状态稳定
  keys.revoke(a.record.id);
  assert.equal(keys.revoke(a.record.id).enabled, false);

  // 未撤销的 key 仍可用（撤销只影响被撤销的那把）
  assert.equal((await keys.authenticate(bearer(fixed.secret))).ok, true);

  // resetQuota 幂等
  const q1 = keys.resetQuota(a.record.id);
  const q2 = keys.resetQuota(a.record.id);
  assert.equal(q1.before, q2.before);

  // remove 两次：true → false（第二次是幂等空操作）
  assert.equal(keys.remove(a.record.id), true);
  assert.equal(keys.remove(a.record.id), false);
});

/* ==================== ③ 上限与校验 ==================== */

test('L-05③ 上限与校验：未知 tier / 过短 secret / 清除语义在各入口一致', () => {
  const { keys } = makeRegistry();

  // 未知 tier：create 与 update 等价报错
  assert.throws(() => keys.create({ tier: badTier, tenantId: 't' }), /未知分层/);
  const a = keys.create({
    tier: 'standard',
    tenantId: 't',
    label: 'lim',
    allowedModels: ['m'],
    expiresAt: 9_000_000_000_000,
    quotaOverride: 5,
    quotaCny: 1,
  });
  assert.throws(() => keys.update(a.record.id, { tier: badTier }), /未知分层/);

  // secret 下限：create 拒绝过短；合法值原样采用（M-02 口径）
  assert.throws(() => keys.create({ tier: 'standard', tenantId: 't', secret: 'short' }), /至少 8/);
  assert.equal(
    keys.create({ tier: 'standard', tenantId: 't', secret: 'a-sufficiently-long-secret' }).secret,
    'a-sufficiently-long-secret',
  );

  // 清除语义：null 与空数组等价清除（update 入口）
  assert.equal(keys.update(a.record.id, { allowedModels: null }).allowedModels, undefined);
  assert.deepEqual(keys.update(a.record.id, { allowedModels: ['m'] }).allowedModels, ['m']);
  assert.equal(keys.update(a.record.id, { allowedModels: [] }).allowedModels, undefined, '空数组等价清除');
  const cleared = keys.update(a.record.id, { expiresAt: null, quotaOverride: null, quotaCny: null });
  assert.equal(cleared.expiresAt, undefined);
  assert.equal(cleared.quotaOverride, undefined);
  assert.equal(cleared.quotaCnyOverride, undefined);

  // label 空白：create 视为未命名；update 空白视为"不修改"
  assert.match(keys.create({ tier: 'standard', tenantId: 't', label: '   ' }).record.label, /未命名 key/);
  const named = keys.create({ tier: 'standard', tenantId: 't', label: 'named' });
  assert.equal(keys.update(named.record.id, { label: '   ' }).label, 'named', '空白 label 必须被视为"不修改"');
});