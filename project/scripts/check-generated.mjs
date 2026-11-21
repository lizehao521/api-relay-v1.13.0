/**
 * L-04 生成物一致性校验（部署/提交前的门禁）。
 *
 * 背景（代码检视报告 L-04）：仓库里有三类"生成物"，此前没有任何校验，
 * 存在"源码改了、生成物没跟上"的静默漂移风险：
 *   ① `src/admin/dashboard-app-min.ts`（由 src/admin/gen-app-min.mjs 从 APP_SRC 压缩而来）；
 *   ② `dist/**`（由 tsc 从 src 编译而来）；
 *   ③ `dist-admin/**`（前端构建产物，由 admin/api.ts 以 /admin/assets/* 对外服务）。
 *
 * 本脚本只做只读校验（不改文件），任一不合格则退出码 1：
 *   A. min 新鲜度：sha256(dist/admin/dashboard.js → APP_SRC) 必须等于产物里记录的 DASHBOARD_APP_SHA；
 *   B. min 可复现：用与生成器相同的参数重算 min，必须与产物里的 DASHBOARD_APP_MIN **逐字节一致**
 *      （不一致 = 被手改或生成器/参数漂移，页面会静默服务与源码不符的脚本）；
 *   C. dist-admin：index.html 引用的每个 /admin/assets/* 资源必须真实存在于 dist-admin/assets。
 *
 * 失败时的修复动作：`node src/admin/gen-app-min.mjs && npm run build`（A/B）
 * 或 `npm --prefix frontend run build` 后同步 dist-admin（C）。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const require = createRequire(import.meta.url);

const problems = [];
const fail = (code, msg, fix) => problems.push({ code, msg, fix });
const ok = (msg) => console.log('  ok  ' + msg);

// ---------- A/B：dashboard min 新鲜度 + 可复现 ----------
const dashPath = join(root, 'dist', 'admin', 'dashboard.js');
const minPath = join(root, 'dist', 'admin', 'dashboard-app-min.js');
if (!existsSync(dashPath) || !existsSync(minPath)) {
  fail('GEN-A0', 'dist/admin/dashboard.js 或 dashboard-app-min.js 缺失', 'npm run build');
} else {
  const { APP_SRC } = await import(pathToFileURL(dashPath).href);
  const { DASHBOARD_APP_SHA, DASHBOARD_APP_MIN } = await import(pathToFileURL(minPath).href);
  if (typeof APP_SRC !== 'string' || APP_SRC.length < 10000) {
    fail('GEN-A1', 'dist/admin/dashboard.js 未导出有效 APP_SRC', 'npm run build');
  } else {
    const sha = createHash('sha256').update(APP_SRC, 'utf8').digest('hex');
    if (sha !== DASHBOARD_APP_SHA) {
      fail('GEN-A2', `min 已过期：APP_SRC sha=${sha.slice(0, 16)}…，产物记录=${String(DASHBOARD_APP_SHA).slice(0, 16)}…`,
        'node src/admin/gen-app-min.mjs && npm run build');
    } else {
      ok('min 新鲜度：APP_SRC sha256 与产物记录一致');
    }
    let esbuild;
    try {
      esbuild = require(join(root, 'node_modules', 'esbuild'));
    } catch {
      fail('GEN-B0', 'esbuild 不可用，无法复算 min', 'npm install');
    }
    if (esbuild) {
      const recomputed = esbuild.transformSync(APP_SRC, { minify: true, target: 'es2020', charset: 'utf8' }).code;
      if (recomputed !== DASHBOARD_APP_MIN) {
        fail('GEN-B1', `min 产物与源码复算不一致（产物 ${DASHBOARD_APP_MIN.length}B，复算 ${recomputed.length}B）——被手改或生成器参数漂移`,
          'node src/admin/gen-app-min.mjs && npm run build');
      } else {
        ok('min 可复现：重算结果与产物逐字节一致');
      }
    }
  }
}

// ---------- C：dist-admin SPA 引用完整性 ----------
const spaHtml = join(root, 'dist-admin', 'index.html');
const spaAssetsDir = join(root, 'dist-admin', 'assets');
if (!existsSync(spaHtml)) {
  fail('GEN-C0', 'dist-admin/index.html 缺失', 'npm --prefix frontend run build 后同步 dist-admin');
} else {
  const html = readFileSync(spaHtml, 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="\/admin\/assets\/([^"]+)"/g)].map((m) => m[1]);
  if (refs.length === 0) {
    fail('GEN-C1', 'dist-admin/index.html 未引用任何 /admin/assets/* 资源', '重建前端产物');
  }
  const present = existsSync(spaAssetsDir) ? readdirSync(spaAssetsDir) : [];
  for (const r of refs) {
    if (present.includes(basename(r))) ok(`dist-admin 资源存在：${r}`);
    else fail('GEN-C2', `dist-admin/index.html 引用了不存在的资源：${r}`, 'npm --prefix frontend run build 后同步 dist-admin/assets');
  }
}

// ---------- 汇总 ----------
console.log('\n生成物一致性校验（L-04）：');
console.log(`  检查项：min 新鲜度 / min 可复现 / dist-admin 引用；问题 ${problems.length} 项`);
if (problems.length > 0) {
  for (const p of problems) console.error(`  FAIL [${p.code}] ${p.msg}\n        修复：${p.fix}`);
  process.exit(1);
}
console.log('  PASS 全部生成物与源码一致');
process.exit(0);