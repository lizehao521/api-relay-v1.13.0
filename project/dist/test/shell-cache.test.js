/**
 * 管理外壳与构建产物一致性测试（L5·遗留修复）。
 *
 * 由来：`/admin` 的外壳 HTML 来自 `dist-admin/index.html`（前端构建产物）。若外壳缓存
 * 不按构建指纹失效，「重新构建前端但不重启网关」时外壳会继续引用**已删除旧 bundle** 的
 * HTML → 浏览器取不到 JS → **整页白屏**（实测踩过）。
 *
 * 本测试固化两点：
 *   ① `shellPayload().html` 必须等于当前 `dist-admin/index.html` 的内容（不引用过期产物）；
 *   ② 启用 dist 时缓存键带 `dist:` 前缀（含 index.html 指纹，构建变更即换键）。
 *
 * 无 `dist-admin`（未构建前端）或显式禁用 dist 时自动 skip，不误报。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { shellPayload } from '../admin/shell.js';
const indexHtmlPath = join(process.cwd(), 'dist-admin', 'index.html');
const distAvailable = existsSync(indexHtmlPath) && process.env['RELAY_DISABLE_DIST_ADMIN'] !== '1';
test('L5: 管理外壳 == 最新构建产物 index.html，且缓存键含指纹', { skip: !distAvailable ? 'dist-admin 不存在（未构建前端）' : false }, () => {
    const indexHtml = readFileSync(indexHtmlPath, 'utf8');
    const shell = shellPayload();
    assert.equal(shell.html, indexHtml, 'shellPayload 返回的外壳必须与 dist-admin/index.html 逐字一致');
    assert.ok(shell.key.startsWith('dist:'), `启用 dist 时缓存键应带 dist: 前缀（当前 ${shell.key}）`);
    assert.ok(shell.key.length > 'dist:'.length, '缓存键必须包含 index.html 指纹（构建变更即换键）');
});
//# sourceMappingURL=shell-cache.test.js.map