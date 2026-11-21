import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const LAB_ROOT = path.resolve(__dirname, '..');
export const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

export const abs = (p) => (path.isAbsolute(p) ? p : path.resolve(LAB_ROOT, p));
export const SANDBOX = abs(CONFIG.paths.sandbox);
export const RUNS = abs(CONFIG.paths.runs);
export const DATA = abs(CONFIG.paths.data);
export const STATE_FILE = path.join(LAB_ROOT, 'state.json');
export const STOP_FILE = path.join(LAB_ROOT, 'STOP');
export const SCORES_FILE = path.join(LAB_ROOT, 'scores.jsonl');
export const LEDGER_FILE = path.join(LAB_ROOT, 'ledger.jsonl');
export const CODELENS = `http://${CONFIG.codelens.host}:${CONFIG.codelens.port}`;

export function readApiKey() {
  const file = abs(CONFIG.llm.apiKeyFile);
  if (file.endsWith('.json')) {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!j.key) throw new Error('凭据文件缺少 key 字段: ' + file);
    return j.key;
  }
  const line = fs.readFileSync(file, 'utf8').split('\n').find((l) => l.trim().startsWith(CONFIG.llm.apiKeyPrefix));
  if (!line) throw new Error('未找到 API Key 行: ' + file);
  return line.trim().slice(CONFIG.llm.apiKeyPrefix.length).trim();
}

export function git(args, opts = {}) {
  const r = spawnSync('git', ['-C', SANDBOX, ...args], { encoding: 'utf8', ...opts });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

export function headCommit() {
  return git(['rev-parse', 'HEAD']);
}

export function sandboxDirty() {
  return git(['status', '--porcelain']).length > 0;
}

export function resetSandbox(commit) {
  git(['reset', '--hard', commit]);
  git(['clean', '-fdx']);
}

export function commitSandbox(message) {
  git(['add', '-A', '--', '.', ':(exclude).artifacts']);
  const r = spawnSync('git', ['-C', SANDBOX, '-c', 'user.name=RSI Lab', '-c', 'user.email=rsi@local.invalid', 'commit', '-m', message], { encoding: 'utf8' });
  if (r.status !== 0) return { committed: false, reason: (r.stdout + r.stderr).trim().slice(0, 200) };
  return { committed: true, commit: headCommit() };
}

export function loadState() {
  if (!fs.existsSync(STATE_FILE)) return null;
  return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
}

export function saveState(s) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

export function appendScore(row) {
  fs.appendFileSync(SCORES_FILE, JSON.stringify(row) + '\n');
}

export function loadLedger() {
  if (!fs.existsSync(LEDGER_FILE)) return [];
  return fs.readFileSync(LEDGER_FILE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

export function saveLedger(entries) {
  fs.writeFileSync(LEDGER_FILE, entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''));
}

export function evaluateSandbox(timeoutMs = 60000) {
  const runOnce = () => {
    const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap'], {
      cwd: SANDBOX, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, NODE_TEST_CONTEXT: undefined },
    });
    const text = (r.stdout || '') + (r.stderr || '');
    const pass = Number((text.match(/# pass (\d+)/) || [])[1] ?? 0);
    const fail = Number((text.match(/# fail (\d+)/) || [])[1] ?? 0);
    const total = pass + fail;
    return { text, pass, fail, total, exitCode: r.status ?? (r.error ? -1 : 1) };
  };
  let out = runOnce();
  if (out.total === 0) out = runOnce();
  return {
    pass: out.pass,
    fail: out.fail,
    total: out.total,
    score: out.total ? out.pass / out.total : 0,
    exitCode: out.exitCode,
    log: out.text,
  };
}

export function approvalPolicy(name, args) {
  if (name === 'sys.exec') {
    const cmd = String(args?.command ?? '');
    const av = Array.isArray(args?.args) ? args.args.map(String) : [];
    if (cmd !== 'node') return { decision: 'reject', reason: 'RSI 策略：只允许 node' };
    if (av.some((a) => ['-e', '--eval', '-p', '--print', '--input-type'].includes(a))) {
      return { decision: 'reject', reason: 'RSI 策略：拒绝解释器内联执行' };
    }
    if (av[0] === '--test' || /\.(m?js|cjs)$/.test(av[0] ?? '')) return { decision: 'allow_once' };
    return { decision: 'reject', reason: 'RSI 策略：仅允许 node --test / node <script>' };
  }
  if (name === 'http.request') return { decision: 'reject', reason: 'RSI 策略：禁止出网' };
  if (name === 'fs.write') {
    const p = String(args?.path ?? '').replace(/\\/g, '/');
    if (!p || p.includes('..') || /^\/|[A-Za-z]:/.test(p)) {
      return { decision: 'reject', reason: 'RSI 策略：拒绝沙箱外路径' };
    }
    if (/^(\.\/)?tests?\//.test(p) || p === 'package.json' || p === 'package-lock.json') {
      return { decision: 'reject', reason: 'RSI 策略：禁止修改测试与依赖清单' };
    }
    return { decision: 'allow_once' };
  }
  if (name === 'fs.read') return { decision: 'allow_once' };
  return { decision: 'reject', reason: 'RSI 策略：未授权工具 ' + name };
}

export async function decideApproval(evt, policy) {
  const url = `${CODELENS}/api/v1/approvals/${encodeURIComponent(evt.approvalId)}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: evt.approvalToken, decision: policy.decision, reason: policy.reason })
  });
  return { status: r.status, ok: r.ok };
}

export function payloadHashOf(payload) {
  return createHash('sha256').update(JSON.stringify(payload, Object.keys(payload || {}).sort())).digest('hex');
}

export const SEMANTICS = {
  'src/stats.js': 'mode(xs) 返回众数（并列取较小值，空数组 NaN）；variance(xs) 返回样本方差（分母 n-1，n<2 为 0）；correlation(xs, ys) 返回皮尔逊相关系数（长度不等、空数组或任一方差为 0 时 NaN）。'
};

export function pendingTargets(dir = SANDBOX, include = ['src']) {
  const out = [];
  for (const base of include) {
    const absBase = path.join(dir, base);
    if (!fs.existsSync(absBase)) continue;
    for (const entry of fs.readdirSync(absBase, { withFileTypes: true })) {
      if (!entry.isFile() || !/\.(m?js|cjs)$/.test(entry.name)) continue;
      if (!fs.readFileSync(path.join(absBase, entry.name), 'utf8').includes('not implemented')) continue;
      const rel = `${base}/${entry.name}`;
      if (!out.includes(rel)) out.push(rel);
    }
  }
  return out.sort();
}

export function renderTaskPrompt(files, hintLookup = () => null) {
  const list = files.length ? files : ['src/stats.js'];
  const hints = list.map((f) => SEMANTICS[f] ?? hintLookup(f)).filter(Boolean);
  return [
    '你是受控 RSI 实验中的自改进 Agent。沙箱根目录下是一个统计工具库项目。',
    '本轮只做一件事：在下面列出的文件里，挑第一个仍含 "not implemented" 的函数并完整实现它。',
    ...list.map((f) => `- ${f}`),
    ...(hints.length ? ['各文件的函数语义：', ...hints.map((h) => `- ${h}`)] : []),
    '要求：不要读测试文件、不要列目录、不要一次改多个函数；只改你挑中的那一个文件；',
    '必须通过 fs.write 工具写入文件（不要把代码写在回复正文里）；可以覆盖写入完整文件，总行数不超过 160 行；改完立即用 sys.exec 运行 node --test。',
    '约束：禁止修改 test/ 与 package.json；禁止访问沙箱外路径；禁止出网；只允许执行 node。',
    '最后用一句话说明实现了哪个函数、测试结果如何。'
  ].join('\n');
}

export const TASK_PROMPT = renderTaskPrompt(['src/stats.js']);

export function sseParse(chunk, onEvent) {
  let buf = chunk;
  return {
    feed(text) {
      buf += text;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, i);
        buf = buf.slice(i + 2);
        let name = 'message';
        let data = '';
        for (const line of raw.split('\n')) {
          if (line.startsWith('event: ')) name = line.slice(7).trim();
          else if (line.startsWith('data: ')) data += line.slice(6);
        }
        let parsed = null;
        try { parsed = data ? JSON.parse(data) : null; } catch { parsed = { raw: data }; }
        onEvent(name, parsed);
      }
      return buf;
    }
  };
}