/**
 * 前端渲染冒烟测试（P0-2）。
 *
 * 背景：2026-10-23 线上事故 —— 总览页因 `Promise.all` 参数数组内引用解构变量产生 TDZ
 * （`Cannot access 'ge' before initialization`），被组件 `catch` 后伪装成"网络不可达"，
 * 而当时的测试体系**完全覆盖不到"页面是否能渲染"**（只有纯逻辑单测）。
 *
 * 本脚本逐页签真实渲染，断言：
 *   1) 无未捕获脚本错误（pageerror）
 *   2) 正文长度达到阈值（空白页直接失败）
 *   3) 不出现已知错误态文案（Cannot access / 数据加载失败 / 面板脚本错误）
 *
 * 用法：
 *   RELAY_ADMIN_TOKEN=... node scripts/smoke-render.mjs
 *   RELAY_SMOKE_USER=judge RELAY_SMOKE_PASS=... node scripts/smoke-render.mjs
 *   环境变量：RELAY_BASE（默认 http://127.0.0.1:8787）、CHROME_PATH（默认 /usr/bin/google-chrome）
 */
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';

const BASE = process.env.RELAY_BASE || 'http://127.0.0.1:8787';
const TABS = ['ov', 'met', 'users', 'ch', 'kb', 'agent', 'agentchat', 'ledger', 'diag', 'ops', 'trust'];
const MIN_LEN = 200;
const BAD_MARKERS = ['Cannot access', '数据加载失败', '面板脚本错误'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 浏览器可执行文件：显式 CHROME_PATH 优先，否则按平台常见安装位置探测。
 *  之前的默认值写死 `/usr/bin/google-chrome`，在 Windows/macOS 上等于"门禁不可用"。 */
function resolveChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates =
    process.platform === 'win32'
      ? [
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
          'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        ]
      : process.platform === 'darwin'
        ? [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
          ]
        : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'];
  for (const p of candidates) if (existsSync(p)) return p;
  return candidates[0];
}

const CHROME = resolveChrome();

async function acquireToken() {
  const direct = process.env.RELAY_ADMIN_TOKEN || '';
  if (direct) return direct;
  const u = process.env.RELAY_SMOKE_USER;
  const p = process.env.RELAY_SMOKE_PASS;
  if (!u || !p) return '';
  const r = await fetch(BASE + '/admin/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: u, password: p }),
  });
  const body = await r.json().catch(() => ({}));
  return body.token || '';
}

const token = await acquireToken();
if (!token) {
  console.error('[smoke] 需要 RELAY_ADMIN_TOKEN，或 RELAY_SMOKE_USER / RELAY_SMOKE_PASS');
  process.exit(2);
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
});

const failures = [];
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String((e && e.message) || e)));

  await page.goto(BASE + '/admin', { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => localStorage.setItem('relay_admin_token', t), token);

  for (const tab of TABS) {
    const before = pageErrors.length;
    await page.goto(BASE + '/admin/#' + tab, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await sleep(2200);
    const info = await page.evaluate(() => {
      const t = document.body ? document.body.textContent || '' : '';
      return { len: t.length, text: t };
    });
    const newErrs = pageErrors.slice(before);
    const bad = BAD_MARKERS.filter((m) => info.text.includes(m));
    const problems = [];
    if (newErrs.length) problems.push('pageerror: ' + newErrs[0].slice(0, 120));
    if (info.len < MIN_LEN) problems.push('正文过短(' + info.len + ')');
    if (bad.length) problems.push('错误态文案: ' + bad.join('/'));
    const status = problems.length ? 'FAIL' : 'ok';
    console.log(`[smoke] ${tab.padEnd(10)} ${status}  len=${info.len}${problems.length ? '  ' + problems.join('; ') : ''}`);
    if (problems.length) failures.push({ tab, problems });
  }
} finally {
  await browser.close();
}

if (failures.length) {
  console.error(`\n[smoke] 失败 ${failures.length}/${TABS.length} 个页签：`);
  for (const f of failures) console.error('  - ' + f.tab + ': ' + f.problems.join('; '));
  process.exit(1);
}
console.log(`\n[smoke] 全部 ${TABS.length} 个页签渲染通过`);