/**
 * 移动端适配审计（真机视口）。
 * 逐页签检测：水平溢出（scrollWidth>clientWidth）、溢出元素、过小触控目标。
 */
import puppeteer from 'puppeteer-core';

const BASE = process.env.RV_BASE || 'http://127.0.0.1:8787';
const CHROME = process.env.RV_CHROME || '/usr/bin/google-chrome';
const TABS = ['ov', 'met', 'users', 'ch', 'kb', 'agent', 'agentchat', 'ledger', 'diag', 'ops', 'trust'];
const VIEWPORTS = [
  { name: 'iPhone12(390x844@3)', width: 390, height: 844, dpr: 3 },
  { name: 'Android(360x740@2)', width: 360, height: 740, dpr: 2 },
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const lr = await fetch(BASE + '/admin/api/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: process.env.RV_USER, password: process.env.RV_PASS }),
});
const { token } = await lr.json();
if (!token) throw new Error('登录失败');

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
});

const probe = (page) =>
  page.evaluate(() => {
    const de = document.documentElement;
    const vw = de.clientWidth;
    const overflow = de.scrollWidth - vw;
    const wide = [];
    for (const el of document.querySelectorAll('body *')) {
      const rc = el.getBoundingClientRect();
      if (rc.width === 0) continue;
      if (rc.right > vw + 1) {
        wide.push({
          tag: el.tagName,
          cls: String(el.className || '').slice(0, 30),
          right: Math.round(rc.right),
          w: Math.round(rc.width),
        });
        if (wide.length >= 4) break;
      }
    }
    let small = 0;
    for (const el of document.querySelectorAll('button,a,[role=button]')) {
      const rc = el.getBoundingClientRect();
      if (rc.width > 0 && (rc.height < 32 || rc.width < 32)) small++;
    }
    return { vw, overflow, wide, small, len: (document.body.textContent || '').length };
  });

for (const vp of VIEWPORTS) {
  console.log(`\n##### ${vp.name} #####`);
  const page = await browser.newPage();
  await page.setViewport({ width: vp.width, height: vp.height, deviceScaleFactor: vp.dpr, isMobile: true, hasTouch: true });
  await page.goto(BASE + '/admin', { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => localStorage.setItem('relay_admin_token', t), token);

  for (const tab of TABS) {
    await page.goto(BASE + '/admin/#' + tab, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await sleep(1300);
    const i = await probe(page);
    const flag = i.overflow > 0 ? '  ✗ 溢出元素: ' + JSON.stringify(i.wide) : '';
    console.log(`  ${tab.padEnd(10)} vw=${i.vw} overflow=${i.overflow}px 小触控=${i.small} 正文=${i.len}${flag}`);
  }

  await page.goto(BASE + '/judge', { waitUntil: 'domcontentloaded' });
  await sleep(1600);
  const j = await probe(page);
  const jf = j.overflow > 0 ? '  ✗ 溢出元素: ' + JSON.stringify(j.wide) : '';
  console.log(`  ${'judge'.padEnd(10)} vw=${j.vw} overflow=${j.overflow}px 小触控=${j.small} 正文=${j.len}${jf}`);
  await page.close();
}

await browser.close();