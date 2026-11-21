# RSI 受控自我改进实验场 · 码道使用痕迹与对账证据（2026-11-08 ~ 11-09）

## 一、开发方式

RSI 实验场（`project/rsi-lab/`）的全部代码、测试、看板与排错，均在**华为云码道（CodeArts）会话**内完成：由自然语言任务描述驱动代码生成、重构与调试，每一步产出都用 `npm test` 与 headless 渲染自检。

## 二、关键交互记录（Prompt → 产出 → 验证）

| # | 任务（自然语言指令要点） | 码道产出 | 验证结果 |
|---|---|---|---|
| 1 | 重建 RSI 实验场：runner（gate/one-round/run-loop/milestone/lib）、dashboard（data/server/index.html）、tests | 全套 ESM 源码 + 6 个测试文件 | 45/45 绿 |
| 2 | 把微内核 R1–R6 两代对账判据接进循环（方案 C） | `runner/verdict.mjs`（423 行）+ `gate.mjs` 薄接缝 + judge 四态链路 | 53/53 绿（新增 14 例全门类对抗测试） |
| 3 | 排错：并发评测 TAP 统计为空（total=0） | 定位根因 = 子进程继承 `NODE_TEST_CONTEXT`；改 `spawnSync` + 环境变量剥离 + 空输出重试 | 单文件 7/7、全量 53/53 |
| 4 | 看板增强：四态判定列、对账账本链、里程碑显示 | `dashboard/data.mjs` + `index.html` 区块 + `verify-render.mjs` | headless 渲染 0 pageerror，17 轮卡/账本 5 行全渲染 |

## 三、可复核证据文件

- `runs/npm-test-final.log`：53/53 全绿，`EXITCODE=0`
- `ledger.jsonl`：5 条哈希链（2 代基线 manifest + 3 条判定），`verifyChain` 通过；同代异 manifest 重记、链篡改均被 R6 拒绝（单测覆盖）
- `sandbox/`：git 提交链 10 条，HEAD=`bad34ff`（round 17，score 0.958）；`git log --oneline` 可直接复核
- `dashboard/verify-render.mjs`：puppeteer-core + Edge headless 渲染校验脚本

## 四、实测收益（详见 readme/RSI实验场运行说明.md）

- 扩展前：8 用例靶子满分 1.000 后空转（round 14 revert 烧 13,735 token）
- 扩展后：满分自动扩靶子（microkernel-measure，24 用例基线 0.667）→ 模型实现 → 0.833 → 0.958（round 17 accept）
- 超时轮（round 16）不再丢弃证据：对账判定 reverted + blockers 入链
