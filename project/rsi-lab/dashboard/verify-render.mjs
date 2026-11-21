import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const puppeteer = require('../../node_modules/puppeteer-core');

const EDGES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
];
const executablePath = EDGES.find((p) => fs.existsSync(p));
if (!executablePath) { console.log('EDGE_NOT_FOUND'); process.exit(2); }

const browser = await puppeteer.launch({ executablePath, headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1100 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto('http://127.0.0.1:18800/', { waitUntil: 'networkidle0', timeout: 20000 });
await page.waitForSelector('.kpi', { timeout: 10000 });
await new Promise((r) => setTimeout(r, 800));

const result = await page.evaluate(() => ({
  title: document.title,
  kpis: document.querySelectorAll('.kpi').length,
  ledgerRows: document.querySelectorAll('#ledgerBody tr').length,
  roundCards: document.querySelectorAll('#roundGrid .card').length,
  metaLine: document.getElementById('metaLine').innerText,
  bodyLen: document.body.innerText.length
}));

await page.screenshot({ path: 'dashboard/screenshot.png', fullPage: true });
console.log(JSON.stringify(result, null, 1));
console.log('pageErrors=', errors.length, errors.slice(0, 3));
if (errors.length > 0) process.exit(1);
await browser.close();