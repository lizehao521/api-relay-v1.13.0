/**
 * 商户 token 券闭环：端到端测试（P4）。
 *
 * 与 merchant-integration.test.ts 的分工：
 * - 集成测试验证「管理接口接上了、链路能走通」；
 * - 本文件验证「进程重启后仍然成立」——这是 origin='voucher' 修复的验收点：
 *   券签发的 key 只存在于 SQLite 的 key_meta 里，重启恢复若只认 'panel'，
 *   顾客手上的 key 会在下一次部署后集体失效。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp, type App } from '../app.js';
import { MockUpstream } from '../mock/upstream.js';
import { Logger } from '../core/logger.js';
import { loadConfig } from '../core/config.js';

process.env.RELAY_DISABLE_DIST_ADMIN = '1';

const silent = new Logger('error', () => undefined);
const ADMIN_TOKEN = 'tok-merchant-e2e-1234567890';
const ENV = { RELAY_ADMIN_TOKEN: ADMIN_TOKEN, RELAY_KEY_STD: 'sk-std-e2e' } as NodeJS.ProcessEnv;

interface Env {
  app: App;
  mock: MockUpstream;
  base: string;
  dir: string;
  dbPath: string;
  configPath: string;
  /** 只关网关，保留 mock 与临时库（重启场景用） */
  stopApp: () => Promise<void>;
  /** 用同一个库重新拉起网关 */
  restart: () => Promise<{ base: string; app: App }>;
  close: () => Promise<void>;
}

async function boot(): Promise<Env> {
  const mock = new MockUpstream({ port: 0, logger: silent });
  const mockBound = await mock.listen();
  const dir = mkdtempSync(join(tmpdir(), 'relay-merchant-e2e-'));
  const dbPath = join(dir, 'relay.db');

  const yaml = `
server:
  host: 127.0.0.1
  port: 0
  adminToken: "{ENV:RELAY_ADMIN_TOKEN}"
storage:
  driver: sqlite
  path: ${JSON.stringify(dbPath)}
logLevel: error
providers:
  - id: mock
    label: mock 上游
    protocol: openai
    baseUrl: ${JSON.stringify(mockBound.url)}
    apiKey: "mock-key"
    models: [mock-small]
    priority: 10
    cost: { inputPerMTok: 1, outputPerMTok: 2 }
modelAliases:
  fast: mock-small
clients:
  - id: std
    label: std
    key: "{ENV:RELAY_KEY_STD}"
    tier: standard
    tenantId: t1
    enabled: true
lossReduction:
  meter:
    batchSize: 1
    flushIntervalMs: 20
`;
  const configPath = join(dir, 'relay.yaml');
  writeFileSync(configPath, yaml, 'utf8');

  const start = async (): Promise<{ app: App; base: string }> => {
    const config = loadConfig({ path: configPath, env: ENV });
    config.server.port = 0;
    const app = await createApp(config, silent);
    const bound = await app.start();
    return { app, base: bound.url };
  };

  const first = await start();
  let current = first;
  return {
    app: first.app,
    mock,
    base: first.base,
    dir,
    dbPath,
    configPath,
    stopApp: async () => {
      await current.app.shutdown();
    },
    restart: async () => {
      current = await start();
      return current;
    },
    close: async () => {
      await current.app.shutdown();
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const H = { 'X-Admin-Token': ADMIN_TOKEN, 'content-type': 'application/json' };

async function adminJson<T = Record<string, any>>(
  base: string,
  path: string,
  init?: RequestInit
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${base}/admin/api/${path}`, { ...init, headers: H });
  return { status: res.status, body: (await res.json()) as T };
}

function chat(base: string, key: string): Promise<Response> {
  return fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'mock-small', messages: [{ role: 'user', content: '你好' }] }),
  });
}

/** 直接读库核对 meter 落盘（管理面已有接口，但这里要验的是「真的写进去了」） */
function readMeter(dbPath: string): Record<string, any>[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare('SELECT key_id, tenant_id, outcome, total_tokens FROM meter ORDER BY id').all() as Record<string, any>[];
  } finally {
    db.close();
  }
}

test('merchant e2e：重启后券签发的 key 仍然可用，且 meter 已落盘', async () => {
  const e = await boot();
  try {
    const q = await adminJson(e.base, 'merchant/quota/update', {
      method: 'POST',
      body: JSON.stringify({ tenantId: 't1', purchasedTokens: 20_000 }),
    });
    assert.equal(q.status, 200);
    assert.equal(q.body.balance.remaining, 20_000);

    const issue = await adminJson(e.base, 'merchant/vouchers/issue', {
      method: 'POST',
      body: JSON.stringify({ tenantId: 't1', storeId: 's1', campaignId: 'c1', tokenAmount: 5_000, expiresAt: Date.now() + 3_600_000 }),
    });
    assert.equal(issue.status, 201);
    const code = issue.body.voucher.code as string;

    const claim = await adminJson(e.base, 'merchant/vouchers/claim', {
      method: 'POST',
      body: JSON.stringify({ code, tenantId: 't1', tier: 'standard' }),
    });
    assert.equal(claim.status, 201);
    const key = claim.body.key as string;

    const before = await chat(e.base, key);
    assert.equal(before.status, 200);
    const beforeBody = (await before.json()) as Record<string, any>;
    assert.ok(beforeBody.choices, '应返回 OpenAI 兼容响应');

    // 等 meter flush（flushIntervalMs=20，留足余量）
    await new Promise((r) => setTimeout(r, 300));

    // 1) 重启前：meter 已落盘，且归因到 t1
    const rowsBefore = readMeter(e.dbPath);
    assert.equal(rowsBefore.length, 1, '一次成功调用应产生一条 meter');
    assert.equal(rowsBefore[0]!['tenant_id'], 't1');
    assert.equal(rowsBefore[0]!['outcome'], 'success');
    assert.ok(Number(rowsBefore[0]!['total_tokens']) > 0, '应记录 token 用量');
    const voucherKeyId = String(rowsBefore[0]!['key_id']);

    // 2) 重启网关（同一 SQLite 文件）
    await e.stopApp();
    const restarted = await e.restart();

    // 3) 券 key 重启后仍能过鉴权（origin='voucher' 必须被恢复流程识别）
    const after = await chat(restarted.base, key);
    assert.equal(after.status, 200, '重启后券 key 不应失效');

    const keys = await adminJson(restarted.base, 'keys');
    assert.equal(keys.status, 200);
    const restored = (keys.body.keys as Record<string, any>[]).find((k) => k.id === voucherKeyId);
    assert.ok(restored, '重启后管理面仍能看到券 key');
    assert.equal(restored!.origin, 'voucher');

    // 4) 券状态与核销流水不因重启丢失
    const vouchers = await adminJson(restarted.base, 'merchant/vouchers?tenantId=t1');
    assert.equal(vouchers.status, 200);
    assert.equal((vouchers.body.vouchers as Record<string, any>[])[0]!.status, 'used');
    const redemptions = await adminJson(restarted.base, 'merchant/redemptions?tenantId=t1');
    assert.equal((redemptions.body.redemptions as Record<string, any>[]).length, 1);

    // 5) 重启后再次尝试兑换同一张券仍应被拒（幂等，不产生第二把 key）
    const again = await adminJson(restarted.base, 'merchant/vouchers/claim', {
      method: 'POST',
      body: JSON.stringify({ code, tenantId: 't1', tier: 'standard' }),
    });
    assert.equal(again.status, 409);

    // 6) 重启后的调用同样落 meter（共 2 条）
    await new Promise((r) => setTimeout(r, 300));
    const rowsAfter = readMeter(e.dbPath);
    assert.equal(rowsAfter.length, 2, '重启后的调用也应归因');
    assert.equal(rowsAfter[1]!['key_id'], voucherKeyId);
  } finally {
    await e.close();
  }
});

test('merchant e2e：券服务故障不影响已签发 key 的调用（fail-open 边界）', async () => {
  const e = await boot();
  try {
    // 先签一把普通面板 key，作为「已有付费客户」的代表
    const created = await adminJson(e.base, 'keys/create', {
      method: 'POST',
      body: JSON.stringify({ tier: 'standard', tenantId: 't1', label: 'paying-customer' }),
    });
    assert.equal(created.status, 201);
    const key = created.body.secret as string;

    // 把商户额度池打到「无余额」（娱乐化链路的写路径从此全部失败）
    await adminJson(e.base, 'merchant/quota/update', {
      method: 'POST',
      body: JSON.stringify({ tenantId: 't1', purchasedTokens: 1_000 }),
    });
    const drain = await adminJson(e.base, 'merchant/vouchers/issue', {
      method: 'POST',
      body: JSON.stringify({ tenantId: 't1', storeId: 's1', campaignId: 'c1', tokenAmount: 1_000, expiresAt: Date.now() + 60_000 }),
    });
    assert.equal(drain.status, 201, '先正常发一张把额度占满');

    // 营销链路确实坏了：再发券会被拒
    const issue = await adminJson(e.base, 'merchant/vouchers/issue', {
      method: 'POST',
      body: JSON.stringify({ tenantId: 't1', storeId: 's1', campaignId: 'c1', tokenAmount: 1, expiresAt: Date.now() + 60_000 }),
    });
    assert.equal(issue.status, 400);
    assert.equal(issue.body.error.code, 'quota_insufficient');

    // 但已签发 key 的模型调用必须完全不受影响
    const res = await chat(e.base, key);
    assert.equal(res.status, 200, '营销链路故障不得影响主网关鉴权与转发');
  } finally {
    await e.close();
  }
});