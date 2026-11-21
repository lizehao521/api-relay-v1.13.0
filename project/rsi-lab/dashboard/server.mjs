import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getSummary, getRoundDetail, listRoundDirs, ledgerSummary } from './data.mjs';

const ROUNDS_ROOT = path.join(process.cwd(), 'runs');
const LEDGER_PATH = path.join(process.cwd(), 'ledger.jsonl');
const STATE_PATH = path.join(process.cwd(), 'state.json');
const HTML_PATH = path.join(process.cwd(), 'dashboard', 'index.html');
const PORT = Number(process.env.PORT) || 18800;

let htmlCache = null;
let htmlMtime = 0;

async function loadHtml() {
  try {
    const st = await fs.stat(HTML_PATH);
    if (!htmlCache || st.mtimeMs !== htmlMtime) {
      htmlCache = await fs.readFile(HTML_PATH, 'utf8');
      htmlMtime = st.mtimeMs;
    }
  } catch {
    htmlCache = '<h1>RSI Lab 看板未就绪</h1>';
  }
  return htmlCache;
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  try {
    if (p === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(await loadHtml());
      return;
    }
    if (p === '/api/summary') return json(res, 200, await getSummary(ROUNDS_ROOT, LEDGER_PATH, STATE_PATH));
    if (p === '/api/rounds') return json(res, 200, { rounds: await listRoundDirs(ROUNDS_ROOT) });
    if (p === '/api/round') return json(res, 200, await getRoundDetail(ROUNDS_ROOT, Number(url.searchParams.get('round'))));
    if (p === '/api/ledger') {
      let entries = [];
      try {
        const text = await fs.readFile(LEDGER_PATH, 'utf8');
        entries = text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      } catch {}
      return json(res, 200, ledgerSummary(entries));
    }
    res.writeHead(404);
    res.end('not found');
  } catch (e) {
    json(res, 500, { error: String(e) });
  }
});

server.listen(PORT, () => console.log(`RSI 看板 HTTP 监听 ${PORT}`));