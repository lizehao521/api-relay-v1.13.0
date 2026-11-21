/**
 * 复核 Overview 修复效果：读 textContent + 截图存档（innerText 依赖可见性，易得空串）。
 */
const puppeteer = require('puppeteer-core');

const CHROME = process.env.RV_CHROME || '/usr/bin/google-chrome';
const BASE = process.env.RV_BASE || 'http://127.0.0.1:8787';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const r = await fetch(BASE + '/admin/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: process.env.RV_USER, password: process.env.RV_PASS }),
  });
  const { token } = await r.json();

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e && e.message || e)));

  await page.goto(BASE + '/admin', { waitUntil: 'networkidle2' });
  await page.evaluate((t) => localStorage.setItem('relay_admin_token', t), token);
  await page.goto(BASE + '/admin/#ov', { waitUntil: 'networkidle2' });
  await sleep(6000);

  const info = await page.evaluate(() => {
    const t = document.body.textContent || '';
    return {
      len: t.length,
      hasLoadFail: t.includes('数据加载失败'),
      hasScriptErr: t.includes('面板脚本错误'),
      hasTDZ: t.includes('Cannot access'),
      hasDashboard: t.includes('请求数') || t.includes('Token 用量'),
      snippet: t.replace(/\s+/g, ' ').slice(0, 260),
    };
  });
  await page.screenshot({ path: '/tmp/ov-after.png', fullPage: false });
  console.log('pageerrors =', JSON.stringify(errs));
  console.log('info =', JSON.stringify(info, null, 2));
  await browser.close();
})().catch((e) => {
  console.error('FAILED:', e && e.message ? e.message : e);
  process.exit(1);
});