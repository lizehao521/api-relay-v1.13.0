/**
 * 在线看板录制脚本 v2（puppeteer-core + 系统 Chrome，跑在 Xvfb 上）。
 *
 * 与 v1 的区别：**先让页面完全就绪，再通知外部开始录屏**（消除片头白屏）。
 *  1) 只读账号（judge）登录拿会话 token；
 *  2) 打开 /admin、注入 token、刷新并等待首屏数据加载完成 → 写 /tmp/rec-ready；
 *  3) 等待 /tmp/rec-go（外部 ffmpeg 已开始录制）→ 再执行页签浏览计划；
 *  4) 计划结束 → 写 /tmp/rec-done。
 */
const fs = require('node:fs');
const puppeteer = require('puppeteer-core');

const CHROME = process.env.RV_CHROME || '/usr/bin/google-chrome';
const BASE = process.env.RV_BASE || 'http://127.0.0.1:8787';
const USER = process.env.RV_USER || '';
const PASS = process.env.RV_PASS || '';
const READY = '/tmp/rec-ready';
const GO = '/tmp/rec-go';
const DONE = '/tmp/rec-done';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForFile(file, timeoutMs = 90000) {
  const t0 = Date.now();
  while (!fs.existsSync(file)) {
    if (Date.now() - t0 > timeoutMs) throw new Error('等待超时: ' + file);
    await sleep(200);
  }
}

(async () => {
  if (!USER || !PASS) throw new Error('缺少 RV_USER / RV_PASS（只读账号）');
  for (const f of [READY, GO, DONE]) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }

  // 1) 只读账号登录
  const res = await fetch(BASE + '/admin/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  const login = await res.json();
  if (!res.ok || !login.token) throw new Error('登录失败：' + JSON.stringify(login).slice(0, 200));
  console.log('[rec] login ok, readonly =', login.readonly);

  // 2) 浏览器就绪并加载看板
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: false,
    defaultViewport: { width: 1600, height: 900 },
    args: [
      '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
      '--window-size=1600,900', '--window-position=0,0', '--kiosk',
      '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
      '--disable-infobars', '--force-device-scale-factor=1', '--lang=zh-CN',
    ],
  });
  const page = await browser.newPage();
  await page.goto(BASE + '/admin', { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => localStorage.setItem('relay_admin_token', t), login.token);
  await page.reload({ waitUntil: 'networkidle2' });
  await page.evaluate(() => { location.hash = 'ov'; });
  await sleep(5000); // 等首屏数据/图表渲染完
  // 就绪断言（2026-10-23 补）：录制前必须确认页面**不处于错误态**。
  // 否则会把「数据加载失败 / Cannot access 'xx' before initialization」这类真实故障
  // 原样录进演示视频 —— 本片第一版正是这么来的（TDZ 修复上线前录的总览页，
  // 整段画面都是错误提示，事后再看才发现）。
  const bodyText = await page.evaluate(() => document.body.textContent || '');
  const badMarkers = ['数据加载失败', 'Cannot access', '面板脚本错误'];
  const hit = badMarkers.find((m) => bodyText.includes(m));
  if (hit) {
    throw new Error(
      '录制中止：页面处于异常态（命中「' + hit + '」）——请先修好页面再录。片段：' +
        bodyText.replace(/\s+/g, ' ').slice(0, 160),
    );
  }
  if (bodyText.length < 200) {
    throw new Error('录制中止：页面正文过短（' + bodyText.length + '），疑似未渲染完成');
  }

  fs.writeFileSync(READY, '1');
  console.log('[rec] page ready');

  // 3) 等外部开始录屏
  await waitForFile(GO);
  console.log('[rec] recording started, begin tab tour');
  await sleep(2500); // 开场静止 2.5s，首帧稳定

  const plan = [
    ['ov', 34000],
    ['met', 24000],
    ['ch', 20000],
    ['ledger', 26000],
    ['agent', 26000],
    ['ov', 18000],
  ];
  for (const [tab, ms] of plan) {
    await page.evaluate((t) => { location.hash = t; }, tab);
    console.log('[rec] tab', tab, 'for', ms, 'ms');
    await sleep(ms);
  }

  fs.writeFileSync(DONE, '1');
  await browser.close();
  console.log('[rec] done');
})().catch((e) => {
  console.error('[rec] FAILED:', e && e.message ? e.message : e);
  try { fs.writeFileSync(DONE, 'err'); } catch { /* ignore */ }
  process.exit(1);
});