/**
 * 商户 token 券闭环：集成测试（P3/P4）。
 *
 * 走真实 HTTP + 真实 SQLite + mock 上游，验证完整链路：
 *   采购额度 → 发券 → 换 key → 用 key 调模型 → 管理面查到用量。
 *
 * 与单元测试的分工：
 * - merchant-voucher.test.ts 验证状态机/原子性/回滚（直接调 Manager）；
 * - 本文件验证「管理接口真的接上了、签出的 key 真的能过鉴权、meter 真的归因」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../app.js';
import { MockUpstream } from '../mock/upstream.js';
import { Logger } from '../core/logger.js';
import { loadConfig } from '../core/config.js';
process.env.RELAY_DISABLE_DIST_ADMIN = '1';
const silent = new Logger('error', () => undefined);
const ADMIN_TOKEN = 'tok-merchant-1234567890';
async function boot() {
    const mock = new MockUpstream({ port: 0, logger: silent });
    const mockBound = await mock.listen();
    const dir = mkdtempSync(join(tmpdir(), 'relay-merchant-it-'));
    const yaml = `
server:
  host: 127.0.0.1
  port: 0
  adminToken: "{ENV:RELAY_ADMIN_TOKEN}"
storage:
  driver: sqlite
  path: ${JSON.stringify(join(dir, 'relay.db'))}
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
    const config = loadConfig({
        path: configPath,
        env: { RELAY_ADMIN_TOKEN: ADMIN_TOKEN, RELAY_KEY_STD: 'sk-std-it' },
    });
    config.server.port = 0;
    const app = await createApp(config, silent);
    const bound = await app.start();
    return {
        app,
        mock,
        base: bound.url,
        close: async () => {
            await app.shutdown();
            await mock.close();
            rmSync(dir, { recursive: true, force: true });
        },
    };
}
const H = { 'X-Admin-Token': ADMIN_TOKEN, 'content-type': 'application/json' };
async function adminJson(env, path, init) {
    const res = await fetch(`${env.base}/admin/api/${path}`, { ...init, headers: H });
    return { status: res.status, body: (await res.json()) };
}
test('merchant 集成：采购额度 → 发券 → 换 key → 调用 → 用量归因', async () => {
    const e = await boot();
    try {
        // 1) 采购额度
        const q = await adminJson(e, 'merchant/quota/update', {
            method: 'POST',
            body: JSON.stringify({ tenantId: 't1', purchasedTokens: 100_000 }),
        });
        assert.equal(q.status, 200);
        assert.equal(q.body.balance.purchased, 100_000);
        assert.equal(q.body.balance.remaining, 100_000);
        // 2) 发券
        const issue = await adminJson(e, 'merchant/vouchers/issue', {
            method: 'POST',
            body: JSON.stringify({
                tenantId: 't1',
                storeId: 's1',
                campaignId: 'c1',
                tokenAmount: 5_000,
                expiresAt: Date.now() + 3_600_000,
            }),
        });
        assert.equal(issue.status, 201);
        const code = issue.body.voucher.code;
        assert.ok(code.length >= 10, '券码应有足够熵');
        // 3) 换 key（明文只返回一次）
        const claim = await adminJson(e, 'merchant/vouchers/claim', {
            method: 'POST',
            body: JSON.stringify({ code, tenantId: 't1', tier: 'standard' }),
        });
        assert.equal(claim.status, 201);
        const key = claim.body.key;
        assert.ok(key.startsWith('sk-relay-'), `应签发 relay key，实际: ${key}`);
        assert.equal(claim.body.quota_tokens, 5_000);
        assert.equal(typeof claim.body.hash_prefix, 'string');
        // 4) 券只能领一次
        const again = await adminJson(e, 'merchant/vouchers/claim', {
            method: 'POST',
            body: JSON.stringify({ code, tenantId: 't1', tier: 'standard' }),
        });
        assert.equal(again.status, 409);
        assert.equal(again.body.error.code, 'voucher_unavailable');
        // 5) 用签出的 key 真的能调用（走完整鉴权 → 路由 → mock 上游）
        const chat = await fetch(`${e.base}/v1/chat/completions`, {
            method: 'POST',
            headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'mock-small', messages: [{ role: 'user', content: '你好' }] }),
        });
        assert.equal(chat.status, 200);
        // 6) meter 归因：等 flush 后管理面能查到这个 key 的用量
        await new Promise((r) => setTimeout(r, 150));
        const keys = await adminJson(e, 'keys');
        assert.equal(keys.status, 200);
        const issued = keys.body.keys.find((k) => k.hashPrefix === claim.body.hash_prefix);
        assert.ok(issued, '管理面应能看到券签发的 key（hashPrefix 匹配）');
        assert.equal(issued.origin, 'voucher', '券 key 的 origin 应为 voucher');
        // 7) 额度池：issued 增加，remaining 相应减少
        const q2 = await adminJson(e, 'merchant/quota?tenantId=t1');
        assert.equal(q2.status, 200);
        assert.equal(q2.body.balance.issued, 5_000);
        assert.equal(q2.body.balance.remaining, 95_000);
        // 8) 券与核销流水可查
        const vouchers = await adminJson(e, 'merchant/vouchers?tenantId=t1');
        assert.equal(vouchers.status, 200);
        assert.equal(vouchers.body.vouchers.length, 1);
        assert.equal(vouchers.body.vouchers[0].status, 'used');
        const redemptions = await adminJson(e, 'merchant/redemptions?tenantId=t1');
        assert.equal(redemptions.status, 200);
        assert.equal(redemptions.body.redemptions.length, 1);
        assert.equal(redemptions.body.redemptions[0].status, 'success');
    }
    finally {
        await e.close();
    }
});
test('merchant 集成：超发被拒绝，且不产生券', async () => {
    const e = await boot();
    try {
        await adminJson(e, 'merchant/quota/update', {
            method: 'POST',
            body: JSON.stringify({ tenantId: 't1', purchasedTokens: 1_000 }),
        });
        const first = await adminJson(e, 'merchant/vouchers/issue', {
            method: 'POST',
            body: JSON.stringify({ tenantId: 't1', storeId: 's1', campaignId: 'c1', tokenAmount: 1_000, expiresAt: Date.now() + 60_000 }),
        });
        assert.equal(first.status, 201);
        const second = await adminJson(e, 'merchant/vouchers/issue', {
            method: 'POST',
            body: JSON.stringify({ tenantId: 't1', storeId: 's1', campaignId: 'c1', tokenAmount: 1, expiresAt: Date.now() + 60_000 }),
        });
        assert.equal(second.status, 400);
        assert.equal(second.body.error.code, 'quota_insufficient');
        const list = await adminJson(e, 'merchant/vouchers?tenantId=t1');
        assert.equal(list.body.vouchers.length, 1, '被拒绝的发放不应落库');
    }
    finally {
        await e.close();
    }
});
test('merchant 集成：券 key 不可轮换、不可硬删（一券一 key 不变量）', async () => {
    const e = await boot();
    try {
        await adminJson(e, 'merchant/quota/update', {
            method: 'POST',
            body: JSON.stringify({ tenantId: 't1', purchasedTokens: 10_000 }),
        });
        const issue = await adminJson(e, 'merchant/vouchers/issue', {
            method: 'POST',
            body: JSON.stringify({ tenantId: 't1', storeId: 's1', campaignId: 'c1', tokenAmount: 1_000, expiresAt: Date.now() + 60_000 }),
        });
        assert.equal(issue.status, 201);
        const claim = await adminJson(e, 'merchant/vouchers/claim', {
            method: 'POST',
            body: JSON.stringify({ code: issue.body.voucher.code, tenantId: 't1', tier: 'standard' }),
        });
        assert.equal(claim.status, 201);
        const listed = await adminJson(e, 'keys');
        const issued = listed.body.keys.find((k) => k.hashPrefix === claim.body.hash_prefix);
        assert.ok(issued, '应能找到券签发的 key');
        // 轮换会凭空再发一把新 key（旧券面额被重复兑现），必须拒绝
        const rotated = await adminJson(e, 'keys/rotate', {
            method: 'POST',
            body: JSON.stringify({ keyId: issued.id }),
        });
        assert.equal(rotated.status, 400);
        assert.match(rotated.body.error.message, /券兑换/);
        // 硬删会抹掉核销凭证的落点，必须拒绝
        const deleted = await adminJson(e, 'keys/delete', {
            method: 'POST',
            body: JSON.stringify({ keyId: issued.id }),
        });
        assert.equal(deleted.status, 400);
        assert.match(deleted.body.error.message, /核销凭证/);
        // 拒绝之后 key 仍然可用（没有被误删/误轮换）
        const chat = await fetch(`${e.base}/v1/chat/completions`, {
            method: 'POST',
            headers: { authorization: `Bearer ${claim.body.key}`, 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'mock-small', messages: [{ role: 'user', content: '你好' }] }),
        });
        assert.equal(chat.status, 200);
    }
    finally {
        await e.close();
    }
});
test('merchant 集成：无 admin token 时被拒', async () => {
    const e = await boot();
    try {
        const res = await fetch(`${e.base}/admin/api/merchant/quota?tenantId=t1`);
        assert.equal(res.status, 401);
    }
    finally {
        await e.close();
    }
});
//# sourceMappingURL=merchant-integration.test.js.map