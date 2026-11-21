/**
 * 内部 Agent 系统单测（v2）。
 *
 * v1 6 例 → v2 扩充：决策解析（v1/v2 双契约）、工具循环、KB 回写（含 opt-in 语义）、
 * 并发保护、发现项状态机、配额护栏、错误码、D8/D9/D10 回归。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KbStore } from '../kb/store.js';
import { MemoryStore } from '../store/index.js';
import { AgentRunner, parseDecision, parseToolCallIntent, type AgentLlmCall, type AgentRunnerDeps } from '../agent/runner.js';
import { adaptiveWindowMs } from '../agent/context.js';
import { AGENT_TOOL_NAMES } from '../agent/tools.js';

function tempKb(t: string): { store: KbStore; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), t));
  const store = new KbStore({ path: join(dir, 'kb.db'), chunkSize: 128, chunkOverlap: 16 });
  return { store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const quietLogger = { info() {}, warn() {}, error() {} } as never;

/** 最小可跑的 Runner 依赖（v2：含 toolCtx 桩） */
function fakeDeps(over: Partial<AgentRunnerDeps> = {}): AgentRunnerDeps {
  return {
    config: { enabled: true, clientId: 'agent', model: 'm', intervalMs: 0 },
    logger: quietLogger,
    llm: { async chat() { return { content: '', promptTokens: 0, completionTokens: 0 }; } },
    context: { async collect() { return { overview: {}, providers: [], recentEvents: [] }; } },
    toolCtx: {
      store: { listEvents: () => [], logEvent: () => {}, windowStatsPreferPersistent: () => ({ requests: 0, errors: 0, tokens: 0, costCny: 0, listCostCny: 0, p95DurationMs: 0, avgDurationMs: 0 }), attributionStats: () => ({ byReason: [], byAction: [], clientAuth: { count: 0, lastAt: 0 }, coverage: { total: 0, delivered: 0, autoRecovered: 0 }, duplicates: 0, precheck: { blocked: 0, degraded: 0 }, overhead: { precheckUsAvg: 0, classifyUsAvg: 0 } }), dimensionStats: () => undefined, health: () => ({} as never), prune: async () => 0 } as never,
      pool: { snapshot: () => [] } as never,
      meter: { summarize: () => ({} as never), snapshot: () => ({ counters: {}, overheadUs: {}, zeroTokenCount: 0, store: {} as never }) } as never,
      config: {} as never,
      kbId: 'kb-iter',
    },
    ...over,
  };
}

/* ================= 决策解析 ================= */

test('agent: parseDecision 解析 v1 契约（无 schemaVersion → 回落 v1）', () => {
  const d = parseDecision(JSON.stringify({
    kind: 'iteration', summary: '建议加对冲', recommendation: '把阈值降到 12s',
    confidence: 0.8, evidence: ['agnes-cn 24h 失败率 32%'],
    kbNote: { title: 'agnes 对冲优化', content: '对冲阈值 20s 偏保守' },
  }));
  assert.equal(d.kind, 'iteration');
  assert.equal(d.schemaVersion, 1);
  assert.equal(d.confidence, 0.8);
  assert.equal(d.kbNote?.title, 'agnes 对冲优化');
  // v1 无 severity → 非 none 默认 warn
  assert.equal(d.severity, 'warn');
});

test('agent: parseDecision 解析 v2 契约（severity/category/proposedChange/toolCalls）', () => {
  const d = parseDecision(JSON.stringify({
    schemaVersion: 2, kind: 'ops', severity: 'critical', category: 'upstream_down',
    summary: 'agnes-cn 已熔断', analysis: 'get_provider: consecutiveFailures=6',
    recommendation: '摘除并核对 key',
    proposedChange: { target: 'provider.disable', payload: { id: 'agnes-cn' }, impact: '切兜底', rollback: '面板恢复', risk: 'low' },
    confidence: 0.86, evidence: ['consecutiveFailures=6'], toolCalls: ['get_metrics', 'get_provider'],
  }));
  assert.equal(d.schemaVersion, 2);
  assert.equal(d.severity, 'critical');
  assert.equal(d.category, 'upstream_down');
  assert.equal(d.proposedChange?.target, 'provider.disable');
  assert.deepEqual(d.toolCalls, ['get_metrics', 'get_provider']);
});

test('agent: proposedChange 白名单外 target 被丢弃（安全边界）', () => {
  const d = parseDecision(JSON.stringify({
    schemaVersion: 2, kind: 'ops', severity: 'warn', category: 'other',
    summary: 'x', recommendation: 'y',
    proposedChange: { target: 'server.adminToken', payload: { v: 'haha' }, impact: '', rollback: '', risk: 'low' },
    confidence: 0.5, evidence: [], toolCalls: [],
  }));
  assert.equal(d.proposedChange, undefined, 'adminToken 不在白名单——必须丢弃');
});

test('agent: parseDecision 容错前后杂字（v1 场景回归）', () => {
  const raw = '分析结果如下：' + JSON.stringify({ kind: 'ops', summary: '上游熔断', recommendation: '检查 agnes', confidence: 0.9, evidence: ['breaker open'] }) + ' 以上';
  const d = parseDecision(raw);
  assert.equal(d.kind, 'ops');
  assert.deepEqual(d.evidence, ['breaker open']);
});

test('agent: D9 回归——多对象输出不再拼出非法 JSON（平衡括号扫描）', () => {
  // v1 的贪婪 /\{[\s\S]*\}/ 会从第一个 { 吞到最后一个 }，拼成非法串整体失败
  const raw = '前面说明 {"example":{"a":1}} 中间 {"schemaVersion":2,"kind":"none","summary":"ok","recommendation":"","confidence":0.5,"evidence":[],"toolCalls":[]} 后面结尾';
  const d = parseDecision(raw);
  assert.equal(d.kind, 'none');
  assert.equal(d.summary, 'ok');
});

test('agent: 非法 JSON 抛错（错误码 parse_failed）', () => {
  assert.throws(() => parseDecision('这不是 JSON'), (e: unknown) => {
    assert.equal((e as { code?: string }).code, 'parse_failed');
    return true;
  });
});

test('agent: kind 非法回退 none + confidence 夹紧（v1 场景回归）', () => {
  const d = parseDecision(JSON.stringify({ kind: 'weird', summary: 'x', recommendation: '', confidence: 2, evidence: [] }));
  assert.equal(d.kind, 'none');
  assert.equal(d.confidence, 1);
});

/* ================= 工具意图解析 ================= */

test('agent: parseToolCallIntent 识别工具调用并校验白名单', () => {
  const ok = parseToolCallIntent('{"tool":"get_provider","args":{"id":"agnes-cn"}}');
  assert.equal(ok?.tool, 'get_provider');
  assert.deepEqual(ok?.args, { id: 'agnes-cn' });
  // 不在白名单 → undefined（按决策解析处理）
  assert.equal(parseToolCallIntent('{"tool":"rm -rf","args":{}}'), undefined);
  // 普通决策 JSON → undefined
  assert.equal(parseToolCallIntent('{"schemaVersion":2,"kind":"none"}'), undefined);
});

test('agent: 工具注册表包含 8 个只读工具', () => {
  assert.equal(AGENT_TOOL_NAMES.length, 8);
  assert.ok(AGENT_TOOL_NAMES.includes('get_metrics'));
  assert.ok(AGENT_TOOL_NAMES.includes('search_kb'));
});

/* ================= 上下文 ================= */

test('agent: adaptiveWindowMs 按错误率分档', () => {
  assert.equal(adaptiveWindowMs(0.5), 300_000);
  assert.equal(adaptiveWindowMs(0.2), 300_000);
  assert.equal(adaptiveWindowMs(0.1), 3_600_000);
  assert.equal(adaptiveWindowMs(0.05), 3_600_000);
  assert.equal(adaptiveWindowMs(0.01), 86_400_000);
});

/* ================= 主循环 ================= */

test('agent: run 全链路（v2 决策 + 真 KB opt-in 回写）', async () => {
  const { store, cleanup } = tempKb('agent-run');
  try {
    await store.init();
    store.createKb('kb-iter', '迭代知识');
    const decision = {
      schemaVersion: 2, kind: 'iteration', severity: 'warn', category: 'cost',
      summary: 'agnes 国际线路慢', analysis: 'get_metrics: p95 18s',
      recommendation: '提高对冲阈值',
      kbNote: { title: 'agnes 慢', content: '平均 18s，建议对冲阈值 12s' },
      confidence: 0.7, evidence: ['provider agnes avg 18s'], toolCalls: ['get_metrics'],
    };
    const fakeLlm: AgentLlmCall = {
      async chat() { return { content: JSON.stringify(decision), promptTokens: 500, completionTokens: 120 }; },
    };
    const runner = new AgentRunner(fakeDeps({
      config: { enabled: true, clientId: 'agent', model: 'm', intervalMs: 0, autoWriteKb: true, kbId: 'kb-iter' },
      llm: fakeLlm, kb: store,
    }));
    const run = await runner.run('manual');
    assert.ok(run.ok, 'run 应成功');
    assert.equal(run.decision.kind, 'iteration');
    assert.equal(run.llmCalls, 1);
    const docs = store.listDocs('kb-iter');
    assert.equal(docs.length, 1, 'KB 回写 1 篇（autoWriteKb=true 显式 opt-in）');
    assert.equal(docs[0]!.title, 'agnes 慢');
    assert.equal(runner.runs().length, 1);
    // v2：发现项已登记
    assert.equal(runner.openFindings().length, 1);
  } finally {
    store.close();
    cleanup();
  }
});

test('agent: D10 回归——autoWriteKb 缺省 false，不自动写 KB', async () => {
  const { store, cleanup } = tempKb('agent-d10');
  try {
    await store.init();
    store.createKb('kb-d10', 'x');
    const fakeLlm: AgentLlmCall = {
      async chat() {
        return { content: JSON.stringify({
          schemaVersion: 2, kind: 'kb', severity: 'info', category: 'kb',
          summary: 's', recommendation: 'r', kbNote: { title: 't', content: 'c' },
          confidence: 0.5, evidence: [], toolCalls: [],
        }), promptTokens: 10, completionTokens: 5 };
      },
    };
    const runner = new AgentRunner(fakeDeps({ llm: fakeLlm, kb: store, config: { enabled: true, clientId: 'a', model: 'm', intervalMs: 0, kbId: 'kb-d10' } }));
    const run = await runner.run('manual');
    assert.ok(run.ok);
    assert.equal(store.listDocs('kb-d10').length, 0, 'v2 默认不自动写——仅人工确认');
  } finally {
    store.close();
    cleanup();
  }
});

test('agent: 工具循环——先调工具再出决策', async () => {
  const { store, cleanup } = tempKb('agent-tool');
  try {
    await store.init();
    const replies = [
      '{"tool":"get_metrics","args":{"window":"5m"}}',                       // 第 1 轮：调工具
      '{"tool":"list_providers","args":{}}',                                 // 第 2 轮：再调工具
      JSON.stringify({ schemaVersion: 2, kind: 'ops', severity: 'warn', category: 'rate_limit', summary: 'A 上游限流', analysis: '', recommendation: '降权', confidence: 0.6, evidence: ['byReason rate_limited=80'], toolCalls: ['get_metrics', 'list_providers'] }), // 第 3 轮：出决策
    ];
    let i = 0;
    const fakeLlm: AgentLlmCall = {
      async chat() { return { content: replies[Math.min(i++, replies.length - 1)]!, promptTokens: 100, completionTokens: 50 }; },
    };
    const runner = new AgentRunner(fakeDeps({ llm: fakeLlm, kb: store }));
    const run = await runner.run('manual');
    assert.ok(run.ok);
    assert.equal(run.llmCalls, 3, '3 次 LLM 调用（2 工具 + 1 决策）');
    assert.deepEqual(run.decision.toolCalls, ['get_metrics', 'list_providers']);
  } finally {
    store.close();
    cleanup();
  }
});

test('agent: LLM 输出坏 JSON → 修复调用兜底 → 仍坏才 ok=false', async () => {
  const { store, cleanup } = tempKb('agent-bad');
  try {
    await store.init();
    store.createKb('kb-bad', '迭代知识');
    const fakeLlm: AgentLlmCall = {
      async chat() { return { content: '这是一段散文，不是 JSON', promptTokens: 100, completionTokens: 50 }; },
    };
    const runner = new AgentRunner(fakeDeps({ llm: fakeLlm, kb: store, config: { enabled: true, clientId: 'a', model: 'x', intervalMs: 0, autoWriteKb: true, kbId: 'kb-bad' } }));
    const run = await runner.run('manual');
    assert.equal(run.ok, false, '坏 JSON（含修复调用后）→ ok=false');
    assert.equal(run.errorCode, 'parse_failed');
    assert.equal(store.listDocs('kb-bad').length, 0, '解析失败不写 KB');
  } finally {
    store.close();
    cleanup();
  }
});

test('agent: 并发保护（第二轮回 already_running，D8：不入历史）', async () => {
  let slowResolve: (() => void) | undefined;
  const gate = new Promise<void>((r) => { slowResolve = r; });
  const fakeLlm: AgentLlmCall = {
    async chat() {
      await gate;
      return { content: JSON.stringify({ kind: 'none', summary: 'x', recommendation: '', confidence: 0.5, evidence: [] }), promptTokens: 1, completionTokens: 1 };
    },
  };
  const runner = new AgentRunner(fakeDeps({ llm: fakeLlm }));
  const p1 = runner.run('manual');
  const p2 = runner.run('manual');
  const r2 = await p2;
  assert.equal(r2.errorCode, 'already_running', '第二轮应被拒');
  slowResolve?.();
  const r1 = await p1;
  assert.ok(r1.ok, '第一轮正常完成');
  // D8：拒绝轮不进历史——只有第一轮
  assert.equal(runner.runs().length, 1, '拒绝轮不得入历史（v1 缺陷：runCount 虚高）');
});

test('agent: 日配额护栏——超限拒绝并记 errorCode=quota_blocked', async () => {
  const { store, cleanup } = tempKb('agent-quota');
  try {
    await store.init();
    const fakeLlm: AgentLlmCall = {
      async chat() { return { content: JSON.stringify({ kind: 'none', summary: 'x', recommendation: '', confidence: 0.5, evidence: [] }), promptTokens: 900, completionTokens: 100 }; },
    };
    const runner = new AgentRunner(fakeDeps({
      llm: fakeLlm, kb: store,
      config: { enabled: true, clientId: 'a', model: 'x', intervalMs: 0, dailyTokenLimit: 1000 },
    }));
    const r1 = await runner.run('manual');
    assert.ok(r1.ok, '第一轮 1000 token 正好达限但允许跑');
    const r2 = await runner.run('manual');
    assert.equal(r2.ok, false);
    assert.equal(r2.errorCode, 'quota_blocked', '第二轮超限拒绝');
    assert.equal(runner.runs().length, 2);
  } finally {
    store.close();
    cleanup();
  }
});

test('agent: 发现项状态机——同题去重 seenCount 递增，mark 销号后退出 open', async () => {
  const { store, cleanup } = tempKb('agent-finding');
  try {
    await store.init();
    const decision = {
      schemaVersion: 2, kind: 'ops', severity: 'warn', category: 'upstream_down',
      summary: 'agnes-cn 熔断', analysis: '', recommendation: '摘除',
      confidence: 0.8, evidence: [], toolCalls: [],
    };
    const fakeLlm: AgentLlmCall = {
      async chat() { return { content: JSON.stringify(decision), promptTokens: 10, completionTokens: 5 }; },
    };
    const runner = new AgentRunner(fakeDeps({ llm: fakeLlm, kb: store }));
    await runner.run('manual');
    await runner.run('manual');
    const open = runner.openFindings();
    assert.equal(open.length, 1, '同题去重——两轮同题只 1 个发现项');
    assert.equal(open[0]!.seenCount, 2, 'seenCount=2');
    // 打标销号
    const marked = runner.markFinding(open[0]!.id, 'resolved');
    assert.equal(marked?.status, 'resolved');
    assert.equal(runner.openFindings().length, 0, '销号后退出未闭环清单');
  } finally {
    store.close();
    cleanup();
  }
});

test('agent: metrics() 暴露成功率与失败分类', async () => {
  const { store, cleanup } = tempKb('agent-metrics');
  try {
    await store.init();
    let bad = true;
    const fakeLlm: AgentLlmCall = {
      async chat() {
        if (bad) return { content: 'not json', promptTokens: 5, completionTokens: 5 };
        return { content: JSON.stringify({ kind: 'ops', severity: 'info', category: 'other', summary: 's', recommendation: '', confidence: 0.5, evidence: [], toolCalls: [] }), promptTokens: 10, completionTokens: 5 };
      },
    };
    const runner = new AgentRunner(fakeDeps({ llm: fakeLlm, kb: store }));
    await runner.run('manual'); // 失败轮（bad JSON，含修复调用）
    bad = false;
    await runner.run('manual'); // 成功轮
    const m = runner.metrics() as { runs: { total: number; failures: number; successRate: number }; byErrorCode: Record<string, number> };
    assert.equal(m.runs.total, 2);
    assert.equal(m.runs.failures, 1);
    assert.equal(m.byErrorCode['parse_failed'], 1);
    assert.ok(m.runs.successRate > 0 && m.runs.successRate < 100);
  } finally {
    store.close();
    cleanup();
  }
});

test('agent: status() 含 v2 字段（promptVersion/quota/maxToolSteps/openFindings）', async () => {
  const runner = new AgentRunner(fakeDeps());
  const st = runner.status() as Record<string, unknown>;
  assert.equal(typeof st['promptVersion'], 'string');
  assert.equal(st['maxToolSteps'], 8);
  assert.ok(st['quota'] !== undefined);
  assert.equal(st['autoWriteKb'], false, 'v2 默认 false（D10）');
});

/* ================= 决策矩阵接入（v3 主题：只仲裁不扩权） ================= */

test('agent: 矩阵启用且判定 reject → run.decision 的 proposedChange 被剥离，并写 agent.matrix_decision 事件', async () => {
  const store = new MemoryStore();
  const decision = {
    schemaVersion: 2, kind: 'ops', severity: 'info', category: 'upstream_down',
    summary: 'agnes 抖动', analysis: '短', recommendation: '继续观察',
    proposedChange: { target: 'provider.disable', payload: { id: 'agnes-cn' }, impact: '切兜底', rollback: '面板恢复', risk: 'medium' },
    confidence: 0.2, evidence: [], toolCalls: [],
  };
  const fakeLlm: AgentLlmCall = {
    async chat() { return { content: JSON.stringify(decision), promptTokens: 10, completionTokens: 5 }; },
  };
  const runner = new AgentRunner(fakeDeps({
    store, llm: fakeLlm,
    config: { enabled: true, clientId: 'a', model: 'm', intervalMs: 0, decisionMatrix: { enabled: true } },
  }));
  const run = await runner.run('manual');

  assert.ok(run.ok, 'run 本身仍成功（矩阵只仲裁档位，不改 ok 语义）');
  assert.equal(run.matrix?.tier, 'reject');
  assert.equal(run.matrix?.rawTier, 'reject');
  assert.equal(run.matrix?.score, 0.37);
  assert.equal(run.matrix?.effectiveChange, undefined, 'reject 档不得携带可执行动作');
  assert.equal(run.decision.proposedChange, undefined, '被驳回的建议不得流向任何执行路径');
  // 其余决策字段保持原样（矩阵不改写 payload/文本）
  assert.equal(run.decision.summary, 'agnes 抖动');
  assert.equal(run.decision.category, 'upstream_down');

  const ev = store.listEvents(100).find((e) => e.kind === 'agent.matrix_decision');
  assert.ok(ev, '应写 agent.matrix_decision 审计事件');
  const detail = ev!.detail as Record<string, unknown>;
  assert.equal(detail['tier'], 'reject');
  assert.equal(detail['score'], 0.37);
  assert.equal(detail['hasChange'], false);
  assert.deepEqual(detail['failedGates'], ['G2', 'G3']);
  assert.equal(runner.matrixHistory().length, 1);
  assert.equal(runner.matrixStats().reject, 1);
});

test('agent: 矩阵启用且判定 accept → 动作保留副本，决策事件带档位与分数', async () => {
  const store = new MemoryStore();
  const decision = {
    schemaVersion: 2, kind: 'iteration', severity: 'warn', category: 'cost',
    summary: '上游平均延迟偏高', analysis: 'get_metrics 显示 p95 18s，高于阈值 12s 的 1.5 倍',
    recommendation: '把对冲阈值下调到 12s',
    proposedChange: { target: 'tier.precheck', payload: { threshold: 12 }, impact: '缩短长尾', rollback: '面板改回 20s', risk: 'low' },
    confidence: 0.94, evidence: ['p95=18s', 'avg=9s', 'window=24h'], toolCalls: ['get_metrics'],
  };
  const fakeLlm: AgentLlmCall = {
    async chat() { return { content: JSON.stringify(decision), promptTokens: 10, completionTokens: 5 }; },
  };
  const runner = new AgentRunner(fakeDeps({
    store, llm: fakeLlm,
    config: { enabled: true, clientId: 'a', model: 'm', intervalMs: 0, decisionMatrix: { enabled: true } },
  }));
  const run = await runner.run('manual');

  assert.ok(run.ok);
  assert.equal(run.matrix?.score, 0.885);
  assert.equal(run.matrix?.tier, 'accept');
  assert.equal(run.matrix?.rawTier, 'accept');
  assert.deepEqual(run.matrix?.gates.map((g) => g.id), ['G1', 'G2', 'G3', 'G4']);
  assert.ok(run.matrix!.gates.every((g) => g.passed), '四门全过 → 不降档');
  assert.equal(run.decision.proposedChange?.target, 'tier.precheck', 'accept 档保留动作');
  assert.equal(run.decision.proposedChange?.payload['threshold'], 12);

  const decisionEv = store.listEvents(100).find((e) => e.kind === 'agent.decision');
  assert.ok(decisionEv);
  const detail = decisionEv!.detail as Record<string, unknown>;
  assert.equal(detail['matrixTier'], 'accept');
  assert.equal(detail['matrixScore'], 0.885);
  assert.equal(runner.matrixStats().accept, 1);
  assert.equal(runner.matrixStats().total, 1);
});
