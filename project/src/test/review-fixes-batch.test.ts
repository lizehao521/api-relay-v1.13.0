/**
 * 代码审查修复的针对性回归测试。
 *
 * 与既有的 `review-fixes.test.ts` 同族：把"审查发现 → 修复"的每条不变量钉在测试里，
 * 防止日后重构时悄悄回退。本文件覆盖本轮审查的批次 1～3：
 *   - 缺点#2：鉴权失败 error.type 映射（并发超限须与 429 同义）
 *   - 缺点#3：上游数字 code 规范化（OpenRouter 形态，OpenAI 契约要求 string）
 *
 * 本轮回归复测（2026-10-29）新增：
 *   - P1：不可达归因 → HTTP 状态码映射（永久故障不得伪装成"稍后重试"的 503）
 *   - P2：CLI 四条命令统一错误出口（不再抛未捕获异常、不再泄露本机绝对路径堆栈）
 *   - P2：MockUpstream 缺省 logger 时 listen() 崩溃（联调脚本 verify_admin.mjs 现场）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asErrorCode, authErrorType, noRouteStatus } from '../gateway/engine.js';
import { deriveReadOnlyActions } from '../admin/api.js';
import { ConfigLoadError, main, parseArgs, renderCliError } from '../cli.js';
import { MockUpstream } from '../mock/upstream.js';
import { Logger } from '../core/logger.js';
import type { FailureReason } from '../core/types.js';
import type { Route } from '../admin/router.js';

test('asErrorCode：数字 code 规范化为字符串（OpenRouter 形态·缺点#3）', () => {
  assert.equal(asErrorCode(42, 'upstream_error'), '42');
  assert.equal(asErrorCode(0, 'upstream_error'), '0');
  assert.equal(typeof asErrorCode(42, 'x'), 'string', '必须是字符串，不能透传数字');
});

test('asErrorCode：字符串 code 原样保留', () => {
  assert.equal(asErrorCode('invalid_api_key', 'upstream_error'), 'invalid_api_key');
  assert.equal(asErrorCode('', 'upstream_error'), '', '空字符串是合法上游 code，不该被回落');
});

test('asErrorCode：缺失/异常类型回落归因码', () => {
  assert.equal(asErrorCode(undefined, 'upstream_error'), 'upstream_error');
  assert.equal(asErrorCode(null, 'upstream_error'), 'upstream_error');
  assert.equal(asErrorCode({}, 'upstream_error'), 'upstream_error');
  assert.equal(asErrorCode(NaN, 'upstream_error'), 'upstream_error');
  assert.equal(asErrorCode(Number.POSITIVE_INFINITY, 'upstream_error'), 'upstream_error');
});

test('authErrorType：并发超限与限流同义为 rate_limit_error（缺点#2）', () => {
  assert.equal(authErrorType('rate_limited'), 'rate_limit_error');
  // 核心断言：too_many_concurrent 的 HTTP 状态是 429，type 必须也是 rate_limit_error，
  // 不能落回 authentication_error（否则 SDK 按鉴权错误分发、不按限流退避）。
  assert.equal(authErrorType('too_many_concurrent'), 'rate_limit_error');
});

test('authErrorType：额度/模型/鉴权的分类不变（防回归）', () => {
  assert.equal(authErrorType('quota_exhausted'), 'insufficient_quota');
  assert.equal(authErrorType('model_not_found'), 'invalid_request_error');
  assert.equal(authErrorType('model_not_allowed'), 'invalid_request_error');
  assert.equal(authErrorType('invalid_key'), 'authentication_error');
  assert.equal(authErrorType('missing_key'), 'authentication_error');
});

test('deriveReadOnlyActions：仅注册 GET 的 action 才只读（缺点#9）', () => {
  const noop = (): boolean => true;
  const routes: Route[] = [
    { method: 'GET', action: 'overview', handler: noop },
    { method: 'GET', action: 'health', handler: noop },
    { method: 'GET', action: 'evolution-direction', handler: noop },
    { method: 'POST', action: 'evolution-direction', handler: noop },
  ];
  const ro = deriveReadOnlyActions(routes);
  assert.ok(ro.has('overview'), '只读端点必须在集合内');
  assert.ok(ro.has('health'), '只读端点必须在集合内');
  // 核心：同时注册了 POST 的 action 不是只读——否则 POST 会被误判为 405。
  assert.ok(!ro.has('evolution-direction'), '有写方法的 action 不应算只读');
});

/* ------------------------------------------------------------------ *
 * P1：不可达（no route）归因 → HTTP 状态码
 * ------------------------------------------------------------------ */

test('noRouteStatus：永久故障不伪装成 503（503 等于叫客户端继续无效重试）', () => {
  // 凭据坏了 / 无权访问：重试一万次也不会好，必须是 401
  assert.equal(noRouteStatus({ failure_reason: 'auth_invalid' }), 401);
  assert.equal(noRouteStatus({ failure_reason: 'permission_denied' }), 401);
  // 余额耗尽：402（付费墙），且绝不能与"限流退避"的 429 混淆
  assert.equal(noRouteStatus({ failure_reason: 'quota_exhausted' }), 402);
  // 模型真不存在：404，调用方改模型名即可
  assert.equal(noRouteStatus({ failure_reason: 'model_not_found' }), 404);

  const permanent: FailureReason[] = ['auth_invalid', 'permission_denied', 'quota_exhausted', 'model_not_found'];
  for (const r of permanent) {
    assert.notEqual(noRouteStatus({ failure_reason: r }), 503, `${r} 是永久故障，不该返回 503`);
    assert.notEqual(noRouteStatus({ failure_reason: r }), 429, `${r} 不该被当成可退避的限流`);
  }
});

test('noRouteStatus：暂时性不可达仍返回 503（冷却后半开试探是真能恢复的）', () => {
  for (const r of ['rate_limited', 'upstream_timeout', 'upstream_unavailable', 'network_error', 'relay_internal_error', 'unknown'] as FailureReason[]) {
    assert.equal(noRouteStatus({ failure_reason: r }), 503, `${r} 属于可等待恢复，保持 503`);
  }
});

/* ------------------------------------------------------------------ *
 * P2：CLI 统一错误出口
 * ------------------------------------------------------------------ */

/** 捕获 stderr（CLI 的错误文案一律走 stderr，不能污染 stdout 的机器可读输出） */
async function captureStderr(run: () => Promise<number> | number): Promise<{ code: number; err: string; out: string }> {
  const errChunks: string[] = [];
  const outChunks: string[] = [];
  const origErr = process.stderr.write.bind(process.stderr);
  const origOut = process.stdout.write.bind(process.stdout);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    errChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    outChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stdout.write;
  try {
    return { code: await run(), err: errChunks.join(''), out: outChunks.join('') };
  } finally {
    process.stderr.write = origErr;
    process.stdout.write = origOut;
  }
}

test('renderCliError：缺环境变量时给"缺什么 + 怎么补 + 原始错误"，exit 1', () => {
  const err = new ConfigLoadError('环境变量 RELAY_ADMIN_TOKEN 未设置（配置中引用了 {ENV:RELAY_ADMIN_TOKEN}）', ['RELAY_ADMIN_TOKEN']);
  const { code, err: text } = captureSync(err);
  assert.equal(code, 1, '配置失败必须是非零退出码');
  assert.match(text, /缺少 1 项环境变量/);
  assert.match(text, /RELAY_ADMIN_TOKEN/);
  // 可执行指引：三种补齐方式都要出现（bash / PowerShell / 零密钥 demo）
  assert.match(text, /export RELAY_ADMIN_TOKEN=/);
  assert.match(text, /\$env:RELAY_ADMIN_TOKEN=/);
  assert.match(text, /relay demo/);
  assert.match(text, /原始错误：环境变量 RELAY_ADMIN_TOKEN 未设置/);
});

test('renderCliError：默认不打印堆栈、不泄露本机绝对路径（用户不需要看 C:/Users/…）', () => {
  const err = new ConfigLoadError('环境变量 X 未设置', ['X']);
  const { err: text } = captureSync(err);
  assert.ok(!text.includes('    at '), '不带 --debug 时不得出现堆栈帧');
  assert.ok(!/[A-Za-z]:[\\/]/.test(text.replace(/export|env:/g, '')), '不得出现 Windows 绝对路径');
  assert.ok(!text.includes('file://'), '不得出现 ESM file:// URL');
  // 反证：--debug 时堆栈必须出现（否则排障的人拿不到任何线索）
  const { err: debugText } = captureSync(err, { debug: true });
  assert.match(debugText, /    at /, '--debug 必须展开完整堆栈');
});

test('renderCliError：缺失项超过 12 个时截断并说明剩余数量', () => {
  const names = Array.from({ length: 15 }, (_, i) => `RELAY_MISSING_${i}`);
  const { err: text } = captureSync(new ConfigLoadError('boom', names));
  assert.match(text, /缺少 15 项环境变量/);
  assert.match(text, /RELAY_MISSING_0/);
  assert.match(text, /其余 3 项/, '截断后必须告诉用户还剩几项');
  assert.ok(!text.includes('RELAY_MISSING_14'), '第 13 项之后不再逐条列出');
});

test('renderCliError：非配置类错误只给一行结论，并提示 --debug', () => {
  const { code, err: text } = captureSync(new Error('sqlite 打开失败'));
  assert.equal(code, 1);
  assert.match(text, /命令执行失败：sqlite 打开失败/);
  assert.match(text, /--debug/);
  assert.ok(!text.includes('    at '));
  // 非 Error（字符串抛出）也不能崩
  const { code: c2, err: t2 } = captureSync('裸字符串' as unknown as Error);
  assert.equal(c2, 1);
  assert.match(t2, /命令执行失败：裸字符串/);
});

/** renderCliError 是同步函数，单独包一层便于与 main() 用例共用断言 */
function captureSync(err: unknown, opts: { debug?: boolean } = {}): { code: number; err: string } {
  let code = 0;
  const text = captureStderrSync(() => {
    code = renderCliError(err, opts);
  });
  return { code, err: text };
}

/** 同步版 stderr 捕获（renderCliError 本身同步；node:test 顶层用例串行执行，替换是安全的） */
function captureStderrSync(run: () => void): string {
  const chunks: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stderr.write;
  try {
    run();
  } finally {
    process.stderr.write = orig;
  }
  return chunks.join('');
}

test('main：catalog 遇缺失环境变量时走统一错误出口，不再抛未捕获异常（P2-3 回归）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-cli-err-'));
  const envName = 'RELAY_TEST_UNSET_KEY_20261029';
  delete process.env[envName];
  const yaml = [
    'server:', '  host: 127.0.0.1', '  port: 0',
    'storage:', '  driver: memory', 'logLevel: error',
    'providers:', '  - id: m', '    label: m', '    protocol: openai',
    `    baseUrl: http://127.0.0.1:9/v1`, `    apiKey: '{ENV:${envName}}'`, '    models: [mock-small]',
    'clients:', '  - id: c', '    label: c', '    key: skv', '    tier: free', '    tenantId: t', '    enabled: true',
  ].join('\n');
  const file = join(dir, 'relay.yaml');
  writeFileSync(file, yaml, 'utf8');
  try {
    const { code, err, out } = await captureStderr(() => main(['catalog', '--config', file]));
    assert.equal(code, 1, '配置装载失败必须 exit 1');
    assert.match(err, /缺少 1 项环境变量/);
    assert.match(err, new RegExp(envName), '必须点名缺的是哪个变量');
    assert.ok(!err.includes('    at '), '默认不打印堆栈');
    assert.equal(out, '', '错误路径不得往 stdout 写任何东西（管道里 stdout 是机器可读的）');
    // --debug 才展开堆栈
    const dbg = await captureStderr(() => main(['catalog', '--config', file, '--debug']));
    assert.match(dbg.err, /    at /, '--debug 下必须能看到堆栈用于排障');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parseArgs：--debug 默认关闭、显式传入才开启（堆栈是排障选项，不是默认噪音）', () => {
  assert.equal(parseArgs(['catalog']).debug ?? false, false);
  assert.equal(parseArgs(['catalog', '--debug']).debug, true);
});

/* ------------------------------------------------------------------ *
 * P2：MockUpstream 缺省 logger
 * ------------------------------------------------------------------ */

test('MockUpstream：不传 logger 也能 listen/close（verify_admin.mjs 崩溃回归）', async () => {
  // 事故：`new MockUpstream({ port: 0 })` 少传 logger，listen() 里 TypeError 崩掉。
  // .mjs 不在 tsc 覆盖范围内，任何门禁都发现不了 —— 只能在运行期兜底 + 用测试钉住。
  const mock = new MockUpstream({ port: 0 });
  const bound = await mock.listen();
  assert.ok(bound.port > 0, 'port: 0 必须绑到真实端口');
  assert.equal(bound.url, mock.url);
  assert.match(bound.url, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
  // 核心：listen() 之后仍然可用（兜底 logger 不能把服务打死）
  assert.equal(mock.count, 0);
  await mock.close();
});

test('MockUpstream：显式传入的 logger 仍收到 mock.listening（兜底不能吞掉正常日志）', async () => {
  const lines: string[] = [];
  const mock = new MockUpstream({ port: 0, logger: new Logger('info', (line) => lines.push(line)) });
  const bound = await mock.listen();
  await mock.close();
  assert.equal(lines.filter((l) => l.includes('mock.listening')).length, 1, '监听事件必须且只记一次');
  assert.ok(lines[0]?.includes(bound.url), '日志里要带上 url，便于多实例排障');
});