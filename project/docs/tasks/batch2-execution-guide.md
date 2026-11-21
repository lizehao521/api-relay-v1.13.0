# 批次 2（收尾批次）执行手册

> 生成：2026-10-19，team-leader。
> 用途：团队调度工具不可用期间，由用户手动执行或新会话恢复工具后按此手册继续。
> 任务书全文本：`docs/tasks/task-6-starter-comment-fix.md` 至 `task-11-final-audit.md`。

## 当前状态

| 项 | 状态 |
| --- | --- |
| 任务书 #6–#11 | ✅ 已落盘（docs/tasks/） |
| 发布确认 | ✅ 用户已确认（依赖链 #6/#7 → #8 → #9 → #10 → #11） |
| DECISIONS.md L236 勘误注（任务 #8 的 A-1 项） | ✅ team-leader 已完成（ADR-012 落点段后新增勘误 blockquote） |
| 主批次（#1–#5） | ✅ 全部完成，VERDICT: PASS（见 docs/对接执行核查报告.md ⑤ 节） |

## 剩余执行步骤（按序）

### 步骤 1 —— 任务 #6：starter.ts 注释修复（代码，约 10 分钟）

文件 `src/core/starter.ts`，只改注释不动逻辑：

- **L7**：`一个上游 · 一两个模型 · 两个 key 槽（第二个留空）· 三个分层照旧（但不解释）`
  → `一个上游 · 一两个模型 · 默认 1 个 key 槽（--env2 <ENV_NAME_2> 可生成双槽）· 三个分层照旧（但不解释）`
- **L191**：`刻意保持短：一个上游、一行 models、两个 key 槽。`
  → `刻意保持短：一个上游、一行 models、默认 1 个 key 槽（--env2 可选双槽）。`
- 同文件如发现其他 key 槽数量失准注释（JSDoc 等），一并修正。

验证：`npm test`（会先 tsc 重建 dist，dist/core/starter.js 注释随之同步）；当前基线 285 项全过。

### 步骤 2 —— 任务 #7：SDK autoRetry() timer 清理（代码，约 20 分钟）

文件 `src/client/auto-retry.ts`（完整源码已通读，修复点如下）：

1. **主循环 timer 统一清理（S1）**：当前 `timer` 只在 L451-454 成功路径 `clearTimeout`。改法：将 `for (let attempt...)` 整个循环包进 `try { ... } finally { if (timer !== undefined) clearTimeout(timer); }`；成功路径的 `clearTimeout` 可保留（无害）或移除（由 finally 统一）。注意保留 L377 注释解释的「成功返回后不摘用户 signal 监听」语义——只清 timer，不摘用户监听。
2. **sleepWithAbort 监听器清理（同族）**：L401-417 每次重试等待都往 `ctrl.signal` 挂一个 abort 监听（`{ once: true }`），Promise.race 结束后未摘除，多次重试会累积监听器。改法：race 前定义 `onAbort`，`finally { ctrl.signal.removeEventListener('abort', onAbort); }`。
3. **契约红线**：不得改函数签名、`AutoRetryError` 结构（kind/failureReason/attribution/attempts/bodyText/response/retryAfterMs/retryBudgetExhausted）、退避公式 `base×2^max(0,attempt-1)`、abort reason 传递（用户取消透传原 reason、超时转 kind:'timeout'）。
4. 可选新增测试：抛错后 timer 不再触发 abort（用注入 sleep + 真实 setTimeout 计数验证）。

验证：`npm test` 全过（SDK 15 项 + 如新增则更多）；记录最终数字供步骤 3 使用。

### 步骤 3 —— 任务 #8：README 数字统一（文档，约 10 分钟）

前置：步骤 1/2 完成后的最终测试数字 N（若 #7 未新增测试则 N=285）。

- **README L15**：`（当前 216 项）` → `（当前 N 项）`
- **README L230**：`（当前 216 项）` → `（当前 N 项）`
- **README L552**：`108 单测 + 30 项冒烟` → `108 单测 + 30 项冒烟（起步阶段；截至 2026-10-19 已增长至 N 项）`
- 全仓搜索「两个 key 槽」「216」「108 单测」复核：合法残留仅为 DECISIONS.md 勘误注、核查报告历史引用（L21/L124/L160）、HANDOVER 历史文档。
- `docs/HANDOVER-*.md` 与核查报告历史记录**不改**。

验证：再跑 `npm test`，确认输出数字与 README 声明一致。

### 步骤 4 —— 任务 #9：独立复审（只读 + npm test）

- 复核 #6 只改注释（diff 逻辑行为零变化）、#7 timer/监听器清理完整且契约不变
- `dist/core/starter.js`、`dist/client/auto-retry.js` 注释/逻辑与 src 同步
- README 数字 = `npm test` 实际输出
- 产出裁决行：`BATCH VERDICT: PASS / FAIL / PARTIAL`

### 步骤 5 —— 任务 #10：交接落盘（文档）

- 新建 `docs/HANDOVER-20261019-followup.md`（风格对齐 HANDOVER-20261018.md）：批次背景、#6–#9 逐任务结果、快照差异归属结论（cli.ts/demo.ts → 10/19 管理面板补丁 §5.6；admin/api.ts/e2e.test.ts → 10/18 前端改造）、最终测试数字、遗留问题
- 更新 `docs/对接方案-模型厂商与用户.md` §10.2：SDK 条目补记 S1 优化完成
- 任务书 task-6 至 task-11 文件头加「状态：已完成」行

### 步骤 6 —— 任务 #11：终审放行

- 核对 #6–#10 全部完成、磁盘抽查四项关键点（starter 注释/SDK timer/README 数字/HANDOVER 在盘）
- 亲自跑 `npm test`（不采信文档声明）
- 产出终审行：`FINAL BATCH VERDICT: PASS / FAIL / PARTIAL`

## 新会话恢复团队工具后（可选替代路径）

若新会话中 publish-task / background-task 恢复可用，可直接对子代理派发：
1. `publish-task` 按 `docs/tasks/batch2-publish.json` 六项发布（blocked_by：doc_consistency ← starter_comment_fix+sdk_cleartimeout；batch_review ← 前三者；handover_doc ← batch_review；final_audit ← handover_doc）
2. `background-task` 并行派发 #6（starter-fixer）、#7（sdk-fixer）
3. #6/#7 完成后依序派发 #8 → #9 → #10 → #11
