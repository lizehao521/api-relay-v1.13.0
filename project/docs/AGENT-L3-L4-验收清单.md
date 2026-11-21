# AGENT-L3-L4 升级方案 · 验收清单（AC-01~AC-34）

> 对象：`project/docs/AGENT-L3-L4-升级方案.md`（内置 Agent「L3 → L4」升级方案）
> 用途：可勾选、可回溯的验收标准；配套审查报告见 `AGENT-L3-L4-审查报告.md`
> 口径：本清单为**方案/规格层**验收（设计承诺），落地后按"实现状态"逐条回填
> 生成：2026-10-26

---

## 1. 结构与范围（4）

- [ ] **AC-01** 方案明确 L4 定义与"仅高风险节点审批"的判定口径（对照评审框架 5 轴）。
- [ ] **AC-02** 四项工程包 A/B/C/D 齐备，含"问题→措施→交付物→验收关口"。
- [ ] **AC-03** 三条不变量（主路径隔离 / 高危禁区 / 零依赖）在方案内被显式声明且未被突破。
- [ ] **AC-04** 每个工程包有明确的前置依赖与门禁（上一包过验收才开下一包）。

## 2. 跨域只读连接器（Batch A）（7）

- [ ] **AC-05** 定义连接器类型（webhook/ticket/ci/im）与统一只读语义（仅 GET / 只读 POST）。
- [ ] **AC-06** 出站安全：`allowHosts` 域名白名单 + `timeoutMs` + 响应 `cap()` 截断。
- [ ] **AC-07** 密钥经 `tokenRef` 指向 config/env，**不入库、不落事件、不进日志**。
- [ ] **AC-08** 新增只读工具 `list_connectors` / `fetch_external` 并在 `AGENT_TOOLS` 注册。
- [ ] **AC-09** 任一连接器超时/4xx/5xx 时，本轮仍产出决策（`ok=true`），不中断、不死循环。
- [ ] **AC-10** 跨域调用审计落 `agent_connector_call` 表 + `agent.connector_call` 事件。
- [ ] **AC-11** 连接器管理页 P2：列表 / 连通测试 / 调用审计（脱敏）三要素齐备。

## 3. 受控执行通道（Batch B）（7）

- [ ] **AC-12** 执行白名单收敛到 4 个 target（`provider.disable` / `tier.precheck` / `agent.interval` / `client.quota`）。
- [ ] **AC-13** 白名单外 target（如 `server.adminToken`）**100% 拒绝**且留痕。
- [ ] **AC-14** 策略可配 `auto | approval`（默认 `approval`）+ `riskThreshold`（默认 `medium`）。
- [ ] **AC-15** 二次确认：`confirmToken` 一次性签发、含 `runId+target+payload` 摘要、防重放。
- [ ] **AC-16** 执行前抓 `before`、执行后抓 `after`，支持一键回滚且回滚留痕。
- [ ] **AC-17** 受控执行流水页（P1 子标签）：待审/已执行/已回滚三态 + ApplyDrawer（diff/影响/回滚/确认）。
- [ ] **AC-18** 全链审计事件：`apply_requested/confirmed/applied/rolled_back/rejected` 齐备。

## 4. 持久化与可度量（Batch C）（6）

- [ ] **AC-19** 新增 `agent_run` 表持久化每轮巡检（决策全文/耗时/token/工具轨迹/拟变更）。
- [ ] **AC-20** 重启后 `/agent/runs` 历史与 `/agent/metrics` 成功率/失败分类**不归零**。
- [ ] **AC-21** 趋势端点 `/agent/metrics/trend?window=` 在 5m/1h/24h 返回连续序列。
- [ ] **AC-22** `/agent/runs` 支持过滤（kind/severity/category/ok/from/to）+ 游标分页。
- [ ] **AC-23** 评测集（10–20 任务）产出 ≥3 类准确率（工具选择/参数/异常恢复/护栏命中）。
- [ ] **AC-24** 新表纳入 `prune`，保留期对齐 `meter.retentionDays`，不误删保留期内数据。

## 5. 多 Agent 协同（Batch D）（4）

- [ ] **AC-25** 三角色分工：分析 / 评审 / 执行；评审用独立 `reviewerModel`。
- [ ] **AC-26** 评审 Agent 可否决"看似合理但越界"的拟变更（不进入执行）。
- [ ] **AC-27** 并发取证下总 token 不超单 Agent 预算上限（全局配额共享）。
- [ ] **AC-28** `/agent/team` 可观测各角色调用数 / 否决率 / 耗时。

## 6. 安全与红线（3）

- [ ] **AC-29** 计费 / 密钥 / 内容策略 / `adminToken` 四类高危动作**硬禁**（白名单外）。
- [ ] **AC-30** Agent 故障（LLM 端点不可达）**绝不影响 `/v1/*` 转发**（回归用例）。
- [ ] **AC-31** 不引入重运行时依赖（Redis/MQ）；持久化与租约用 SQLite/文件锁。

## 7. 交付与验证（3）

- [ ] **AC-32** 页面清单落进现有"监控/配置/智能/系统"四组，组内 ≤7 项，不改组数。
- [ ] **AC-33** 接口清单与现有 `/admin/api/agent/*` 风格一致（含 `{error:{message,type,code}}`）。
- [ ] **AC-34** 6 大测试场景的 L4 通过线逐条可执行（用例 + 期望 + 关联包）。

> 合计 **34 条**（>30 条）。落地后逐条回填"实现状态：已实现/部分/未实现 + 证据"。