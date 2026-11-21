# 任务交接文档 —— 收尾批次（#6–#9）执行记录（2026-10-19 followup）

> 写给**下一个接手的人**（也可能是几天后的我自己）。读完就能安全继续动手，不重复已踩过的坑。
> 本次主题：**主批次（对接方案核查 / SDK / 代码审查 / 最终验证，VERDICT: PASS）遗留的 4 项收尾工作已全部完成**——starter 注释修复、SDK 资源清理、全仓文档一致性、独立复审 **BATCH VERDICT: PASS**。主仓 `npm test` **287/287** 全绿。

---

## 0. 一句话现状

数据面（`src/gateway|loss|upstream|store`）逻辑零改动（#6 只改注释、#7 只改资源清理路径、#8/#9 纯文档与验证）。`npm test` **287/287**；README 与 architecture.svg 的测试数量声明已与实测一致；「两个 key 槽」失准表述在活文档中清零（合法残留仅存历史记录与勘误注）。

---

## 1. 批次背景：主批次遗留了什么

主批次五个任务（#1 对接方案核查、#2 SDK、#3/#5 代码审查、#4 最终验证，见 `docs/对接执行核查报告.md`，VERDICT: PASS）因分工边界（只读 / 无修改权限）留下 4 项建议级问题，由本收尾批次处置：

| # | 遗留项 | 来源 | 处置任务 |
|---|---|---|---|
| 1 | `src/core/starter.ts` L7/L191 注释仍写「两个 key 槽」，与实现（默认单槽）矛盾 | #1 audit F1/R1（README L71 已由 team-leader 修复，src 注释当时未动） | 任务 #6 |
| 2 | `autoRetry()` 抛错路径不清总超时定时器；`sleepWithAbort` 每次重试挂的 abort 监听器不摘除（建议级，不阻塞） | #3/#5 code-reviewer 审查项 S1 | 任务 #7 |
| 3 | README 测试数量声明三处失准（L15/L230「当前 216 项」、L552「108 单测」） | pitch 检查清单与 #4 final-verifier 附记 | 任务 #8 B 节 |
| 4 | 「两个 key 槽」失准表述全仓清理（DECISIONS.md L236 勘误注 + 散落残留搜索） | #1/#4 | 任务 #8 A/C 节（A-1 勘误注由 team-leader 于批次启动前完成） |

执行中新发现的同类问题（一并处置）：

- `architecture.svg` L196「216 项单测 + 30 项 e2e」——活文档失准，同批修正为 287（任务 #8）。
- `--env2` 带值用法示例（#4 final-verifier 建议）——已由 team-leader 落入方案文档 §3.1 步 2（`--env2 DEEPSEEK_API_KEY_2` 完整示例），本次复核确认五处核心位置表述一致。

---

## 2. 逐任务记录

### 任务 #6：starter.ts 注释修复（`src/core/starter.ts`）

- L7 →「一个上游 · 一两个模型 · 默认 1 个 key 槽（--env2 <ENV_NAME_2> 可生成双槽）· 三个分层照旧（但不解释）」
- L191 →「刻意保持短：一个上游、一行 models、默认 1 个 key 槽（--env2 可选双槽）。」
- 只改注释，逻辑行零变化（与 L205/L206 实现逐字对齐：默认单槽 `apiKey`，`opts.envName2` 存在才生成 `apiKeys` 双槽数组）。
- dist 同步：`npm test` 先 tsc 重建 dist，`dist/core/starter.js` L7/L137 注释同步已验证。
- 测试：285/285（基线，无新增）。

### 任务 #7：SDK autoRetry() 资源清理（`src/client/auto-retry.ts` + `auto-retry.test.ts`）

两处修复，**对外契约零变化**（函数签名 / `AutoRetryError` 结构 / 退避公式 / abort reason 链全部保留）：

1. 主循环（L425 起）包进 `try { ... } finally { if (timer !== undefined) clearTimeout(timer); }`——所有出口（成功 return / 网络错误 / HTTP 错误 / 超时 / body 中断）统一清理总超时定时器；成功路径原 `clearTimeout` 移除（由 finally 统一）。**用户 signal 监听刻意不清理**（成功返回后用户 abort 仍需能切断正在读的流式 body，语义见 L377 注释）。
2. `sleepWithAbort`（L401-423）：race 前持有 `onAbort` 引用，`finally` 摘除——覆盖 sleep 先到 / abort 先到 / 注入 sleep 抛错 / 进入时已 aborted 四条路径，多次重试不再累积监听器。

新增测试 2 项（`auto-retry.test.ts`「资源清理（S1）」节，L317-379）：

- 「抛错后总超时定时器被 finally 统一清理」——真实等待 400ms（> timeoutMs 150）断言内部信号不被误 abort；
- 「重试等待的 abort 监听器在每次 race 结束后被摘除」——计数 add/remove，断言 added = removed = 2 不累积。

测试：287/287（基线 285 + 新增 2；SDK 单测 15 → 17 项）。

### 任务 #8：文档一致性清理（`README.md` + `architecture.svg`）

| 文件 | 改动 |
|---|---|
| README.md L15 | 「当前 216 项」→「当前 287 项」 |
| README.md L230 | 同上 |
| README.md L552 | 「108 单测 + 30 项冒烟」补注「（起步阶段；截至 2026-10-19 已增长至 287 项）」，历史里程碑数字保留 |
| architecture.svg L196 | 「216 项单测 + 30 项 e2e」→「287 项单测 + 30 项 e2e」（执行中新发现的活文档失准） |

复核（全仓搜索「两个 key 槽」「216」「108 单测」）：残留仅存合法位置——DECISIONS.md L236 原文（L239 勘误注钉住）、核查报告历史记录（L21/L124/L160）、任务书与批次工具（任务定义本身）、pitch 检查清单（其「以实际输出为准」语义仍成立）、HANDOVER 历史文档。`--env2` 带值表述在 README L71、方案文档 §2/§3.1 步 2、DECISIONS.md 勘误注、starter 源码注释五处一致。

验证：`npm test` 287/287，与 README/svg 声明逐字一致。

### 任务 #9：独立复审（只读 + npm test）

七项审查全部通过：#6 只改注释（逻辑零变化）/ #7 清理完整且契约不变 / dist 同步 / 文档复核 / 全量回归 287/287 / `--env2` 一致性 / 新增测试质量（行为级断言，无空洞）。

**BATCH VERDICT: PASS** —— 三项改动均最小且正确，无契约破坏，文档与实现、与 `npm test` 实测输出完全一致。

---

## 3. 快照差异文件归属（最终结论，含本批次增量）

`.merkle-snapshot.json` 与源码尺寸差异的归属（核查报告 ④ 节结论 + 本批次增量）：

| 文件 | 归属 | 依据 |
|---|---|---|
| `src/admin/api.ts`、`src/test/e2e.test.ts` | 2026-10-18 前端改造 | `docs/HANDOVER-20261018.md` |
| `src/cli.ts`、`src/demo.ts` | 2026-10-19 管理面板优化补丁（pickPort 端口漂移修复） | `docs/ux/2026-10-19-管理面板优化实施补丁.md` §5.6 |
| `src/core/starter.ts`、`src/client/auto-retry.ts`、`src/client/auto-retry.test.ts` | **本收尾批次**（#6/#7） | 本文档 §2 |
| `README.md`、`architecture.svg` | **本收尾批次**（#8） | 本文档 §2 |

结论不变：所有差异均有明确归属，无来路不明的改动。下次刷新快照时按上表对账即可。

---

## 4. 测试数量与 README 声明对应关系（截至 2026-10-19）

| 声明位置 | 声明值 | 实测（`npm test`） |
|---|---|---|
| README L15 / L230 | 当前 287 项 | 287（# pass 287 / # fail 0）✓ |
| README L552 | 起步 108 → 截至 2026-10-19 已增长至 287 项 | 同上 ✓ |
| architecture.svg L196 | 287 项单测 + 30 项 e2e | 单测同上 ✓（30 项冒烟本机未跑，见 §5） |

数量演进：108（起步）→ 270（10-18 前端改造后，HANDOVER-20261018）→ 285（10-19 主批次后，核查报告 ⑤）→ **287**（本批次 +2）。

---

## 5. 遗留问题与建议处置

| # | 事项 | 建议 |
|---|---|---|
| 1 | `scripts/smoke.sh`（30 项冒烟）本机无 bash 未跑——README/svg 的「30 项」沿旧记录 | 在有 bash 的环境补跑一次（HANDOVER-20261018 §6.2 同款遗留，非本批次引入） |
| 2 | `.merkle-snapshot.json` 未刷新 | 下次快照刷新时按 §3 表对账，或以本文档为准重新生成 |
| 3 | **新发现**：`architecture.svg` L196 源码行数统计已过时——标注 loss/ 2,133 · gateway/ 1,889 · upstream/ 1,265 · store/ 923，2026-10-19 实测（递归、不含 `*.test.ts`）为 loss 2,073 · gateway 3,383 · upstream 2,149 · store 1,466（且未列 core/ 2,107、client/ 575） | 历史快照口径，本批次只修了同行的测试数量、未动行数（无原始统计口径可复现）。下次更新 svg 时以统一口径重算，或改为定性表述 |
| 4 | pitch 路演材料检查清单仍写「README 自相矛盾（§1 216 项 / §11 108+30）」 | 历史材料不改；矛盾已消除，「路演前以实际输出为准」的提示本身仍有效 |

---

## 6. 关键文件索引

| 文件 | 说明 |
|---|---|
| `src/core/starter.ts` | L7/L191 注释修复（#6） |
| `src/client/auto-retry.ts` | L401-423 sleepWithAbort 监听器摘除、L542-548 外层 finally 清 timer（#7） |
| `src/client/auto-retry.test.ts` | L317-379「资源清理（S1）」节新增 2 项测试 |
| `README.md` | L15/L230/L552 测试数量声明（#8） |
| `architecture.svg` | L196 测试数量（#8；行数统计遗留见 §5.3） |
| `docs/tasks/task-6..9-*.md` | 任务书（文件头已标完成状态） |
| `docs/tasks/batch2-execution-guide.md` | 批次执行手册（含 #10/#11 步骤） |
| `docs/对接执行核查报告.md` | 主批次核查报告（F/R/V 编号来源，④⑤ 节与本文档互证） |
| `docs/HANDOVER-20261018.md` | 上一份交接（前端改造；§1 环境速查与 §5 坑清单仍适用） |

---

*交接人就位即安全：先跑 `npm test`（287/287），全绿再动手；改 SDK 记住契约红线（签名 / 错误结构 / 退避公式 / abort reason 链），改文档记住「历史记录不改、活文档同步实测」。*
