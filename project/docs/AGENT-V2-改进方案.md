# 内置 Agent 助手（v1）现状分析与 v2 改进方案

> 面向第二版迭代。以第一版已落地的「内部 Agent 系统 · 自托管运维/迭代决策环」为切入点，先如实描述现状与不足，再给出可落地的改进方案与修改建议。
> 事实来源：`src/agent/{runner,context,llm}.ts`、`src/admin/handlers/agent.ts`、`src/admin/api.ts`、`src/app.ts`、`src/core/{types,config}.ts`、`frontend/src/views/Agent.tsx`、`src/test/agent.test.ts`。文中行号以 v1 为准。

---

## 0. 结论先行（TL;DR）

v1 的 Agent 是一个**设计正确、边界干净、但能力停在"单轮问答"** 的运维助手：它把"网关调用自己"的闭环跑通了（读运营快照 → 调本网关 LLM → 产出建议 → 写 KB + 记审计），安全边界（只建议不执行、故障不影响转发）也守得住。

但它有四个结构性短板，决定了它"能用但不够用"：

1. **无工具调用**——上下文一次塞死，信息要么不足要么噪声大，无法按需取证；
2. **无记忆/无闭环追踪**——每轮独立、同一问题重复报、建议无处"销号"；
3. **无成本护栏**——周期巡检会持续烧 token，Agent 自身故障可反复自伤；
4. **闭环断在最后一步**——只产出纯文本建议，人还得手抄，且产出无法被反馈学习。

v2 的核心命题：**把它从"周期性写报告的 LLM 调用器"升级为"带只读工具、有记忆、有护栏、有受控执行通道的运维 Agent"**，同时守住"零运行时依赖 / 不自动改配置"两条红线。

---

## 一、v1 现状

### 1.1 定位与设计意图

- **自托管运维/迭代决策环**："网关用自己的 LLM 分析自己的运营数据"，不依赖外部 SaaS，天然可审计。
- **安全不变量**（写进文件头注释）：主路径（鉴权/路由/透传）完全不碰 Agent；Agent 只产"建议"不直接改配置/数据库；所有 LLM 调用带 agent 指纹（`client_kind=agent`），在计量里可识别、可归因。
- **自证闭环**：Agent 调 LLM 走本网关 `/v1/chat/completions`，因此它自己也被鉴权/预检/归因/熔断/计量保护。

### 1.2 代码结构与规模（事实）

| 文件 | 行数 | 职责 |
|---|---|---|
| `src/agent/runner.ts` | 319 | 决策契约、SYSTEM_PROMPT、上下文拼装、`parseDecision`、决策历史环、`run()` 主循环 |
| `src/agent/context.ts` | 47 | `collect()`：把 meter/pool/store 打包成 `AgentOpsSnapshot` |
| `src/agent/llm.ts` | 65 | 封 `fetch` 调本网关 `/v1/chat/completions`（`temperature=0.1`、`max_tokens=1024`、UA=`api-relay-ops-agent/1.0`） |
| `src/admin/handlers/agent.ts` | 141 | 面板视图 / 手动触发 / 子路由（`last`、`runs`）/ 重启回退重建 |
| `src/admin/api.ts` | — | 路由挂载（`/admin/api/agent[...]`）+ 惰性 getter 回填 |
| `src/app.ts` L122-149 | — | 装配：找 agent client key → 建 llm/context/runner → 回填 admin.deps |
| `frontend/src/views/Agent.tsx` | 329 | Agent 页：状态表、最近一轮、决策历史、复制、一键写 KB |
| `src/test/agent.test.ts` | 139 | 6 个单测 |

### 1.3 运行链路

```
周期 intervalMs（或面板手动 POST /admin/api/agent）
  └─ AgentRunner.run(trigger)
       ├─ 并发保护：running=true 则拒绝（already_running）
       ├─ context.collect() → AgentOpsSnapshot
       │     ├─ overview = { uptime_s, window24h: meter.summarize(24h) }
       │     ├─ providers = pool.snapshot()（id/label/disabled/breakerOpen/requests/failures/consecutiveFailures）
       │     └─ recentEvents = store.listEvents(30)
       ├─ 若 kb.ok：kb.search(kbId, '迭代 优化 运维', 5) → snap.kbHits
       ├─ buildUserPrompt(snap)（各段 slice 限长）
       ├─ llm.chat([system, user]) → 走本网关 → 普通 chat.completion
       ├─ parseDecision(content)（容错：整体 parse → 失败抠首个 {...} → 再 parse）
       ├─ 若 kind∈{kb,iteration} 且 kbNote 且 autoWriteKb≠false → kb.upsertDoc(...)
       └─ store.logEvent('agent.decision', {...}) → 写入内存历史环
```

### 1.4 对外接口 / 配置项

**管理接口**（`src/admin/api.ts`）

| 方法 | 路径 | 语义 |
|---|---|---|
| GET | `/admin/api/agent` | 状态视图（`status` + `runs` 仅保留最新 1 条） |
| POST | `/admin/api/agent` | 手动触发一轮（返回 202；运行中 409 `agent_running`；未启用 503 `agent_disabled`） |
| GET | `/admin/api/agent/last` | 最近一轮（无记录 404） |
| GET | `/admin/api/agent/runs?limit=N` | 决策历史（默认 20，上限 200） |

**配置**（`AgentConfig`，`src/core/types.ts` L800-817）：`enabled` / `clientId` / `model` / `intervalMs` / `llmTimeoutMs` / `autoWriteKb` / `recentEvents` / `kbId`。

**决策契约**（LLM 输出 JSON）：`kind ∈ {ops, iteration, kb, none}`、`summary`、`recommendation`、`kbNote?{title,content}`、`confidence ∈ [0,1]`、`evidence[]`（截断到 12 条）。

### 1.5 v1 已经做对的地方（v2 必须保住）

- ✅ **安全边界**：Agent 不执行配置变更；失效不影响主转发路径。
- ✅ **KB 防堆积**：用 `upsertDoc`（同题原地更新）而非 `addDoc`——修掉了 `manual#392 / #368`（30 分钟重写同题把 KB 堆到 159 篇/54 标题）。
- ✅ **重启回退**（`manual#255`）：内存环空时用持久 `agent.decision` 事件重建最近一轮，面板不空。
- ✅ **惰性扫描**（`manual#340`）：`lastFromEvent()` 只在回退分支才扫事件，稳态不白扫 500 条。
- ✅ **视图载荷瘦身**（`manual#353`）：视图 `runs` 只留最新 1 条，完整历史走 `/agent/runs`。
- ✅ **并发保护**：`already_running` 防重入。
- ✅ **JSON 容错**：`parseDecision` 处理 markdown 围栏/前后杂字，非法 kind 回退 `none`，confidence 夹紧。
- ✅ **自指纹**：`client_kind=agent` 让 Agent 流量在计量里可区分。

---

## 二、v1 的不足

> 分维度编号，便于 v2 逐条对齐。带 `⚑` 的是**代码级确定缺陷**（附位置）。

### A. 决策能力（"想问什么"层面）

- **A1 无工具调用**：上下文一次性塞给 LLM，Agent 无法"先看一眼再决定看什么"。想看某上游 5 分钟细节、想查某条 trace、想检索特定关键词，都做不到——只能等下一轮整体重来。
- **A2 单轮无记忆**：每轮独立，`history` 只用于面板展示，**不回喂 prompt**；上一轮的结论/未解决项对下一轮不可见 → 同一问题反复报。
- **A3 无严重度分级**：`kind` 只有类别，没有 `severity`（现在告警 vs 可延后优化），运维无法排优先级。
- **A4 confidence 语义弱**：模型自报置信度，无校准、无历史命中率回校，`confidence` 对决策排序几乎无实际作用。

### B. 上下文与检索

- **B1 上下文静态**：`collect()` 窗口写死 24h（`86_400_000`）、事件默认 30 条；失败率飙升时不会自动扩窗/加密度，也不会把最相关的证据前移。
- **B2 检索 query 写死**：`kb.search(kbId, '迭代 优化 运维', 5)` 是**常量查询**，与"当前到底出什么事"无关 → 召回的历史经验往往不对题，错题本的复用价值被浪费。
- **B3 检索器是关键词（bigram+TF-IDF）**：无同义/无向量，语义相近但用词不同的经验召不回；`kbHits` 还只取 `text.slice(0,200)`（`runner.ts` L269），信息被二次截断。
- **B4 无 trace / 账本接入**：`context.ts` 的依赖只有 `pool/store/meter/kb`，**没有 traceStore**；Agent 看不到"某个请求卡在哪一步"，只能看聚合与事件。
- **B5 未把"降损健康信号"显式化**：`unknown` 归因占比、`precheckDegraded`、熔断上游数、预算越线——这些恰是最该驱动运维动作的信号，但没进快照。

### C. 执行闭环与安全

- **C1 闭环断在最后一步**：产出是纯文本 `recommendation`，无结构化"拟变更"，人还要手抄；面板"一键写 KB"也只覆盖知识沉淀，不覆盖配置类建议。
- **C2 无变更影响评估**：建议不附带"影响面 / 回滚方式 / 风险等级"，执行者缺依据。
- **C3 无通知外发**：产出只进面板与事件库，值班不看面板就收不到。
- **C4 无人在环反馈**：运维无法对建议打标（采纳/驳回/无用），Agent 不学习。

### D. 健壮性与成本（**最该在 v2 补的短板**）

- **D1 无成本护栏**：`intervalMs` 很短或模型较贵时，Agent 会持续烧 token；无单日 token/金额上限、无"Agent 自伤熔断"（Agent 自己连续失败仍在定时调用）。
- **D2 多实例重复**：定时器每实例各跑一份 → 重复 LLM 花费 + 重复写 KB（`upsertDoc` 只消除重复文档，不消除重复调用）。
- **D3 错误处理薄**：LLM 超时/5xx/解析失败**无重试、无退避、无降级**；解析失败只是把原文截 200 字符塞进 evidence。
- **D4 无错误分类码**：所有失败挤成 `error` 字符串（`llm_parse_failed:` / `kb_write_failed:` 前缀手工拼），无法按类型统计与告警。
- **D5 `max_tokens=1024` 偏小**：结构化决策 + `kbNote.content` 偏长时可能被**截断**，直接导致 JSON 不完整 → 解析失败。
- **D6 ⚑ 缺少启动期配置校验**：`inspectConfig()`（`src/core/config.ts` L333+）校验了 providers/clients/adminToken/阶梯，**但对 `config.agent` 零校验**。`agent.enabled=true` 但 `clientId` 找不到时，`agentKey=''`（`app.ts` L126）→ 每轮 LLM 调用必然 401，而启动/`check` **不报错**，静默失败。
- **D7 ⚑ 前端"一键写 KB"绕过了服务端防堆积**：`Agent.tsx` L52 POST 到固定 `kb/kb-demo/docs`（`addDoc`，**无判重**），且库名 `kb-demo` 与后端默认 `kb_demo` 不一致（`runner.ts` L243 / `handlers/agent.ts` 注释）。即服务端好不容易修好的"堆积"问题，在这个手动按钮上又开了一个口子。
- **D8 ⚑ 拒绝轮次污染历史**：`already_running` 的拒绝结果也 `history.set(...)`（`runner.ts` L260），会占 `runCount` 与历史列表，面板"历史轮数"因此虚高。
- **D9 ⚑ `parseDecision` 贪婪匹配**：`/\{[\s\S]*\}/` 从第一个 `{` 取到最后一个 `}`；模型若输出多个对象/含示例对象，会拼出非法 JSON 而整体失败。
- **D10 ⚑ `autoWriteKb` 语义与注释矛盾**：类型注释写"默认 true；仅人工确认的才自动写"，但代码在 `autoWriteKb !== false` 时**自动写**（`runner.ts` L288-290）→ 实际是"默认自动发布，无人工确认"。文档误导。

### E. 可观测性与面板

- **E1 无 Agent 自身指标**：只有 `runCount` + 单轮结果，缺成功率、p50/p95 耗时、token 趋势、kind 分布、失败分类占比。
- **E2 历史是内存环（cap 50）**：重启即丢，`runCount` 归零；仅靠事件回退重建"1 条"，无完整决策史、无趋势、无法做"哪类建议常被采纳"的复盘。
- **E3 面板能力单薄**：无筛选（kind/trigger/ok）、无搜索、无导出（只有单条复制）、无"未闭环清单"、无受控 apply。
- **E4 无引导**：未启用时只给一段文字，无"一键生成 agent client key + 配置片段"（用户要手工配 `clients` 里那条 key，正是 D6 的高发区）。
- **E5 ⚑ 轮询交互粗糙**：手动触发后用 8/16/24/32/40/48s 六次固定轮询（`Agent.tsx` L242），到点没结果就交给自动刷新；无进度态/无失败提示。

### F. 与"降损"主线的耦合

- **F1 归因目录未反哺**：`unknown` 占比是"该补哪条规则"的 TODO 清单（见 `docs/research/03` §M3），但 Agent 没读 `byFailureReason`，提不出"补规则"的迭代建议——这恰是它自称的职责之一。
- **F2 Agent 自身故障未入运维闭环**：Agent 连续 `llm_timeout` / 连续解析失败，没有任何告警信号（只在单轮 `logEvent` 里留一条 warn）。
- **F3 prompt 硬编码**：SYSTEM_PROMPT 与 `buildUserPrompt` 写死在 `runner.ts`，不可配置、不可 A/B、不可按环境定制。

### G. 测试覆盖

- **G1 仅 6 个用例**：覆盖了 `parseDecision`(4) + 全链路 + 坏 JSON + 并发；**未覆盖** `status()`、`start()/stop()`、历史环上限（50）、`lastFromEvent` 重建、KB 未启用降级、`upsertDoc` 更新路径（同题二次运行）、D6-D9 的缺陷分支。

---

## 三、v2 改进方案（主题制）

> 每个主题：**问题 → 方案 → 收益 → 风险/边界**。落地优先级见第四节。

### 主题 1：从"单轮问答"升级为"只读工具化 Agent 循环"

- **对应不足**：A1、B1、B4。
- **方案**：引入**只读工具集**（function/tool calling 或结构化指令循环），允许 Agent 在 2–4 步内"取证→再决策"：
  - `get_metrics(window, dimension, topN)` —— 取代"整坨 overview"；
  - `list_events(kind, level, since, limit)` —— 按需拉事件；
  - `get_provider(id)` / `list_providers()` —— 单上游深挖；
  - `list_traces(filter)` / `get_trace(id)` —— 具体请求证据（脱敏）；
  - `search_kb(query, topK)` —— **query 由 Agent 现生成**（解决 B2）；
  - `get_catalog()` —— 归因目录/未知占比（解决 F1 的一半）；
  - `read_policy()` —— 当前降损层开关与分层策略（只读）。
- **硬约束**：**全部只读、无副作用**；工具白名单在代码里固定，不开放任意代码执行。
- **收益**：上下文按需、噪声小、token 省、结论可追溯到具体证据；把"一次性大 prompt"变成"小步快跑"。
- **风险**：循环上限必须硬编码（`maxToolSteps`），否则可能失控轮询；每次工具调用不消耗网关主链路配额（是内部读）。

### 主题 2：结构化、可执行的决策契约（v2 schema）

- **对应不足**：A3、C1、C2、D4。
- **方案**：扩展决策 JSON：

```json
{
  "schemaVersion": 2,
  "kind": "ops|iteration|kb|none",
  "severity": "info|warn|critical",
  "category": "rate_limit|quota|upstream_down|cost|precheck_fp|kb|rule_gap|...",
  "summary": "一句话结论",
  "analysis": "为什么会这样（引用工具取证结果）",
  "recommendation": "给运维的可执行建议（人话）",
  "proposedChange": {
    "target": "provider.disable|tier.precheck|agent.interval|client.quota|...",
    "payload": { "...": "..." },
    "impact": "影响面",
    "rollback": "如何回滚",
    "risk": "low|medium|high"
  },
  "kbNote": { "title": "…", "content": "…" },
  "confidence": 0.0,
  "evidence": ["工具调用#1 结果摘要", "..."]
}
```

- **受控执行通道（人在环）**：`proposedChange` 只是**声明**，不自动执行；面板按 `target` 走**动作白名单**渲染一个"一键执行"按钮（**二次确认 + 记事件 + 可回滚**）。默认仍不自动执行，安全边界不变。
- **收益**：建议可被机器消费（排序/去重/追踪），人不必手抄；为"闭环销号"打基础。
- **风险**：白名单必须收敛到**低风险、可回滚**动作（关预检、清熔断、摘上游、调 agent 间隔）；**禁止** Agent 触碰计费/密钥/内容策略（对齐 `docs/research/03` §393 的指纹落地约束）。

### 主题 3：上下文工程（context engineering）

- **对应不足**：B1、B4、B5。
- **方案**：
  - **自适应窗口**：按异常显著性自动选 5m/1h/24h；异常越大窗口越细、维度越深；
  - **健康信号面板化前置**：把 `unknown 归因占比`、`precheckDegraded`、`熔断上游数`、`预算越线`、`零 token 事件数` 做成"关键-值"表**置顶**（而非混在大 JSON 里）；
  - **接入 traceStore**：快照里带"最近 N 条失败 trace 的 id + 首次失败阶段"（脱敏），供 Agent 引用与工具下钻；
  - **分级摘要**：概览用极简指标，细节靠工具按需拉。
- **收益**：同样的上下文预算，信号密度大幅提升；结论更贴主线的降损指标。
- **风险**：自适应窗口要有上限（避免异常时把窗口拉到全量扫表）。

### 主题 4：检索与长期记忆

- **对应不足**：A2、B2、B3、E2。
- **方案**：
  - **检索 query 动态生成**：用当前异常特征（top failure_reason + 上游 + 模型 + fatal kind）拼 query，替代常量 `'迭代 优化 运维'`；
  - **记忆持久化**：新增持久表（如 `agent_run` / `agent_finding`）保存每轮决策与"发现项"；
  - **发现项状态机**：`open → acknowledged → resolved / ignored`，同一问题**不再重复报**（新轮次把 open 项喂回 prompt，做"这轮是否已改善"的增量判断）；
  - **回喂上一轮**：把"上一轮 summary + 未闭环清单"作为 prompt 的固定段落。
- **收益**：从"每次都从头看"变成"带着上下文增量运维"，噪声骤降、可销号。
- **风险**：新表要纳入 `prune` 保留期；`kbId` 与发现项的关系要定义清楚。

### 主题 5：护栏与成本控制（**v2 最高优先级之一**）

- **对应不足**：D1、D2、D3、D5。
- **方案**：
  - **Agent 自身配额**：给 agent client 在 `clients` 里配 `tier` / `quotaOverride`，复用网关既有预算能力；**再加** Agent 专属"日 token / 日金额上限 + 超限熔断"；
  - **多实例去重**：分布式租约（"仅 leader 跑"）或 DB 抢占锁，确保同一时刻只有一份巡检；
  - **调用健壮性**：超时/5xx 指数退避重试；**JSON 修复二次调用**（解析失败时把坏输出 + schema 回喂，要求"只重发合法 JSON"）；
  - **`max_tokens` 提高 + 流式收集**：避免截断（`proposedChange` 会加长输出）；
  - **错误分类码枚举**：`llm_timeout | llm_http_5xx | llm_http_4xx | parse_failed | schema_invalid | kb_write_failed | quota_blocked`。
- **收益**：Agent 变成"成本可预测、失败可分类、多副本安全"的组件。
- **风险**：租约机制要轻（不引入 Redis，用 SQLite/文件锁即可，保持零依赖）。

### 主题 6：可观测性与面板增强

- **对应不足**：E1、E2、E3、E5、C4。
- **方案**：
  - 新端点 `GET /admin/api/agent/metrics`：成功率、p50/p95 耗时、token 趋势、kind/severity 分布、失败分类占比；
  - 面板：**筛选/搜索/导出（CSV/JSON）**、**未闭环清单**、**一键 apply（受控 + 二次确认）**、**打标反馈**（采纳/驳回 → 供"建议采纳率"与后续 prompt 优化）；
  - 触发后**进度态**（SSE 或轮询带状态字段，替代固定六次盲轮询）。
- **收益**：Agent 从"黑盒跑一轮"变成"可运营的产品面"。
- **风险**：metrics 端点注意体积（与前次 `#353` 同族的载荷天花板教训）。

### 主题 7：prompt 与模型策略工程化

- **对应不足**：A4、F3、D5。
- **方案**：
  - **prompt 外置**：SYSTEM_PROMPT / user 模板移到配置文件或模板文件，支持版本号与 A/B；
  - **few-shot** 稳定 JSON 契约（放 1-2 个正确样例）；如上游支持，改用 **JSON Schema/结构化输出**；
  - **分层模型策略**：常规巡检用便宜快模型，`severity=critical` 或工具循环深挖时升级到强模型（复用 `modelLadders` 思路）。
- **收益**：契约更稳、成本更低、可调优。
- **风险**：外置 prompt 的注入安全（模板不得拼接未净化的运营数据到 system 指令段）。

### 主题 8：与"降损"主线打通

- **对应不足**：F1、F2。
- **方案**：
  - **规则迭代闭环**：Agent 读归因 `unknown` 占比 + 高频未归因样本，产出"**该补哪条规则**"的 `iteration` 建议（`category=rule_gap`）；
  - **Agent 自身纳入运维闭环**：连续失败超阈值 → 写一条 `agent.degraded` 事件并在面板显著提示（与 `meter`/`store` 降级同款处理）。
- **收益**：Agent 真正成为"降损层"的一部分（自我改进回路），而非旁挂的分析器。
- **风险**：规则建议仍需人工评审后才改代码（不越界到自动改代码）。

---

## 四、修改建议（落地清单）

> 列：编号 / 内容 / 涉及文件 / 优先级。P0 = v2 必做，P1 = 强烈建议，P2 = 有余力再做。

### P0（v2 必做，多为护栏与契约，改动可控）

| # | 变更 | 涉及文件 |
|---|---|---|
| P0-1 | 决策 schema 扩展到 v2（`severity/category/schemaVersion/proposedChange`），`parseDecision` 兼容 v1 输入 | `agent/runner.ts`、`core/types.ts`、`frontend/src/types.ts` |
| P0-2 | 错误分类码枚举 + `AgentRunContext.errorCode`；`status()` 暴露最近错误码 | `agent/runner.ts`、`admin/handlers/agent.ts` |
| P0-3 | **补 `inspectConfig` 的 agent 校验**：`enabled` 时校验 `clientId` 在 `clients` 中存在、`model` 非空、`kbId`（若回写）存在；缺失 → error（对齐 D6） | `core/config.ts` |
| P0-4 | Agent 自身配额/日上限 + 超限熔断（复用 clients 预算能力 + 新护栏） | `core/types.ts`、`app.ts`、`agent/runner.ts` |
| P0-5 | 多实例巡检去重（SQLite/文件租约，"仅 leader 跑"） | `agent/runner.ts`、`app.ts` |
| P0-6 | LLM 调用健壮性：退避重试 + JSON 修复二次调用 + `max_tokens` 提高 | `agent/llm.ts`、`agent/runner.ts` |
| P0-7 | 决策/发现项持久化（新表）+ 未闭环状态机 + 回喂上一轮 | `store/index.ts`、`agent/runner.ts` |
| P0-8 | 修复 D7（前端"一键写 KB"对齐服务端 `upsertDoc` 与 `kbId`）、D8（拒绝轮次不入历史）、D9（`parseDecision` 换非贪婪/首个平衡对象）、D10（`autoWriteKb` 注释与默认值对齐） | `frontend/src/views/Agent.tsx`、`agent/runner.ts` |

### P1（强烈建议）

| # | 变更 | 涉及文件 |
|---|---|---|
| P1-1 | 只读工具集 + Agent 循环（`maxToolSteps` 硬上限）→ 新增 `agent/tools.ts` | `agent/tools.ts`(新)、`agent/runner.ts`、`agent/llm.ts`（tool-calling 适配） |
| P1-2 | 自适应上下文窗口 + 健康信号前置 + trace 接入 | `agent/context.ts` |
| P1-3 | 检索 query 动态生成（由异常特征拼） | `agent/runner.ts`、`kb/store.ts`（可选：混合检索） |
| P1-4 | Agent 指标端点 `/admin/api/agent/metrics` | `admin/handlers/agent.ts`、`admin/api.ts` |
| P1-5 | 面板增强：筛选/搜索/导出/未闭环清单/受控 apply（二次确认）/打标 | `frontend/src/views/Agent.tsx`、`admin/handlers/agent.ts` |
| P1-6 | prompt 外置 + few-shot + schema 契约 | `agent/prompts.ts`(新) 或配置项、`agent/runner.ts` |
| P1-7 | 补测试：`status/start/stop`、历史上限、`lastFromEvent`、KB 降级、`upsertDoc` 二次更新、P0 各缺陷分支 | `src/test/agent.test.ts` |

### P2（有余力）

| # | 变更 | 涉及文件 |
|---|---|---|
| P2-1 | 分层模型策略（巡检用快模型、critical 升级） | `agent/runner.ts`、`core/types.ts` |
| P2-2 | 通知外发（webhook/IM） | 新 `agent/notify.ts`、配置 |
| P2-3 | 未启用时的"一键启用向导"（生成 agent key + 配置片段） | `admin/handlers/agent.ts`、`frontend/src/views/Agent.tsx` |
| P2-4 | 混合/向量检索（评估是否引入依赖，保持"零运行时依赖"红线的前提下优先自研 bigram 增强） | `kb/store.ts` |

---

## 五、建议的 v2 决策契约（最小可用版示例）

```json
{
  "schemaVersion": 2,
  "kind": "ops",
  "severity": "critical",
  "category": "upstream_down",
  "summary": "agnes-cn 近 5 分钟失败率 78%，已触发熔断，疑似上游密钥被吊销",
  "analysis": "get_provider('agnes-cn') 显示 consecutiveFailures=6；list_events(kind=auth_invalid) 近 10 分钟 4 条指向同一 provider",
  "recommendation": "先摘除 agnes-cn，改用 agnes-global 承接；同时去厂商控制台核对 key",
  "proposedChange": {
    "target": "provider.disable",
    "payload": { "id": "agnes-cn" },
    "impact": "agnes-cn 承载的全部模型请求改走 agnes-global；成功率预计回升",
    "rollback": "面板『上游』页点『恢复』",
    "risk": "low"
  },
  "confidence": 0.86,
  "evidence": ["consecutiveFailures=6", "auth_invalid×4 in 10m"]
}
```

---

## 六、验收标准（v2 交付时应可验证）

1. **契约**：`parseDecision` 同时接受 v1/v2；v2 非法字段回退安全默认，`schemaVersion` 缺失按 v1 处理。
2. **护栏**：Agent 日 token/金额超限后**拒绝下一轮**并记 `agent.quota_blocked` 事件；多实例下同一时刻仅一份巡检（可用两进程并发测试验证）。
3. **健壮性**：LLM 5xx/超时按退避重试；坏 JSON 触发一次"修复调用"，仍失败才 `ok=false`；错误码分类可查。
4. **记忆**：重启后决策历史与未闭环项**不丢**（持久表）；同一问题连续两轮不重复出现在未闭环清单（除非恶化）。
5. **校验**：`enabled=true` 但 `clientId` 缺失时，`relay check` 与启动**报 error**（不再静默 401）。
6. **测试**：`agent.test.ts` 用例数显著扩充，覆盖 status/生命周期/历史上限/回退重建/降级/更新路径与新护栏分支；全量 `npm test` 通过。
7. **不变量**：Agent 故障绝不影响 `/v1/*` 转发（可用"Agent LLM 端点不可达"场景回归）。

---

## 七、刻意不做（守住 v1 的边界与卖点）

- ❌ **不做自动执行高危变更**：计费、密钥、内容策略、`adminToken` 等仍只能人工操作；`proposedChange` 只开放低风险可回滚动作白名单。
- ❌ **不做服务端内容审查**（与主线一致）。
- ❌ **不引入重运行时依赖**：多实例租约用 SQLite/文件锁；检索增强优先自研（若要向量库，需单独立项并评估"零依赖"卖点取舍）。
- ❌ **不让 Agent 触碰主转发路径**：所有 Agent 代码仍在旁路，异常零外溢。

---

## 附：一页速览（给评审/排期用）

| 维度 | v1 | v2 目标 |
|---|---|---|
| 交互范式 | 单轮问答 | 只读工具循环（≤N 步） |
| 上下文 | 固定 24h + 30 事件 | 自适应窗口 + 指标前置 + trace |
| 检索 | 常量 query、关键词 | 动态 query（可选混合检索） |
| 记忆 | 内存环 50、重启即丢 | 持久化 + 未闭环状态机 + 回喂 |
| 契约 | kind/conf/evidence | +severity/category/proposedChange/schemaVersion |
| 执行 | 纯文本建议 | 建议 + 受控一键 apply（二次确认/可回滚） |
| 护栏 | 无 | 日配额 + 熔断 + 多实例去重 + 重试/修复 |
| 可观测 | runCount | metrics 端点 + 采纳率 + 失败分类 |
| 校验 | 无 | `check` 校验 agent 配置 |
| 测试 | 6 例 | 覆盖生命周期/回退/降级/新护栏 |