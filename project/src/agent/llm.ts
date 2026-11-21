/**
 * Agent 的 LLM 入口：走本网关 /v1/chat/completions（自托管自证闭环）。
 *
 * v2 主题 5（护栏与健壮性）在 v1 基础上补：
 *   - 指数退避重试（超时/5xx/网络，可重试错误最多 retries 次）；
 *   - max_tokens 从 1024 提到 2048（v2 契约更长，截断=解析失败的常见根因）；
 *   - 错误分类为 AgentError（code 枚举），runner 按码统计；
 *   - usage 落账（token 累计给日配额护栏用）。
 */

import type { AgentLlmCall } from './runner.js';
import { agentError } from './errors.js';

export interface AgentLlmOptions {
  /** 网关自身 base URL（http://127.0.0.1:8787） */
  baseUrl: string;
  /** 用于调 LLM 的客户端 key（明文；来自 config.clients 里 agent 专用的那条） */
  key: string;
  /** 默认模型（config.agent.model） */
  model: string;
  /** 失败重试次数（默认 2；只对 timeout/5xx/网络错误生效） */
  retries?: number;
  fetchImpl?: typeof fetch;
}

/** 单轮 token 用量（runner 聚合进 run 上下文与配额护栏） */
export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  /** 本轮对话（含工具循环多轮）的总调用次数 */
  calls: number;
}

export function createAgentLlm(opts: AgentLlmOptions): AgentLlmCall & {
  setBaseUrl?: (u: string) => void;
  usage: () => LlmUsage;
  resetUsage: () => void;
} {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  let baseUrl = opts.baseUrl;
  const maxRetries = opts.retries ?? 2;
  let usage: LlmUsage = { promptTokens: 0, completionTokens: 0, calls: 0 };

  async function chatOnce(messages: { role: string; content: string }[], callOpts: { model: string; timeoutMs: number }): Promise<{
    content: string;
    promptTokens: number;
    completionTokens: number;
  }> {
    const body = {
      model: callOpts.model || opts.model,
      messages,
      temperature: 0.1, // 运维决策要稳定，不采样
      max_tokens: 2048, // v2：契约更长（proposedChange/analysis/toolCalls），1024 常截断
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), callOpts.timeoutMs || 60_000);
    try {
      const base = baseUrl.replace(/\/$/, '');
      let res: Response;
      try {
        res = await fetchImpl(base + '/v1/chat/completions', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: 'Bearer ' + opts.key,
            // Agent 自指纹：网关把它识别成 agent 型客户（client_kind=agent），计量里可区分
            'user-agent': 'api-relay-ops-agent/2.0',
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (e) {
        throw agentError('llm_network', 'Agent LLM 网络错误: ' + String(e instanceof Error ? e.message : e));
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const code = res.status >= 500 ? 'llm_http_5xx' : 'llm_http_4xx';
        throw agentError(code, 'LLM 上游 ' + res.status + ': ' + text.slice(0, 200), { status: res.status });
      }
      const data = (await res.json()) as {
        usage?: { prompt_tokens?: number; completion_tokens?: number };
        choices?: { message?: { content?: string } }[];
      };
      const content = data.choices?.[0]?.message?.content ?? '';
      return {
        content,
        promptTokens: data.usage?.prompt_tokens ?? 0,
        completionTokens: data.usage?.completion_tokens ?? 0,
      };
    } catch (e) {
      // AbortController 超时：fetch 以 AbortError 名义抛出
      if (e instanceof Error && e.name === 'AbortError') {
        throw agentError('llm_timeout', 'LLM 调用超时（' + (callOpts.timeoutMs || 60_000) + 'ms）');
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  const llm = {
    async chat(messages: { role: string; content: string }[], callOpts: { model: string; timeoutMs: number }) {
      let lastErr: unknown;
      // 重试策略：只对可重试错误（timeout/5xx/network）退避重试；4xx（鉴权类）直接抛
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          const r = await chatOnce(messages, callOpts);
          usage = {
            promptTokens: usage.promptTokens + r.promptTokens,
            completionTokens: usage.completionTokens + r.completionTokens,
            calls: usage.calls + 1,
          };
          return r;
        } catch (e) {
          lastErr = e;
          const retryable = (e as { retryable?: boolean }).retryable === true;
          if (!retryable || attempt === maxRetries) throw e;
          // 指数退避 400ms×2^n（对齐网关 backoffBaseMs 家族），带上限 4s
          const delay = Math.min(400 * 2 ** attempt, 4000);
          await new Promise((r) => setTimeout(r, delay));
        }
      }
      throw lastErr;
    },
    setBaseUrl(u: string) { baseUrl = u; },
    usage: () => ({ ...usage }),
    resetUsage() { usage = { promptTokens: 0, completionTokens: 0, calls: 0 }; },
  };
  return llm;
}
