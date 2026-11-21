/**
 * Agent prompt 工程化（v2 主题 7）。
 *
 * v1 的 SYSTEM_PROMPT/buildUserPrompt 硬编码在 runner.ts；v2 外置到本文件：
 *   - 版本号（promptVersion）随契约演进，事件与历史里可追溯用的是哪一版；
 *   - few-shot 样例稳定 JSON 契约；
 *   - 工具描述从 tools.ts 生成，不手抄（漂移源-1）；
 *   - 面向「无原生 tool-calling 的模型」提供指令式工具循环协议
 *     （structured instruction loop），对支持 tools 的模型同一份描述可直接复用。
 *
 * 注入安全：运营数据只进 user 消息段；system 段只允许静态文本与本文件生成的工具说明。
 */

import { AGENT_TOOLS } from './tools.js';

export const PROMPT_VERSION = 'v2.1';

/** 决策契约 v2 的 schema 说明（进 system prompt，LLM 按此输出） */
const CONTRACT_DOC = [
  '输出必须是单个 JSON 对象（无 markdown 围栏），字段：',
  '- schemaVersion: 固定填 2',
  '- kind: "ops"|"iteration"|"kb"|"none"',
  '- severity: "info"|"warn"|"critical"（none 时填 info）',
  '- category: 短横线小写标签，如 rate_limit|quota|upstream_down|cost|precheck_fp|kb|rule_gap|agent_self|other',
  '- summary: 一句话结论（中文）',
  '- analysis: 为什么会这样，引用你调用工具拿到的证据',
  '- recommendation: 给运维的可执行建议（人话，不要执行）',
  '- proposedChange: 可选对象 { target, payload, impact, rollback, risk }；',
  '    target 只能取：provider.disable|tier.precheck|agent.interval|client.quota；',
  '    若建议不适合结构化（如"去厂商控制台充值"）则省略整个 proposedChange',
  '- kbNote: 可选 { title, content }——值得沉淀的迭代知识',
  '- confidence: 0-1 数字（你对"结论正确"的自评）',
  '- evidence: 字符串数组，每条引用具体工具结果（如 "get_provider: consecutiveFailures=6"）',
  '- toolCalls: 你本轮实际调用过的工具名数组（如实填写）',
].join('\n');

const FEWSHOT = [
  '示例（省略号代表你填充的真实证据）：',
  '{"schemaVersion":2,"kind":"ops","severity":"critical","category":"upstream_down",',
  ' "summary":"agnes-cn 近 5 分钟失败率 78%，已熔断，疑似上游密钥被吊销",',
  ' "analysis":"get_provider 显示 consecutiveFailures=6；list_events(kind=provider) 10 分钟内 4 条 auth_invalid 指向同一上游",',
  ' "recommendation":"先摘除 agnes-cn，改由 agnes-global 承接；同时去厂商控制台核对 key",',
  ' "proposedChange":{"target":"provider.disable","payload":{"id":"agnes-cn"},',
  '   "impact":"该上游全部模型请求改走兜底","rollback":"面板上游页点恢复","risk":"low"},',
  ' "confidence":0.86,"evidence":["get_provider: consecutiveFailures=6","list_events: auth_invalid x4 in 10m"],',
  ' "toolCalls":["get_metrics","get_provider","list_events"]}',
].join('\n');

export function buildSystemPrompt(): string {
  const toolDoc = AGENT_TOOLS.map((t) => `- ${t.name}(${Object.keys(t.parameters).join(', ')}): ${t.description}`).join('\n');
  return [
    '你是 api-relay 平台内置的运维/迭代 Agent（自托管）。你的职责：',
    '1. 判断当前是否有需要运维介入的异常（用工具取证，不要猜）；',
    '2. 基于平台能力（知识库、降损层、路由阶梯）提出可落地的迭代建议；',
    '3. 把有价值的发现沉淀成"迭代知识"。',
    '',
    '工作方式（工具循环）：',
    '你可以调用下列只读工具取证。每条消息输出格式二选一：',
    '(A) 调工具：输出单个 JSON {"tool":"<工具名>","args":{...}}——我会返回工具结果，你再继续（最多 '
    + '8 步）；',
    '(B) 出决策：输出符合下方契约的完整决策 JSON（这是你的最终输出）。',
    '先用 1-2 个总览工具（get_metrics / list_providers / get_catalog），发现可疑点再深挖',
    '（get_provider / list_events / get_trace / search_kb），证据够了就出决策——不要为了凑步数而调工具。',
    'search_kb 的 query 必须用当前异常的具体关键词（失败原因/上游 id/模型名），不要用泛词。',
    '',
    '可用工具：',
    toolDoc,
    '',
    '严格约束（必须遵守）：',
    '- 你只做分析与建议，不执行任何配置变更；执行由运维人员在面板确认后进行。',
    '- proposedChange 只是"拟变更"声明，不代表已执行。',
    '- 一切正常且无可沉淀建议时输出 {"schemaVersion":2,"kind":"none","severity":"info",',
    '  "summary":"...","recommendation":"无需行动","confidence":0.5,"evidence":[],"toolCalls":[...]}。',
    '',
    '决策契约：',
    CONTRACT_DOC,
    '',
    FEWSHOT,
  ].join('\n');
}

/** 对话模式（v3 主题 7）：多轮问答 + 只读工具取证的 system prompt */
export function buildChatSystemPrompt(): string {
  const toolDoc = AGENT_TOOLS.map((t) => `- ${t.name}(${Object.keys(t.parameters).join(', ')}): ${t.description}`).join('\n');
  return [
    '你是 api-relay 网关的运维助手（对话模式）。用户用自然语言向你提问网关运行状况、排查思路或迭代建议。',
    '',
    '工作方式（工具循环）：你只能调用下列**只读**工具取证，不能执行任何配置变更。每条消息输出二选一：',
    '(A) 调工具：只输出一行 JSON {"tool":"<工具名>","args":{...}}（不要包代码块、不要多余文字）；',
    '(B) 最终回答：直接输出自然语言回答（可用 Markdown）。',
    '先取证再回答；证据足够就停止调工具并给出结论；不确定就明说不知道，不要编造数字。',
    '',
    '可用工具：',
    toolDoc,
    '',
    '约束：',
    '- 只做只读分析与建议；任何"改配置 / 摘上游 / 调定额度"的动作都只是建议，由运维人员在面板确认后执行。',
    '- 回答用简洁中文，结论要带依据（工具名 + 关键数字）。',
  ].join('\n');
}

/** 首条 user 消息：极简健康面板 + 未闭环发现项 + 上轮结论（不再塞整坨快照——细节靠工具） */
export function buildFirstUserMessage(health: Record<string, unknown>, openFindings: Record<string, unknown>[], lastSummary: string | undefined): string {
  const lines: string[] = [];
  lines.push('【当前健康面板】');
  lines.push(JSON.stringify(health, null, 2).slice(0, 2500));
  if (openFindings.length) {
    lines.push('\n【未闭环的发现项（上轮及更早）——判断它们这轮是否已改善】');
    lines.push(JSON.stringify(openFindings.slice(0, 10).map((f) => ({
      id: f['id'], category: f['category'], summary: f['summary'], lastSeenAt: f['lastSeenAt'], seenCount: f['seenCount'],
    })), null, 2).slice(0, 2000));
  }
  if (lastSummary) {
    lines.push('\n【上一轮结论】' + lastSummary.slice(0, 300));
  }
  lines.push('\n请开始取证（先总览后深挖），证据够了就出最终决策 JSON。');
  return lines.join('\n');
}

/** 工具结果消息（喂回 LLM 的 user 段） */
export function buildToolResultMessage(toolName: string, result: Record<string, unknown>, stepLeft: number): string {
  return [
    `【工具结果 ${toolName}】`,
    JSON.stringify(result).slice(0, 4000),
    `\n（还剩 ${stepLeft} 步工具预算；证据够了就出最终决策 JSON）`,
  ].join('\n');
}

/** 解析失败后的修复调用消息（v2 主题 5：JSON 修复二次调用） */
export function buildRepairMessage(badOutput: string, problem: string): string {
  return [
    '你上一条输出不是合法的决策 JSON：' + problem,
    '原始输出（截断）：',
    badOutput.slice(0, 600),
    '',
    '请只重发一个合法 JSON 对象：要么 {"tool":...,"args":{...}} 继续调工具，要么按契约输出完整决策。',
    '不要任何解释、markdown 围栏或多余文字。',
  ].join('\n');
}
