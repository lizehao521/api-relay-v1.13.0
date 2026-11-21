# api-relay

**智能体基础设施层**：OpenAI 兼容的**模型 API 聚合中转站** + **传话层工程降损**（P2 预检 / P3 失败归因 / P5 请求轨迹 / P8 损耗度量）——**错误可执行 · 数据可信 · 损耗可度量**。我们没有再造一个 Agent，而是做所有 Agent 都要站的那层地基。

- 一个 OpenAI 兼容入口，背后聚合多个上游厂商与模型；按档位（free / standard / pro）做鉴权、限流、并发闸门与额度。
- **成功响应零改写**：非流式响应体与 SSE 帧逐字节透传；一切附加信息只进响应头或错误体。
- **可归因**：任何非 2xx 都带 `relay_attribution`（失败原因 + 下一步动作 + 是否可恢复 + 上游）。
- 内嵌运营看板（`/admin`）与评委展示页（`/judge`），均为零 CDN 依赖的内联实现。

## 商业扩展：AI 权益中枢 × Vibe Pay

api-relay 可作为 AI 服务的权益与用量底座：将线下消费或商户活动发放为 Token 券，用户领取后获得受额度、模型白名单与有效期约束的 API Key；调用用量可计量、归因和核销。商户 Token 券闭环 M0 已实现，包含额度池、发券、领券发 Key、核销计费及管理接口（`/admin/api/merchant/*`），代码见 [`src/merchant/`](./src/merchant/) 与 [`src/admin/handlers/merchant.ts`](./src/admin/handlers/merchant.ts)。

商业方案面向门店 AI 体验，探索与 Vibe Pay 等支付能力衔接：可组合商家自供 Token、软件/部署服务，以及后续的云算力出图。**当前已完成的是权益与计量内核；支付订单、支付回调、GPU 会话调度和平台代供均未接入生产，仍属规划**。正式落地前需核实支付渠道与云资源资质、成本、退款和服务责任边界；商业测算以实际报价和试点数据为准。

提交包中的完整方案材料见 [`../ppt/商业扩展-VibePay融合方案.pdf`](../ppt/商业扩展-VibePay融合方案.pdf) 与 [`../ppt/附属商业篇-权益中枢.pdf`](../ppt/附属商业篇-权益中枢.pdf)。

## 快速开始

要求 Node ≥ 22.5.0。

```bash
npm install
npm run build        # 编译后端（tsc → dist/）并构建管理面板（vite → dist-admin/）
npm run mock         # 终端 A：起本地 mock 上游（离线自测，零成本）
npm run start        # 终端 B：起网关（默认 127.0.0.1:8787）
```

浏览器打开 `http://127.0.0.1:8787/admin`。未配置 `server.adminToken` 时，本机直连即进入体验模式（首屏会提示"直接进入面板"）。若需要**账号密码登录**，必须显式配置 `server.adminLogin.username` 与 `server.adminLogin.password`——**没有默认口令**，未配置时该通道一律拒绝，请改用 `server.adminToken`。

## 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/v1/chat/completions`、`/v1/embeddings` | 业务端点（`Authorization: Bearer <relay key>`） |
| POST | `/v1/completions`、`/v1/responses` | **同路径透传，不做协议转译**：请求体与响应体保持上游原样（上游需支持对应端点）。鉴权、预检、路由、归因与计量照常生效 |
| POST | `/v1/messages` | Anthropic 入站适配，**opt-in**：需配置 `server.inboundAdapters.anthropic: true`，未开启时返回 404 并提示开关；开启后请求转译为 OpenAI 链路再回写 Anthropic 形状 |
| GET | `/v1/models` | 按该 key 的白名单过滤的模型清单 |
| GET | `/v1/attribution/catalog` | 错误归因目录（客户端可预取） |
| POST | `/v1/kb/{id}/ask` | 知识库问答（检索结果注入 system 后走完整引擎链路） |
| GET | `/healthz`、`/` | 探活与自述 |
| GET | `/v1/quota`、`/v1/panel` | 用量 / 看板数据包（默认仅本机可读） |
| GET | `/admin`、`/judge` | 管理面板 / 作品展示页 |

管理接口位于 `/admin/api/*`，需要登录会话令牌；`GET /admin/api/panel-info` 免鉴权，自述端点契约。

## 脚本

| 命令 | 作用 |
|---|---|
| `npm run build` | 后端 `tsc` + 前端 `vite build`（同时产出 `dist/` 与 `dist-admin/`） |
| `npm run typecheck` / `npm test` | 类型检查 / 单元与端到端测试 |
| `npm run check` | 配置与生成物一致性校验 |
| `npm run mock` / `npm run demo` | 本地 mock 上游 / 演示 |
| `npm run report` | 渲染运营摘要 |
| `npm run e2e` | 端到端测试（mock 上游全链路） |

## 文档

- 架构与设计：`docs/ARCHITECTURE.md`、`docs/DESIGN.md`
- 部署与运维：`docs/DEPLOYMENT.md`、`docs/MAINTENANCE.md`
- 上手与交付：`docs/下游用户接入包.md`、`docs/对外入口现状.md`
- 研究结论：`docs/research/`（上游协议与错误契约、降损层落点裁决等）
- 决策记录：`DECISIONS.md`