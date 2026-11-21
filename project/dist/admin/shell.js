/**
 * 管理面 HTML 外壳与静态资源加载（C2·审查修复·模块归档）。
 *
 * 从 `admin/api.ts` 抽出：这些函数**不读 this**、也不依赖 AdminApi 的任何服务，
 * 符合本层既定的抽层判据①（不读 this.* → 抽成模块级函数）。抽出的收益与
 * `admin/response.ts` 同款：api.ts 只留组合与路由，外壳/缓存/资源加载自成一文件，
 * 且进程内缓存（SHELL_CACHE / DIST_INDEX_CACHE）与它的失效策略住在一起，不会被拆散。
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { dashboardHtml } from './dashboard.js';
let SHELL_CACHE = null;
export function shellPayload() {
    // 回落链（frontend/ 改造）：dist-admin/index.html（新前端构建产物）→
    // overrides/dashboard.html（用户换皮）→ 内嵌 dashboardHtml()（旧版单文件面板）。
    // dist-admin 存在时优先新面板；不存在时行为与旧版完全一致（269 项测试不破坏）。
    // 开关按调用时判定 + 按开关分份缓存——e2e 先禁用后启用时两份缓存互不串味。
    const useDist = distAdminEnabled();
    // key 携带 index.html 指纹：前端重新构建后（bundle 文件名换 hash）必须让外壳缓存失效，
    // 否则 /admin 会一直返回引用**已删除旧 bundle** 的 HTML → 页面白屏（实测踩过该回归）。
    const key = useDist ? 'dist:' + distIndexStamp() : 'legacy';
    if (!SHELL_CACHE || SHELL_CACHE.key !== key) {
        const fromDist = useDist ? loadDistAdminIndex() : undefined;
        const html = fromDist ?? loadCustomDashboard(process.cwd()) ?? dashboardHtml();
        SHELL_CACHE = { html, gz: gzipSync(Buffer.from(html), { level: 6 }), key };
    }
    return SHELL_CACHE;
}
/** dist-admin/assets/<file>：构建产物带内容哈希文件名，可 immutable 长缓存。
 *  只接受单段文件名（basename），杜绝路径穿越。 */
export function loadDistAdminAsset(file) {
    const safe = file.split(/[\\/]/).pop() ?? '';
    if (!/^[\w.-]+\.(js|css|map|svg|png|woff2?)$/.test(safe))
        return undefined;
    const p = join(process.cwd(), 'dist-admin', 'assets', safe);
    try {
        if (!existsSync(p))
            return undefined;
        const body = readFileSync(p);
        const type = safe.endsWith('.js') ? 'text/javascript; charset=utf-8'
            : safe.endsWith('.css') ? 'text/css; charset=utf-8'
                : safe.endsWith('.svg') ? 'image/svg+xml'
                    : safe.endsWith('.png') ? 'image/png'
                        : safe.endsWith('.map') ? 'application/json'
                            : 'font/woff2';
        return { body, type };
    }
    catch {
        return undefined;
    }
}
/** 新面板开关：RELAY_DISABLE_DIST_ADMIN=1 强制回落旧版内联 HTML（运维逃生门 + 测试隔离） */
function distAdminEnabled() {
    return process.env.RELAY_DISABLE_DIST_ADMIN !== '1';
}
/** dist-admin/index.html 路径 */
function distAdminIndexPath() {
    return join(process.cwd(), 'dist-admin', 'index.html');
}
/**
 * 构建产物指纹（size + mtimeMs）。
 *
 * 前端每次 `vite build` 都会产出新的 bundle 文件名，index.html 随之改变；
 * 进程内缓存必须按指纹失效 —— 否则「重新构建前端但不重启网关」时，
 * /admin 会继续发出引用**已删除旧 bundle** 的 HTML，浏览器取不到 JS → **整页白屏**。
 */
function distIndexStamp() {
    try {
        const st = statSync(distAdminIndexPath());
        return st.size + ':' + Math.floor(st.mtimeMs);
    }
    catch {
        return 'missing';
    }
}
/** dist-admin（frontend/ 构建产物）进程内缓存；按 index.html 指纹失效（不存在时为 undefined） */
let DIST_INDEX_CACHE = null;
function loadDistAdminIndex() {
    const stamp = distIndexStamp();
    if (DIST_INDEX_CACHE && DIST_INDEX_CACHE.stamp === stamp)
        return DIST_INDEX_CACHE.html;
    let html;
    try {
        const p = distAdminIndexPath();
        html = existsSync(p) ? readFileSync(p, 'utf8') : undefined;
    }
    catch {
        html = undefined;
    }
    DIST_INDEX_CACHE = { stamp, html };
    return html;
}
/** 若存在用户自定义看板模板则优先使用（方便不改代码就换皮） */
export function loadCustomDashboard(root) {
    const p = `${root}/overrides/dashboard.html`;
    try {
        return existsSync(p) ? readFileSync(p, 'utf8') : undefined;
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=shell.js.map