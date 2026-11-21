# api-relay

**智能体的基础设施层：错误可执行 · 数据可信 · 损耗可度量**

> 我们没有再造一个 Agent，而是做所有 Agent 都要站的那层地基。

api-relay 是一个 OpenAI 兼容的**模型 API 聚合中转站**，在协议透传之外补上 Agent 真正缺的三件事：**失败可解释、用量可归因、损耗可度量**。一个入口聚合多个上游厂商与模型，按档位（free / standard / pro）完成鉴权、限流、并发闸门与额度控制；成功响应逐字节透传，任何非 2xx 都带结构化归因。

- **版本**：v1.13.0　**运行时**：Node.js ≥ 22.5.0　**后端依赖**：仅 Node 标准库（零运行时依赖）
- **测试**：`npm test` 505 / 505，`npm run e2e` 40 / 40（2026-11-03 于本仓库源码实跑）
- **赛事**：2026 华为开发者大赛 · 智能体创新赛 · 队伍「落幕」

---

## 为什么需要它

Agent 的可用性不取决于模型有多强，而取决于**模型出错之后系统还能做什么**。常见中转站只做协议转换：上游 429、超时、内容被拒，客户端拿到的往往是一句无法判断的报错，Agent 只能盲目重试或直接崩溃。

api-relay 把错误当作一等公民：

| 能力 | 做什么 | 代码位置 |
|---|---|---|
| **P2 预检** | 请求发出前判断 token 预算、上下文长度、模型能力是否匹配，能拦下的错误不浪费一次调用 | [`project/src/loss/precheck.ts`](project/src/loss/precheck.ts) |
| **P3 失败归因** | 每个非 2xx 附带 `relay_attribution`：失败原因、下一步动作、是否可恢复、哪个上游 | [`project/src/loss/attribution.ts`](project/src/loss/attribution.ts) |
| **P5 请求轨迹** | 从入站到上游的完整链路轨迹，可回放到请求账本 | [`project/src/loss/tracer.ts`](project/src/loss/tracer.ts) |
| **P8 损耗度量** | 把重试、降级、拦截带来的额外消耗量化成可对账的指标 | [`project/src/loss/meter.ts`](project/src/loss/meter.ts) |
| **逐字节透传** | 成功响应体与 SSE 帧不改写，附加信息只进响应头或错误体 | [`project/src/gateway/engine.ts`](project/src/gateway/engine.ts) |

## 核心特性

- **多上游聚合与路由**：多厂商、多 Key 轮换、健康检查、熔断与并发闸门；按档位做限流与额度。
- **协议边界清晰**：`/v1/chat/completions`、`/v1/embeddings` 完整链路；`/v1/completions`、`/v1/responses` 同路径透传不转译；`/v1/messages` 为 opt-in 的 Anthropic 入站适配。
- **平台化能力**：多租户与 RBAC、计费账务、分布式状态原语、协议适配（含流式错误帧），决策记录见 [`project/DECISIONS.md`](project/DECISIONS.md)。
- **商户 Token 券闭环（M0）**：额度池 → 发券 → 领券发 Key → 核销计费，管理接口位于 `/admin/api/merchant/*`。
- **内嵌运营看板**：`/admin` 提供 14 个页签（总览 / 指标 / 客户 Key / 上游 / 租户 / 套餐与账单 / 知识库 / Agent / 决策矩阵 / Agent 对话 / 请求账本 / 排障 / 运维 / 信任），另有面向评委的只读展示页 `/judge`，构建产物无 CDN 依赖。

## 快速开始（零密钥，约 3 分钟）

要求 Node.js ≥ 22.5.0。

```bash
# 一键安装（Linux / macOS）
bash readme/install.sh

# 一键安装（Windows / PowerShell）
powershell -ExecutionPolicy Bypass -File readme\install.ps1

# 等价手动步骤
cd project
npm install
npm --prefix frontend install
npm run build

# 离线复现：终端 A 起 mock 上游，终端 B 起网关
npm run mock
npm run start        # 打开 http://127.0.0.1:8787/admin
```

也可以直接跑一键演示（自动启动 mock 与网关，并执行 5 项自检）：

```bash
bash project/demo.sh
```

未配置 `server.adminToken` 时，本机直连进入体验模式。需要账号密码登录必须显式配置 `server.adminLogin.username` / `password`——**没有默认口令**，未配置时该通道一律拒绝。

接入真实上游时，复制 [`project/config/relay.example.yaml`](project/config/relay.example.yaml) 为 `relay.yaml`，凭据一律用环境变量占位（如 `{ENV:DEEPSEEK_API_KEY}`），不要把 Key 写进仓库。

## 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/v1/chat/completions`、`/v1/embeddings` | 业务端点，`Authorization: Bearer <relay key>` |
| POST | `/v1/completions`、`/v1/responses` | 同路径透传，不做协议转译 |
| POST | `/v1/messages` | Anthropic 入站适配，需开启 `server.inboundAdapters.anthropic` |
| GET | `/v1/models` | 按该 Key 白名单过滤的模型清单 |
| GET | `/v1/attribution/catalog` | 错误归因目录，客户端可预取 |
| POST | `/v1/kb/{id}/ask` | 知识库问答（检索结果注入 system 后走完整链路） |
| GET | `/healthz`、`/` | 探活与自述 |
| GET | `/v1/quota`、`/v1/panel` | 用量 / 看板数据包（默认仅本机可读） |
| GET | `/admin`、`/judge` | 管理面板 / 作品展示页 |

管理接口位于 `/admin/api/*`，需登录会话令牌；`GET /admin/api/panel-info` 免鉴权，用于自述端点契约。

## 仓库结构

```text
.
├── project/            完整工程源码（网关 + 管理面板）
│   ├── src/            后端：gateway / loss / upstream / admin / merchant / store / agent
│   ├── frontend/       管理面板（Vite + Preact）
│   ├── config/         YAML 配置与示例（凭据走环境变量）
│   ├── docs/           架构、设计、部署、运维、研究与任务文档
│   └── DECISIONS.md    架构决策记录（ADR）
├── ppt/                作品介绍、商业扩展、附属商业篇（PDF / HTML）与答辩文稿
├── video/              演示视频、在线链接与分镜脚本
├── readme/             安装部署、更新说明、开源组件说明、评分对照与自评
├── codearts_proof/     码道（CodeArts）使用证明与截图
├── design-proto/       管理面板交互原型与审查记录
├── deliverables/       竞品与产品策略分析
└── SUBMISSION-README.md 参赛提交包说明
```

## 常用脚本

在 `project/` 目录下执行：

| 命令 | 作用 |
|---|---|
| `npm run build` | 编译后端（`tsc` → `dist/`）并构建管理面板（`vite` → `dist-admin/`） |
| `npm run typecheck` | TypeScript 类型检查（严格模式） |
| `npm test` | 单元与端到端测试（Node 内置 `node --test`） |
| `npm run e2e` | mock 上游全链路端到端测试 |
| `npm run check` | 配置与生成物一致性校验 |
| `npm run demo` | 本地演示与自检 |
| `npm run bench` | 基准测试 |

## 文档

- 架构与设计：[`project/docs/ARCHITECTURE.md`](project/docs/ARCHITECTURE.md)、[`project/docs/DESIGN.md`](project/docs/DESIGN.md)
- 部署与运维：[`project/docs/DEPLOYMENT.md`](project/docs/DEPLOYMENT.md)、[`project/docs/MAINTENANCE.md`](project/docs/MAINTENANCE.md)
- 架构决策记录：[`project/DECISIONS.md`](project/DECISIONS.md)
- 接入与交付：[`project/docs/下游用户接入包.md`](project/docs/下游用户接入包.md)、[`project/docs/对外入口现状.md`](project/docs/对外入口现状.md)
- 环境与安装：[`readme/环境依赖与一键安装.md`](readme/环境依赖与一键安装.md)
- 版本更新：[`readme/更新说明-v1.13.0.md`](readme/更新说明-v1.13.0.md)
- 评分对照：[`readme/评分标准对照与自评表.md`](readme/评分标准对照与自评表.md)

## 商业扩展：AI 权益中枢

api-relay 可作为 AI 服务的权益与用量底座：把线下消费或商户活动发放为 Token 券，用户领取后获得受额度、模型白名单与有效期约束的 API Key，调用用量可计量、归因与核销。

**边界说明**：当前已完成的是权益与计量内核（M0 商户 Token 券闭环）；支付订单、支付回调、GPU 会话调度与平台代供均未接入生产，属于规划。所有成本与盈亏测算均标注假设与来源，以实际报价和试点数据为准。方案材料见 [`ppt/商业扩展-VibePay融合方案.pdf`](ppt/商业扩展-VibePay融合方案.pdf) 与 [`ppt/附属商业篇-权益中枢.pdf`](ppt/附属商业篇-权益中枢.pdf)。

## 演示

- 演示视频：[`video/api-relay-demo.mp4`](video/api-relay-demo.mp4)（约 2 分 50 秒）
- 评委展示页：`http://121.36.29.96:8787/judge`（演示实例，可用性以现场为准）

## 说明

- 本仓库为参赛作品提交物，未附带开源许可证；如需复用代码或材料，请先联系作者。
- 仓库不包含 `node_modules/`、`dist/`、`dist-admin/` 与任何密钥文件；依赖与构建产物由上述命令本地生成。

---

**队伍**：落幕　**联系**：li1119489753@outlook.com