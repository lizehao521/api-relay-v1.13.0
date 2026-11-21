/**
 * 前端运行时错误捕获：逐页签打开管理面板，记录 pageerror / console.error 及堆栈位置。
 * 目的：定位 "Cannot access 'xx' before initialization"（TDZ）的真实触发点。
 */
const puppeteer = require('puppeteer-core');

const CHROME = process.env.RV_CHROME || '/usr/bin/google-chrome';
const BASE = process.env.RV_BASE || 'http://127.0.0.1:8787';
const USER = process.env.RV_USER || '';
const PASS = process.env.RV_PASS || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!USER || !PASS) throw new Error('缺少 RV_USER / RV_PASS');
  const r = await fetch(BASE + '/admin/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  const { token } = await r.json();
  if (!token) throw new Error('登录失败');

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });

  const errors = [];
  page.on('pageerror', (e) => {
    errors.push({ kind: 'pageerror', msg: String(e && e.message || e), stack: String(e && e.stack || '') });
  });
  page.on('console', (m) => {
    if (m.type() === 'error') {
      errors.push({ kind: 'console', msg: m.text().slice(0, 400), stack: '' });
    }
  });

  await page.goto(BASE + '/admin', { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => localStorage.setItem('relay_admin_token', t), token);

  const tabs = ['ov', 'met', 'users', 'ch', 'kb', 'agent', 'agentchat', 'ledger', 'diag', 'ops', 'trust'];
  for (const tab of tabs) {
    const before = errors.length;
    await page.goto(BASE + '/admin/#' + tab, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await sleep(1800);
    const added = errors.length - before;
    console.log(`--- tab ${tab}: +${added} error(s)`);
  }

  console.log('\n===== CAPTURED ERRORS (' + errors.length + ') =====');
  errors.forEach((e, i) => {
    console.log(`[${i + 1}] ${e.kind}: ${e.msg}`);
    if (e.stack) {
      console.log(e.stack.split('\n').slice(0, 6).map((l) => '      ' + l.trim()).join('\n'));
    }
  });

  await browser.close();
})().catch((e) => {
  console.error('FAILED:', e && e.message ? e.message : e);
  process.exit(1);
});