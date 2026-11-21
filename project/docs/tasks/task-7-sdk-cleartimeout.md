# 任务 7：SDK autoRetry() 抛错路径 clearTimeout 优化（审查项 S1）

> **状态（2026-10-19）**：已完成，完成报告见 docs/HANDOVER-20261019-followup.md。

## 背景
code-reviewer（任务 #3/#5）发现 `src/client/auto-retry.ts` 中 `autoRetry()` 的超时定时器只在成功路径 `clearTimeout(timer)`，抛错路径未清理。timer 到期只执行 `ctrl.abort()` 无实际副作用，仅延迟闭包 GC（最多 timeoutMs），属建议级优化（S1），不阻塞。

## 要求
1. 重构 `src/client/auto-retry.ts` 中 timer 的清理逻辑：确保**所有路径**（成功、抛错、提前返回）都清理定时器。推荐 `finally` 统一清理或等价结构。保持行为不变。
2. 不得改变任何对外契约：函数签名、返回值、错误结构（`kind`/`failureReason`/`attribution` 等字段）、退避公式、abort reason 传递链。
3. 检查同文件是否存在其他资源清理疏漏（如多次重试循环中每次迭代的 timer/listener），一并处理。
4. 运行 `npm test` 确认全过（当前基线 285 项；数量如有变化如实记录）；SDK 15 项单测必须仍然全过。
5. 如为验证清理正确性需要新增测试（例如：抛错后定时器不再触发 abort），可以新增，但新增测试须与既有风格一致（node --test、mock fetch、不绑端口）。

## 约束
- 零运行时依赖（仅内置 fetch / node:* 全局 / `import type`）
- 不改核心网关代码（src/gateway、loss、core、upstream、store 等）
- 不改 README 测试数量声明（文档数量统一由任务 #8 处理）
- 完成报告：改动 diff 摘要 + 契约不变性说明 + 测试结果（通过数/总数，如有新增测试说明新增了哪几项）
