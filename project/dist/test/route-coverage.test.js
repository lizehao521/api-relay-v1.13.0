/**
 * 路由纪律测试（C4·审查修复）。
 *
 * 由来：kb 子路由曾两连踩"父分支短路子分支"（#94 GET 列表短路 /docs/{docId}、
 * #95 POST 单篇短路 /docs/batch），kb.ts 里留下的纪律是"父分支必须同时校验深度"，
 * 但一直只靠注释与人工复查——本文件把它固化成单测，并把路由表的**无重复注册**与
 * **只读派生**也纳入自动校验：新增路由自动进入覆盖，无需手工在白名单里登记。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, memoryConfig } from '../app.js';
import { Logger } from '../core/logger.js';
import { deriveReadOnlyActions } from '../admin/api.js';
import { parseKbSub } from '../admin/handlers/kb.js';
import { resolveRoute } from '../admin/router.js';
const silent = new Logger('error', () => undefined);
test('C4: 路由表无重复注册（method+action 唯一，且均非空）', async () => {
    const app = await createApp(memoryConfig(), silent);
    try {
        const routes = app.admin.routeActions();
        const seen = new Set();
        for (const r of routes) {
            const k = `${r.method} ${r.action}`;
            assert.ok(!seen.has(k), `路由重复注册: ${k}`);
            seen.add(k);
            assert.ok(r.action.length > 0 && r.method.length > 0, `路由 method/action 不能为空: ${k}`);
        }
        // 域覆盖下限：ops/provider/key/config/evolution/kb 六域合计远多于 10 条
        assert.ok(routes.length >= 20, `路由数量异常偏少（${routes.length}）`);
    }
    finally {
        await app.shutdown();
    }
});
test('C4: 只读派生 = 路由表中仅注册 GET 的 action（自动随路由表变化）', async () => {
    const app = await createApp(memoryConfig(), silent);
    try {
        const routes = app.admin.routeActions();
        const ro = deriveReadOnlyActions(routes);
        const methodsByAction = new Map();
        for (const r of routes) {
            const s = methodsByAction.get(r.action) ?? new Set();
            s.add(r.method);
            methodsByAction.set(r.action, s);
        }
        // 有写方法的 action 绝不进只读集合
        for (const [action, methods] of methodsByAction) {
            if (methods.size > 1)
                assert.ok(!ro.has(action), `有写方法的 action 不应算只读: ${action}`);
        }
        // 纯只读端点必须在集合内，且在表里确实只有 GET
        for (const a of ['overview', 'keys', 'series', 'metrics', 'config', 'traces']) {
            assert.ok(ro.has(a), `只读端点缺失: ${a}`);
            assert.deepEqual([...(methodsByAction.get(a) ?? [])], ['GET'], `${a} 在表里应只有 GET`);
        }
    }
    finally {
        await app.shutdown();
    }
});
test('C4: resolveRoute 精确匹配（大小写敏感、不做前缀匹配、方法参与）', () => {
    const routes = [
        { method: 'GET', action: 'keys', handler: () => true },
        { method: 'GET', action: 'keys/export', handler: () => true },
    ];
    assert.ok(resolveRoute(routes, 'GET', 'keys'));
    assert.ok(resolveRoute(routes, 'GET', 'keys/export'));
    assert.equal(resolveRoute(routes, 'GET', 'key'), undefined, '不做前缀匹配');
    assert.equal(resolveRoute(routes, 'get', 'keys'), undefined, '大小写敏感');
    assert.equal(resolveRoute(routes, 'POST', 'keys'), undefined, '方法参与匹配');
});
test('C4: kb 子路径解析与深度纪律（#94/#95/#96 同型 bug 固化）', () => {
    const docs = parseKbSub('docs');
    assert.equal(docs.cmd, 'docs');
    assert.equal(docs.depth, 1, '一级分支 depth 必须为 1');
    assert.equal(docs.docId, '');
    const doc = parseKbSub('docs/12');
    assert.equal(doc.cmd, 'docs');
    assert.equal(doc.depth, 2);
    assert.equal(doc.docId, '12');
    // 关键：'docs/batch' 与 'docs/{docId}' 同为 depth=2 —— 调用方必须按 docId 再分流，
    // 否则单篇分支会短路 batch（#95 同型）。
    const batch = parseKbSub('docs/batch');
    assert.equal(batch.depth, 2);
    assert.equal(batch.docId, 'batch');
    assert.equal(parseKbSub('search').depth, 1);
    assert.equal(parseKbSub('stats').depth, 1);
    assert.equal(parseKbSub('').depth, 1);
    // 纪律断言：一级分支条件（depth===1）绝不能匹配深层路径，否则会短路更深分支。
    assert.notEqual(parseKbSub('docs/12').depth, 1);
    assert.notEqual(parseKbSub('docs/batch').depth, 1);
});
//# sourceMappingURL=route-coverage.test.js.map