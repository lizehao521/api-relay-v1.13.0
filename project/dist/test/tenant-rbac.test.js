/**
 * 批次1 · 多租户 / RBAC 单元测试。
 *
 * 覆盖（映射 AC4-T01/02/03/06 的**逻辑层**）：
 *  - RbacPolicy：owner 恒全权且不可被削减；operator/viewer 受限；未知角色 fail-closed；
 *  - setRole：运行时改矩阵、过滤非法权限点、owner 不可改；
 *  - requiredPermission：`METHOD action` → 权限点映射（只覆盖有权限语义的端点）；
 *  - 租户谓词：tenantOf / filterByTenant / resolveTenantScope（跨租户 = forbidden，防存在性泄漏）；
 *  - TenantHandlers：list 含隐式 default；create 校验/重复 409；update 404 与 default 不可停用；
 *    rolesUpdate 拒绝改 owner、operator 可改。
 *
 * 运行：npm run build 后 `node --test "dist/test/tenant-rbac.test.js"`（Node ≥ 22.5）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RbacPolicy, requiredPermission, ALL_PERMISSIONS } from '../admin/rbac.js';
import { TenantHandlers, filterByTenant, tenantOf, resolveTenantScope, DEFAULT_TENANT_ID, } from '../admin/handlers/tenants.js';
import { MemoryStore } from '../store/index.js';
import { defaultConfig } from '../core/config.js';
/* ---------------- 测试用最小 ServerResponse 桩 ---------------- */
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
function newHandlers(tenants) {
    const config = defaultConfig();
    if (tenants)
        config.tenants = tenants;
    const rbac = new RbacPolicy(config.rbac);
    const store = new MemoryStore();
    return { h: new TenantHandlers({ config, store, rbac }), rbac };
}
/* ---------------- RbacPolicy ---------------- */
test('RbacPolicy：owner 恒全权（配置不可削减），operator/viewer 受限，未知角色 fail-closed', () => {
    // 配置试图把 owner 削成空 —— 必须被忽略
    const rb = new RbacPolicy({ roles: { owner: [], operator: ['keys.read'] } });
    assert.equal(rb.allowed('owner', 'tenants.admin'), true, 'owner 恒全权');
    assert.equal(rb.allowed('owner', 'billing.write'), true, 'owner 恒全权');
    assert.equal(rb.allowed('operator', 'keys.read'), true);
    assert.equal(rb.allowed('operator', 'tenants.admin'), false, 'operator 无租户管理');
    assert.equal(rb.allowed('operator', 'billing.write'), false, 'operator 无计费写（SOD）');
    assert.equal(rb.allowed('viewer', 'keys.read'), true);
    assert.equal(rb.allowed('viewer', 'keys.write'), false, 'viewer 只读');
    assert.equal(rb.allowed('nobody', 'keys.read'), false, '未知角色 fail-closed');
});
test('RbacPolicy.setRole：改矩阵、过滤非法权限、owner 不可改', () => {
    const rb = new RbacPolicy();
    rb.setRole('viewer', ['keys.read', 'bogus.permission']);
    assert.deepEqual(rb.permissionsFor('viewer'), ['keys.read'], '非法权限点被过滤');
    rb.setRole('owner', []);
    assert.equal(rb.allowed('owner', 'tenants.admin'), true, 'owner 仍全权（setRole 对其 no-op）');
    // snapshot 顺序按 ALL_PERMISSIONS
    const snap = rb.snapshot();
    assert.deepEqual(snap['owner'], [...ALL_PERMISSIONS]);
});
/* ---------------- requiredPermission 映射 ---------------- */
test('requiredPermission：按 METHOD action 映射权限点', () => {
    assert.equal(requiredPermission('keys', true), 'keys.write');
    assert.equal(requiredPermission('keys', false), 'keys.read');
    assert.equal(requiredPermission('keys/create', true), 'keys.write');
    assert.equal(requiredPermission('keys/rotate', true), 'keys.write');
    assert.equal(requiredPermission('tenants', true), 'tenants.admin');
    assert.equal(requiredPermission('tenants/update', true), 'tenants.admin');
    assert.equal(requiredPermission('roles/update', true), 'tenants.admin');
    assert.equal(requiredPermission('providers/reset', true), 'providers.write');
    assert.equal(requiredPermission('providers', false), 'providers.read');
    assert.equal(requiredPermission('state/backend', true), 'providers.write');
    // 无权限语义的运营读端点 → undefined（沿用既有只读保护，不在此加门）
    assert.equal(requiredPermission('health', false), undefined);
    assert.equal(requiredPermission('overview', false), undefined);
    assert.equal(requiredPermission('metrics', false), undefined);
});
/* ---------------- 租户谓词 ---------------- */
test('tenantOf：缺省归 default（ADR-029）', () => {
    assert.equal(tenantOf({}), DEFAULT_TENANT_ID);
    assert.equal(tenantOf({ tenantId: '' }), DEFAULT_TENANT_ID);
    assert.equal(tenantOf({ tenantId: 'acme' }), 'acme');
});
test('filterByTenant：空 tenantId = 全量；非空 = 仅本租户', () => {
    const rows = [{ tenantId: 'a' }, { tenantId: 'b' }, {}, { tenantId: 'a' }];
    assert.equal(filterByTenant(rows, null).length, 4, '平台视角全量');
    assert.equal(filterByTenant(rows, undefined).length, 4, '缺省全量');
    assert.equal(filterByTenant(rows, 'a').length, 2, '仅本租户');
    assert.equal(filterByTenant(rows, 'b').length, 1);
    // default 桶不含未标注的 rows（未标注的在 tenantOf 里算 default，故应命中）
    assert.equal(filterByTenant(rows, DEFAULT_TENANT_ID).length, 1, '空 tenantId 归 default');
});
test('resolveTenantScope：跨租户 = forbidden；平台视角不越权', () => {
    assert.deepEqual(resolveTenantScope('a', 'b'), { forbidden: true });
    assert.deepEqual(resolveTenantScope('a', 'a'), { forbidden: false, tenantId: 'a' });
    assert.deepEqual(resolveTenantScope('a', null), { forbidden: false, tenantId: 'a' });
    assert.deepEqual(resolveTenantScope(undefined, 'x'), { forbidden: false, tenantId: 'x' });
    assert.deepEqual(resolveTenantScope(undefined, null), { forbidden: false });
});
/* ---------------- TenantHandlers ---------------- */
test('TenantHandlers.list：含隐式 default + 配置声明租户', () => {
    const { h } = newHandlers([{ id: 'acme', name: 'Acme', status: 'active' }]);
    const list = h.list();
    assert.ok(list.some((t) => t.id === DEFAULT_TENANT_ID), '含 default');
    assert.ok(list.some((t) => t.id === 'acme'), '含配置租户');
    // default 排最前
    assert.equal(list[0].id, DEFAULT_TENANT_ID);
});
test('TenantHandlers.create：格式校验 400 / 重复 409 / 成功 200', () => {
    const { h } = newHandlers([{ id: 'acme', name: 'Acme', status: 'active' }]);
    {
        const { res, out } = fakeRes();
        h.create(res, { id: 'bad id' }, 'test');
        assert.equal(out.status, 400, '非法 id → 400');
    }
    {
        const { res, out } = fakeRes();
        h.create(res, { id: 'acme' }, 'test');
        assert.equal(out.status, 409, '重复 → 409');
    }
    {
        const { res, out } = fakeRes();
        h.create(res, { id: 'beta', name: 'Beta' }, 'test');
        assert.equal(out.status, 200, '创建成功 → 200');
        assert.ok(h.find('beta'));
    }
});
test('TenantHandlers.update：不存在 404；default 不可停用 400', () => {
    const { h } = newHandlers();
    {
        const { res, out } = fakeRes();
        h.update(res, { id: 'nope' }, 'test');
        assert.equal(out.status, 404);
    }
    {
        const { res, out } = fakeRes();
        h.update(res, { id: DEFAULT_TENANT_ID, status: 'disabled' }, 'test');
        assert.equal(out.status, 400, 'default 不可停用');
    }
    {
        const { res, out } = fakeRes();
        h.update(res, { id: DEFAULT_TENANT_ID, name: '默认' }, 'test');
        assert.equal(out.status, 200);
    }
});
test('TenantHandlers.rolesUpdate：改 owner 被拒 400；改 operator 生效', () => {
    const { h, rbac } = newHandlers();
    {
        const { res, out } = fakeRes();
        h.rolesUpdate(res, { role: 'owner', permissions: [] }, 'test');
        assert.equal(out.status, 400, 'owner 不可改');
    }
    {
        const { res, out } = fakeRes();
        h.rolesUpdate(res, { role: 'operator', permissions: ['keys.read'] }, 'test');
        assert.equal(out.status, 200);
        assert.deepEqual(rbac.permissionsFor('operator'), ['keys.read']);
    }
    // 缺少 permissions 数组 → 400
    {
        const { res, out } = fakeRes();
        h.rolesUpdate(res, { role: 'viewer' }, 'test');
        assert.equal(out.status, 400);
    }
});
//# sourceMappingURL=tenant-rbac.test.js.map