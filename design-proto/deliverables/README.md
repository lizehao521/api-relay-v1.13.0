# api-relay · 设计原型交付说明（deliverables · v1.2）

> 单文件、hash 切页、零 CDN、双击即可离线打开的静态高保真原型。
> 设计系统：**Linear 基因 + 沿用 GitHub 暗色色值**（`design-proto/02-design-system.md` v1.0）
> 规格依据：`design-proto/03-prototype-spec.md`（页面结构 / 交互 / 状态 / 权限 / 计费 / 密钥路由 / 监控日志 / 验收）
> 版本：**v1.2**（原型 172,476 B / 2074 行；新增 `#/tenants`、`#/instances` 两页 + 8 项平台化改进）

---

## 1. 如何打开（开箱即用）

| 交付物 | 打开方式 |
|---|---|
| `api-relay-platform-prototype.html` | **直接双击**，用任意现代浏览器（Chrome / Edge / Firefox）打开。无需服务器/联网/构建，**断网可用**。 |
| `api-relay-platform-prototype.pdf` | 双击用 PDF 阅读器打开 / 打印（浏览器默认视图打印稿）。 |
| `api-relay-platform-prototype.pptx` | PowerPoint / WPS / 兼容软件打开（16:9，9 页交付摘要）。 |
| `api-relay-platform-prototype.zip` | 解压后双击其中的 HTML 即可（含上列 3 个文件 + 本 README）。 |

- 顶部有「角色预览」下拉，可切换 `owner / sre / finance / auditor / client` 五种视角。
- 所有 CSS/JS/图标**内联**，图标为文本符号，字体为系统栈 —— **零外链**。

---

## 2. 设计系统标注（令牌来源 100% 可回溯）

| 项 | 取值来源 |
|---|---|
| 色彩 | 02 §2.0/§2.1（暗色默认 + 亮色映射）；语义色 `ok/warn/danger/info/neutral`、上游五态、分层三色 |
| 主题 | `html[data-theme="dark|light"]`（顶栏 `◐` 切换，持久化到 localStorage） |
| 密度 | `html[data-density="compact|cozy"]`（运营面默认 compact，客户面默认 cozy；顶栏 `▤` 可手动切） |
| 排版 | 02 §3（系统字体栈 + 9 级字号 + `tabular-nums` 契约） |
| 间距/圆角/阴影 | 02 §4/§7（`--sp-*`/`--r-*`/`--sh-*`） |
| 组件 | 02 §5（按钮/输入/表格/抽屉/卡片/徽标/进度/Toast/空态/骨架屏） |
| 壳层 | 02 §6（TopBar + SideNav + main 三区 Grid；≤960px 侧栏抽屉） |
| 动效 | 02 §8（120–220ms；`prefers-reduced-motion` 全局关停） |
| 无障碍 | 02 §9（`:focus-visible` 焦点环、抽屉 Esc + 焦点归还、色+符号双编码、`aria-live`） |

> 原型内所有色值/尺寸均引用 02 文档的 CSS 自定义属性（`--c-*` / `--fs-*` / `--sp-*` …），未写死任何临场色值。原型内以 HTML 注释 `<!-- §x.y -->` / `<!-- 改进项N -->` 标注对应章节与改进来源。

---

## 3. 页面清单（23 页 = 运营面 17 + 客户面 6）

### 运营面（`data-density="compact"`，角色 owner / sre / finance / auditor）

| hash | 页面 | 模板 id | 规格章节 |
|---|---|---|---|
| `#/ov` | 总览（改造） | `tpl-ov` | §3.B.1 |
| `#/met` | 指标（保留，+口径拆分） | `tpl-met` | §1.5 · 改进项8 |
| `#/ledger` | 请求账本（保留，+流式 SSE error 帧） | `tpl-ledger` | §8.4 · 改进项6 |
| `#/diag` | 排障（保留，+归因契约对外公开） | `tpl-diag` | §1.5 · 改进项1 |
| `#/users` | 客户与租户（改造） | `tpl-users` | §3.B.2 |
| `#/tenants` | **租户管理（v1.2 新增）** | `tpl-tenants` | §3.B.9 · 改进项3 |
| `#/approvals` | 密钥审批队列（新增） | `tpl-approvals` | §3.B.3 |
| `#/plans` | 套餐目录（运营视角，+套餐能力对比） | `tpl-plans` | §3.A.4 · 改进项2 |
| `#/route` | 路由策略配置（新增，+成本路由自动化） | `tpl-route` | §3.B.5 · 改进项4 |
| `#/ch` | 上游（保留） | `tpl-ch` | §1.5（保留·令牌迁移） |
| `#/billing` | 计费与对账（新增，+客户级 WTCS） | `tpl-billing` | §3.B.4 · 改进项2 |
| `#/observ` | 可观测看板（新增，+监控对接） | `tpl-observ` | §3.B.6 · 改进项7 |
| `#/instances` | **实例与分布式（v1.2 新增）** | `tpl-instances` | §3.B.10 · 改进项5 |
| `#/ops` | 运维（改造） | `tpl-ops` | §1.5（改造）+ §3.B.8 |
| `#/trust` | 信任（保留） | `tpl-trust` | §1.5（保留·令牌迁移） |
| `#/audit` | 审计日志（新增） | `tpl-audit` | §3.B.7 |
| `#/agent` | 知识库 / Agent（内部位） | `tpl-agent` | §1.2 / §1.5（不对外） |

### 客户面（`data-density="cozy"`，角色 client）

| hash | 页面 | 模板 id | 规格章节 |
|---|---|---|---|
| `#/portal` | 开发者控制台概览（新增） | `tpl-portal` | §3.A.1 |
| `#/keys` | 我的密钥（新增，自助申请+自检） | `tpl-keys` | §3.A.2 |
| `#/usage` | 用量与账单（新增，+WTCS 三段式） | `tpl-usage` | §3.A.3 · 改进项2 |
| `#/plans` | 套餐目录 / 定价（客户视角） | `tpl-plans` | §3.A.4 |
| `#/docs` | API 文档 / 快速开始（新增） | `tpl-docs` | §3.A.5 |
| `#/status` | 状态页 / 可用性（新增） | `tpl-status` | §3.A.6 |

> 客户面**不出现** Agent / 知识库三页（阶段1 §7 Q11：不对外卖点）。
> `#/plans` 为同名路由双视角（运营/客户各一次，故 23 = 17 + 6）；唯一路由数为 22。

---

## 4. v1.2 新增页面与交互说明

### 4.1 新增页面

- **`#/tenants` 租户管理（改进项3）**：租户列表（`tenantId/名称/隔离级别/key 数/套餐/预算占用/状态`）+ **五角色 × 能力 RBAC 矩阵**（管理员/运维/财务/审计/客户开发者，`● 允许 · ◐ 受限 · ○ 不允许`）。顶部 `note.warn` 声明「单实例逻辑隔离」——客户面 API 只能在自身 `tenantId` 内读写，越权返回 **403 且不泄漏他租户存在性**；不做物理隔离（属产品边界）。含「新建租户」（抽屉）与「导出 CSV」。
- **`#/instances` 实例与分布式（改进项5）**：实例列表（`instanceId/角色/版本/在途/rpm 占用/心跳/状态`，含 leader/worker 与「已排空（滚动升级）」）+ **一致性状态**表（限流/配额/熔断/key 池：单实例语义 vs 多实例外置后）+ Redis 健康卡 + **状态外置指示**（`state.backend=redis`）+ **回滚方案**（`memory→redis` 分阶段启用、Redis 不可用自动降级 fail-open）。含「刷新实例」「状态外置详情」（抽屉）。

### 4.2 8 项平台化改进（映射竞品/路线图，均已纳入原型）

1. **归因契约对外公开（改进项1）**：`#/diag` 新增 15 类 `failure_reason` × 11 种 `quick_action` × OpenRouter `error_type` 词表，含可一键复制的契约 JSON `api-relay.attribution.v1`；坚持「只作附加字段，绝不改写上游原文」。
2. **WTCS 三段式对账（改进项2）**：`#/usage` 新增「可对账节省额」四成分表（**计数 × 单价 = 金额** 可复算）+ 单价表（`cost_source=config/reference`、待补价不计入合计）；`#/billing` 新增客户级 WTCS 销售视图；`#/plans` 新增「套餐能力对比」（额度/SLA/可观测能力/定价）。
3. **多租户 + RBAC（改进项3）**：见 `#/tenants`。
4. **成本路由自动化（改进项4）**：`#/route` 新增开关 + `route_reason`/`cost_source` 对照表 + 缺失 cost 模型计数（不静默退化）。
5. **多实例/分布式状态（改进项5）**：见 `#/instances`。
6. **流式 SSE error 帧（改进项6）**：`#/ledger` 新增流式中断轨迹 `tr_st1` + 抽屉内**注入步骤时间线**与 `error` 帧示例（分层投递：`free` 层纯管道不注入，正常路径逐字节一致）。
7. **监控对接（改进项7）**：`#/observ` 新增「监控对接」区块（Prometheus `/metrics` scrape、node_exporter 主机指标、进程指标、blackbox 站点可用性 + scrape 配置样例）。
8. **口径拆分（改进项8）**：`#/met` 新增「开销占比口径拆分」表——对外承诺 **≤0.1%** vs 工程熔断线 **3%**，消除原口径冲突。

---

## 5. 可交互 vs 静态示意

### ✅ 真实可交互（原型中可点、可见反馈）

1. **hash 路由切页**：点侧栏 / `data-goto` 按钮 / 改 URL hash 均切换页面，刷新停留原页（含新增 `#/tenants`、`#/instances`）。
2. **角色切换**（顶栏下拉）：切换导航（运营面 ↔ 客户面）、密度（compact ↔ cozy）、动作禁用态（如 sre 不可批准）。
3. **主题切换**（`◐`）与**密度切换**（`▤`）：全站令牌联动。
4. **抽屉**：`data-drawer` 打开；`Esc` / 点遮罩 / `✕` 关闭后焦点**归还**触发按钮（含 `tenant-new`/`tenant-detail`/`state-external`/`trace-stream`）。
5. **一次性明文**（I1）/ **轮换两步确认**（I2）/ **审批流**（I3）/ **批量批准**（I15）。
6. **粘贴自检 whoami**（I8）：四态结论（有效/已禁用/已过期/非本网关签发），色 + 文字。
7. **筛选与搜索**、**路由维度切换**（I16）、**优先级上/下移**（I11 键盘兜底）。
8. **导出**（I7）：生成 CSV（BOM + CRLF）/ JSON 并触发下载；`#/tenants` 导出可用。
9. **复制**：`data-copy` / `data-copy-sel` 走 Clipboard API，失败降级，再失败 Toast。
10. **Toast**：所有操作有语义色反馈；错误 Toast 为 `role=alert` + `aria-live=assertive`（P2-2）。
11. **v1.2 新增反馈**：`#/instances`「刷新实例」→ Toast「实例列表已刷新（3 在线 · 1 已排空）」。
12. **抽屉焦点锁定（P1-3）**：打开时背景 `inert` + `aria-hidden`，`Tab`/`Shift+Tab` 首尾回环。
13. **导航重排提示 + 旧顺序开关（AC-05）**：新顺序（值守/经营/客户/系统）↔ 旧顺序（监控/配置/智能/系统），持久化 localStorage。
14. **表格首载骨架 + 空态（P2-7）**：`#/keys`/`#/users`/`#/audit` 首载骨架；空态 `Empty`；`#/audit` 对受限角色显示 ⛔ 403 示例。

### 🟡 静态示意（占位数据，标注"示意 / 占位待替换"）

1. **全部数值**（请求数 / Token / 成本 / 毛利率 / SLO 值 / 延迟 / 实例 rpm）为**假数据示意**——**不构成任何真实承诺或统计断言**。
2. **套餐定价**：因 M2（真实定价）缺失，套餐卡金额与账单牌面价为占位。
3. **图表**：总览柱图、可观测折线为骨架/色块占位（非真实绘图库）。
4. **告警动作 / 通知渠道**：按 Q10 仅表达入口（"通知渠道待接入"）。
5. **红点 / 计数徽标**（如审批 `3`）为固定示意值。
6. **登录门**：原型默认已登录，未实现 `#/login`。

---

## 6. 无障碍与约束自检

- **零依赖**：无 CDN、无 `@import url()`、无图标字体；图标为文本符号（`▦ ∿ ☰ ⚑ ◆ ⧗ ▤ ⇄ ⬡ ¥ ◉ ▷ ⚙ ⚖ ✓ ▣ ⛁ ◈`）。
- **键盘**：`:focus-visible` 焦点环；`Esc` 逐级关闭；抽屉打开焦点移入、关闭归还。
- **不靠色**：状态/进度均"色 + 符号/文本"双编码（`●▲■◆○`、`◐ 受限`、百分比）。
- **数字列**：`tabular-nums` + 右对齐 + 等宽字体（`.num`）。
- **响应式**：≤1020px 两栏折列 / KPI 折 2 列；≤960px 侧栏收进抽屉；≤720px 单列 + 触控目标加大。
- **动效**：仅 CSS transition/animation，`prefers-reduced-motion: reduce` 下全局关停。
- **红线**：界面**无**任何"改写成功响应 / 缓存 / 去重 / Agent 编排平台"的暗示；透明信息（`X-Relay-Mode` / `x-relay-model-*`）可见。

---

## 7. 交付目录文件结构

```
design-proto/deliverables/
├── api-relay-platform-prototype.html   # 主入口（单文件，内联全部 CSS/JS/图标，hash 切页）★双击打开
├── api-relay-platform-prototype.pdf    # 打印/归档稿（浏览器默认视图打印）
├── api-relay-platform-prototype.pptx   # 演示摘要（16:9，9 页）
├── api-relay-platform-prototype.zip    # 完整交付包（含上列 3 文件 + 本 README）
└── README.md                           # 本文件
```

> 未使用外部图片资源，故无 `assets/`；当前所有图示均为 CSS/文本实现。