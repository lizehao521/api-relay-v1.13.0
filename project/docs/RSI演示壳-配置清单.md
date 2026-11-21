# RSI 演示壳 · 配置清单（CodeLens @ 1C2G 云服务器）

> 状态：**方案文档，尚未部署**。所有环境变量名均取自仓库 `server/src/config/env.ts` 与 `deploy/codelens.env.example`，未实测项不写入。
> 定位：RSI（Recursive Self-Improvement，递归自我改进）作为 CodeLens 的**受控演示壳**——Agent 自己改自己的工作区代码、跑评测、按分数迭代；每轮受预算/审批/快照约束，任何一轮都可回滚。
> 服务器判定：用户确认现有 1C2G 演示机可承载；本清单按"串行短回合"设计，单轮预算 90s 以内，避免长进程驻留。

---

## 1. 运行拓扑

```
cron(每 30min, flock 防重叠)
  └─ round-runner.sh  (nice 10, 超时硬杀)
       ├─ git worktree 建轮次工作区（从 bare 仓库 best 提交拉出）
       ├─ POST localhost:8789/api/v1/agent/stream  (SSE, provider=custom → api-relay 8787)
       ├─ 解析 done 事件（usage/finishReason/toolCallCount）
       ├─ 跑评测子集（vitest 指定目录，不跑全量）
       ├─ 决策：accept（commit 到 bare）/ revert（丢弃 worktree）/ stop（写 stop 文件）
       └─ 落盘 run-report.json + 追加 scores.jsonl
```

- runner 直连 `127.0.0.1:8789`，**不经过 8788 nginx**；8788 只服务评委浏览器演示。
- 模型链路：CodeLens → api-relay `127.0.0.1:8787/v1`（复用组合方案底座，计量/归因/熔断都在）。
- 磁盘：worktree 每轮清理；bare 仓库只保留 accept 的提交链，40G 盘可长期跑。

## 2. 系统用户与目录

```bash
useradd -r -m -d /opt/codelens-rsi -s /bin/bash codelens-rsi
mkdir -p /opt/codelens-rsi/{repo.git,workspace,runs,eval}
# bare 仓库 + 基线提交（初始代码即"第 0 轮"）
git clone --bare https://github.com/lizehao521/codelens-local-agent-workbench /opt/codelens-rsi/repo.git
git -C /opt/codelens-rsi/repo.git config core.bare true
```

- 代码仓库**只读克隆 + 每轮 worktree**，Agent 永远改不到裸仓库本身，改坏最多丢一个 worktree。
- `runs/<round>/` 存 run-report.json、stdout.log、diff.patch；`eval/` 放评测脚本与基线分数。

## 3. CodeLens 侧环境变量（/root/codelens/.env 追加或独立实例）

```bash
# ── 资源与并发（1C2G 硬约束）──
AGENT_MAX_CONCURRENT=1
AGENT_MAX_TOOL_CALLS=40
AGENT_TASK_BUDGET_MS=90000          # 单轮 90s 硬上限，配合 cron 短回合
CHECKPOINT_ENABLED=true
SANDBOX_ROOT=/opt/codelens-rsi/workspace
AGENT_DB_PATH=/opt/codelens-rsi/data/codelens.db

# ── 上游：RSI 专用 key（见第 4 节），非空即强制 custom 通道 ──
LLM_SERVER_API_KEY=<rsi 专用 key，仅写入本文件，勿入 git>
TRIAL_MODE_ENABLED=true             # 评委页仍可用；runner 用 custom 直呼
TRIAL_BASE_URL=http://127.0.0.1:8787/v1
TRIAL_MODEL=glm-5.3                 # 评委演示档（实测首 token≈4.7s，见项目记忆）
TRIAL_DAILY_LIMIT=5

# ── 三道预算（RSI 防无限自嗨的关键）──
FALLBACK_GLOBAL_DAILY_TOKEN_LIMIT=3000000   # 全天所有轮次合计
FALLBACK_PER_IP_DAILY_TOKEN_LIMIT=3000000
FALLBACK_PER_TASK_TOKEN_LIMIT=120000        # 单轮上限

# ── 模型清单同步（与 api-relay 同机）──
MODEL_SOURCE_URL=http://127.0.0.1:8787/v1/models
MODEL_SOURCE_FORMAT=openai
MODEL_SOURCE_ALLOW_PRIVATE=true
MODEL_SOURCE_ALLOW_INSECURE=true
MODEL_REFRESH_INTERVAL_MS=3600000

# ── 限流 ──
API_RATE_LIMIT_PER_MIN=120

# ── 签名密钥（独立生成，勿复用演示实例）──
AGENT_APPROVAL_SECRET=<openssl rand -hex 32>
```

**审批三分法（在 CodeLens 三档审批里配置）**
| 动作类别 | 策略 |
|---|---|
| 读文件 / 跑评测子集 / 写轮次 worktree 内文件 | 自动批准，但每轮 diff 留档 |
| 写 worktree 之外、装依赖、改配置 | 强制人工审批（默认拒绝，演示时人工放行一次作为卖点） |
| 出网 / curl / 下载 | 默认拒绝；白名单仅模型端点与包源 |

## 4. api-relay 侧：RSI 独立 client

```yaml
# relay.base.yaml → clients 追加（然后 npm run config:build + kill MainPID）
- id: rsi
  label: RSI 迭代专用
  key: "{ENV:RELAY_KEY_RSI}"
  tier: standard
  tenantId: rsi
  enabled: true
```

- 目的：计量独立（按 tenant 看 token/成本）、故障隔离（rsi key 可单独 disable 而不动演示 key）、一键止损。
- 迭代模型**全程用快速档 `glm-5.3-flash`**（amd/modelscope 多路兜底）。**不要**在展示轮切 `glm-5.3`：它是推理模型，思维链会吃光单轮输出预算，实测只完成 1 次工具调用就结束（详见第 13 节）。

## 5. nginx（仅评委入口 8788，长 SSE 防超时/限流）

```nginx
# http 块
limit_req_zone $binary_remote_addr zone=codelens:10m rate=2r/s;

# server 块（现有配置基础上追加）
client_max_body_size 8m;
proxy_read_timeout   600s;      # 已存在
proxy_send_timeout   600s;      # 已存在
proxy_buffering      off;       # 已存在，SSE 必须
limit_req            zone=codelens burst=5 nodelay;
add_header           X-Accel-Buffering no;
```

- runner 走本地 8789 不受 nginx 限流；评委多次刷新也只 2r/s。
- 已修复的 CSP 头（`proxy_hide_header Content-Security-Policy` + 自建 CSP）保持不变，见 `deploy/nginx-codelens.conf`。

## 6. 评测与停止条件（伪代码）

```text
baseline := 当前 best 提交的评测分数
stop_reason := none
for round in 1..MAX_ROUNDS(12):
    report := run_agent(best_worktree, task=EVAL_IMPROVE_TASK, budget=90s)
    score  := run_eval(report.worktree, subset=affected_tests)   # 不跑 995 全量
    write run-report.json (含 usage / toolCallCount / diffStat)
    if report.finishReason != 'stop' or report.toolCallCount == 0:
        revert(); if ++noop_streak >= 2: stop('agent_no_progress')
    elif score > best + EPS(0.005):
        commit_to_bare(report.worktree); best := score; no_improve := 0
    elif score < best - TOL(0.01):
        revert(); if ++regress_streak >= 2: stop('regression')
    else:
        revert(); if ++no_improve >= 2: stop('no_improvement')
    if tokens_total > DAILY_TOKEN_CAP: stop('budget')
    if approval_rejection_rate(round) > 0.5: stop('gate_friction')
    if build_fail_streak >= 2: stop('build_broken')
write stop 标记文件 → runner 下一轮直接退出（次日人工清标记恢复）
```

**必须同时成立的三个停表条件**：迭代上限、连续无提升、预算耗尽。任何一条命中即写 `/opt/codelens-rsi/STOP`，cron 任务先查该文件再启动。

## 7. cron 调度脚本（跳过 STOP、flock 防重叠、硬超时）

```bash
#!/usr/bin/env bash
# /opt/codelens-rsi/bin/round-runner.sh
set -euo pipefail
STOP=/opt/codelens-rsi/STOP
[ -f "$STOP" ] && { echo "stopped: $(cat "$STOP")"; exit 0; }
exec 9>/opt/codelens-rsi/.lock
flock -n 9 || { echo "previous round still running"; exit 0; }
nice -n 10 timeout -k 10 180 /opt/codelens-rsi/bin/one-round.sh
```

```cron
*/30 * * * * codelens-rsi /opt/codelens-rsi/bin/round-runner.sh >> /opt/codelens-rsi/runs/cron.log 2>&1
```

- 单轮硬超时 180s（agent 90s + 评测 60s + 余量），超出直接杀，不留僵尸。
- 30 分钟间隔给评测与清理留窗口；1C2G 上不要并行轮次。

## 8. 每轮证据落盘（演示与答辩素材）

`runs/<round>/run-report.json` 固定字段：

```json
{
  "round": 3, "baseCommit": "abc1234", "taskKind": "improve",
  "finishReason": "stop", "iteration": 4, "toolCallCount": 7,
  "usage": { "promptTokens": 12031, "completionTokens": 642 },
  "durationMs": 61234, "filesChanged": 2,
  "eval": { "passed": 118, "failed": 0, "score": 0.91, "delta": 0.03 },
  "decision": "accept", "commit": "def5678", "rollback": null
}
```

- `scores.jsonl` 每轮一行，答辩时直接画分数曲线（比口头说"AI 会自我改进"有力）。
- accept 的提交链 = 可审计的进化史；revert 的 diff.patch 也留档，证明"护栏真的拦得住"。

## 9. 一轮现场演示时间轴（受控 mini-loop，约 3 分钟）

| 时间 | 动作 | 预期可见结果 |
|---|---|---|
| 0:00 | 讲清定位：受控 RSI，不是放任自改 | 评委理解边界 |
| 0:15 | 打开 CodeLens 页面，展示第 2 轮 run-report 与分数曲线 | 进化有证据 |
| 0:45 | 现场触发第 3 轮（TRIAL 通道，快速档模型） | SSE 流式：reasoning → tool_call → tool_result |
| 1:30 | Agent 试图改 worktree 外文件，**审批弹窗拦住** | 护栏卖点，比顺利跑完更抓人 |
| 2:00 | 人工放行工作区内改动，评测跑绿 | 分数 +0.03，done 事件 usage 可见 |
| 2:30 | `git log --oneline` 展示提交链 + 回滚演示 | 可回滚、可审计 |
| 2:50 | 收尾：成本（本轮 token≈12k）+ stop 条件 | 可控、可计量 |

- 现场不要跑满 12 轮；演示只展示"一轮完整闭环"。
- 提前预热模型（演示前 10 分钟发一次空跑），避免首请求冷启动。

## 10. 安全清单（部署前逐项勾）

- [ ] 独立系统用户 `codelens-rsi`，非 root 运行
- [ ] `SANDBOX_ROOT` 独立目录，与演示实例数据库/沙箱物理隔离
- [ ] 裸仓库只读 + 每轮 worktree（Agent 无写裸仓库权限）
- [ ] 审批三分法生效：worktree 外写 / 装依赖 / 出网 全部人工审批
- [ ] 出站白名单：仅 `127.0.0.1:8787` 与包源；关闭任意出网
- [ ] `AGENT_APPROVAL_SECRET` 独立生成，不入 git、不入日志
- [ ] `STOP` 文件机制存在，cron 先查后跑
- [ ] 磁盘巡检：`runs/` 保留最近 50 轮，worktree 每轮强制清理
- [ ] run-report 中不落任何密钥（token 用量可以，key 不行）
- [ ] api-relay `rsi` key 可单独 disable（止损开关已验证可用）

## 11. 验收标准

1. 连续 3 轮成功闭环，`finishReason=stop`，单轮 ≤90s，内存峰值不触发 OOM。
2. 至少 1 轮"评测不过 → 自动 revert"，且 best 提交未被污染。
3. 至少 1 次审批拦截（worktree 外写入被拒），拦截事件可追溯。（本地已验证：Agent 尝试覆盖 `test/extra.test.js`，策略拒绝，`tool_result=rejected`，记录见 `runs/guardrail-probe/probe.json`）
4. `scores.jsonl` 呈单调趋势（非必须，但至少不倒退）。
5. 演示时间轴 3 分钟内可完整跑完，全程无人工干预（除演示性放行）。

## 12. 已知边界（答辩时主动说）

- 1C2G 上这是"可行性 + 护栏"验证，不是生产力级 RSI；长跑建议 4C8G 独立实例。
- 评测集当前按"受影响目录子集"跑，全量 995 用例不进每轮循环（时间成本不划算，已在本地验证全量全绿）。
- 自改范围限定在工作区 + 评测脚本，不触碰 CodeLens 服务端代码与部署配置——服务端自改需要更强隔离，不在本次演示范围。
## 13. 实测约束与踩坑（本地 lab 已复现）

以下均为本地 RSI 实验场（`glm-5.3-flash` + CodeLens 18791）的真实结论，部署前必须对齐：

| 约束 | 实测表现 | 处理 |
|---|---|---|
| **Agent 流接口 `maxTokens` 默认 2048** | `POST /api/v1/agent/stream` 不传时走 schema 默认值 2048；`fs.write` 的 `arguments.content` 被截断，上游报 `function.arguments 不是合法 JSON` 或模型直接结束（`toolCallCount=1`、`finishReason=stop`） | 请求体显式传 `maxTokens: 4096`（schema 上限 8192） |
| **推理档 `glm-5.3` 不可用于迭代** | 思维链吃光输出预算，实测 `completionTokens≈2081/2094` 即结束，只读了 1 个文件 | 全流程用 `glm-5.3-flash` |
| **单次运行迭代上限** | `maxIterations` 默认 12（schema 可传 5–30）；早期未调参时 `iteration=5` 即 `stop` | 请求体按需传 `maxIterations`，单轮任务仍要保持极小粒度 |
| **`.artifacts/` 会混入提交** | runner 用 `git add -A` 会把运行时产物一起提交 | `git add -A -- . ':(exclude).artifacts'` |
| **审批分级** | `fs.read`=无需审批；`fs.write`=`soft` 自动放行；`sys.exec`=`hard` 走审批（事件 `tool_approval_required`） | runner 按策略自动决策：`node --test` 放行，解释器内联/出网拒绝 |

**里程碑二实测曲线**（靶子：8 个函数 + 16 个用例，初始 8/16 = 0.5）：

| 轮次 | 决策 | 分数 | 通过/失败 | token | 提交 |
|---|---|---|---|---|---|
| 11 | accept | 0.688 | 11/16 | 17,655 | `a9ca9f8` |
| 12 | accept | 0.813 | 13/16 | 17,836 | `a6cb227` |
| 13 | accept | **1.000** | **16/16** | 18,452 | `4eeb6fb` |
| 14 | revert | 1.000 | 16/16 | 13,735 | —（已满分，无提升） |

- 每轮只实现 1 个待实现函数，形成"0.5 → 0.688 → 0.813 → 1.0"的阶梯爬升，比一次性满分更适合答辩叙事。
- 满分轮工具轨迹：`fs.read` → `fs.write`（覆盖 `src/stats.js`）→ `sys.exec node --test`；3 次审批全部按策略放行，0 拒绝。
- 里程碑二 4 轮合计 67,678 token（单轮 13.7k–18.5k），均在 1C2G 可承受范围；实验室全历史累计 273,142 token（含早期参数未调优的探索轮）。
## 14. 原创扩展与收益（方案 C：微内核对账判据移植，本地已实测）

在演示壳之上做的原创扩展：把桌面「微内核-RSI」的 **R1–R6 两代对账判据**（`runner/verdict.mjs`，423 行完整移植）接进自改进循环，让每一轮"改进"都必须过六道门才算数。

### 14.1 扩展内容

| 扩展件 | 位置 | 作用 |
|---|---|---|
| **R1–R6 对账判据** | `runner/verdict.mjs` | R1 结构门 / R2 产物指纹门 / R3 判据放水门 / R4 证据门 / R5 改进门 / R6 哈希链锚定门 |
| **gate 接缝层** | `runner/gate.mjs` | 把循环里的"评测分数"翻译成"两代 manifest 对账"，复用微内核 judge 四态（improved / not_improved / refused / undecidable） |
| **自动扩靶子** | `runner/milestone.mjs` + `run-loop.mjs` | 满分后自动落入下一个里程碑模板（新靶子变红 → 基线重锚 → 模型继续改进），不用人工换题 |
| **超时留痕** | `runner/one-round.mjs finishAborted` | 模型超时/崩溃时，只要沙箱落过盘就必须评一次、对一次账、把判定写进链——超时不许抹账 |
| **对账看板** | `dashboard/` | 四态判定列（accept/revert/timeout/milestone_failure）、账本链 Verify 徽章、17 轮明细卡 |

### 14.2 实测收益（本地 lab 真跑数据）

**扩展前**（第 11–14 轮）：8 用例靶子爬到满分 1.000 后循环空转（round 14 revert，白烧 13,735 token）。
**扩展后**（第 15–17 轮）：满分自动扩靶子 → 24 用例新基线 0.667 → 模型实现到 **0.833 → 0.958**，fail_count 4→1、pass_rate 双指标同时变好才放行：

| 轮次 | 事件 | 分数 | 提交 |
|---|---|---|---|
| 15 | 满分触发扩靶子 `microkernel-measure`，基线重锚 g1 → 实现后 **accept g2** | 0.833（20/24） | `6c176e3` |
| 16 | 模型超时——**留痕不抹账**：对账判定 reverted + blockers 入链 | — | —（沙箱还原） |
| 17 | 模型补完剩余缺陷 → **accept g3** | **0.958（23/24）** | `bad34ff` |

- **账本哈希链 5 条**（2×manifest 基线 + 3×判定），`verifyChain` 全程 ok；同代异 manifest 重记、链篡改均被 R6 拒绝（有单测）。
- **沙箱 git 提交链完整**：`4eeb6fb → 0432527(里程碑) → 6c176e3 → bad34ff`，HEAD 恢复后实测 24 用例 23 过 = 0.958，与账本一致。

### 14.3 质量保障（53/53 单测全绿）

- R1–R6 全门类对抗测试：放水（loosened/removed）、同字节换标签、`estimated/model_says` 冒充证据、代际不增、分母缺失——全部 refused（有正对照 improved 佐证判据不是一律拒绝）。
- 超时留痕 3 例：已落盘必对账 / 未落盘不动账本 / 写一半给诚实结论。
- 看板数据层 7 例：四态映射、失败轮 verdict 保留、轮次升序、详情字段完整。
- 评测器加固：`spawnSync` + 超时守卫 + `NODE_TEST_CONTEXT` 环境变量剥离（修掉子进程 TAP 统计为空的瞬态坑）+ 空输出重试。
- headless 渲染校验：`verify-render.mjs`（puppeteer-core + Edge）0 pageerror，17 轮卡/账本 5 行/KPI 全渲染。

### 14.4 对答辩的叙事价值

1. **"改尺子冒充改产品"防不住的痛点被六道门关死**——这是与"裸 Agent 自动改代码"最本质的差异，也是评委最容易感知的原创点。
2. **满分不等于终点**：扩靶子机制让 demo 能连续讲故事（爬升 → 满分 → 换更难的题 → 继续爬升），证据链全程可回放。
3. **超时/崩溃也有诚实记录**——系统的可信度来自"失败也留痕"，与赛题"可信智能体"主题直接呼应。
