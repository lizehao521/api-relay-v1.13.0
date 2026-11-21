/**
 * 内部 Agent handler（v2）。
 *
 * 在 v1（视图/触发/last/runs/重启回退）之上新增：
 *   主题 6  GET /agent/metrics          —— Agent 自身指标（成功率/p95/token/失败分类/发现项）
 *           GET /agent/findings         —— 全部发现项（未闭环清单 + 已闭环复盘）
 *           POST /agent/findings/:id/mark —— 打标反馈（acknowledged/resolved/ignored）
 *   D7      面板"写入 KB"改走 upsert semantics（见前端 Agent.tsx：POST kb/:id/docs →
 *           kb handler 的 upsert 语义由 store.upsertDoc 落地；此处仅保证视图数据带 kbId）
 *
 * 依赖四个：agent / store / logger / kb（写 KB 按钮在后端走 kb handler，不在这里）。
 */

import type { ServerResponse } from 'node:http';
import type { Store } from '../../store/index.js';
import type { Logger } from '../../core/logger.js';
import type { AgentMatrixConfig } from '../../core/types.js';
import { AgentRunner } from '../../agent/runner.js';
import { DEFAULT_MATRIX_CONFIG, DIMENSIONS } from '../../agent/matrix.js';
import { AGENT_ERROR_HINTS } from '../../agent/errors.js';
import { json } from '../response.js';
import { numParam } from '../params.js';

export interface AgentHandlerDeps {
  store: Store;
  logger: Logger;
  /** 惰性取值：undefined = 未启用（app.ts 构造顺序约束，v1 注释保留） */
  agent: () => AgentRunner | undefined;
}

export class AgentHandlers {
  constructor(private readonly deps: AgentHandlerDeps) {}

  view(): Record<string, unknown> {
    const agent = this.deps.agent();
    if (!agent || !agent.enabled) {
      return { enabled: false, note: '内部 Agent 系统未启用（config.agent.enabled 为 false）' };
    }
    const status = agent.status();
    // 重启回退（v1 语义保留）：内存 ring 空时用持久 agent.decision 事件重建。
    // 惰性化：只有回落分支才扫事件（稳态零扫描）。
    const runs = agent.runs();
    const lastMem = agent.lastRun();
    const rebuilt = (runs.length === 0 || !lastMem) ? this.lastFromEvent() : undefined;
    const list = runs.length ? runs : (rebuilt ? [rebuilt] : []);
    return {
      enabled: true,
      status: { ...status, lastRun: lastMem ?? rebuilt ?? null },
      // 视图 runs 只保留最新一轮（载荷瘦身，完整历史走 /agent/runs?limit=N）
      runs: list.slice(0, 1),
      // v2：错误码人话指引（面板渲染"为什么失败/怎么办"）
      errorHints: AGENT_ERROR_HINTS,
    };
  }

  trigger(res: ServerResponse, _body: Record<string, unknown> | undefined, actor?: string): boolean {
    const agent = this.deps.agent();
    if (!agent || !agent.enabled) {
      return json(res, 503, { error: { message: 'Agent 系统未启用', type: 'agent_disabled', code: 'agent_disabled' } });
    }
    if (agent.isRunning) {
      return json(res, 409, { error: { message: 'Agent 上一轮仍在运行', type: 'conflict_error', code: 'agent_running' } });
    }
    void agent.run('manual').then((run) => {
      this.deps.store.logEvent('info', 'agent.manual_trigger', { actor, ok: run.ok, kind: run.decision.kind, ...(run.errorCode ? { errorCode: run.errorCode } : {}) });
    }).catch((e) => {
      this.deps.logger.error('agent.manual_trigger_failed', { error: String(e), actor });
    });
    return json(res, 202, { ok: true, note: '已触发，稍后查 agent 状态/events 看结果', actor });
  }

  /**
   * 从持久事件库重建最近一轮 Agent 运行（v1 语义保留；v2 补 errorCode 透传）。
   */
  lastFromEvent(): Record<string, unknown> | undefined {
    const ev = (this.deps.store.listEvents(500) as { kind?: string; ts?: number; detail?: Record<string, unknown> }[])
      .find((e) => e.kind === 'agent.decision');
    if (!ev) return undefined;
    const d = ev.detail ?? {};
    const ev2 = Array.isArray(d['evidence']) ? (d['evidence'] as unknown[]).map((x) => String(x)) : [];
    return {
      startedAt: Number(ev.ts ?? 0),
      trigger: String(d['trigger'] ?? 'auto'),
      durationMs: 0,
      model: '',
      promptTokens: 0,
      completionTokens: 0,
      llmCalls: 0,
      decision: {
        kind: String(d['kind'] ?? 'ops'),
        severity: String(d['severity'] ?? 'info'),
        category: String(d['category'] ?? 'other'),
        summary: String(d['summary'] ?? ''),
        analysis: '',
        recommendation: String(d['recommendation'] ?? ''),
        confidence: typeof d['confidence'] === 'number' ? d['confidence'] : null,
        evidence: ev2,
        ok: d['ok'] !== false,
      },
      errorCode: d['errorCode'] !== undefined ? String(d['errorCode']) : undefined,
      fromEvent: true,
    };
  }

  route(method: string, action: string, url: URL, body: Record<string, unknown> | undefined, res: ServerResponse, actor?: string): boolean {
    const agent = this.deps.agent();
    if (!agent || !agent.enabled) {
      return json(res, 503, { error: { message: 'Agent 系统未启用', type: 'agent_disabled', code: 'agent_disabled' } });
    }
    const parts = action.split('/'); // [agent, sub...]
    const sub = parts.slice(1).join('/');

    if (method === 'GET' && (sub === '' || sub === 'runs')) {
      const runs = agent.runs();
      const rebuilt = runs.length === 0 ? this.lastFromEvent() : undefined;
      const list = runs.length ? runs : (rebuilt ? [rebuilt] : []);
      return json(res, 200, { status: agent.status(), runs: list.slice(0, numParam(url, 'limit', 20, 1, 200)) });
    }
    if (method === 'GET' && sub === 'last') {
      const last = agent.lastRun() ?? this.lastFromEvent();
      return json(res, last ? 200 : 404, last ? { last } : { error: { message: '尚无 Agent 运行记录', type: 'not_found_error', code: 'not_found' } });
    }
    // ---- v3 主题 7：对话模式（多轮 + 只读工具调用） ----
    if (method === 'POST' && sub === 'chat') {
      const raw = body?.['messages'];
      if (!Array.isArray(raw) || raw.length === 0) {
        return json(res, 400, { error: { message: 'messages 必须是非空数组（[{role,content},...]）', type: 'invalid_request_error', code: 'invalid_messages' } });
      }
      const history = (raw as unknown[])
        .filter((m): m is Record<string, unknown> => typeof m === 'object' && m !== null)
        .map((m) => ({ role: String(m['role'] ?? 'user'), content: String(m['content'] ?? '') }))
        .filter((m) => m.content.trim().length > 0)
        .slice(-20);
      if (history.length === 0) {
        return json(res, 400, { error: { message: 'messages 里没有非空 content', type: 'invalid_request_error', code: 'invalid_messages' } });
      }
      const t0 = Date.now();
      void agent.chat(history)
        .then((out) => {
          json(res, 200, { ...out, durationMs: Date.now() - t0, model: agent.status().model, actor });
        })
        .catch((e) => {
          this.deps.logger.error('agent.chat_failed', { error: String(e), actor });
          json(res, 500, { error: { message: '对话失败：' + String(e instanceof Error ? e.message : e), type: 'agent_error', code: 'agent_chat_failed' } });
        });
      return true;
    }
    // ---- v2 主题 6：指标端点 ----
    if (method === 'GET' && sub === 'metrics') {
      return json(res, 200, agent.metrics());
    }
    // ---- v2 主题 4：发现项（未闭环清单 + 复盘） ----
    if (method === 'GET' && sub === 'findings') {
      const onlyOpen = url.searchParams.get('open') === '1';
      const all = agent.findings();
      return json(res, 200, {
        findings: onlyOpen ? all.filter((f) => f.status === 'open') : all,
        counts: {
          open: all.filter((f) => f.status === 'open').length,
          total: all.length,
        },
      });
    }
    // ---- v2 主题 4/6：打标反馈（人在环闭环） ----
    if (method === 'POST' && /^findings\/[^/]+\/mark$/.test(sub)) {
      const id = decodeURIComponent(parts[2] ?? '');
      const status = String(body?.['status'] ?? '');
      if (!['acknowledged', 'resolved', 'ignored'].includes(status)) {
        return json(res, 400, { error: { message: 'status 必须是 acknowledged|resolved|ignored', type: 'invalid_request_error', code: 'invalid_status' } });
      }
      const f = agent.markFinding(id, status as 'acknowledged' | 'resolved' | 'ignored');
      if (!f) {
        return json(res, 404, { error: { message: `发现项 ${id} 不存在`, type: 'not_found_error', code: 'not_found' } });
      }
      this.deps.store.logEvent('info', 'agent.finding_marked', { actor, id, status });
      return json(res, 200, { ok: true, finding: f });
    }

    /* ---- 决策矩阵（可选能力）：配置读写 + 历史 + 复位 ---- */
    // 说明：矩阵关闭（config.enabled=false）时这些端点**依然可用**——运营需要先读到配置
    // 再决定是否开启；返回体里的 config.enabled 才是"矩阵是否介入仲裁"的真相。
    // Agent 未启用时统一在上面的 503 提前返回，与其它 agent 子路由一致。
    if (method === 'GET' && sub === 'matrix') {
      const config = agent.matrixConfig();
      return json(res, 200, {
        enabled: true,
        config,
        // 维度元数据 + **生效权重**：面板不用再猜默认值，改过权重也直接对得上
        dimensions: DIMENSIONS.map((d) => ({ key: d.key, label: d.label, description: d.description, weight: config.weights[d.key] })),
        last: agent.matrixHistory(1)[0] ?? null,
        stats: agent.matrixStats(),
      });
    }
    if (method === 'PUT' && sub === 'matrix') {
      // body 整体交给引擎校验：**不做字段过滤**是刻意的——拼错键名（如 acceptTreshold）
      // 会被 validateMatrixConfig 判为"含未知字段"并回 400，而不是静默忽略后
      // 呈现"改了没生效"。校验口径只有引擎一处真相。
      try {
        const config = agent.updateMatrixConfig((body ?? {}) as AgentMatrixConfig);
        return json(res, 200, { ok: true, config });
      } catch (e) {
        return this.matrixWriteFailed(res, e, actor, '更新决策矩阵配置失败');
      }
    }
    if (method === 'POST' && sub === 'matrix/reset') {
      // 复位 = 写回内置默认值（注意：默认是 **enabled:false**，即"恢复出厂 = 矩阵关闭"）。
      // 复用 updateMatrixConfig 同一条路径：同样校验、同样持久化、同样写 agent.matrix_config 事件，
      // 避免出现"复位走另一条不写盘的分支"导致重启后又变回旧值。
      try {
        const config = agent.updateMatrixConfig({ ...DEFAULT_MATRIX_CONFIG });
        this.deps.store.logEvent('info', 'agent.matrix_config_reset', { actor });
        return json(res, 200, { ok: true, config });
      } catch (e) {
        return this.matrixWriteFailed(res, e, actor, '复位决策矩阵配置失败');
      }
    }
    if (method === 'GET' && sub === 'matrix/history') {
      const limit = numParam(url, 'limit', 20, 1, 50);
      return json(res, 200, { evaluations: agent.matrixHistory(limit), stats: agent.matrixStats() });
    }

    // 已注册的矩阵子路径收到不支持的方法 → 405 + Allow（而不是笼统 404）：
    // 路由存在、只是方法不对，HTTP 语义与文件里其它 405 一致。
    // 用 Map 而不是对象字面量：`{'constructor'} in obj` 会命中原型链（见 params.ts 同类教训）。
    const matrixMethods = new Map<string, string>([
      ['matrix', 'GET/PUT'],
      ['matrix/history', 'GET'],
      ['matrix/reset', 'POST'],
    ]);
    const allow = matrixMethods.get(sub);
    if (allow !== undefined) {
      res.setHeader('allow', allow);
      return json(res, 405, {
        error: { message: `agent/${sub} 只支持 ${allow}，收到 ${method}`, type: 'method_not_allowed', code: 'method_not_allowed' },
      });
    }

    return json(res, 404, { error: { message: `未知 Agent 子路由 ${method} agent/${sub}`, type: 'not_found_error', code: 'not_found' } });
  }

  /**
   * 矩阵写操作的统一失败出口。
   *
   * 校验失败 → 400 + `invalid_matrix_config` + `details[]`（逐条中文原因，面板可直接列出来）；
   * 其它异常（落盘/归一化意外）→ 500 并记日志——不能让"配置没改成"表现为 200。
   * details 从抛出对象的 `details` 取；引擎未附带时退化为 `[message]`，
   * 保证契约字段形状恒定（客户端不用为两种形状写两套解析）。
   */
  private matrixWriteFailed(res: ServerResponse, e: unknown, actor: string | undefined, fallback: string): boolean {
    const message = e instanceof Error ? e.message : String(e);
    const detailErr = e as { code?: string; details?: unknown };
    const details = Array.isArray(detailErr.details)
      ? detailErr.details.map((x) => String(x))
      : [message];
    if (detailErr.code === 'invalid_matrix_config' || /配置非法/.test(message)) {
      return json(res, 400, {
        error: { message, type: 'validation_error', code: 'invalid_matrix_config', details },
      });
    }
    this.deps.logger.error('agent.matrix_config_write_failed', { error: message, actor });
    return json(res, 500, {
      error: { message: `${fallback}：${message}`, type: 'agent_error', code: 'agent_matrix_write_failed' },
    });
  }
}
