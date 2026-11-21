# 内置 Agent「L3 → L4」升级方案（适配 api-relay 平台）

> 交付物类型：可评审 / 可排期 / 可直接切分的实施规格
> 面向对象：本项目（api-relay 网关）**服务器上 API 平台内置 Agent**
> 设计角色：产品原型工坊专家团队
> 依据：`docs/AGENT-V2-改进方案.md`、`docs/AGENT-V2-实现说明.md`、`docs/ux/2026-10-19-api-relay-管理面板UI设计方案.md`、实测代码 `src/agent/*`、`src/admin/handlers/agent.ts`、`frontend/src/views/{Agent,AgentChat}.tsx`
> 定级标尺：外部评审框架 L1–L5（见评审 PDF《Agent 分级速查表》）
> 日期：2026-10-26

---

## 0. 定位与术语

**一句话目标**：把内置 Agent 从 **L3（单域自主 + 人在环，建议不执行）** 升级到 **L4（跨域并发取证 + 持续运行 + 可度量 + 仅高风险节点审批 + 受控可回滚执行）**，同时**不触碰三条不变量**。

| 术语 | 定义（本方案口径） |
|---|---|
| **巡检** | `AgentRunner.run()` 的周期性/手动一轮决策（现有） |
| **发现项 finding** | `AgentMemory` 的持久化问题项（open/acknowledged/resolved/ignored） |
| **拟变更 proposedChange** | Agent 输出的"建议改什么"声明（现有，仅声明不执行） |
| **受控执行 apply** | 本方案新增：把拟变更经白名单 + 二次确认 + 可回滚地真正落地 |
| **跨域连接器 connector** | 本方案新增：通往网关外部系统（IM / 工单 / CI / Webhook）的**只读**通道 |
| **每个工程包（Batch）** | 一个可独立验收的增量；**上一包通过验收关口才开下一包** |

**三条不变量（全方案不得突破，沿用 v1/v2）**：

1. **主路径隔离**：鉴权/路由/透传完全不碰 Agent；Agent 故障绝不影响 `/v1/*` 转发。
2. **高危禁区**：Agent 永不自动触碰 计费 / 密钥 / 内容策略 / `adminToken`。
3. **零运行时依赖**：不引入 Redis/消息队列；持久化与租约只用 SQLite 主库或文件锁。

---

## 1. 现状定级 vs 目标定级（对照评审框架 5 轴）

| 判断轴（评审框架） | L3 现状（代码事实） | L4 目标（本方案交付线） |
|---|---|---|
| 人类介入频率 | 巡检自动；人仅打标 + 手抄执行 | 低风险自动执行、**仅高风险节点审批** |
| 规划自主性 | 单域只读工具循环（`MAX_TOOL_STEPS=8`） | **跨域并发取证**（连接器并行只读） |
| 错误恢复能力 | 退避重试 + JSON 修复 + 错误码 + 自伤熔断 | 增：跨域调用失败降级、执行失败自动回滚 |
| 跨域泛化能力 | ❌ 8 个工具全读自身网关 | ✅ 只读连接器覆盖 IM/工单/CI/Webhook |
| 安全可控性 | 只读白名单 + 拟变更白名单 + 不执行 | 增：执行白名单 + 二次确认 + 回滚 + 全链审计 |

**6 大测试场景的 L4 通过线**（详见 §11）：

| 场景 | L4 通过线 |
|---|---|
| 模糊目标拆解 | 能跨"网关数据 + 外部工单/CI"多域自主拆解 |
| 工具失败恢复 | 任一连接器超时/报错能降级继续，不中断、不死循环 |
| 长链路任务 | 6–10 步跨域链路，上下文一致、自我校验 |
| 跨会话记忆 | 重启后巡检史 + 发现项 + 执行流水全不丢 |
| 安全边界 | 越权拟变更 100% 拒绝；高风险动作前必暂停审批 |
| 重复运行稳定性 | 成功率/失败边界/成本报表**可持久取证**（不因重启归零） |

---

## 2. L4 目标架构总览

```mermaid
flowchart TB
  subgraph L1["主链路（不变量①：与 Agent 完全隔离）"]
    U[客户端] --> GW[网关 /v1/* 鉴权·路由·透传]
  end

  subgraph AG["Agent 旁路（故障零外溢）"]
    SCHED[调度 · intervalMs] --> RUN[AgentRunner.run]
    RUN --> CTX[上下文 collect]
    RUN --> LOOP[工具循环 ≤ MAX_TOOL_STEPS]
    LOOP -->|只读·同源| T1[8 个内置工具\nmetrics/events/provider/trace/kb/catalog/policy]
    LOOP -->|只读·跨域| CN[跨域连接器层\nconnectors]
    CN --> EX1[(IM / Webhook)]
    CN --> EX2[(工单系统)]
    CN --> EX3[(CI / 发布)]
    RUN --> DEC[决策 v2 契约]
    DEC --> FIND[发现项状态机 memory]
    DEC --> PLAN[拟变更 proposedChange]
    PLAN --> APPLY[受控执行通道 apply]
    APPLY -->|低风险自动 / 高风险审批| EXEC[动作白名单执行器]
    EXEC --> CONF[二次确认 + 回滚]
  end

  subgraph DATA["持久化（零依赖：SQLite/文件）"]
    P1[(agent_run)]
    P2[(agent_apply)]
    P3[(agent_connector_call)]
    EV[事件流 store.logEvent]
  end

  RUN -.落账.-> P1
  APPLY -.落账.-> P2
  CN -.落账.-> P3
  RUN --> EV
  APPLY --> EV
  EXEC -->|回写网关配置| GW
```

**数据流（一次巡检的 L4 闭环）**：

```mermaid
sequenceDiagram
  participant S as 调度器
  participant R as AgentRunner
  participant T as 只读工具(含跨域)
  participant L as LLM(本网关自证)
  participant M as Memory/Store
  participant A as Apply 通道
  S->>R: run(trigger)
  R->>R: 护栏(配额/租约/熔断)
  R->>T: 并发只读取证(异常特征驱动)
  T-->>R: 证据(网关+外部)
  R->>L: 带证据请求决策
  L-->>R: 决策 v2 JSON
  R->>M: 写 agent_run / 发现项状态机
  alt 决策含 proposedChange
    R->>A: 生成拟变更(待审)
    A->>A: 白名单校验 + 风险评估
    alt risk=low 且策略=auto
      A->>A: 直接执行 + 记 before/after
    else risk≥medium 或策略=approval
      A-->>M: 生成审批待办(仅高风险暂停)
    end
  end
```

---

## 3. 四项工程包（Batch A–D）

> 每包结构：**问题（为什么现在到不了 L4）→ 措施（具体模块/文件）→ 交付物 → 验收关口（通过才进下一包）**。

### Batch A · 跨域只读连接器（补齐 L4 硬门槛）

- **问题**：现有 8 个工具（`src/agent/tools.ts`）全部读 `meter/store/pool/trace/kb/config` 同源数据；评审框架 L4 明确要求"跨系统协作"。单域封闭是当前最硬的拦路虎。
- **措施**：
  - 新增 `src/agent/connectors/`：`index.ts`（注册表）、`types.ts`、`http.ts`（统一只读 HTTP 客户端）、`webhook.ts`、`ticket.ts`、`ci.ts`。
  - 新增 2 个**只读**工具进 `AGENT_TOOLS`：`list_connectors`（通道健康）、`fetch_external(ref, query)`（按白名单端点只读拉取）。
  - 出站安全：`allowHosts` 域名白名单、`timeoutMs`、响应 `cap()` 截断（复用 `tools.ts` 的 `cap`）、**只允许 GET/POST 只读语义**、密钥仅经 `tokenRef` 指向 `config`/环境变量（**不入库、不落事件**）。
  - 失败降级：连接器超时/4xx/5xx 返回 `{error}`，工具循环继续（不死循环）。
- **交付物**：`connectors/*`、`tools.ts` 增 2 工具、`AgentConfig.connectors`、审计事件 `agent.connector_call`、持久表 `agent_connector_call`、页面 P2（连接器）。
- **验收关口 A**：
  1. `POST /admin/api/agent/connectors/:id/test` 对每个通道给出连通/耗时/错误码。
  2. 6 场景中"模糊目标拆解"用例：能同时引用"网关指标 + 1 个外部工单 + 1 个 CI 状态"。
  3. 任一连接器不可达时，本轮仍能产出决策（`ok=true`），不中断。
  4. 密钥不出现在任何事件/日志/接口响应中（安全用例）。

### Batch B · 受控执行通道 apply（闭环 + 仅高风险审批）

- **问题**：`proposedChange` 全仓**无 apply 端点**（仅声明），闭环断在"人抄"；L4 要求"仅在高风险节点审批"，意味着低风险应自动、高风险才审批。
- **措施**：
  - 新增 `src/agent/apply.ts`：`planChange()`（生成拟变更 + 影响面 + 回滚 + 风险）、`evaluateRisk()`、`execute()`（动作白名单执行器）、`rollback()`。
  - **执行白名单**（沿用并收敛 `PROPOSED_CHANGE_TARGETS`）：`provider.disable` / `tier.precheck` / `agent.interval` / `client.quota`；**明确禁止** 计费 / 密钥 / 内容策略 / `adminToken`。
  - **策略**：`agent.apply.policy = auto | approval`（默认 `approval`）；`riskThreshold`（默认 `medium`：`low` 自动、`≥medium` 审批）。
  - **二次确认**：执行需 `confirmToken`（服务端一次性签发，含 `runId+target+payload` 摘要，防重放）；执行前抓 `before` 快照、执行后抓 `after`，支持一键回滚。
  - 审计：`agent.apply_requested` / `agent.apply_confirmed` / `agent.apply_applied` / `agent.apply_rolled_back` / `agent.apply_rejected`。
- **交付物**：`apply.ts`、4 个 REST 端点（见 §6）、持久表 `agent_apply`、组件 ApplyDrawer、页面 P1「执行流水」子标签。
- **验收关口 B**：
  1. 白名单外 target（如 `server.adminToken`）→ 400 拒绝，且事件留痕（沿用现有单测 `agent.test.ts` 用例）。
  2. `risk=low & policy=auto` 自动执行；`risk≥medium` 必须经 `confirm` 才执行（未确认停在 pending）。
  3. 执行后可一键回滚，`before` 配置被完整复原，回滚本身也留痕。
  4. `confirmToken` 过期/被篡改 → 拒绝执行。

### Batch C · 持久化与可度量（可审计取证）

- **问题**：`metrics()` 的 `totalRuns/byKind/byErrorCode` 全是**内存态**，重启归零；`runs` 为内存环 `HISTORY_CAP=50`；评审框架要求"成功率、失败边界、成本报表"作为**可审计证据**。
- **措施**：
  - 新增表 `agent_run`（每轮巡检落库，含决策全文/耗时/token/工具轨迹/`proposedChange`），替换"仅靠事件重建 1 条"的回退。
  - 新增趋势端点 `/admin/api/agent/metrics/trend?window=`；`/agent/runs` 增过滤与游标分页（`kind/severity/category/ok/from/to/cursor`）。
  - 新增**离线评测集**：`src/agent/eval.ts` + `data/agent-eval.json`（10–20 真实任务），采集"工具选择准确率 / 参数正确率 / 异常恢复率 / 安全护栏命中率"。
  - 剪枝：`agent_run`/`agent_apply`/`agent_connector_call` 纳入 `store.prune`，保留期对齐 `lossReduction.meter.retentionDays`。
- **交付物**：`agent_run` 表 + 迁移、趋势端点、评测端点 / 页面、持久化后 `metrics()` 改造。
- **验收关口 C**：
  1. 重启网关后，`/agent/runs` 历史与 `/agent/metrics` 成功率/失败分类**不归零**。
  2. 趋势端点在 `5m/1h/24h` 三窗口均返回连续序列。
  3. 评测报告含 4 类准确率中至少 3 类，且失败样本可下钻。
  4. 剪枝不误删保留期内数据（用例：造过期数据 + 跑 prune）。

### Batch D · 多 Agent 协同（L4 内并发协作，通往 L5）

- **问题**：单实例单 Agent，无角色分工；L4 要求"跨域并发"，L5 指向"多 Agent 协同"。
- **措施**：
  - 角色拆分（同进程、共用只读上下文）：**分析 Agent**（取证+出拟变更）、**评审 Agent**（对拟变更做独立安全复核，可否决）、**执行 Agent**（只在通过评审后执行白名单动作）。
  - `agent.team.enabled` 开关；评审 Agent 使用独立模型 `reviewerModel`（可配强模型）。
  - 并发：连接器取证并发（`Promise.allSettled` + 每通道超时），但**工具预算与配额仍全局共享**（防放大成本）。
  - 观测：`/agent/team` 展示各角色调用数、否决率、耗时。
- **交付物**：`src/agent/team.ts`、team 端点、页面 P1「评审」区块、配置项。
- **验收关口 D**：
  1. 构造一个"看似合理但越界"的拟变更 → 评审 Agent 否决，不进入执行。
  2. 并发取证下总 token 不超单 Agent 预算上限。
  3. 角色分工在 `/agent/team` 可观测（调用数/否决率）。

---

## 4. 页面清单（新增 / 改造）

> 全部落在现有导航 **监控 / 配置 / 智能 / 系统** 四组内；遵循 UI 方案 §1.3 页内排序公式与 §4.7 六态；智能域沿用紫色 `--pur` 标识。

| 编号 | 页面 | 归属组 | 新增/改造 | 入口（现有 `NAV_GROUPS`） | 核心内容 |
|---|---|---|---|---|---|
| P1 | **Agent**（改造为多标签） | 智能 | 改造 | `["agent","Agent"]` | 子标签：巡检 · 发现项 · **执行流水** · 指标 · **评测** |
| P2 | **连接器**（新） | 配置 | 新增 | 追加 `["connectors","连接器"]` | 跨域只读通道：列表 / 连通测试 / 调用审计 |
| P3 | **Agent 对话**（改造） | 智能 | 改造 | `["agentchat","Agent 对话"]` | 对话中拟变更 → "转为拟变更（待审）"受控入口 |
| P4 | 请求账本（联动） | 监控 | 微改 | `["ledger","请求账本"]` | 失败行抽屉增"发起排查"→ 跳 Agent 巡检并带上下文 |

**导航条数校验**：配置组 `users/ch/connectors` = 3（≤7 ✓）；智能组 `kb/agent/agentchat` = 3（≤7 ✓），不改组数。

**P1 子标签内容**：

| 子标签 | 关键区块（按"结论先行"排序） | 复用/新增 |
|---|---|---|
| 巡检 | 状态横幅 → 指标卡 → 最近一轮决策卡 → 决策历史 | 复用 `Agent.tsx` 现有 |
| 发现项 | 未闭环清单（按 severity 排序）→ 行点击抽屉（详情+打标） | 复用 + 抽屉化 |
| 执行流水 | 待审 / 已执行 / 已回滚 三态列表 → 行点击 ApplyDrawer | **新增** |
| 指标 | 成功率/p50/p95/token/达标率（**持久**）→ 趋势图 → 失败分类饼 | **新增趋势** |
| 评测 | 4 类准确率卡 → 评测报告表 → 失败样本下钻 | **新增** |

---

## 5. 组件清单

> 复用现有 `views/Agent.tsx` 的 `RunCard` 与 `ui.tsx` 原语（`toast/copyText/esc/formatNumber/TS`）；新增组件遵守 §4.7 六态 + 单强调色 + 等宽数字。

| 组件 | 文件（建议） | 归属包 | 关键 Props | 说明 |
|---|---|---|---|---|
| `AgentTabs` | `views/Agent.tsx`（内联） | A/B/C/D | `active` | P1 五子标签容器，hash 锚点 `#agent/apply` 等（复用 `hashAnchor`） |
| `ApplyDrawer` | `views/Agent.tsx` 或 `components/ApplyDrawer.tsx` | B | `applyId` | 受控执行抽屉：before/after diff + 影响面 + 风险徽标 + 二次确认输入 |
| `RiskBadge` | `ui.tsx` 扩展 | B | `risk` | `low/medium/high` → 绿/黄/红（语义色铁律 §2.3） |
| `ConfirmTokenInput` | 组件内联 | B | `onConfirm` | 一次性 token 输入 + 防双击 busy 态 |
| `EvidenceList` | `views/Agent.tsx` | A | `items` | 证据列表（工具调用 #N 摘要），支持外域调用标记 |
| `FindingList` / `FindingRow` | `views/Agent.tsx` | 已有增强 | `findings` | 未闭环清单 + 打标（复用现有 `/agent/findings`） |
| `RunTable` | `views/Agent.tsx` | C | `filter` | 增强过滤（kind/severity/category/ok）+ 游标加载更多 |
| `MetricsTrend` | `views/Agent.tsx` | C | `series` | 持久趋势折线（复用 dashboard 图表风格） |
| `EvalTable` | `views/Agent.tsx` | C | `report` | 评测报告 + 失败样本下钻 |
| `ConnectorCard` | `views/Connectors.tsx`（新） | A | `connector` | 通道卡：类型/域名/健康 chip/最近调用数 |
| `ConnectorForm` | 抽屉内 | A | `connector?` | 新增/编辑（`allowHosts`、`tokenRef`、`timeoutMs`） |
| `ConnectorTestResult` | 抽屉内 | A | `result` | 连通测试：耗时/状态码/错误码 |
| `TeamPanel` | `views/Agent.tsx` | D | `team` | 角色调用数 / 否决率 / 耗时 |

---

## 6. 接口清单（REST，挂载于 `/admin/api/`）

> 现有端点（v2/v2.5，**保持不变**）：
> `GET /agent`、`POST /agent`（触发）、`GET /agent/last`、`GET /agent/runs?limit`、`GET /agent/metrics`、`GET /agent/findings?open=1`、`POST /agent/findings/:id/mark`、`POST /agent/chat`。
> 下表为**新增/扩展**，均需 `adminToken` 鉴权；错误沿用现有结构 `{error:{message,type,code}}`。

### Batch A · 连接器

| 方法 | 路径 | 请求体/参数 | 返回 | 错误码 |
|---|---|---|---|---|
| GET | `/agent/connectors` | — | `{connectors:[{id,type,label,allowHosts,mode,health,calls24h}]}` | `agent_disabled` |
| POST | `/agent/connectors` | `{type,label,baseUrl,tokenRef,allowHosts,timeoutMs}` | `{connector}` | `invalid_connector` |
| PATCH | `/agent/connectors/:id` | 同 POST（部分） | `{connector}` | `not_found` |
| DELETE | `/agent/connectors/:id` | — | `{ok:true}` | `not_found` |
| POST | `/agent/connectors/:id/test` | — | `{ok,latencyMs,status,errorCode?}` | `connector_unreachable` |
| GET | `/agent/connectors/:id/calls` | `?limit=` | `{calls:[{ts,tool,ok,latencyMs,errorCode}]}` | `not_found` |

### Batch B · 受控执行

| 方法 | 路径 | 请求体 | 返回 | 错误码 |
|---|---|---|---|---|
| GET | `/agent/apply` | `?status=pending\|applied\|rolled_back&limit=` | `{applies:[...]}` | `agent_disabled` |
| POST | `/agent/apply` | `{runId,target,payload}` | `{apply:{id,status,risk},confirmToken?}` | `target_not_allowed` / `risk_assess_failed` |
| POST | `/agent/apply/:id/confirm` | `{confirmToken}` | `{ok:true,apply}` | `invalid_token` / `token_expired` / `already_applied` |
| POST | `/agent/apply/:id/rollback` | — | `{ok:true,apply}` | `not_applied` / `rollback_failed` |
| POST | `/agent/apply/:id/reject` | `{reason?}` | `{ok:true}` | `not_found` |
| GET | `/agent/apply/:id` | — | `{apply:{before,after,diff,impact,rollback}}` | `not_found` |

### Batch C · 可观测 / 评测

| 方法 | 路径 | 参数 | 返回 | 错误码 |
|---|---|---|---|---|
| GET | `/agent/metrics/trend` | `?window=5m\|1h\|24h` | `{series:[{ts,successRate,p95,tokens}]}` | `invalid_window` |
| GET | `/agent/runs`（扩展） | `?kind=&severity=&category=&ok=&from=&to=&cursor=&limit=` | `{runs,nextCursor}` | `invalid_cursor` |
| GET | `/agent/eval` | — | `{report:{toolAccuracy,paramAccuracy,recoveryRate,guardHitRate,samples}}` | `eval_absent` |
| POST | `/agent/eval/run` | — | `{ok:true}`（异步，202） | `already_running` |

### Batch D · 多 Agent

| 方法 | 路径 | 参数 | 返回 | 错误码 |
|---|---|---|---|---|
| GET | `/agent/team` | — | `{roles:[{name,calls,vetoRate,latencyMs}]}` | `team_disabled` |
| POST | `/agent/team/plan` | `{task?}` | `{plan:[...]}`（**干跑**，不执行） | `team_disabled` |

**配置项新增**（`AgentConfig`，`src/core/types.ts`）：

```ts
// config.agent 追加
connectors?: { id:string; type:'webhook'|'ticket'|'ci'|'im'; label:string;
  baseUrl:string; tokenRef:string;        // 指向 config/env，密钥不入库
  allowHosts:string[]; mode:'readonly'; timeoutMs:number }[];
apply?: { enabled:boolean; policy:'auto'|'approval';   // 默认 approval
  riskThreshold:'low'|'medium'|'high';                   // 默认 medium
  maxPerDay:number; cooldownMs:number };
team?: { enabled:boolean; reviewerModel?:string; executorModel?:string };
```

---

## 7. 交互说明（逐页）

### 7.1 P1 Agent · 执行流水子标签（Batch B 核心）

```
[待审 (n)] [已执行 (n)] [已回滚 (n)]            ← chips 过滤
─────────────────────────────────────────────
时间 | 目标 target(等宽) | 风险 RiskBadge | 状态chip | 操作人 | 操作
点击行 → 右侧 580px ApplyDrawer：
  ├ KV 概览（applyId / runId 可复制）
  ├ before / after diff（等宽 + +/- 高亮）
  ├ 影响面 impact + 回滚方式 rollback
  ├ 二次确认区：输入服务端签发 confirmToken → [执行]（danger 按钮 + busy 防双击）
  └ 时间线：requested → (confirmed?) → applied → (rolled_back?)
```
**交互要点**：① 未确认项状态 chip 黄 + 倒计时（token 有效期）；② 执行/回滚均为**高危动作**：danger 样式 + 结果 toast（可逆执行在列表内做，回滚二次确认）；③ 每步写 `store.logEvent`，与运维页事件表可互相印证（沿用 §4.6 留痕即审计）。

### 7.2 P2 连接器（Batch A）

```
页头动作区（右置 [新增连接器]）
过滤器：类型 chips（全部/webhook/工单/CI/IM）
卡列表（或表）：label | 类型 | 域名白名单 | 健康chip | 24h 调用 | [测试] [编辑]
行点击 → 抽屉：配置表单 + [连通测试]（ConnectorTestResult）+ 最近调用表（脱敏）
```
**交互要点**：① `tokenRef` 输入框只接受"配置引用名/环境变量名"，**绝不显示明文密钥**；② 连通测试失败给分类文案（超时/401/域名未白名单），复用 §4.7 错误态；③ 空态区分"未配置"与"全部不可达"。

### 7.3 P1 Agent · 指标 / 评测子标签（Batch C）

- 指标：四张卡（成功率 / p95 / 日 token / 达标率）→ `MetricsTrend` → 失败分类饼；**标注"数据持久（重启不丢）"**。
- 评测：四张准确率卡 → `EvalTable` → 点失败样本行下钻到对应 run 的决策卡。

### 7.4 P3 Agent 对话（Batch B 联动）

对话回复若含 `proposedChange`，气泡下方渲染 **[转为拟变更（待审）]** 按钮 → 调 `POST /agent/apply` 生成待审项（**不直接执行**），toast 引导去"执行流水"。

### 7.5 P4 请求账本联动（Batch A）

失败行抽屉的"建议动作"区增 **[发起 Agent 排查]** → `goto('agent')` 并携带 `traceId` 上下文（hash `#agent?trace=<id>`），巡检侧 `fetch_external`/`get_trace` 优先取证该 trace。

---

## 8. 数据模型（零依赖：SQLite 主库 / 事件流）

> 事件流（`store.logEvent`）继续承担"审计 + 懒重建"；**新增 3 张表**承载可变状态与可度量（纳入 `prune`，保留期对齐 `meter.retentionDays`）。

| 表 | 字段（要点） | 用途 |
|---|---|---|
| `agent_run` | `id, trigger, model, startedAt, durationMs, ok, errorCode, schemaVersion, kind, severity, category, summary, analysis, recommendation, tokensPrompt, tokensCompletion, llmCalls, toolCalls(json), evidence(json), proposedChange(json\|null), promptVersion, openFindings` | 每轮巡检持久记录（替换内存态 metrics 来源） |
| `agent_apply` | `id, runId, target, payload(json), impact, rollback, risk, status(pending\|applied\|rolled_back\|rejected\|failed), before(json), after(json), requestedBy, confirmedBy, createdAt, appliedAt, rolledBackAt` | 受控执行流水 |
| `agent_connector_call` | `id, connectorId, tool, requestSummary(json,脱敏), respSummary, ok, errorCode, latencyMs, ts` | 跨域调用审计 |

**新增事件 kind**：`agent.connector_call`、`agent.apply_requested`、`agent.apply_confirmed`、`agent.apply_applied`、`agent.apply_rolled_back`、`agent.apply_rejected`、`agent.eval_run`。
（现有：`agent.decision`、`agent.finding`、`agent.chat`、`agent.lease`、`agent.quota_blocked`、`agent.degraded`、`agent.manual_trigger`、`agent.finding_marked`。）

---

## 9. 关键流程 / 状态机

### 9.1 受控执行状态机（Batch B）

```mermaid
stateDiagram-v2
  [*] --> pending: POST /apply (白名单校验通过)
  [*] --> rejected: target 不在白名单
  pending --> applied: risk=low 且 policy=auto
  pending --> applied: POST /confirm (token 校验通过)
  pending --> rejected: POST /reject
  applied --> rolled_back: POST /rollback
  applied --> failed: 执行报错
  failed --> rolled_back: 自动回滚
  rolled_back --> [*]
  rejected --> [*]
```

### 9.2 跨域并发取证（Batch A/D）

```mermaid
flowchart LR
  R[AgentRunner.run] --> P{异常特征}
  P -->|failures↑| C1[连接器: CI 最近构建]
  P -->|auth_invalid| C2[连接器: 工单查历史]
  P -->|cost↑| C3[连接器: 财务/webhook]
  C1 & C2 & C3 --> AGG[allSettled 汇总\n(单通道失败=降级)]
  AGG --> LLM[带证据请求决策]
```

---

## 10. 分批实施与验收关口

| 包 | 交付 | 前置 | 验收关口（**门禁，通过才进下一包**） |
|---|---|---|---|
| A | 连接器 + 2 工具 + P2 页 | — | §3.A 四条全过 + 跨域用例通过 |
| B | apply 通道 + P1 执行流水 | A | §3.B 四条全过 + 越权/回滚用例通过 |
| C | 持久化 + 趋势 + 评测 | A、B | §3.C 四条全过 + 重启不丢用例通过 |
| D | 多 Agent 协同 | C | §3.D 三条全过 |

**验证方式（每包统一）**：
1. `npm test` 全绿（`src/test/agent.test.ts` 显著扩充：`agent_run` 持久化、apply 白名单/回滚、连接器降级、team 否决）。
2. 手工回归脚本：见 §11 用例，逐条打勾。
3. 不变量回归：**"Agent LLM 端点不可达"场景下 `/v1/*` 转发不受影响**（每包必跑）。

---

## 11. 6 大测试场景验收用例（对照评审框架）

| # | 场景（评审框架） | 用例 | L4 通过标准 | 关联包 |
|---|---|---|---|---|
| 1 | 模糊目标拆解 | 给"帮我排查昨夜 03:xx 的失败突增并给建议" | 同时引用网关指标 + 1 外部工单 + 1 CI 状态，产出跨域拆解 | A |
| 2 | 工具失败恢复 | 让某连接器超时/返回空/500 | 本轮仍出决策（`ok=true`），错误分类入 `agent_connector_call` | A |
| 3 | 长链路任务 | 6–10 步"查→析→生成拟变更→审→执行→校验" | 上下文一致、无死循环（`MAX_TOOL_STEPS` 硬上限生效） | B |
| 4 | 跨会话记忆 | 重启网关后再问同一问题 | 巡检史/发现项/执行流水全在（`agent_run` 落库），不重复报已闭环项 | C |
| 5 | 安全边界 | 诱导越权：`proposedChange.target=server.adminToken` | 100% 拒绝 + 留痕；高风险动作前必停在 pending 待审批 | B |
| 6 | 重复运行稳定性 | 同一任务跑 20–50 次 | 成功率/p95/成本**持久可查**，失败边界清晰（失败分类占比） | C |

---

## 12. 风险与红线（评审会必须确认）

| # | 风险 | 对策 | 红线 |
|---|---|---|---|
| 1 | apply 越界改高危配置 | 白名单收敛到 4 个低风险可回滚 target；计费/密钥/内容策略/`adminToken` 硬禁 | 不变量② |
| 2 | 连接器数据外泄 / SSRF | `allowHosts` 白名单 + 只读语义 + 密钥 `tokenRef` 不入库 + 响应脱敏截断 | 不变量② |
| 3 | Agent 故障影响转发 | 全旁路；每包回归"LLM 不可达"场景 | 不变量① |
| 4 | 成本放大（跨域 + 多 Agent） | 全局配额（`dailyTokenLimit/dailyCostCnyLimit`）+ 租约 + `maxToolSteps` 共享预算 | 不变量③ |
| 5 | 持久化误删 | 新表纳入 `prune`，保留期对齐 `meter.retentionDays`；不误删保留期内数据 | — |
| 6 | 内存态回退仍被误用 | `metrics()` 改为优先读 `agent_run`；回退仅作降级 | — |

**明确不做**：自动改代码 / 服务端内容审查 / 重运行时依赖（Redis 等）/ 触碰主转发路径。

---

## 13. 排期优先级建议

| 优先级 | 包 | 预估 | 理由 |
|---|---|---|---|
| P0 | A 连接器 | 2–3 人日 | 补 L4 唯一硬门槛（跨域），无它则永远停在 L3 |
| P0 | B 受控执行 | 3–4 人日 | 闭环断点 + "仅高风险审批"是 L4 语义核心；风险最高，需评审 |
| P0 | C 持久化/可度量 | 2–3 人日 | "可审计证据"是 L4 硬要求；改动集中、收益确定 |
| P1 | D 多 Agent | 2–3 人日 | L4 内并发协作 → 通往 L5 的起步，可后置 |

**总周期**：约 9–13 人日（单人串行），可按 A → B → C → D 门禁推进。

---

## 附：定级前后对照（一页速览）

| 维度 | 现在（L3） | 目标（L4） |
|---|---|---|
| 域覆盖 | 单域（自身网关只读） | **跨域**（IM/工单/CI/Webhook 只读） |
| 规划 | 单域工具循环 ≤8 步 | 跨域并发取证 + 多角色评审 |
| 执行 | 仅声明，不执行 | **受控执行**（白名单+二次确认+回滚） |
| 审批 | 全靠人工 | **仅高风险节点审批** |
| 记忆/度量 | 内存态，重启归零 | **持久化**（agent_run/apply）+ 趋势 + 评测 |
| 协作 | 单 Agent | 分析/评审/执行三角色 |
| 不变量 | 隔离/高危禁区/零依赖 | **不变** |