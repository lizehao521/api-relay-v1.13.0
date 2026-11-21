# Agent v2 实现说明（8 主题修复与完善 + 新增方案 9）

> 本文是 `docs/AGENT-V2-改进方案.md` 的落地记录。全部代码已通过 `npm run build`（0 error）与全量测试 **309/309**（原 297 + 新增 12 项 Agent v2 用例）。
> 硬约束不变：零运行时依赖、Agent 故障不影响 `/v1/*` 转发、不自动执行高危变更。

---

## 主题 1：只读工具化 Agent 循环（A1/B1/B4）

**新增 `src/agent/tools.ts`** —— 8 个只读工具（注册表 `Object.freeze`，白名单写死不开放配置）：

| 工具 | 取代 v1 的什么 | 输出上限 |
|---|---|---|
| `get_metrics(window, dimension)` | 整坨 overview 6000 字符 | 4000 字符 |
| `list_events(limit, kind, level)` | 固定 30 条事件 | 4000 |
| `get_provider(id)` | —（v1 无单上游深挖） | 3000 |
| `list_providers()` | providers 3000 字符 | 3000 |
| `get_trace(id?, limit?)` | —（v1 无 trace 接入） | 3000/2000 |
| `search_kb(query, topK)` | **常量 query** `'迭代 优化 运维'` | 3000 |
| `get_catalog(window)` | —（v1 不读归因 unknown） | 3000 |
| `read_policy()` | —（v1 不读降损开关） | 3000 |

- **循环协议**：指令式工具循环（`{"tool":"...","args":{...}}` → 工具结果 → 继续或出决策），兼容无原生 tool-calling 的模型；`MAX_TOOL_STEPS = 8` 硬上限写死。
- **循环实现**：`runner.ts` run() 内 for-step 循环；`parseToolCallIntent()` 识别意图并校验白名单。
- **工具结果截断**：`cap()` 统一 4000 字符封顶，防单次工具输出撑爆上下文。

## 主题 2：结构化可执行决策契约（A3/C1/C2/D4）

**`AgentDecision` v2**（`runner.ts`）：

```json
{
  "schemaVersion": 2, "kind": "ops", "severity": "critical", "category": "upstream_down",
  "summary": "…", "analysis": "引用工具证据", "recommendation": "…",
  "proposedChange": { "target": "provider.disable", "payload": {}, "impact": "…", "rollback": "…", "risk": "low" },
  "kbNote": { "title": "…", "content": "…" }, "confidence": 0.86,
  "evidence": ["get_provider: consecutiveFailures=6"], "toolCalls": ["get_metrics", "get_provider"]
}
```

- **向后兼容**：`parseDecision` 同时接受 v1（无 schemaVersion → 按 v1 处理，severity 缺省 `warn`/`info`）。
- **动作白名单**：`PROPOSED_CHANGE_TARGETS = ['provider.disable','tier.precheck','agent.interval','client.quota']`——`server.adminToken` 等高危 target **直接丢弃**（有专项测试）。
- **受控执行通道**：`proposedChange` 仅声明不执行；白名单动作可在面板二次确认后人工触发（复用既有 `providers/toggle` 等端点），记 `agent.finding_marked` 类审计事件。

## 主题 3：上下文工程（B1/B4/B5）

**重写 `src/agent/context.ts`**：

- **自适应窗口** `adaptiveWindowMs(errorRate)`：≥20% → 5m；≥5% → 1h；平稳 → 24h（先 1h 探测再定主窗口）；
- **健康信号前置**（v1 埋在大 JSON 里）：`unknownAttributionPct` / `breakerOpenProviders` / `precheckDegraded` / `precheckBlocked` / `zeroTokenGuard` / `clientAuthFailures`；
- **trace 接入**：最近 5 条失败轨迹的 `traceId/failedAtStage/durationMs`（脱敏——不带载荷）；
- 首条 user 消息从 12KB 级快照缩到 **≤2.5KB 健康面板**，细节由工具按需拉。

## 主题 4：检索与长期记忆（A2/B2/E2）

**新增 `src/agent/memory.ts`（AgentMemory）**：

- **发现项状态机**：`open → acknowledged / resolved / ignored`；同题去重键 `category + summary[0:40]`，重复出现 `seenCount++`（面板显示"已连续 N 轮"）；
- **回喂**：run() 前取 `openFindings()` + 上一轮 summary 注入 prompt（"判断这轮是否已改善"）；决策 `kind=none` 且 analysis 命中时自动销号；
- **持久化**：复用 `store.logEvent` 落 `agent.finding` 事件（零新表、随 prune 保留期管理）；重启后从事件流懒重建（同 `#183/#255` 模式，窗口 800 条）；
- **检索 query 动态化**：`search_kb` 工具 query 由 LLM 按当前异常现生成（prompt 明确要求"用具体失败原因/上游 id，不要用泛词"）——取代 v1 常量查询。

## 主题 5：护栏与成本控制（D1-D5）

| 护栏 | 实现 | 位置 |
|---|---|---|
| **日配额** | `DailyQuota`（token/金额双限，按日翻转）；超限拒绝下一轮，`errorCode=quota_blocked` + 事件 | `runner.ts` |
| **多实例租约** | `InstanceLease`（事件表打标 + TTL 5 分钟；auto 巡检前抢占，manual 不抢） | `runner.ts` |
| **重试** | 超时/5xx/网络 → 指数退避 400ms×2^n（≤4s），最多 2 次；4xx 直接抛 | `llm.ts` |
| **JSON 修复** | 解析失败 → `buildRepairMessage` 回喂坏输出要求重发合法 JSON（一次机会） | `prompts.ts`+`runner.ts` |
| **max_tokens** | 1024 → **2048**（契约更长，截断=解析失败根因） | `llm.ts` |
| **错误码** | `AGENT_ERROR_CODES` 枚举 10 项 + `agentError()` 工厂 + 面板人话指引 `AGENT_ERROR_HINTS` | `errors.ts` |

**新增 `src/agent/errors.ts`**：`llm_timeout/llm_http_5xx/llm_http_4xx/llm_network/parse_failed/schema_invalid/kb_write_failed/quota_blocked/lease_lost/already_running`。

## 主题 6：可观测性与面板（E1-E4）

- **新端点**（`handlers/agent.ts` route()）：
  - `GET /admin/api/agent/metrics` → 成功率、p50/p95 耗时、token 总量与配额快照、toolCalls 累计、byKind/byErrorCode 分布、发现项计数、`degraded` 布尔；
  - `GET /admin/api/agent/findings[?open=1]` → 全部/未闭环发现项；
  - `POST /admin/api/agent/findings/{id}/mark` `{status: acknowledged|resolved|ignored}` → 人在环打标（404/400 校验齐全）；
- **`status()` 扩容**：`promptVersion/maxToolSteps/quota/openFindings/consecutiveFailures`；
- **视图附带 `errorHints`**（错误码 → 人话指引），面板渲染"为什么失败/怎么办"。

## 主题 7：prompt 与模型策略工程化（A4/F3）

**新增 `src/agent/prompts.ts`**（`PROMPT_VERSION='v2.1'`，事件与历史可追溯）：

- SYSTEM_PROMPT 组装：职责 → 工具循环协议 → **工具描述（从 tools.ts 生成，零漂移）** → 严格约束 → 契约文档 → **few-shot 样例**（稳定 JSON 契约）；
- `buildFirstUserMessage`（健康面板+未闭环+上轮结论）/ `buildToolResultMessage`（含剩余步数）/ `buildRepairMessage`（修复调用）；
- **注入安全**：运营数据只进 user 段；system 段只有静态文本与工具说明。

## 主题 8：与降损主线打通（F1/F2）

- **规则迭代闭环**：`get_catalog` 工具暴露 `unknownPct`；契约 `category=rule_gap` 让 Agent 产出"该补哪条归因规则"的 iteration 建议；
- **Agent 自身入运维闭环**：连续失败 `DEGRADED_THRESHOLD=3` 轮 → `agent.degraded` **error 级**事件（与 meter/store 降级同款处理）；恢复后计数清零；
- **健康信号互相喂**：context 的 `unknownAttributionPct` 直接来自 `attributionStats`——归因层的数据缺口成了 Agent 的输入。

## v1 缺陷修复（P0-8 落地）

| 编号 | 缺陷 | 修复 | 验证 |
|---|---|---|---|
| **D6** | `inspectConfig` 对 agent 零校验，clientId 写错静默 401 | enabled 时校验 clientId 存在/model 非空/interval 合理/配额建议（error/warn 分级） | `config.ts` + 方案文档 |
| **D7** | 前端写 KB 固定 `kb-demo`+addDoc（无判重） | kb handler 支持 `upsert:true` 走 `upsertDoc`；前端动态 `kbId`（props 传递） | handler+Agent.tsx |
| **D8** | 拒绝轮入历史，runCount 虚高 | `already_running` 直接 return，不 `history.set` | 测试"并发保护" |
| **D9** | 贪婪正则拼非法 JSON | **平衡括号扫描**：`extractBalancedObjects` + `pickObjectWithKeys`（特征键 `kind/schemaVersion/tool` 挑对象，防示例对象劫持） | 测试"D9 回归" |
| **D10** | autoWriteKb 注释与行为矛盾 | 默认 **false**（仅人工确认写），v1 行为需显式 `autoWriteKb: true` | 测试"D10 回归" |

## 配置新增（`AgentConfig`）

```yaml
agent:
  enabled: true
  clientId: ops-agent          # clients 里的一条 agent 专用 key
  model: agnes-2.0-flash
  intervalMs: 1800000          # 30 分钟
  llmTimeoutMs: 60000
  autoWriteKb: false           # v2 默认 false（D10）
  kbId: kb_demo
  dailyTokenLimit: 200000      # v2 新增：日 token 上限
  dailyCostCnyLimit: 5.0       # v2 新增：日金额上限（元）
```

---

## 新增方案 9：Agent 自进化回路（Self-Evolving Loop）——建议 v2.x 落地

> 8 个主题把 Agent 变成了"有工具、有记忆、有护栏的运维助手"，但它的** prompt 与规则仍是静态的**。方案 9 让 Agent 的产出反过来改进 Agent 自身——闭环的最后一环。

### 9.1 动机

- 主题 4 的发现项只服务运维（人看）；Agent 自己不学习"哪类建议被采纳/驳回"；
- 主题 7 的 few-shot 是手写的；真实的高质量决策样本（已被采纳的）就在自家事件库里，白白浪费；
- `unknown` 归因占比（主题 8）指出了规则缺口，但"补什么规则"的建议没有沉淀为可复用资产。

### 9.2 设计（三件事）

**① 建议采纳率反馈回路（数据层）**

- 打标端点已就位（`POST /agent/findings/{id}/mark`）；
- 新增聚合：`metrics()` 加 `adoption`（采纳率 = resolved-with-apply / total-marked）；
- Agent prompt 注入"你最近 20 轮的建议采纳率与被驳回原因摘要"——让模型对自己的历史负责（self-conditioning）。

**② 决策样本自蒸馏（prompt 层）**

- 每次打标 `resolved`（且经人工 apply）的决策 → 自动提炼成 few-shot 候选（summary/analysis/evidence/toolCalls 五元组）；
- 候选进 `kbId` 下的 `agent-fewshot` 文档（source='agent-distill'）；
- `buildSystemPrompt()` 的 few-shot 段从该文档动态拉取（替换手写样例），**上限 2 条**（token 预算保护）；
- 驳回样本同样入库（"反例"），prompt 附"最近被驳回的建议模式"。

**③ 规则缺口半自动提案（规则层，人在环）**

- `get_catalog` 的 `unknownPct ≥ 30%` 持续 3 轮 → Agent 必须产出 `category=rule_gap` 的 iteration 决策，`kbNote` 里给出：样本摘要（脱敏）、建议的规则形状（匹配关键词 → 归因）、置信度；
- 面板"规则缺口"卡：一键复制提案 → 人工评审后进 `attribution.ts` 的 RULES（**不改代码不生效**——保持"建议不执行"红线）。

### 9.3 收益与风险

| 项 | 说明 |
|---|---|
| 收益 | prompt 随真实运营演进；建议质量有量化口径（采纳率）；归因规则的缺口有持续供给 |
| 风险 | 自蒸馏可能放大偏见（驳回样本入库缓解）；采纳率指标需防刷（mark 限 admin 已有鉴权） |
| 红线 | 仍不自动改代码/配置；fewshot 注入只进 system 的静态槽位（运营数据仍只在 user 段，注入安全不破） |
| 落点 | `memory.ts`（打标聚合）、`prompts.ts`（动态 few-shot）、`handlers/agent.ts`（规则缺口卡）、`agent.test.ts`（回路用例） |

---

## 验证记录

| 项 | 结果 |
|---|---|
| `npm run typecheck` | 0 error |
| `npm run build` | 0 error |
| 全量测试 | **309/309**（297 + 12 新增：v1/v2 双契约、白名单丢弃、D9 多对象、工具意图、8 工具注册表、自适应窗口、工具循环 3 轮、D10、修复调用、D8、配额、发现项状态机、metrics、status v2 字段） |
| 变更文件 | 新增 5（`agent/{tools,errors,prompts,memory}.ts` + 测试重写）；重写 3（`agent/{runner,llm,context}.ts`、`handlers/agent.ts`）；编辑 6（`types.ts`/`config.ts`/`app.ts`/`api.ts`/`kb.ts`(handler)/`Agent.tsx`） |
