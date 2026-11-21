/**
 * 批次3 · 控制面持久化测试（control_doc + 租户/套餐/账单状态跨实例恢复）。
 *
 * 覆盖：
 *  - 内存 Store：save/load 往返；
 *  - SqliteStore：落盘后**新建实例**可读（真持久化，非仅进程内）；
 *  - TenantHandlers / PlanRegistry / LedgerReport：写操作落盘、新实例恢复；
 *  - fail-open：未知 key 返回 undefined。
 *
 * 运行：npm run build 后 `node --test "dist/test/control-persistence.test.js"`。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore, SqliteStore } from '../store/index.js';
import { TenantHandlers } from '../admin/handlers/tenants.js';
import { RbacPolicy } from '../admin/rbac.js';
import { PlanRegistry, LedgerReport } from '../admin/billing.js';
import { defaultConfig } from '../core/config.js';
function fakeRes() {
    const out = { status: 0, body: undefined };
    const res = {
        setHeader() {
            /* no-op */
        },
        writeHead(code) {
            out.status = code;
            return res;
        },
        end(s) {
            try {
                out.body = JSON.parse(s);
            }
            catch {
                out.body = s;
            }
            return res;
        },
    };
    return { res, out };
}
function mkRec(p) {
    return {
        traceId: 't',
        requestId: 'r',
        ts: Date.now(),
        keyId: 'k',
        tenantId: 'default',
        tier: 'standard',
        clientKind: 'app',
        agentScore: 0,
        model: 'm',
        providerId: 'p',
        stream: false,
        toolCalling: false,
        outcome: 'success',
        httpStatus: 200,
        durationMs: 1,
        ttfbMs: null,
        bytesIn: 0,
        bytesOut: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cachedPromptTokens: 0,
        costCny: 0,
        listCostCny: 0,
        attemptCount: 1,
        failureReason: null,
        quickAction: null,
        recoverable: null,
        precheckViolations: 0,
        precheckBlocked: false,
        precheckDegraded: false,
        precheckUs: 0,
        classifyUs: 0,
        attributionDelivered: false,
        duplicateInWindow: 0,
        ...p,
    };
}
/** 开启临时 SQLite 库 */
async function openSqlite() {
    const dir = mkdtempSync(join(tmpdir(), 'relay-ctl-'));
    const store = new SqliteStore({ path: join(dir, 'relay.db'), batchSize: 50, flushIntervalMs: 1000 });
    await store.init();
    return { store, dir };
}
/* ---------------- 内存 Store ---------------- */
test('MemoryStore：control_doc 往返 + 未知 key 返回 undefined', () => {
    const s = new MemoryStore();
    assert.equal(s.loadControlDoc('nope'), undefined, '未知 key → undefined');
    s.saveControlDoc('k', { a: 1, b: 'x' });
    assert.deepEqual(s.loadControlDoc('k'), { a: 1, b: 'x' });
});
/* ---------------- SQLite 真持久化 ---------------- */
test('SqliteStore：control_doc 落盘后新建实例可读（真持久化）', async () => {
    const { store: s1, dir } = await openSqlite();
    try {
        s1.saveControlDoc('doc1', { tenantId: 'a', n: 42 });
        const s2 = new SqliteStore({ path: join(dir, 'relay.db'), batchSize: 50, flushIntervalMs: 1000 });
        await s2.init();
        assert.deepEqual(s2.loadControlDoc('doc1'), { tenantId: 'a', n: 42 }, '新实例读到落盘文档');
        s2.saveControlDoc('doc1', { tenantId: 'a', n: 43 }); // upsert
        const s3 = new SqliteStore({ path: join(dir, 'relay.db'), batchSize: 50, flushIntervalMs: 1000 });
        await s3.init();
        assert.equal(s3.loadControlDoc('doc1').n, 43, 'upsert 覆盖生效');
        await s2.close();
        await s3.close();
    }
    finally {
        await s1.close();
        rmSync(dir, { recursive: true, force: true });
    }
});
/* ---------------- 租户落盘/恢复 ---------------- */
test('TenantHandlers：新建租户落盘，新实例恢复', async () => {
    const { store, dir } = await openSqlite();
    try {
        const config = defaultConfig();
        const h1 = new TenantHandlers({ config, store, rbac: new RbacPolicy() });
        const { res } = fakeRes();
        h1.create(res, { id: 'acme', name: 'Acme' }, 'test');
        // 新实例（同库）应恢复 acme
        const h2 = new TenantHandlers({ config, store, rbac: new RbacPolicy() });
        assert.ok(h2.find('acme'), '新实例恢复持久化租户');
        assert.equal(h2.find('acme')?.name, 'Acme');
    }
    finally {
        await store.close();
        rmSync(dir, { recursive: true, force: true });
    }
});
test('TenantHandlers：角色矩阵落盘，新实例恢复', async () => {
    const { store, dir } = await openSqlite();
    try {
        const config = defaultConfig();
        const rbac1 = new RbacPolicy();
        const h1 = new TenantHandlers({ config, store, rbac: rbac1 });
        const { res } = fakeRes();
        h1.rolesUpdate(res, { role: 'operator', permissions: ['keys.read'] }, 'test');
        const rbac2 = new RbacPolicy();
        // eslint-disable-next-line no-new
        new TenantHandlers({ config, store, rbac: rbac2 });
        assert.deepEqual(rbac2.permissionsFor('operator'), ['keys.read'], '角色矩阵跨实例恢复');
    }
    finally {
        await store.close();
        rmSync(dir, { recursive: true, force: true });
    }
});
/* ---------------- 套餐 / 账单状态落盘/恢复 ---------------- */
test('PlanRegistry：套餐落盘，新实例恢复', async () => {
    const { store, dir } = await openSqlite();
    try {
        const config = defaultConfig();
        const pr1 = new PlanRegistry({ config, store });
        const { res } = fakeRes();
        pr1.upsert(res, { id: 'pro-x', tier: 'pro', status: 'active' }, 'test');
        const pr2 = new PlanRegistry({ config, store });
        assert.ok(pr2.find('pro-x'), '新实例恢复持久化套餐');
        assert.equal(pr2.activePlan()?.id, 'pro-x');
    }
    finally {
        await store.close();
        rmSync(dir, { recursive: true, force: true });
    }
});
test('LedgerReport：账单状态机落盘，新实例恢复', async () => {
    const { store, dir } = await openSqlite();
    try {
        const config = defaultConfig();
        const pr = new PlanRegistry({ config, store });
        const l1 = new LedgerReport({ store, plans: pr });
        store.record(mkRec({ tenantId: 'a', costCny: 1 }));
        const body = { period: '2026-10', from: 0, to: Date.now() + 1000 };
        const { res, out } = fakeRes();
        l1.issue(res, body, 'test');
        assert.equal(out.status, 200);
        const l2 = new LedgerReport({ store, plans: pr });
        const bills = l2.bills({ tenantId: null, from: 0, to: Date.now() + 1000, period: '2026-10' });
        assert.equal(bills[0]?.status, 'issued', '出账状态跨实例恢复');
    }
    finally {
        await store.close();
        rmSync(dir, { recursive: true, force: true });
    }
});
//# sourceMappingURL=control-persistence.test.js.map