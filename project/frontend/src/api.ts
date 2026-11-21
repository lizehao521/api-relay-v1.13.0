import { signal } from "@preact/signals";
import type { AgentMatrixView, MatrixConfig, MatrixConfigResp, MatrixHistoryResp } from "./types";

let token = localStorage.getItem("relay_admin_token") || "";

export const unauthorized = signal(0);

export const getToken = () => token;
export const setToken = (t: string) => {
  token = t;
  if (t) localStorage.setItem("relay_admin_token", t);
  else localStorage.removeItem("relay_admin_token");
};

export class ApiError extends Error {
  status: number;
  type?: string;
  code?: string;
  body?: unknown;
  constructor(msg: string, status: number, type?: string, code?: string, body?: unknown) {
    super(msg);
    this.status = status;
    this.type = type;
    this.code = code;
    this.body = body;
  }
}

export async function raw<T = any>(path: string, opts?: RequestInit): Promise<T> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 30000);
  let res: Response;
  try {
    // 合并调用方自定义头（审查修复·缺点#8）：此前只设 token 与 content-type，
    // 调用方经 opts.headers 传入的头会被静默丢弃（契约不成立）。仅合并普通对象形态
    // （Headers 实例 / string[][] 需先规整，此处不处理，避免误并）。
    const extraHeaders: Record<string, string> =
      opts?.headers && !(opts.headers instanceof Headers) && !Array.isArray(opts.headers)
        ? (opts.headers as Record<string, string>)
        : {};
    res = await fetch("/admin/api/" + path, {
      ...(opts || {}),
      signal: ac.signal,
      headers: {
        ...(token ? { "X-Admin-Token": token } : {}),
        ...(opts && opts.body ? { "content-type": "application/json" } : {}),
        ...extraHeaders,
      },
    });
  } catch (e: any) {
    clearTimeout(timer);
    if (e && e.name === "AbortError")
      throw new ApiError("请求超时（30s）——服务端可能正忙，稍后重试", 0);
    throw e;
  }
  clearTimeout(timer);
  const text = await res.text();
  let body: any;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (!res.ok) {
    if (res.status === 401) {
      setToken("");
      unauthorized.value = unauthorized.value + 1;
    }
    throw new ApiError(
      body?.error?.message || "HTTP " + res.status,
      res.status,
      body?.error?.type,
      body?.error?.code,
      body,
    );
  }
  return body as T;
}

export const api = raw;

/* ---------------- 内部 Agent 决策矩阵（matrix） ----------------
 * 统一走上面的 raw()：token、30s 超时、401 登出、ApiError(code) 语义全站一致；
 * 未启用 Agent 时后端返回 503 {error:{code:'agent_disabled'}}，由调用方分流到专用空态。 */

/** GET /admin/api/agent/matrix —— 配置 + 维度定义 + 最近一次评估 + 统计 */
export const getAgentMatrix = (): Promise<AgentMatrixView> => raw<AgentMatrixView>("agent/matrix");

/** PUT /admin/api/agent/matrix —— 只提交 config 的子集；400 invalid_matrix_config 时 details 逐条给出原因 */
export const updateAgentMatrix = (config: Partial<MatrixConfig>): Promise<MatrixConfigResp> =>
  raw<MatrixConfigResp>("agent/matrix", { method: "PUT", body: JSON.stringify(config) });

/** POST /admin/api/agent/matrix/reset —— 恢复出厂默认配置 */
export const resetAgentMatrix = (): Promise<MatrixConfigResp> =>
  raw<MatrixConfigResp>("agent/matrix/reset", { method: "POST", body: JSON.stringify({}) });

/** GET /admin/api/agent/matrix/history?limit=N —— 内存环形缓冲里的评估记录（N 由 historyLimit 决定上限） */
export const getAgentMatrixHistory = (limit: number): Promise<MatrixHistoryResp> =>
  raw<MatrixHistoryResp>("agent/matrix/history?limit=" + encodeURIComponent(String(limit)));
