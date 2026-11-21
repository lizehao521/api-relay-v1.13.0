# 竞品对标分析 ·api-relay 平台化竞争格局

> 项目：api-relay（OpenAI 兼容的多上游聚合中转网关 + 内嵌 Preact 管理面板）
> 分析目标：为「从工具级自托管网关 → 可对外运营的聚合中转模型 API 平台」的升级提供客观竞品对标，暴露劣势与差异化机会
> 作者：竞品分析师「竞析」 ｜ 版本：v1.0 ｜ 日期：2026-10-24
> 事实依据：`project/README.md`（§6.1/§6.2/§9/§11）、`project/docs/research/01-竞品与生态矩阵.md`（含源码行号证据）、`design-proto/01-discovery.md`、`design-proto/04-review.md`
> 信息新鲜度：竞品事实主要锚定 research-01，其抓取基准日为 **2026-09-11（CST）**，距今约 6 周；本报告另以 web 检索做了有限的时效校核（见文末「时效校核」）。凡未一手核实的条目一律标注 **[未核实]**。

---

## 【阅读导航】

| # | 章节 | 它回答什么 |
|---|---|---|
| 0 | 分析设定与方法 | 评分口径、证据等级、时效边界 |
| 1 | 竞品全景图 | 7 个竞品各是什么、怎么部署、怎么赚钱 |
| 2 | 功能对比矩阵 + 逐项评分 | 15 维横评、api-relay 得分与依据、加权总分 |
| 3 | SWOT（api-relay 视角） | 我们的内外优劣势与机会威胁 |
| 4 | 差异化机会 | 结合「降损层」窄点，深耕什么、必须补齐什么 |
| 5 | Battle Card | 面对 NewAPI / LiteLLM / OpenRouter 的攻防话术 |

---

## §0 分析设定与方法

- **目标**：为一轮「平台化升级」设定一把可复用的对标尺子（维度 + 权重 + 证据规则），使后续任何一次竞品复核都能在同一口径下重算。
- **输入**：`project/docs/research/01`（逐竞品源码/文档证据）、`project/README.md`（api-relay 自身能力事实）、`design-proto/01-discovery.md`（平台化目标 G1–G7 与待实现 N1–N10）。
- **产出物**：评分口径（15 维 + 权重）、证据等级规则、分析范围边界。
- **关键决策**：
  1. **对标对象锁定 7 家**：OneAPI、NewAPI(QuantumNous)、LiteLLM、Portkey、Helicone、OpenRouter、Cloudflare AI Gateway。前 5 家为开源可自托管，后 2 家为闭源托管标杆；这是「可对外运营平台」必须同时面对的两类对手。
  2. **评分维度对齐任务清单，并以「平台可运营」为目标加权**：多租户/计费/可观测/企业功能等「能卖」的维度权重更高；纯工程炫技维度权重克制。**权重是产品视角的取舍，不是中立的物理量**，已显式写出以便讨论与重算。
  3. **api-relay 按「当前仓库现状」评分，不按路线图评分**——路线图上的 Anthropic/Gemini、多租户等一律按「未实现」计，避免自我美化。
  4. **证据分级**：`[E1]` 源码行号（最强）> `[E2]` GitHub 元数据 > `[E3]` 官方文档 > `[推断]` 基于信号的推断。事实与推测在正文分开陈述。
- **风险与待办**：
  - ① 竞品事实存在约 6 周时滞，若某竞品近期有重大版本迭代，需重跑 research-01 的抓取脚本（本文不覆盖「昨日新闻」级的动态）。
  - ② 评分含主观判断，权重变更会改变名次；本文给出「原始分表」而非只给总分，便于第三方按自己的权重重算。
  - ③ **「竞品评分 vs 我方评分」不是同一观测条件下得出**（竞品多为文档口径，我方按源码事实），存在系统性偏差 —— 这是本节最大的方法学风险，已在解读时降权处理。

---

## §1 竞品全景图

> 图例：部署形态分「自托管开源」/「托管 SaaS」/「混合」三类；商业模式分「开源免费 + 商业托管」/「开源免费 + 企业版」/「纯托管计费」/「倍率转售」。

### 1.1 OneAPI（`songquanpeng/one-api`）

- **定位**：LLM API 管理与分发系统。把 OpenAI/Azure/Claude/Gemini/DeepSeek/文心/星火/通义/混元等统一成一套 OpenAI 兼容 API，用于 key 管理与二次分发。**国内中转站的事实标准数据模型来源**。`[E3]`
- **部署形态**：自托管开源。Go 单可执行文件 + Docker，自带 Web 管理与用户/令牌/渠道体系。`[E1][E3]`
- **许可**：**MIT**（`LICENSE`，Copyright 2023 JustSong）——可闭源商用、可 fork 改名、**无传染**，这是它相对 NewAPI 的最大优势。`[E1]`
- **核心能力**：多渠道负载均衡（priority 分档 + 档内随机，`model/cache.go:227`）、多机部署、令牌管理（过期/额度/IP 白名单/模型白名单）、兑换码、渠道批量创建、用户分组 + 渠道分组 + 分组倍率、额度明细、失败自动重试、绘图接口、Turnstile、多登录方式；官方扩展方式是**管理 API**（README 第 118 条），而非代码钩子。`[E1][E3]`
- **商业模式**：项目本身免费；实际商业形态是**被大量「套壳站」二次分发**——即 OneAPI 是「友商的生产工具」，转售商在其上加倍率计价与客服。`[推断，基于国内中转业态]`
- **对我们的关键事实**：**没有多 key 池**（`model.Channel.Key` 是单个 `string`，一渠道一 key，`model/channel.go:23`）；错误路径**几乎无加工**（`relay/controller/error.go:55 RelayErrorHandler`：非 OpenAI 上游只抽出一个字符串，语义全丢）；主分支 `HEAD` 提交日期 2025-02-21，**推测已停滞一年半**（`pushed_at` 2026-01-09 与默认分支 HEAD 不一致，属推断）。`[E1]`

### 1.2 NewAPI（`QuantumNous/new-api`，原 `Calcium-Ion/new-api`）

- **定位**：OneAPI 的增强分支，已发展为「统一 AI 模型聚合与分发中枢」——跨协议互转（OpenAI ⇄ Claude ⇄ Gemini ⇄ Responses）、多渠道多 key、更完整的计费与看板。**当前国产功能最全的中转站**。`[E2][E3]`
- **部署形态**：自托管开源。Go；`relaykit/`（`dto`/`types`/`relayconvert`）已抽成独立模块；`plugins/tasks/*/plugin.js` 任务插件；`web/`、`electron/`。`[E1]`
- **许可**：**AGPL-3.0 + Section 7 附加条款**（关键风险，见下）；另有商业授权入口 `support@quantumnous.com`（双重授权）。`[E1]`
  - **Section 7 义务（README `README.md:474-488` 原文）**：任何修改版本必须保留署名 `Frontend design and development by New API contributors.`；**任何带 UI 的修改版本必须保留指向 `https://github.com/QuantumNous/new-api` 的可见链接**。
  - **传染性含义**：只要把 NewAPI 代码跑成面向用户的网络服务，就必须**向服务使用者提供完整对应源码**。→ **直接否决「fork NewAPI 做自有品牌闭源中转站」这条路径**（与 design-proto 的「不做 fork」结论一致）。
- **核心能力**：多 key 池 + key 级状态机（`model/channel.go:204 GetNextEnabledKey()`、`:671 handlerMultiKeyUpdate()`）；智能路由（渠道加权随机 + 失败自动重试 + 用户级模型限流）；计费（分组倍率、按次/按量、缓存命中成本核算）；协议互转；高级 API（Responses/Realtime/Claude Messages/Gemini/Rerank）；数据看板。`[E1][E3]`
- **错误路径现状（对 P3 最重要）**：内部 `types.NewAPIError`（`relaykit/types/error.go:90`）已具备 **30+ 个分层 `ErrorCode`**（`channel:no_available_key`、`channel:response_time_exceeded`、`insufficient_user_quota` …）与 `ErrorType`（`openai_error/claude_error/gemini_error/…`）；但对外 `ToOpenAIError()`（`:180`）**有损映射 + `MaskSensitiveInfo` 主动脱敏**，**完全没有**「建议下一步 / 可重试性 / 预计恢复时间」字段。已有 `Log.UpstreamRequestId`（`model/log.go:79`，对账抓手）。`[E1]`
- **商业模式**：开源 + 商业授权双轨。社区版被大量转售商使用；因 AGPL，等价于「想闭源就得谈商业授权」。`[E1][推断]`

### 1.3 LiteLLM（`BerriAI/litellm`）

- **定位**：「Rust core with Python SDK」——既是 **Python SDK**（统一调用 100+ 上游），也是 **Proxy/网关**（`litellm/proxy`，带虚 key、预算、限流、`/ui` 管理后台）。**开源阵营里路由与异常工程最完备者**。`[E2][E1]`
- **部署形态**：自托管开源为主（Python/FastAPI Proxy），另有 LiteLLM Cloud 托管。`[E1][推断]`
- **许可**：**MIT**，但根 `LICENSE` 声明 `enterprise/` 目录另有许可（该例外条款实际适用范围 **[未核实]**，抓取 `enterprise/LICENSE` 返回 404）。`[E1]`
- **核心能力（全场最全的工程地基）**：
  - **路由策略**（`litellm/types/router.py:893 RoutingStrategy`）：`least-busy` / `latency-based` / `cost-based` / `usage-based(v2)` / `provider-budget`，**5 种策略，竞品中最完整**。`[E1]`
  - **回退链**：`async_function_with_fallbacks`（`router.py:7527`），区分 **generic / context_window / content_policy 三条独立回退链** + `max_fallbacks`/`fallback_depth` 防「回退地狱」。`[E1]`
  - **错误地基**：`exception_mapping_utils.py:2323 exception_type()` 把任意上游异常映射成 OpenAI 异常；`litellm/exceptions.py` **31 个语义化异常类**，且**刻意继承 `openai.*` 异常树**（让用户 `except openai.RateLimitError` 继续生效）；**`RateLimitErrorCategory`（`exceptions.py:21`）区分 `vendor_rate_limit`（上游）vs `litellm_rate_limit`（自身）**——回答了 P3 的「是谁限流」。`[E1]`
  - **钩子扩展点（P2/P3 现成插槽）**：`async_pre_call_hook`（P2 落点）、**`async_post_call_failure_hook`（`custom_logger.py:451`，P3 现成插槽，官方注释明写「Return an HTTPException to transform the error response sent to the client」）**、`async_post_call_response_headers_hook`（注入自定义响应头）。**对会 Python 的团队，P2/P3 可零 fork 实现**。`[E1]`
  - 护栏（20+ hooks）、预算/RPM/TPM（按 key·team·user·model）、OTel 观测。`[E1]`
- **商业模式**：开源免费 + 企业版（`enterprise/`）。护城河在**SDK 生态与 provider 覆盖**，不在「中转站产品化」。`[推断]`
- **对我们的关键事实**：LiteLLM **「P3 归因的地基已经有了，但没把错误做成面向 Agent 的可执行建议」**——它的输出是「换 deployment / 走另一条 fallback 链」的机器决策，不是给 Agent/开发者看的自然语言 quick_action。这是 api-relay 差异化的**最窄也最值钱的缝**。`[E1]`

### 1.4 Portkey Gateway（`Portkey-AI/gateway`）

- **定位**：「A blazing fast AI Gateway with integrated guardrails」，路由到 1600+ LLM、50+ AI Guardrails，路由策略 + 护栏在**同一个 JSON 配置**里声明。`[E2]`
- **部署形态**：自托管开源（TS/Node，可部署到 Node 或 Cloudflare Workers，有 `wrangler.toml`），另有 Portkey SaaS 平台。`[E1]`
- **许可**：**MIT**（`LICENSE`，Copyright 2024 Portkey, Inc）。`[E1]`
- **核心能力**：**配置驱动路由**（`{ "strategy": { "mode": "fallback", "on_status_codes": [429] }, "targets": [...] }`，fallback 默认对任何非 2xx 触发）；钩子系统（`HookType{GUARDRAIL, MUTATOR}`，事件仅 `beforeRequestHook`/`afterRequestHook`）；**20+ 家第三方安全厂商护栏插件**；内置 Admin UI（`/public/`，日志流 + key 录入 + fallback 配置，`conf.json.admin_token` 鉴权，`--headless` 可禁用）。`[E1][E3]`
- **错误路径现状**：**几乎没有加工** —— 错误类型只有 `GatewayError`（message+status+cause）与 `RouterError`（message+cause）；无集中错误分类常量表；上游错误体由各 provider 的 `xxx.ts` **逐个手工映射**；**没有「失败后」钩子**，要加 P3 = 从零补一个错误分类层。`[E1]`
- **商业模式**：开源 Gateway（引流）+ Portkey SaaS 平台（计费/护栏/可观测的商业面）。**网关本体不做计费，平台侧才有**。`[E1]`
- **对我们的关键事实**：Portkey 证明「**路由策略写成配置 JSON 而非代码**」是正确形态，其 `strategy.mode + on_status_codes + targets` 值得照搬作为 api-relay 的 `standard/pro` 层路由配置面；但其**没有失败后钩子**，P3 归因在它身上落地成本最高。`[E1]`

### 1.5 Helicone（`Helicone/helicone`）

- **定位**：「Open source LLM observability platform」起家（YC W23），现同时是 AI Gateway（`ai-gateway.helicone.ai`，100+ provider 的统一 OpenAI 兼容入口 + 可观测）。**可观测是它的立身之本**。`[E2][E3]`
- **部署形态**：**混合** —— SaaS 为主 + 完整 Docker/Helm 自部署。大型 monorepo：`web/`（Next.js 看板）、`worker/`（**Cloudflare Worker 网关**）、`valhalla/jawn`（TS/tsoa 后端）、`clickhouse/`、`supabase/`。`[E1]`
- **许可**：**Apache-2.0**（根 README 明示）。`[E2][E1]`
- **核心能力**：路由「**最便宜的 provider 优先，同价则负载均衡**」；**BYOK 优先 + 平台托管 key 兜底**；故障转移触发条件**公开成表**：429/401/400（上下文长度）/408/500+；路由语法 `model/openai`（锁 provider）、`model/azure,gpt-4o-mini`（手动回退链）、`!openai,gpt-4o-mini`（排除 provider）；可观测（session/user/custom properties、cost tracking、prompt management、caching、custom rate limits）。`[E3]`
- **错误归因现状**：**只到「状态码 → 是否换 provider」**，无语义化分类（`worker/src/routers/aiGatewayRouter.ts` 只管 `/models`，统一错误分类模块**未定位到 [未核实]**）。`[E1]`
- **商业模式**：SaaS 订阅 + 自部署（企业版）。**卖的是「可观测」**，网关是观测的入口。`[推断]`
- **对我们的关键事实**：Helicone 的**「故障转移触发条件公开成一张表」成本极低、说服力高**——api-relay 应照做，且更进一步：把**每一类失败后的建议**也公开成表（这正是 P3 的产品化形态）。其对外对比表把 OpenRouter markup 写作 5.5% **是竞品营销口径，非中立事实**，引用须标注来源。`[E1][E3]`

### 1.6 OpenRouter（商业聚合站）

- **定位**：商业模型聚合与路由平台，一个 key 访问数百模型，按 provider 路由，按 token 计费，带 credits 体系。**它定义了本行业事实上的「错误契约」标准**。`[E3]`
- **部署形态**：**纯托管 SaaS，闭源**（GitHub 无对应官方仓库）。`[E2]`
- **许可**：**闭源商业服务**。`[E2]`
- **核心能力（错误与路由口径 A 级 - 全场最强）**：
  - **provider routing 控制面**：`allow_fallbacks` / `require_parameters` / `data_collection` / `quantizations` / `sort(price|throughput|latency)` / `max_price` / `order` / `only` + `:nitro`（吞吐优先 + priority 层）/ `:floor`（价格优先 + flex 层）+ `service_tier`。**控制项之间的互斥关系文档写得很清楚**。`[E3]`
  - **类型化错误契约**（`/docs/api-reference/errors-and-debugging`）：`error.metadata.error_type` 词表（`context_length_exceeded`、`rate_limit_exceeded`、`provider_overloaded`、`provider_unavailable`、`content_policy_violation`、`refusal`、`unmapped` …）+ `provider_code` + `metadata.raw`（上游逐字载荷）+ `Retry-After` 头（官方明确 OpenAI/Anthropic/Vercel SDK 已自动遵守）。
  - **中途流式错误的规范化表达**（最有工程价值的一条）：SSE 事件 `{error:{code,message,metadata}, choices:[{delta:{content:''}, finish_reason:'error'}]}`，**HTTP 状态保持 200**（响应头早已发出），错误在 body 里，流在该事件后终止。非流式同理：客户端拿到 `200 OK` 但 body 只有 `error` 对象，官方要求「即使 200 也要检查 body 里的 error 字段」。
  - **静默重试**：失败发生在任何 token 到达客户端之前 → 自动换 provider 重试；因 200 已发出，即使全失败状态码仍是 200，最后一个错误在 body 里到达。
  - **脱敏策略**：500 类换通用文案、省略 `provider_code`/`openrouter_metadata`（防上游细节泄漏），非 500 才透出 `provider_code`。`[E3]`
- **商业模式**：**纯托管计费**（credits 体系，402 = 余额不足），**闭源**。`[E3]`
- **对我们的关键事实**：**「错误的类型化」是 OpenRouter 已定的行业标配；「错误的可执行化」（failure_reason → recoverable? → quick_action）它也没做**——这正是 api-relay 的差异区间。同时它给出了**必须接受的三条约束**：直接采用它的 `error_type` 词表与 HTTP 口径（不自创）、实现 `200 + body 内 error + finish_reason:"error"` 中途失败表达、500 类脱敏/非 500 透出 `provider_code` 的分级暴露。`[E1][E3]`

### 1.7 Cloudflare AI Gateway（托管网关代表）

- **定位**：Cloudflare 平台内的 AI 网关，一行代码接入，提供分析、缓存、限流、重试、模型回退、BYOK、DLP、护栏、动态路由。**把「AI 网关」做成边缘基础设施的一部分**。`[E3]`
- **部署形态**：**纯托管 SaaS（边缘网络），非自部署开源**。管理面是 Dashboard + REST API + Workers Bindings + MCP server。`[E3]`
- **许可**：闭源托管服务。`[E3]`
- **核心能力**：
  - **Dynamic Routing（Beta）**：可视化或 JSON 定义**版本化路由流**，节点类型 `Start` / `Conditional`（If-Else，可引用 `user_plan == "paid"` 这类 metadata）/ `Percentage`（灰度/AB）/ `Model` / `Rate Limit` / `Budget Limit` / `End`；支持版本、发布、**即时回滚**。
  - **一个矛盾信号**：OpenAI 兼容端点（`/compat/chat/completions`）在标准单模型聊天上**已标记 Deprecated**，但动态路由目前**只能用这个端点调用**，且动态路由**不支持 REST API**。`[E3]`
  - 其余：Caching、Rate limiting、Spend limits（Beta）、Unified Billing、BYOK（Beta）、Custom Providers（Beta）、Guardrails（Beta）、DLP（Beta）、OpenTelemetry、Logpush。`[E3]`
- **错误归因现状**：日志字段丰富（**含 `Status` 可按 error type/status 过滤**），但**没有面向调用方的语义化错误翻译，也没有「下一步建议」**。`[E3]`
- **商业模式**：**核心功能（看板分析、缓存、限流）全计划免费**；持久化日志按套餐限量（Workers Free：所有网关合计 10 万条；Paid：每网关 1000 万条）；DLP 全计划免费，护栏为 Beta。**用免费网关驱动 Cloudflare 主平台消费**。`[E3]`
- **对我们的关键事实**：`cf-aig-collect-log-payload` 这类**「只存元数据、不存正文」的显式开关**，直接回应 data 合规风险（与 api-relay 红线 4「不落正文」同向）；`Percentage`/`Conditional` 节点正是「按客户分层路由」的现成语义，可作为 api-relay 路由配置面的形态参考。`[E3]`

### 1.8 全景图一图速览

| 竞品 | 定位一句话 | 部署 | 许可 | 商业模式 | 对 api-relay 的最大威胁点 |
|---|---|---|---|---|---|
| OneAPI | 国内中转站事实标准（MIT） | 自托管开源 | MIT | 被套壳转售 | 生态惯性（数据模型/用户习惯） |
| NewAPI | 国产功能最全聚合中枢 | 自托管开源 | **AGPL-3.0+Sec7** | 开源+商业授权 | 功能广度（协议互转/多 key 池/看板） |
| LiteLLM | 开源最完备路由+异常地基 | 自托管开源（+Cloud） | MIT（enterprise 例外[未核实]） | 开源+企业版 | **P2/P3 钩子现成、SDK 生态** |
| Portkey | 配置驱动网关+护栏 | 自托管开源（+SaaS） | MIT | 开源引流+SaaS | 1600 provider、护栏生态 |
| Helicone | 可观测起家的网关 | 混合 | Apache-2.0 | SaaS+自部署 | **可观测标杆、BYOK 两段式** |
| OpenRouter | 定义错误契约的商业聚合站 | 纯 SaaS 闭源 | 闭源 | 托管计费(credits) | **错误契约标准、路由控制面** |
| Cloudflare | 边缘 AI 网关 | 纯 SaaS 闭源 | 闭源 | 免费网关驱动平台 | 免费、边缘规模、动态路由 |

### 1.9 本部分元信息

- **目标**：把 7 个竞品「是什么、怎么部署、怎么赚钱、对我们威胁在哪」压成一页可决策的画像。
- **输入**：`docs/research/01` §1.1–§1.8（逐竞品剖析，含源码行号）、各竞品官方文档与 GitHub 元数据（基准日 2026-09-11）。
- **产出物**：§1.1–§1.8 逐竞品画像 + §1.8 速览表。
- **关键决策**：① 以「部署形态 × 许可 × 商业模式」三轴而非单纯功能罗列来画像，因为「能不能闭源商用」直接决定竞品可否被模仿/对抗；② 每家末条统一落到「对 api-relay 的最大威胁点」，把画像直接转为竞争判断。
- **风险与待办**：
  - ① **NewAPI 的 AGPL-3.0 + Section 7** 是本报告唯一会改变「战略可行性」的法律事实，须在阶段5 交付物中醒目标注；若未来要引入任何 NewAPI 代码或 UI，必须重做合规评估。
  - ② 竞品许可与商业模式存在 6 周时滞（尤其 Portkey / Cloudflare 的 Beta 功能可能已转正或下线），定价口径尤须复核。
  - ③ OneAPI「主分支停滞」是推断，不作为「可放心 fork」的依据。

---

## §2 功能对比矩阵 + 逐项对标评分

- **目标**：用一张横轴=竞品、纵轴=维度的矩阵，把「谁强谁弱」说清楚；再用 1–5 分 + 权重算出加权总分，把「我方排第几、差在哪」量化。
- **输入**：`docs/research/01` 附录 A 能力矩阵与 B 节错误路径（源码级证据）、`project/README.md` 对 api-relay 的自我陈述。
- **产出物**：矩阵（§2.1）、评分表（§2.2–§2.4）、加权总分行榜（§2.5）、api-relay 逐维依据（§2.6）。
- **关键决策**：① 维度取任务清单的 15 项，权重按「平台可运营」目标倾斜（多租户/计费/可观测权重高）；② api-relay 按**仓库现状**打分；③ 竞品分以「开源版的公开能力」为准，不含其商业 SaaS 的加值（避免用对手的收费面打我们的免费面）。
- **风险与待办**：① 矩阵对深海功能有压缩，细节以 §1 正文为准；② 权重主观，§2.4 附「拖累分析」给出不依赖权重的另一种排序，供交叉验证。

### 2.1 功能对比矩阵

图例：**✅ 原生完整 · ⚠️ 部分/间接/需二开 · ❌ 无 · 🚧 开发中/留位**

| 维度 | api-relay | OneAPI | NewAPI | LiteLLM | Portkey | Helicone | OpenRouter | Cloudflare |
|---|---|---|---|---|---|---|---|---|
| **协议兼容**（OpenAI/Anthropic/Gemini） | ⚠️ OpenAI 完整；Anthropic/Gemini **仅留位** | ⚠️ 多厂商统一为 OpenAI | ✅ OpenAI⇄Claude⇄Gemini⇄Responses | ✅ 100+ provider + 原生格式 | ✅ 1600+ LLM | ✅ 100+ provider（+Anthropic proxy） | ✅ 数百模型（OpenAI 面） | ⚠️ `/compat` 部分 Deprecated |
| **多上游聚合与故障转移** | ✅ 优先级/成本/权重/延迟 + 熔断半开 + 阶梯兜底 | ✅ 多渠道均衡 + 失败重试 | ✅ 加权随机 + 失败重试 + 渠道禁用 | ✅✅ 三条独立回退链 | ✅ 默认任何非 2xx 触发 | ✅ 429/401/400/408/500+ | ✅ 静默换 provider | ✅ Fallback 节点 |
| **多 key 池** | ✅ 轮换/报废/冷却 | ❌ 一渠道一 key | ✅ key 级状态机 | ✅ 多 deployment/多 key | ⚠️ BYOK/配置内，无池轮换 | ✅ BYOK + 托管兜底 | ✅ 平台侧托管(不可见) | ⚠️ BYOK store(Beta) |
| **路由策略** | ⚠️ 4 类基础策略（成本依赖配置） | ⚠️ priority 分档+随机 | ⚠️ 加权随机+亲和 | ✅✅ 5 种策略 | ✅ 配置驱动(mode+status) | ⚠️ 最便宜优先+同价均衡 | ✅✅ 最全控制面 | ✅✅ Dynamic Routing 版本化 |
| **限流与配额** | ⚠️ 分层 rpm/并发/周期额度（**单实例**） | ✅ 额度/倍率/分组 | ✅ 用户级模型限流 | ✅✅ 预算/RPM/TPM/按多主体 | ⚠️ 网关侧不做 | ✅ custom rate limits | ✅ credits | ✅ Rate/Spend limits |
| **多租户/团队** | ❌ tenantId 字段仅创建可填 | ✅ 用户/令牌/分组 | ✅ 用户分组+权限 | ✅✅ 虚 key + team + SSO | ⚠️ 靠外部 header | ✅ 组织/用户体系 | ✅ key/workspaces | ⚠️ 账户级 gateway |
| **密钥管理** | ✅ 明文一次性/指纹/whoami/被拒台账 | ✅ 令牌管理+兑换码 | ✅ 多 key+令牌 | ✅ 虚 key+预算 | ⚠️ 配置内 key | ✅ BYOK | ⚠️ 平台侧 | ⚠️ BYOK(Beta) |
| **计费与账务** | ⚠️ token 额度 + 预算¥(402)；**无账单/毛利** | ✅ 额度/倍率/明细 | ✅ 倍率/按量/缓存计费 | ✅✅ 预算+成本追踪 | ❌ 网关侧不做 | ✅ cost+credits | ✅ credits(402) | ⚠️ Unified billing(Beta) |
| **可观测/日志/追踪** | ✅ P5 请求级轨迹 + 降损量化 + 事件审计（**单机 SQLite，无 OTel**） | ⚠️ Log 表，无 error 字段 | ✅ Error 专表 + UpstreamRequestId | ✅✅ OTel+callback+31 异常 | ⚠️ /log/stream | ✅✅ 行业标杆 | ⚠️ 基础用量/成本 | ✅✅ 丰富日志+OTel+Logpush |
| **错误归因/降损** | ✅✅ **可执行化**(failure_reason+quick_action+recoverable) | ❌ 语义丢失 | ⚠️ 内部强类型/对外有损+脱敏 | ⚠️ 映射异常树+限流归属，**无下一步** | ❌ 无统一归因 | ⚠️ 只到状态码 | ✅✅ 最强**类型化**契约，**无下一步** | ⚠️ 有 Status 过滤，无翻译 |
| **缓存/去重** | ⚠️ **刻意不做响应缓存**；仅重复观测 + prompt cache 观测 | ❌ | ⚠️ 缓存命中计费统计 | ✅ 缓存(Redis 等) | ✅ cache 中间件 | ✅ caching | ⚠️ 平台级语义 | ✅ Caching |
| **SDK/生态** | ⚠️ 单一 `auto-retry.ts`（零依赖） | ⚠️ 管理 API | ⚠️ 兼容 OneAPI 生态 | ✅✅ 多语言 SDK + 大生态 | ✅ 多语言 SDK | ✅ 多语言 SDK | ✅ 多语言 SDK | ⚠️ Workers 生态 |
| **文档站** | ❌ 无对外文档站（仅 README/docs/信任页） | ❌ README | ✅ newapi.ai/docs | ✅ docs.litellm.ai | ✅ docs.portkey.ai | ✅ docs.helicone.ai | ✅ 完整文档 | ✅ 完整文档 |
| **企业功能**（SSO/审计/合规） | ⚠️ 事件审计 + HMAC 自证 + 合规红线；**无 SSO/无 RBAC** | ⚠️ 多登录+Turnstile | ⚠️ 权限+多语言 | ✅ SSO+budget+guardrails | ✅ 护栏生态 | ✅ 企业版+安全 | ⚠️ workspaces | ✅ DLP/Guardrails(Beta) |
| **自托管 vs SaaS** | ⚠️ 仅自托管（SaaS 为目标） | 仅自托管 | 仅自托管 | 自托管(+Cloud) | 混合 | **混合** | 纯 SaaS | 纯 SaaS |

### 2.2 评分口径（1–5 分）

| 分 | 含义 |
|---|---|
| 5 | 行业标杆级，开箱即用且工程成熟 |
| 4 | 完整可用，缺个别高级能力 |
| 3 | 基本可用但需二开/受限 |
| 2 | 雏形或间接具备，难直接商用 |
| 1 | 基本缺失 |
| 0 | 完全无（本表最低记 1） |

### 2.3 原始评分表（15 维，单位：分）

| 维度 | 权重 | api-relay | OneAPI | NewAPI | LiteLLM | Portkey | Helicone | OpenRouter | Cloudflare |
|---|---|---|---|---|---|---|---|---|---|
| 协议兼容 | 8 | 3 | 3 | 5 | 5 | 5 | 4 | 4 | 3 |
| 多上游聚合与故障转移 | 10 | 4 | 4 | 4 | 5 | 4 | 4 | 5 | 4 |
| 多 key 池 | 5 | 4 | 1 | 5 | 5 | 2 | 4 | 4 | 3 |
| 路由策略 | 7 | 3 | 2 | 3 | 5 | 4 | 4 | 5 | 5 |
| 限流与配额 | 5 | 3 | 4 | 4 | 5 | 2 | 4 | 4 | 4 |
| 多租户/团队 | 8 | 2 | 4 | 4 | 5 | 2 | 5 | 4 | 3 |
| 密钥管理 | 5 | 4 | 4 | 4 | 4 | 2 | 4 | 3 | 3 |
| 计费与账务 | 10 | 3 | 4 | 4 | 5 | 2 | 4 | 4 | 3 |
| 可观测/日志/追踪 | 8 | 4 | 2 | 4 | 5 | 3 | 5 | 3 | 5 |
| 错误归因/降损 | 11 | **5** | 1 | 3 | 4 | 1 | 2 | 5 | 2 |
| 缓存/去重 | 3 | 2 | 1 | 2 | 4 | 3 | 4 | 3 | 4 |
| SDK/生态 | 5 | 2 | 2 | 2 | 5 | 5 | 5 | 5 | 3 |
| 文档站 | 4 | 2 | 2 | 4 | 5 | 5 | 5 | 5 | 5 |
| 企业功能 | 7 | 3 | 2 | 3 | 4 | 4 | 4 | 3 | 4 |
| 自托管 vs SaaS | 4 | 2 | 2 | 2 | 3 | 5 | 4 | 3 | 3 |
| **权重合计** | **100** | | | | | | | | |

> 权重说明：**降损/错误归因（11）** 与 **多上游聚合（10）**、**计费账务（10）** 为最高档；**多租户（8）**、**协议兼容（8）**、**可观测（8）** 次之；纯工程炫技维度（缓存/去重 3）权重克制。这是「以可对外运营平台为目标」的取舍。

### 2.4 逐项评分——api-relay 得分与依据

| 维度 | 分 | 依据（均以 `project/README.md` 事实为准） |
|---|---|---|
| 协议兼容 | 3 | OpenAI 端点完整（chat/completions 含 SSE、embeddings、completions、models、responses）；但 **Anthropic/Gemini 原生仅留实现位**，`/v1/messages` 仅 agnes 系可用，mimo/step 系走该端点 404（§6.1、§11 已知边界）。 |
| 多上游聚合与故障转移 | 4 | 优先级/成本/权重/延迟路由 + 可恢复错误自动故障转移 + 熔断半开 + 三段式恢复（同请求内降权 / 阈值熔断 / 冷却半开），同模型跨供应商兜底（§3、§9.1）。**扣分点：未做分布式（多实例熔断/额度每实例独立）**（§11）。 |
| 多 key 池 | 4 | 同一上游挂多 key，轮换分摊限流，被拒 key 自动报废或短冷却（§6.1）。缺 key 级权重/健康分的高级调度（research-01 E.2 列为推迟项）。 |
| 路由策略 | 3 | 有 priority/cost/weight/latency 四类，但**成本路由依赖 `providers[].cost` 配置，未配置时退化为优先级**（§11）；无可视化/版本化路由流。 |
| 限流与配额 | 3 | 分层 rpm/并发/周期额度齐备（free 20rpm/4 并发、pro 1200rpm/128 并发，§9）；**但单实例，未做分布式限流/额度一致性**（§11）。 |
| 多租户/团队 | 2 | `tenantId` 字段存在但**仅创建时可填**（01-discovery §3.1 证据），面板以单 `X-Admin-Token` 鉴权、展示全量；**无按 tenantId 过滤的客户面、无团队/角色体系**。这是本轮平台化（N10）最大缺口。 |
| 密钥管理 | 4 | 明文只显示一次、服务端仅存 sha256、指纹前 8 位、whoami 自助自检、被拒 key 指纹台账（§8）。**扣分：无 SSO 签发的 key 治理、无多环境同步**。 |
| 计费与账务 | 3 | token 额度 + 预算¥（`quotaCny`）双口径、超预算返 **402**、持久化（§8、§9）；**但无账单形态/期间汇总、无毛利看板、无发票**（01-discovery N4/N5、Q8）。 |
| 可观测/日志/追踪 | 4 | P5 请求级轨迹（auth→…→meter 时间线）、P8 降损量化基线、事件流审计、指标页计数器+分布（§7、§8）。**扣分：单机 SQLite、无 OTel/外部日志导出**（对比 Cloudflare Logpush/LiteLLM OTel）。 |
| **错误归因/降损** | **5** | **唯一给满分**：15 类 `failure_reason` × 11 `quick_action` + `recoverable`，覆盖 6 种上游错误体形态，区分「429 限流 vs 余额不足」、覆盖 `finish_reason=content_filter` 的 200 场景，分层投递（free off / standard header / pro full）（§7.2、§9）。**业界无第二家做「可执行化」**（research-01 B.4）。 |
| 缓存/去重 | 2 | **刻意不做** P6 响应缓存（命中即零 token 零收入 + 非确定性信任灾难），P7 降级为重复观测；仅有 prompt cache 命中 token 观测（§6.2、§7.3）。作为「降本」手段确实薄弱，作为「信任」选择是自洽的。 |
| SDK/生态 | 2 | 仅 `src/client/auto-retry.ts` 一个零依赖客户端 SDK（§7.5），**无多语言 SDK、无框架集成、无 provider 生态**。 |
| 文档站 | 2 | 有 README、docs/、信任页，**但无对外文档站**（01-discovery Q5 默认「暂不独立域名」）。 |
| 企业功能 | 3 | 事件流可审计、HMAC 自证、四条合规红线有测试落点（§8）；**无 SSO、无 RBAC（单一令牌）、无正式合规认证**。 |
| 自托管 vs SaaS | 2 | 目前**仅自托管**，无托管 SaaS 形态（升级目标即补齐此形态）。 |

### 2.5 加权总分排行（满分 500）

| 排名 | 竞品 | 加权总分 | 折算(÷5) |
|---|---|---|---|
| 1 | **LiteLLM** | **466** | 93.2 |
| 2 | **OpenRouter** | **410** | 82.0 |
| 3 | **Helicone** | **403** | 80.6 |
| 4 | **NewAPI** | **364** | 72.8 |
| 5 | **Cloudflare AI Gateway** | **352** | 70.4 |
| 6 | **api-relay** | **326** | **65.2** |
| 7 | **Portkey Gateway** | **311** | 62.2 |
| 8 | **OneAPI** | **265** | 53.0 |

> **读法（重要）**：api-relay 排第 6，属「开源阵营中游偏下」。但要看到分差的**结构性来源**：它在**错误归因/降损维度是全场唯一 5 分**（与 OpenRouter 并列最强，且比 OpenRouter 多出「下一步建议」），拉低名次的全部是**「平台化外壳」维度**（多租户 2、SDK 2、文档站 2、计费 3、协议兼容 3）。这与 01-discovery 的诊断完全一致：**技术能力已具备，缺的是面向客户与销售的产品化外壳**。

### 2.6 「拖累分析」——不依赖权重的最弱维度

为避免「权重主观」被诟病，用 **机会损失 = 权重 ×（5 − 得分）** 做交叉验证，看 api-relay 的分数主要丢在哪：

| 维度 | 权重 | 得分 | 机会损失 | 说明 |
|---|---|---|---|---|
| 多租户/团队 | 8 | 2 | **24** | 最大拖累。平台化（G1/G2/N10）无法绕开 |
| 计费与账务 | 10 | 3 | **20** | 「能卖的网关」核心；缺账单/毛利 |
| 协议兼容 | 8 | 2→3 | **16** | Anthropic/Gemini 原生缺口限制客户面 |
| SDK/生态 | 5 | 2 | **15** | 自助接入与生态网络效应 |
| 路由策略 | 7 | 3 | 14 | 缺版本化/可运营形态 |
| 企业功能 | 7 | 3 | 14 | 无 SSO/RBAC，B 端门槛 |
| 文档站 | 4 | 2 | 12 | 对外可信度 |
| 自托管 vs SaaS | 4 | 2 | 12 | 缺托管售卖形态 |
| 多上游聚合 | 10 | 4 | 10 | 缺分布式 |
| 限流与配额 | 5 | 3 | 10 | 缺分布式 |
| 缓存/去重 | 3 | 2 | 9 | 刻意取舍，可接受 |
| 可观测 | 8 | 4 | 8 | 缺 OTel/导出 |
| 密钥管理 | 5 | 4 | 5 | — |
| 多 key 池 | 5 | 4 | 5 | — |
| 错误归因/降损 | 11 | 5 | **0** | 唯一零损失，即差异化护城河 |

**结论**：即使换一套权重，api-relay 的短板排序也稳定落在 **多租户 → 计费账务 → 协议兼容/SDK**，而**错误归因/降损**始终是唯一满分项。这为 §4 的「必须补齐 vs 可深耕」提供了客观依据。

### 2.7 本部分元信息

- **目标**：把「谁强谁弱、我方第几、差在哪、强在哪」量化成可复核的矩阵与分数。
- **输入**：`docs/research/01` 附录 A/B、`project/README.md`、`design-proto/01-discovery.md`（N1–N10 缺口）。
- **产出物**：§2.1 矩阵、§2.3 原始分表、§2.5 排行、§2.6 拖累分析。
- **关键决策**：① 用「原始分表 + 拖累分析」双口径，避免结论被单一权重绑架；② api-relay 按现状而非路线图打分，宁可自评偏低，换取结论可信；③ 竞品只取其**开源/公开能力**，不与对手的付费 SaaS 加值直接对撞。
- **风险与待办**：
  - ① 我方评分与竞品评分**观测条件不同**（源码 vs 文档），存在系统性偏差，已按「宁可自评低」原则处理；若有条件，应对 NewAPI/LiteLLM 做一次**同条件实测复核**。
  - ② 权重方案应先在阶段5 与主理人/客户对齐；若客户更看重「开源赛道对抗」，可上调错误归因与协议兼容权重，api-relay 名次会上升。
  - ③ 「加权总分」是决策辅助，不是结论本身；**分差最大的三项（多租户 24 / 计费 20 / 协议 16）才是行动清单**。

---

## §3 SWOT 分析（api-relay 视角）

- **目标**：把 §1–§2 的事实收敛为「我方内生的优/劣」与「外部机会/威胁」四象限，作为差异化策略的输入。
- **输入**：`project/README.md` §6/§7/§9/§11、`docs/research/01` B 节（错误路径空白区）、`design-proto/01-discovery.md` §2/§5、§2 评分表。
- **产出物**：SWOT 四象限 + 交叉策略（SO/WO/ST/WT）。
- **关键决策**：SWOT 只写**有事实支撑**的条目；每条尽量落到 §1/§2 的证据锚点，避免变成口号。
- **风险与待办**：① SWOT 随竞品动态变化，需在每轮平台化评审时刷新；② 部分威胁（如 NewAPI 生态惯性）为推断，已标注。

### 3.1 优势（Strengths）

| # | 优势 | 证据锚点 |
|---|---|---|
| S1 | **错误可执行化是全场唯一**：`failure_reason` + `recoverable` + `quick_action`（下一步该做什么），覆盖面到「429 限流 vs 402 余额不足」的区分与 `finish_reason=content_filter` 的 200 场景 | README §7.2；research-01 B.4「仍然是空白的部分」 |
| S2 | **降损层是内建的，不是后插的**：零改写成功响应（逐字节透传）、治理层开销 < 千分之一、fail-open 且如实记账 | README §7.1/§7.3 |
| S3 | **零运行时依赖 + Node≥22.5**：单进程可跑 mock+网关+看板，生产免 `npm install`，内网可用 | README §1/§5 |
| S4 | **可验证透明性**：`X-Relay-Verify-Nonce` → HMAC 自证字节未篡改；四条红线各有测试落点 | README §6.1/§8 |
| S5 | **分层降损开关**：free 纯管道 / standard 归因进 header / pro 完整卡片，且 `X-Relay-Mode` 回显 | README §7.2/§9 |
| S6 | **许可洁净**：自有代码，无 AGPL 传染，闭源商用路径自由 | README §6.2「不 fork OneAPI/NewAPI」 |
| S7 | **密钥治理细腻**：明文一次性/仅存 sha256/指纹前 8 位/whoami 自助自检/被拒台账 | README §8 |
| S8 | **同模型跨供应商兜底三段式**：同请求内降权→阈值熔断→冷却半开，客户仍拿 200 | README §9.1 |

### 3.2 劣势（Weaknesses）

| # | 劣势 | 证据锚点 | 对应拖累分 |
|---|---|---|---|
| W1 | **多租户/团队缺位**：tenantId 仅创建可填、单令牌鉴权、无客户面过滤、无 RBAC | 01-discovery §3.1；README §8 | 机会损失 24（最大） |
| W2 | **计费与账务不完整**：无账单形态/期间汇总/毛利看板/发票 | 01-discovery N4/N5、Q8 | 20 |
| W3 | **多协议原生缺口**：Anthropic/Gemini 仅留位；`/v1/messages` 仅 agnes 系 | README §6.1/§11 | 16 |
| W4 | **SDK/生态单薄**：仅一个 `auto-retry.ts`，无多语言/框架集成 | README §7.5 | 15 |
| W5 | **路由不可运营**：无可视化/版本化路由流，成本路由依赖配置 | README §11 | 14 |
| W6 | **企业门槛**：无 SSO、无独立审计角色、无正式合规认证 | 01-discovery §3.1/§5.4（N8） | 14 |
| W7 | **无对外文档站**：文档偏工程内部 | 01-discovery Q5 | 12 |
| W8 | **无托管 SaaS 形态**：仅自托管 | 01-discovery §2.2 | 12 |
| W9 | **单实例边界**：无分布式限流/额度/熔断 | README §11 | 10 |
| W10 | **无响应缓存/去重**（刻意取舍，但竞争对手拿它降本） | README §6.2 | 9 |

### 3.3 机会（Opportunities）

| # | 机会 | 依据 |
|---|---|---|
| O1 | **「错误的可执行化」仍是空白**：OpenRouter 只做类型化，LiteLLM 只做机器决策，国内套壳站连类型化都没有 | research-01 B.4 |
| O2 | **Agent 框架的无效重试是共同痛点**：CloseAI 要用「400 扣数倍配额」惩罚无效重试，却无人告诉用户下一步 | research-01 §1.8 |
| O3 | **客户自助是最大产品化缺口**：所有查询靠运营转发；whoami 在管理面板内不可达 | 01-discovery 场景 1/5 |
| O4 | **分层降损可产品化为「治理即服务」**：free/standard/pro 与套餐闸天然咬合 | README §9 |
| O5 | **NewAPI 的 AGPL 把大量转售商挡在闭源路径外**：他们需要「无传染」的替代品 | research-01 §1.2/§C.2 |
| O6 | **B 端需要「合规自证」**：HMAC 自证 + 不落正文 + 事件审计是现成素材，竞品少有同款组合 | README §8、Cloudflare `cf-aig-collect-log-payload` 佐证需求 |
| O7 | **「同模型兜底」的语义一致性**：跨供应商切同一模型名、`x-relay-model-served` 不变，是 Agent 场景的刚需 | README §9.1 |

### 3.4 威胁（Threats）

| # | 威胁 | 依据 | 严重度 |
|---|---|---|---|
| T1 | **LiteLLM 的钩子现成 + SDK 生态碾压**：P2/P3 可零 fork，且 100+ provider、31 类异常、5 种路由 | research-01 §1.3/§C.3 | 高 |
| T2 | **OpenRouter 已定义错误契约标准**：我们自创 `error_type` 会让用户改代码 | research-01 B.4/§1.6 | 高 |
| T3 | **NewAPI 生态惯性 + 功能广度**：协议互转/多 key/看板齐备，且 2026-09-09 仍在活跃迭代 | research-01 §1.2 | 高 |
| T4 | **Cloudflare/Helicone 免费或低价网关**：Cloudflare 核心功能全计划免费，靠平台变现 | research-01 §1.7 | 中高 |
| T5 | **可观测维度被 Helicone/Cloudflare 占位**：我们做全量可观测=换赛道打 6k★ 对手 | research-01 §E.1 | 中 |
| T6 | **AGPL 传染误伤**：若未来误引入 NewAPI 代码/UI，自有品牌闭源路径被摧毁 | research-01 §1.2 | 中（法律） |
| T7 | **闭源巨头加码**：OpenRouter/Cloudflare 的托管体验是无运维门槛的护城河 | research-01 §1.6/§1.7 | 中 |

### 3.5 SWOT 交叉策略

| 类型 | 策略 |
|---|---|
| **SO**（优势×机会） | 把 S1/S2（可执行化 + 内建降损）对准 O1/O2：**不做第二个可观测平台，做「错误→下一步」的权威口径**，并以 O3 客户自助面把归因交付到客户手上。 |
| **WO**（劣势×机会） | 用 O3/O4 补 W1/W2：**多租户 + 账单是与降损同等优先的平台化底线**，不能只做归因不做「能卖」。 |
| **ST**（优势×威胁） | 用 S6（许可洁净）对抗 T6：明确「不 fork、不引入 AGPL」；用 S4（可验证）对抗 T1/T2 的生态碾压——**在「可证明的透明」上差异化**，而非拼覆盖数。 |
| **WT**（劣势×威胁） | 不正面硬拼 LiteLLM/OpenRouter 的覆盖面与生态（W4/T1/T2）；用**窄点（降损）+ 洁净许可**定义战场，避免在对手主场作战。 |

### 3.6 本部分元信息

- **目标**：产出可支撑差异化决策的四象限与交叉策略。
- **输入**：§1 竞品画像、§2 评分/拖累分析、`README.md` §6/§7/§9/§11、`docs/research/01` B/§1。
- **产出物**：SWOT 四表 + §3.5 交叉策略。
- **关键决策**：① 每条优劣势都挂证据锚点，避免「自我感觉良好」；② SWOT 强度与 §2 拖累分挂钩，使「劣势」有量化排序（W1>W2>W3…）。
- **风险与待办**：① T3/T7 含推断成分，需在下一轮竞品复核时用一手证据刷新；② 交叉策略中的「不做可观测平台」是边界决策，需与主理人确认不与 G4（合规清晰）冲突（G4 只要求可自证，不要求全量可观测）。

---

## §4 差异化机会（结合「降损层」这一窄点）

- **目标**：在 SWOT 基础上，明确「可深耕的窄点」与「必须补齐的底座」，并用一句话钉住本次升级的差异化定位。
- **输入**：§3 SWOT、`docs/research/01` B.4（P3 真实空白区间）、`README.md` §7/§9、`design-proto/01-discovery.md` §2/§5.4。
- **产出物**：定位声明 + 深耕清单 + 补齐清单 + 机会优先级。
- **关键决策**：**不自夸「我们会分类错误」（那是 2026 入场券），只主张「我们会把错误变成可执行的下一步」**——这是 research-01 修正后的结论。
- **风险与待办**：① 「降损省 40%」被研究 03 判定为高估，任何收益数字必须来自 P8 实测基线；② 深耕点的商业价值（「Agent 任务完成率提升」）是**唯一真正未验证的产品假设**，需 A/B 实测。

### 4.1 定位声明（一句话）

> **api-relay 卖的不是 token，是「错误对 Agent 可执行」。**
> 在「类型化错误已是标配」的 2026 年，我们把竞争点前移到**可执行化**：`failure_reason → recoverable? → quick_action`，跨上游统一口径，并覆盖 `200 + finish_reason:error` 与 `finish_reason=content_filter` 两条最易漏的失败路径。**成功响应逐字节透传，一点不碰。**

### 4.2 可深耕（建立壁垒的窄点）

| # | 深耕点 | 为什么是壁垒 | 行动 |
|---|---|---|---|
| D1 | **可执行归因的稳定契约** | 竞品做到「类型化」即止；「下一步动作」词表一旦被 Agent 框架采纳即形成事实标准锁定 | 对外公开 `failure_reason × quick_action` 目录（已有 `attribution/catalog`），并**采用 OpenRouter `error_type` 词表作为对外类型层**，内部叠 NewAPI 式分层码 |
| D2 | **跨上游统一口径** | 6 种错误体形态解析 + 「绝不说错根因」的不变量（有上游支持就不说 model_not_found）是别人不做的脏活 | 把一致性不变量写进对外契约，并各配一条测试 |
| D3 | **200-内的语义失败** | `finish_reason=content_filter` / mid-stream error 是最易漏类，OpenAI SDK 把它当语义事件而非 HTTP 错误 | 补齐 SSE `error` 帧注入（README §11 列为待办），与 OpenRouter 的 `200+error` 对齐 |
| D4 | **损耗量化即「可证明的价值」** | 归因投递率/自动恢复数/无效重试/预检拦截/治理层开销占比——把「省了什么」变成客户看得见的数字 | 把 P8 基线做成客户面只读指标（N2），按套餐分层展示 |
| D5 | **分层降损 = 治理即服务** | free 纯管道 / standard 归因 header / pro 完整卡片，与「卖套餐」天然咬合 | 把「降损等级」做成套餐目录的一等卖点（N1） |

### 4.3 必须补齐（否则窄点无处落地）

> 依据 §2.6 拖累分析：**缺口不在技术，在「能卖/能自助/能隔离」的外壳**。

| 优先级 | 补齐项 | 对应劣势 | 关联 01-discovery |
|---|---|---|---|
| P0 | **多租户隔离**（按 tenantId 过滤的客户面、RBAC） | W1 | N10 / §3.1 权限矩阵 |
| P0 | **用量账单**（期间汇总、币种 ¥、对账单导出） | W2 | N4 |
| P0 | **客户自助门户**（用量/额度/账单/whoami 自检） | W1/W7 | N2 / 场景 1、5 |
| P0 | **套餐目录**（分层×白名单×预算闸可视化） | W2 | N1 / 场景 1 |
| P1 | **成本与毛利看板** | W2 | N5 |
| P1 | **对外开发者文档站**（端点/错误码/归因目录/自验） | W7 | N7 |
| P1 | **Anthropic/Gemini 原生适配**（若有客户付费验证） | W3 | §5.4 边界 |
| P1 | **审计与合规页**（事件导出、留存声明、红线可验证） | W6 | N8 |
| P2 | **路由可版本化/可视化**（对齐 Cloudflare Dynamic Routing 形态） | W5 | E.2 推迟项 |
| P2 | **分布式限流/额度**（接口已隔离，换 Redis 实现） | W9 | §11 已知边界 |

### 4.4 机会优先级矩阵

| | 高价值 | 低价值 |
|---|---|---|
| **可快速做** | **D1 归因契约公开 / D4 P8 客户面 / P0 多租户+账单+自助门户** | 文档站美化、主题 |
| **需投入** | **D3 SSE error 帧 / P1 协议原生适配 / P2 分布式** | 全量可观测平台（**不做**） |

### 4.5 三条最关键的差异化机会（结论）

1. **把「可执行归因」做成跨上游的事实标准**（D1+D2）：对外开放 `failure_reason × quick_action` 契约、采纳 OpenRouter `error_type` 词表、把「绝不说错根因」的一致性不变量写进文档——**这是唯一一个竞品集体留白、且一旦被 Agent 生态采纳即形成锁定的点**。
2. **把「降损能力」与「可售卖分层」焊死**（D5+D4）：让 free=纯管道、standard=归因进 header、pro=完整卡片成为**套餐目录里的可见卖点**，并把 P8 损耗量化做成客户面只读指标，把「省了什么」变成客户能对账的数字。
3. **先补 P0 平台化底座（多租户 + 账单 + 自助门户）**：降损窄点再锋利，若没有「客户能自助拿到 key、查用量、看账单、做自检」的外壳，就永远停在工具级——这正是 §2 拖累分最大的三块（24/20/16）。

### 4.6 本部分元信息

- **目标**：在窄点（降损）上给出「深耕 vs 补齐」的明确分工与优先级。
- **输入**：§3 SWOT、research-01 B.4/E 节、README §7/§9、01-discovery §2/§5.4。
- **产出物**：定位声明、深耕清单 D1–D5、补齐清单 P0–P2、机会优先级矩阵、三条关键机会。
- **关键决策**：① **定位只用「可执行化」这一层**，主动放弃「我们会分类错误」这类已被做掉的卖点；② 补齐清单严格对齐 01-discovery 的 N1–N10，不新增范围外承诺。
- **风险与待办**：① D3（SSE error 帧）目前是 README §11 已知空洞，落地需改流式路径，须评估对「流式只做字节转发」红线的影响；② 深耕点的收益数字（省 40%）被判定高估，**任何对外数字必须来自 P8 实测**；③ D1 的「事实标准锁定」是推断，需通过 Dify/LangChain 集成实测验证采纳意愿。

---

## §5 Battle Card（对线 NewAPI / LiteLLM / OpenRouter 的攻防话术）

- **目标**：把前四节的分析转成销售/售前可直接照读的「面对某竞品时说什么、别说什么、怎么化解」。
- **输入**：§1 竞品画像、§2 评分、§3 SWOT、§4 差异化机会。
- **产出物**：3 张 Battle Card（NewAPI / LiteLLM / OpenRouter）+ 通用话术红线。
- **关键决策**：每张卡固定「我们优势 / 我们劣势 / 如何化解 / 一句话钩子 / 禁用话术」五段式；**禁用话术**单列，防止销售承诺我们做不到的事。
- **风险与待办**：① 话术中的数字必须是 P8 实测口径，不得使用「省 40%」这类高估数字；② 竞品事实有 6 周时滞，对线前应复核对手当前版本。

### 5.1 通用话术红线（三张卡共用）

| 红线 | 说明 |
|---|---|
| **不说「业内没人做错误归因」** | OpenRouter 已定义 `error_type` 标准；说错了会当场被识破。改说「**业内没人把错误做成可执行的下一步**」。 |
| **不说具体省钱百分比** | 「省 40%」被研究 03 判定为高估。只说「我们能**量化**省了什么」（归因投递率/自动恢复数/预检拦截数）。 |
| **不承诺 Agent 平台能力** | 我们不做工具编排/会话记忆；承诺即越界。 |
| **不承诺响应缓存/改写** | P1/P6 是刻意不做的红线，承诺会摧毁「我只是管道」的信任。 |
| **不攻击竞品许可**（除 NewAPI） | OneAPI/LiteLLM/Portkey 均为宽松许可，攻击不成立；**唯 NewAPI 的 AGPL-3.0+Sec7 是可用的差异化点**。 |

### 5.2 Battle Card A：面对 **NewAPI**

| 维度 | 内容 |
|---|---|
| **对手是谁** | 国产功能最全的聚合中枢（star 已约 5 万，2026-10 仍活跃迭代；AGPL-3.0 + Section 7）。 |
| **我们的优势** | ① **许可洁净**：自有代码，闭源商用无传染；NewAPI 的 AGPL 要求网络服务提供完整源码 + UI 保留署名与项目链接。② **P3 可执行化**：NewAPI 内部有 30+ `ErrorCode` 但**对外有损映射 + `MaskSensitiveInfo` 脱敏**，**零「下一步建议」**；我们给 `failure_reason + quick_action + recoverable`。③ 零运行时依赖、内网可用。 |
| **我们的劣势** | ① **功能广度落后**：NewAPI 有协议互转（OpenAI⇄Claude⇄Gemini⇄Responses）、多 key 池 key 级状态机、数据看板、多语言文档站；我们协议仅 OpenAI 完整。② 生态惯性：NewAPI 兼容 OneAPI 数据库，存量用户迁移成本低。③ 计费完整度（缓存命中计费）优于我们。 |
| **如何化解** | ① 许可差异对**想闭源做自有品牌**的客户是致命点，直接对号入座；对「本来就开源」的客户则改用「P3 可执行化」差异化。② 承认广度差距，但我们主张「**广度不是本次战场**」：客户真正痛的是 Agent 无效重试与对不上账，不是少两个协议。③ 用「不具备的功能不承诺」建立可信度。 |
| **一句话钩子** | 「NewAPI 让错误**看起来**统一，我们让错误**可执行**——客户拿到的不再是一句话，是下一步该干什么。而且我们的代码你可以闭源商用，NewAPI 不行。」 |
| **禁用话术** | 「NewAPI 有安全隐患」「NewAPI 停更了」（均不实：它 2026-10 仍在发布）。 |

### 5.3 Battle Card B：面对 **LiteLLM**

| 维度 | 内容 |
|---|---|
| **对手是谁** | 开源阵营的工程地基之王：Python SDK + Proxy，466/500 加权第一，P2/P3 有现成钩子（`async_post_call_failure_hook`），100+ provider、31 类异常、5 种路由。 |
| **我们的优势** | ① **「可执行」这一层它没做**：LiteLLM 的输出是「换 deployment / 走另一条 fallback 链」的**机器决策**，不是给 Agent/开发者看的自然语言 `quick_action`。② **零运行时依赖 + 单二进制**：部署比 Python Proxy 轻，无 Python 环境/依赖面。③ **许可无传染**（自有代码），且能给客户「可验证透明」（HMAC 自证）。 |
| **我们的劣势** | ① **生态碾压**：100+ provider、多语言 SDK、guardrails、budget 生态；我们只有一个 `auto-retry.ts`。② **路由/异常地基**：31 类异常 + `RateLimitErrorCategory`（vendor vs self）比我们的 15 类 reason 更底层更完备。③ 它可零 fork 挂 P2/P3，意味着**对手能用它的钩子把我们的卖点「免费搭车」**。 |
| **如何化解** | ① 明确「**用 LiteLLM 做地基 + 你自研可执行层**」是一条可行替代路径——但我们卖的是**已内建、已验证**的成品，不是让你自己写钩子。② 用「同模型跨供应商兜底时 `x-relay-model-served` 不变」这类**面向 Agent 的语义一致性**差异，打它「换 deployment」带来的语义漂移。③ 主打「**部署即用、内网可用、零依赖**」的场景（企业内网/信创/无 Python 运维能力的团队）。 |
| **一句话钩子** | 「LiteLLM 把错误**分好类**就交给你的框架了；我们把错误**变成你的框架能直接执行的下一步**，而且一个进程就能跑。」 |
| **禁用话术** | 「LiteLLM 功能少」「LiteLLM 性能差」（都不实；应承认其地基更强，只在「可执行化 + 部署轻量」上竞争）。 |

### 5.4 Battle Card C：面对 **OpenRouter**

| 维度 | 内容 |
|---|---|
| **对手是谁** | 定义行业错误契约标准的商业聚合站（闭源 SaaS，credits 计费，410/500 加权第二）。 |
| **我们的优势** | ① **同样是 5 分，但方向上互补**：OpenRouter 强在**类型化**（`error_type` 词表 + `provider_code` + `metadata.raw` + `Retry-After`），**依然没有「下一步建议」**（2026-10-12 文档已复核确认）。我们强在**可执行化**。② **自托管可控**：客户可把网关部署在自己的合规边界内；OpenRouter 是纯 SaaS，数据出域。③ **许可自由**：无平台绑定。 |
| **我们的劣势** | ① **路由控制面**：OpenRouter 的 `sort/order/only/allow_fallbacks/require_parameters/data_collection/quantizations/max_price` + `:nitro`/`:floor`/`service_tier` 是全场最全，我们只有基础 4 类。② **模型覆盖**：数百模型 vs 我们的内置模板。③ **中途流式错误**：OpenRouter 的 `200 + error + finish_reason:"error"` 已产品化，我们 README §11 承认流式 mid-stream 错误**尚未注入 SSE error 帧**。 |
| **如何化解** | ① **直接采纳它的 `error_type` 词表作为对外类型层**（不自创），在此之上叠我们的 `quick_action`——即「站在它的标准上多做一层」。② 承认模型覆盖差距：我们不做「模型市场」，做「客户指定上游 + 稳定兜底」，**把 OpenRouter 当上游的一种**（内置模板已有 `openrouter`）。③ 把「SSE error 帧」列为 P1 补齐项，与它的 `200+error` 对齐。 |
| **一句话钩子** | 「OpenRouter 告诉你**错在哪一类**，我们额外告诉你**下一步做什么**，而且你能把它部署在自己的边界里。」 |
| **禁用话术** | 「OpenRouter 不透明/不安全」（它有明确的脱敏与 metadata 策略）；不引用 Helicone 的「5.5% markup」作为 OpenRouter 口径（那是竞品营销数字，非中立事实）。 |

### 5.5 Battle Card 速查（一页版）

| 面对 | 一句话切割点 | 必须承认的劣势 | 禁止说的 |
|---|---|---|---|
| **NewAPI** | 许可洁净 + 可执行归因 | 协议/生态/计费广度落后 | 攻击其安全/停更 |
| **LiteLLM** | 可执行化 + 零依赖部署 | 生态/异常地基弱于它 | 说它功能少/性能差 |
| **OpenRouter** | 多一层「下一步」+ 可自托管 | 路由控制面/模型覆盖/流式错误 | 说它不透明、引用 5.5% markup |

### 5.6 本部分元信息

- **目标**：产出可直接用于售前对线的三张 Battle Card 与一页速查表。
- **输入**：§1–§4 全部结论、研究 03 的「省 40% 高估」修正、Study 01 对 OpenRouter/LiteLLM 错误能力的源码级结论。
- **产出物**：§5.1 通用红线、§5.2–§5.4 三张卡、§5.5 速查表。
- **关键决策**：① 固定五段式（优势/劣势/化解/钩子/禁用）保证可照读；② **主动写出我方劣势**，因为对线时对手一定会提，提前给销售「化解话术」比只讲优势更有效；③ 把「禁用话术」单列，防止越界承诺。
- **风险与待办**：① Battle Card 中的竞品事实有 6 周时滞，正式对线前须复核对手当前版本；② 「x-relay-model-served 不变」等卖点需有可复现 demo 支撑，否则会被质疑为 PPT。

---

## 附录 A · 时效校核（本报告在 research-01 基准日 2026-09-11 之上的增量核实）

> 本节是对 `docs/research/01` 的关键事实做**有限在线复核**的结果（检索时间 2026-10-24），用于降低 6 周时滞风险。仅复核了「会改变结论」的三条事实，未做全量重跑。

| # | 复核项 | 复核结果 | 对报告结论的影响 |
|---|---|---|---|
| A1 | **NewAPI 许可是否仍为 AGPL-3.0 + Section 7** | **确认仍成立**（GitHub `QuantumNous/new-api` LICENSE + README 原文：AGPLv3，Section 7 附加条款要求保留署名与 UI 可见项目链接；商业授权入口 `support@quantumnous.com`）。`[E1/E2]` | 结论**不变**：闭源商用路径仍被否决。 |
| A2 | **NewAPI 活跃度/规模** | **进一步确认高速迭代**：star 由 research-01 记录时约 4.78 万 → 复核时约 **4.99 万**；版本列表显示 2026-10-10 仍在发布。`[E2]` | 威胁 T3「生态惯性 + 高频迭代」**上调为确定事实**，Battle Card A「禁止说 NewAPI 停更」得到证据支持。 |
| A3 | **OpenRouter 错误契约是否新增「下一步建议」** | **确认仍未提供**：文档（`errors-and-debugging`，更新于 2026-10-12）仍是 `error.metadata.error_type` + `provider_code` + `metadata.raw` + `Retry-After` + 中途流式错误 + 500 脱敏；**无任何 `suggested_next`/`quick_action` 字段**。`[E3]` | 核心差异化机会 O1/D1 **得到强佐证**：api-relay 的「可执行化」仍是空白。 |
| A4（附加发现） | **OpenRouter 402 语义细化** | 402（`payment_required`）在 `limit_source=openrouter_in_flight_budget` 时**也可能带 `Retry-After`**，与「余额不足不重试」的 API-relay 口径存在语义交集，需在对外错误码表里说明差异。`[E3]` | 提示：api-relay 的「超预算返 402 且不可重试」在对外文档里应显式说明与 OpenRouter 的差异，避免客户误以为可退避重试。 |

**结论**：三条核心竞品事实经复核**均未推翻原结论**，且 A2/A3 反而**强化**了「NewAPI 迭代快（威胁）」与「可执行化仍是空白（机会）」两个关键判断。报告主体结论可信。

## 附录 B · 未核实事项（不得作为决策依据）

1. **LiteLLM `enterprise/` 目录的许可范围** —— research-01 抓取 `enterprise/LICENSE` 返回 404，适用范围 **[未核实]**（本报告未复核）。
2. **Google Vertex AI 是否存在第一方 AI Gateway** —— `cloud.google.com` 不可达，research-01 标记全 **[未核实]**。
3. **OneAPI 主分支是否真的停滞** —— `pushed_at` 与默认分支 HEAD 日期不一致，**[推断]**；且其 `star`/活跃度本轮**未复核**。
4. **Helicone 网关的失败转移实现细节** —— 未定位到统一错误分类模块，其「failover 触发条件表」来自官方文档，实现位置 **[未核实]**。
5. **Portkey / Cloudflare 的计费与配额能力边界** —— 多依文档（多数为 Beta 标注），**[未核实]** 实际可用性；本轮未复核其 Beta 是否转正。
6. **各竞品真实错误体抓包** —— 本报告所有错误结构来自**源码与文档**，未对任一线上服务发起失败请求实测。
7. **OpenRouter 的 5.5% markup** —— 来自 Helicone 营销对比页，**非 OpenRouter 官方口径**，本报告未采用。

## 附录 C · 主要来源与证据等级

- **[E1] 源码行号**（最强）：`project/docs/research/01` 对本节全部竞品做的浅克隆证据（OneAPI/NewAPI/LiteLLM/Portkey 的 file:line 引用），以及 `project/README.md` 对 api-relay 自身的事实陈述。
- **[E2] GitHub 元数据**：star/fork/license/pushed_at（research-01 抓取于 2026-09-11；附录 A 复核于 2026-10-24）。
- **[E3] 官方文档**：OpenRouter `errors-and-debugging`（2026-10-12）、Cloudflare AI Gateway 文档、Helicone/Portkey/LiteLLM 文档。
- **[推断]**：标注为推断的条目（OneAPI 停滞、生态惯性、商业模式推导）不做决策依据。

---

## 附录 D · 结论摘要（供主理人汇编）

- **文件绝对路径**：`deliverables/product-strategy/_parts/competitive-analysis.md`
- **api-relay 加权总分**：**326 / 500（折算 65.2 / 100）**，在 8 个对标对象中**排第 6**。排名：LiteLLM(466) > OpenRouter(410) > Helicone(403) > NewAPI(364) > Cloudflare(352) > **api-relay(326)** > Portkey(311) > OneAPI(265)。
- **最强 3 个维度**（按绝对分）：① **错误归因/降损 = 5**（全场唯一满分，且比 OpenRouter 多出「下一步建议」）；② **多上游聚合与故障转移 = 4**（熔断半开 + 同模型兜底三段式）；③ **多 key 池 = 4** 与 **可观测 = 4**（P5 请求级轨迹 + P8 量化 + 事件审计）。
- **最弱 3 个维度**（按加权拖累 = 权重 ×(5−得分)）：① **多租户/团队**（得分 2，拖累 24）；② **计费与账务**（得分 3，拖累 20）；③ **协议兼容**（得分 3，拖累 16）。（并列低分项另有：SDK/生态、文档站、缓存/去重、自托管 vs SaaS 均为 2 分。）
- **3 条最关键的差异化机会**：
  1. **把「可执行归因」做成跨上游的事实标准**（D1+D2）：采纳 OpenRouter `error_type` 词表作为对外类型层，在其上叠 `failure_reason × quick_action`，并把「绝不说错根因」的一致性不变量写进对外契约——**竞品集体留白，一旦被 Agent 生态采纳即形成锁定**（附录 A3 已证 OpenRouter 仍无此层）。
  2. **把「降损能力」与「可售卖分层」焊死**（D5+D4）：让 free=纯管道 / standard=归因进 header / pro=完整卡片成为套餐目录的可见卖点，并把 P8 损耗量化做成客户面只读指标，把「省了什么」变成客户能对账的数字。
  3. **先补 P0 平台化底座**（多租户 + 账单 + 自助门户 + 套餐目录）：这是拖累分最大的三块（24/20/16）所在；「能卖的网关」外壳缺失，窄点再锋利也停在工具级。
- **给主理人的衔接建议**：本文件是 `deliverables/product-strategy/` 的 `_parts` 之一，建议与其他 `_parts`（定位/定价/GTM/路线图）合并时，**统一采用本报告的 15 维权重口径**，以便后续复核可重算；Battle Card 可独立抽成售前文档。
- **必读的红线提示（法律级）**：**NewAPI 为 AGPL-3.0 + Section 7，禁止引入其代码或 UI 到自有品牌产品**；本报告经附录 A1 复核确认该许可仍成立。