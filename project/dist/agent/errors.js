/**
 * Agent 错误分类码（v2 主题 5）。
 *
 * v1 把所有失败挤成一个 error 字符串（手工拼 'llm_parse_failed:' 前缀），
 * 无法按类型统计与告警。v2 统一为枚举 + 工厂函数：
 *   - AgentRunContext.errorCode 落历史与事件
 *   - /admin/api/agent/metrics 按 errorCode 聚合失败分布
 *   - 面板按 code 渲染人话指引
 */
export const AGENT_ERROR_CODES = [
    'llm_timeout', // LLM 调用超时（AbortController 触发）
    'llm_http_5xx', // 网关/上游 5xx
    'llm_http_4xx', // 鉴权失败（agent key 无效）、请求被拒等
    'llm_network', // fetch 抛错（连接拒绝/DNS）
    'parse_failed', // LLM 输出不是合法 JSON（一次修复调用后仍失败）
    'schema_invalid', // JSON 合法但字段形状不对（含 v2 校验失败）
    'kb_write_failed', // KB 回写失败
    'quota_blocked', // Agent 自身日配额耗尽，本轮拒绝启动
    'lease_lost', // 多实例租约被抢（本轮让位，不算失败）
    'already_running', // 并发保护拒绝（v1 已有；v2 不入历史，只作 errorCode 返回）
];
export function agentError(code, message, opts = {}) {
    const retryable = opts.retryable ?? (code === 'llm_timeout' || code === 'llm_http_5xx' || code === 'llm_network');
    const e = new Error(message);
    e.code = code;
    e.retryable = retryable;
    if (opts.status !== undefined)
        e.status = opts.status;
    return e;
}
/** 面板用的人话指引（找不到时回退 message 本身） */
export const AGENT_ERROR_HINTS = {
    llm_timeout: 'LLM 调用超时——模型太慢或网关排队；可调大 agent.llmTimeoutMs 或换快模型',
    llm_http_5xx: '网关或上游 5xx——看网关健康与上游熔断状态；持续出现查 agent key 的 tier 限流',
    llm_http_4xx: '鉴权/请求被拒——大概率 agent.clientId 对应的 key 无效或被禁用（relay check 应在启动时报）',
    llm_network: '网络错误——Agent 调本网关失败；确认 baseUrl 回填正确、端口未变',
    parse_failed: 'LLM 输出非合法 JSON（含一次修复调用后仍失败）——换更强模型或在 prompt 里加强 few-shot',
    schema_invalid: 'JSON 合法但字段形状不对——检查 schemaVersion 与字段类型',
    kb_write_failed: 'KB 回写失败——查 KB 健康与磁盘；autoWriteKb 可临时关闭',
    quota_blocked: 'Agent 日配额耗尽——次日自动恢复，或调大 agent.dailyTokenLimit / dailyCostCnyLimit',
    lease_lost: '多实例租约被抢——另一实例在跑巡检，本轮让位（正常，不需处理）',
    already_running: '上一轮仍在运行——稍后再触发（LLM 一轮 10-20 秒）',
};
//# sourceMappingURL=errors.js.map