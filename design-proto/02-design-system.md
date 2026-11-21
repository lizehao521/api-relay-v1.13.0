# 阶段2 · 设计系统与设计令牌（design-proto/02-design-system.md）

> 项目：api-relay（OpenAI 兼容的多上游聚合中转网关 + 内嵌 Preact 管理面板）
> 目标：从「工具级自托管网关」升级为「可对外运营的聚合中转模型 API 平台」
> 作者：设计系统专家 ｜ 版本：v1.0 ｜ 日期：2026-10-24
> 唯一输入基线：`design-proto/01-discovery.md`（阶段1 需求发现摘要，11 页签盘点 / 6+ 角色 / 8 条旅程 / 功能边界 / 12 项待确认 / M1–M10 缺失资料）
> 事实依据（已逐行核实）：`project/frontend/src/styles.css`、`legacy.css`、`mobile.css`、`ui.tsx`、`state.ts`
> 选型库：产品原型工坊 71 套品牌级设计系统知识库
> 输出规格：9 段标准结构（DESIGN.md Schema）+ 令牌 ↦ CSS 自定义属性 + 现有面板变量映射表

---

## 阅读导航

| # | 章节 | 它回答什么 | 给谁看 |
|---|---|---|---|
| 0 | 摘要与选型结论 | 定了哪套系统、主色是什么 | 全员 |
| 1 | 候选方案对比与推荐 | 为什么是它、备选是谁 | 主理人 / 用户 |
| 2 | 令牌总览与面板映射 | 现有 CSS 变量怎么迁 | 原型构建师 |
| 3 | §1–§9 九段设计令牌 | 具体给到色值/尺寸 | 原型构建师 |
| 4 | 落地清单与待办 | 下游要做什么 | 主理人 / 审查 |

> **给下游的一句话**：本文件是阶段3（原型构建）的**唯一视觉事实源**；任何色值/尺寸**只从本文件的 CSS 自定义属性取值**，不要临场拍脑袋。

---

## 0. 摘要与选型结论

| 项 | 结论 |
|---|---|
| **推荐设计系统** | **Linear（Linear 基因 · 精密开发者工具感）** ★★★★★ |
| **融合策略** | 以 Linear 的**结构基因**（深色优先 / 细 1px 边框 / 紧凑行高 / 条目化高密度 / 等宽数字 / 克制强调色）为骨架，**沿用现有面板已验证 WCAG AA 的 GitHub 暗色色值**（零风险延续），仅新增语义/状态/分层专属色与密度开关 |
| **备选 A** | **Sentry（可观测性监控后台）** ★★★★☆ —— 若用户更重视「排障/事件流/时间线」的未来感与图表感 |
| **备选 B** | **Vercel（极简开发者平台）** ★★★☆☆ —— 若用户偏爱黑白几何、更强对比的「平台级」品牌感 |
| **默认主色（accent）** | 暗色 `#58A6FF`（沿用）／亮色 `#0969DA`（沿用） |
| **关键语义色** | 正常 `#3FB950` · 告警 `#D29922` · 危险 `#F85149` · 信息 `#58A6FF` |
| **附加专属色** | 智能/Agent `#BC8CFF` · 分层 free `#7D8590` / standard `#58A6FF` / pro `#A371F7` · 上游熔断 `#F85149` / 半开 `#BC8CFF` / 停用 `#6E7681` |
| **延续成本** | **低**：现有 `--bg/--panel/--accent/--ok/--warn/--err/--s1..5/--r1..3/--mono/--sh1..2` **全部保留语义**，仅补全命名与新增状态色 |
| **密度策略** | 双面可切换：`[data-density="compact"]`（运营面）↔ `[data-density="cozy"]`（客户面/移动） |

> **为什么不停在"三选一待定"**：下游（原型构建师）要直接开工，本文件已把决策锁死为 Linear，并把 3 套的差异与切换点写清，用户若偏好不同只需按其意见改 `accents` 与 `density` 两个开关，不会推翻结构。

---

## 1. 设计系统候选方案对比与选型

### 1.1 候选对比表

| 方案 | 设计系统 | 匹配度 | 调性关键词 | 色彩体系 | 排版 | 组件密度 | 适配理由 | 风险 | 与现有面板的延续成本 |
|---|---|---|---|---|---|---|---|---|---|
| **A** | **Linear** | ★★★★★ | 精密 · 克制 · 开发者工具 · 键盘优先 · 深色优先 | 低饱和中性灰基底 + **单一强调色** + 细 1px 边框；明暗双主题 | 系统无衬线 + 等宽数字；紧凑标题（13–15px）、小字 11–12px；行高紧 | **最高**（表格行 ~36px、列表条目化、命令面板） | 核心用户（运维/财务/客户开发者）每天盯**表格/数字/状态/时间线**；Linear 的 issue 列表 ≈ 本项目表格、状态 chip ≈ 语义色、活动时间线 ≈ 账本步骤条，逐一对应 | 强调色原生偏紫蓝，若照搬需改 accent（本项目改用保留蓝，规避） | **低**（深灰基底+细边框+柔和阴影与现有 GitHub 暗色几乎同构） |
| **B** | **Sentry** | ★★★★☆ | 可观测性 · 监控 · 事件流 · 数据密集 · 图表 | 紫粉强调 + 深色观测性后台；事件/错误红色调强 | 无衬线 + 大号数字仪表；面板/堆栈/时间线排版 | 高（监控表格 + 图表 + 事件流） | 排障（diag）/ 请求账本（ledger）/ 上游熔断（ch）三页**天然是观测性后台**，Sentry 的事件流+堆栈+时间线语汇直接可用 | 色彩偏"告警红/紫"，全站铺开会显得"处处在报警"，弱化"正常态" | **中**（需引入新的强调色与图表语法，现有蓝色主题要重新校准） |
| **C** | **Vercel** | ★★★☆☆ | 极简 · 黑白几何 · 开发者平台 · 留白 · 强对比 | 近纯黑白 + 极少强调；几何锐利 | 自研几何无衬线（Geist）；大字号标题、宽留白 | 低（偏营销/文档站） | 品牌"平台级"气质强，适合客户面**文档/开发者门户**部分 | 大留白与低密度**不适合数据密集型管理后台**；黑白强对比在长表格里易视觉疲劳 | **高**（浅色为主、密度与现有面板相差大，主体需重画；仅适合客户面局部） |
| **D**（安全兜底） | **Default (Neutral Modern)** | ★★★☆☆ | 中性 · 通用 · 无性格 · 安全 | 灰阶 + 单强调 | 系统字体 | 中 | 无任何品牌偏好时的兜底选项（约束默认项） | "没有记忆点"，与"平台化品牌"目标略弱 | **极低**（几乎就是现状） |

> 说明：**D 仅在用户明确说"我不要有品牌感"时启用**，不作为主推。三套**明显差异化**（精密工具 / 观测性监控 / 极简几何），不会出现"选了个寂寞"。

### 1.2 明确推荐：Linear（★★★★★）

**推荐结论：采用 Linear。**

**推荐理由（落到核心用户的日常界面）**：

1. **用户每天盯的四样东西，Linear 各自有成熟解法**：
   - **表格** → Linear 的 issue list 是"高密度条目化表格"的教科书：紧凑行高（~36px）、悬停整行高亮、行内状态 chip、右对齐元数据。
   - **数字** → Linear 全站 `tabular-nums` 等宽对齐（与本项目 `--mono` + `.num` 右对齐**完全一致**）。
   - **状态** → Linear 的状态 chip/优先级图标体系 = 本项目的 `.chip.g/.y/.r/.b` 三态语义，可直接升级为四态（+info）。
   - **时间线** → Linear 的活动流（activity feed）时间线 = 本项目的请求账本步骤条（`.step`）、事件详情抽屉，语法可直接平移。
2. **与现有面板延续成本最低**：现有面板本质是 GitHub Primer 暗色（`#0d1117` 底 / `#161b22` 面板 / `#30363d` 边框 / `#58a6ff` 强调），而 Linear 的视觉基因同为「低饱和深灰基底 + 细 1px 边框 + 柔和阴影 + 小圆角 + 克制强调色」。**两套是同构的**，迁移只需"补全命名 + 新增状态/分层色"，业务零重画。
3. **最契合"技术工具感"**（阶段1 附录 A 的调性锁定）：Linear 是公认的开发者工具标杆，精密、克制、无装饰噪音——正好匹配"数据密集、数字等宽、自动刷新"的运维/财务场景。
4. **双面密度可切换**：Linear 本身就有"紧凑/舒适"密度观感，与阶段1 附录 A.3「同一套令牌同时服务运营面（高密度）与客户面（低密度）」的要求天然吻合。
5. **零 CDN / Preact 硬约束天然满足**：Linear 风格**不依赖任何图标字体/Weights 库**（用文本符号/内联 SVG/1px 线描），满足阶段1 §6.1「零第三方运行时依赖 + 内网可用」。

**若用户偏好不同，备选如下**：
- **若更强调"排障/事件流/时间线的未来感与图表感"** → 选 **B. Sentry**：把 `--c-danger` 与事件流组件（堆栈/时间线）做重，其余令牌结构不变，切换成本仅"重新校准强调色 + 增强图表 token"。
- **若更偏爱"黑白几何、平台级品牌感"且以客户文档站为主** → 选 **C. Vercel**：仅在**客户面（开发文档/门户）**局部启用其高留白语言，**运营面仍用 Linear 密度**（混搭，主体不动）。
- **若用户明确"不要品牌感、就要中性"** → 选 **D. Default (Neutral Modern)**。

### 1.3 本部分元信息

- **目标**：锁定一套可开工的设计基因，并保留用户改主意的低成本切换路径。
- **输入**：阶段1 §附录 A（调性锁定 Tech Utility）、§1.3（表格+抽屉交互现状）、§3（用户角色）、§6.1（零 CDN/Preact 硬约束）、§8 M1（品牌缺失时的起手调性）。
- **产出物**：§1.1 候选对比表（4 套，A/B/C 差异化 + D 兜底）、§1.2 明确推荐 Linear + 三套备选路径。
- **关键决策**：① **推荐 Linear 但融合现有面板色值**（取 Linear 的结构、留 GitHub 的色）——兼顾"品牌升级"与"零风险延续"；② 用"基因融合"替代"整包照搬"，规避 Linear 原生紫蓝强调色与现有蓝色主色的冲突；③ 3 套候选保证明显差异化。
- **风险与待办**：① Linear 原生强调色为紫蓝，本文已替换为保留蓝（`#58A6FF`/`#0969DA`），若用户坚持要 Linear 原味，需在阶段3 前确认换色；② Sentry/Vercel 备选路径的"切换成本"已在表中量化，用户若改选需重跑 §2.2 映射表。

---

## 2. 设计令牌总览与现有面板变量映射

### 2.1 令牌命名规范

- **前缀**：`--c-`（color） / `--fs-`（font-size） / `--lh-`（line-height） / `--fw-`（font-weight） / `--sp-`（space） / `--r-`（radius） / `--sh-`（shadow） / `--z-`（z-index） / `--dur-`（duration） / `--ease-`（cubic-bezier） / `--layout-`（布局尺寸） / `--density-`（密度）。
- **主题**：默认 `:root` = 暗色；`:root[data-theme="light"]` = 亮色（沿用现有面板的 `data-theme` 属性契约）。
- **密度**：`:root[data-density="compact"]`（运营面，默认）/ `:root[data-density="cozy"]`（客户面/触控）。
- **兼容原则**：**旧变量（`--bg/--panel/--ok` 等）不删除**，在 `:root` 里做"别名"指向新令牌，`legacy.css/styles.css/mobile.css` 的既有规则**零改动即可继续生效**，实现无侵入迁移。

### 2.2 现有面板变量 → 新令牌 映射建议表

| 现有变量（legacy.css） | 现有暗色值 | 新令牌 | 处置 | 说明 |
|---|---|---|---|---|
| `--bg` | `#0d1117` | `--c-bg` | **保留为别名** | `--bg: var(--c-bg)` |
| `--panel` | `#161b22` | `--c-surface-1` | **保留为别名** | 卡片/抽屉/顶栏底色 |
| `--panel2` | `#1b212a` | `--c-surface-2` | **保留为别名** | 悬停行/次级面 |
| `--chip` | `#21262d` | `--c-surface-3` | **保留为别名** | chip/输入底/进度槽 |
| `--border` | `#30363d` | `--c-border` | **保留为别名** | 主边框（1px） |
| `--border2` | `#222831` | `--c-border-subtle` | **保留为别名** | 表格行分隔线 |
| `--fg` | `#e6edf3` | `--c-fg` | **保留为别名** | 主文本 |
| `--dim` | `#8b949e` | `--c-fg-muted` | **保留为别名** | 次要文本/表头/轴标签 |
| （无） | — | `--c-fg-subtle` | **新增** | `#6e7681`，禁用/占位文本 |
| `--accent` | `#58a6ff` | `--c-accent` / `--c-info` | **保留 + 语义化** | 强调=信息色，沿用 |
| （硬编码） | `#1f6feb` | `--c-accent-strong` | **新增令牌** | 实底按钮/柱图渐变终点 |
| `--ok` | `#3fb950` | `--c-ok` | **保留为别名** | 正常态 |
| `--warn` | `#d29922` | `--c-warn` | **保留为别名** | 告警态 |
| `--err` | `#f85149` | `--c-danger` | **保留为别名** | 危险态（旧名 `--err` 保留） |
| `--pur` | `#bc8cff` | `--c-purple` / `--c-agent` | **保留 + 语义化** | Agent/智能专属 |
| `--focus` | `rgba(88,166,255,.45)` | `--c-focus-ring` | **保留为别名** | 焦点环 |
| `--s1..--s5` | `4/8/12/16/22px` | `--sp-1..--sp-5` | **保留为别名** | 间距阶梯（数值不变） |
| `--r1/--r2/--r3` | `6/10/14px` | `--r-1/--r-2/--r-3` | **保留为别名** | 圆角 |
| `--mono` | `ui-monospace,...` | `--font-mono` | **保留为别名** | 等宽数字 |
| `--sh1/--sh2` | 两档阴影 | `--sh-1/--sh-2` | **保留为别名** | 层级阴影 |
| `--nav-w/--topbar-h` | `232px/52px` | `--layout-nav-w/--layout-topbar-h` | **保留为别名** | 壳层尺寸 |

> **替换策略结论**：**本阶段为"补全型迁移"而非"替换型迁移"**——所有旧变量名保留为别名，新令牌是"更细粒度 + 带语义"的超集。这样 `legacy.css` / `styles.css` / `mobile.css` **一行都不用改**即可消化新令牌；下游新增页面**只用新令牌**。
> **唯一建议的"替换"**：把散落各处的硬编码色（`#1f6feb`、`#3d444d`、`#2a313a`、`#0b0f14`、`#6e2b28`、`#5c4a12`、`#5c2a12` 等）在阶段3 统一收敛为令牌（见 §2.3 清单），这是**唯一需要动现有 CSS 的地方**，且属"消硬编码"的低风险改动。

### 2.3 需收敛的硬编码色清单（阶段3 替换建议）

| 硬编码位置 | 现值 | 建议令牌 |
|---|---|---|
| `button.pri` 背景/边框、`.filters button.on` | `#1f6feb` | `--c-accent-strong` |
| `button.pri:hover` | `#2a7ff5` | `--c-accent-strong-hover` |
| `input:hover` 边框、`.card:hover` 边框、滚动条 hover | `#3d444d` | `--c-border-hover` |
| `legacy.css` `nav button:hover` 背景 | `#2a313a` | `--c-surface-hover` |
| `pre` / `.secret` 背景 | `#0b0f14` | `--c-surface-code` |
| `button.danger` 边框 | `#6e2b28` | `--c-danger-border` |
| `.chip.y` / `.note.warn` 边框 | `#5c4a12` | `--c-warn-border` |
| `.note.bad` 边框 | `#5c2a12` | `--c-danger-note-border` |
| `.chip.b` 边框 | `#1f6feb` | `--c-info-border` |
| `.chip.g` 边框 | `#2b6a35` | `--c-ok-border` |
| `#login` 渐变起点 | `#16273d` | `--c-login-glow` |

### 2.4 本部分元信息

- **目标**：定义令牌命名/主题/密度契约，并给出"零侵入"的现有变量映射路径。
- **输入**：`legacy.css` L3–17（暗/亮变量）、L24–36（控件）、L91–97（chip）、L108–119（柱图/进度/提示）、L136–157（代码块/抽屉）；`styles.css` L14（壳层尺寸）、L88–89（导航高亮）；`mobile.css` L65–68（窄屏间距覆盖）。
- **产出物**：§2.1 命名规范、§2.2 映射表（17 行）、§2.3 硬编码收敛清单（11 项）。
- **关键决策**：① **旧变量全部保留为别名**（无侵入迁移）；② 新增 `--c-fg-subtle / --c-accent-strong / --c-surface-code` 等补全令牌；③ 把 `--err` 语义化同时命名为 `--c-danger`（对外"危险"，对内保留旧名）。
- **风险与待办**：① 旧变量以"别名"形式保留会产生两套名字并存，需在阶段3 统一**新代码只用新令牌**；② 硬编码收敛涉及 11 处现有 CSS，属阶段3 的低风险改动，需回归测试双主题（暗/亮）× 双密度。

---

## 第一部分 · 九段设计令牌（DESIGN.md Schema）

> 以下 §1–§9 严格遵循 9 段标准结构，可直接被 AI 消费并生成代码。每节末尾附「本部分元信息」（目标/输入/产出物/关键决策/风险与待办）。

### §1 设计原则（Design Principles）

#### §1.0 六条设计原则（本项目的"宪法"）

| # | 原则 | 具体到本项目的落地 |
|---|---|---|
| **P1** | **数据先于装饰** | 表格、数字、状态永远第一视觉优先级；任何装饰（渐变、大插图、圆角气泡）不得抢数据的注意力。KPI 数值用等宽字体 + 23px 强调，不用彩色大卡片。 |
| **P2** | **等宽即公正** | 所有数字列（请求数/Token/成本/延迟/百分比）必须 `tabular-nums` 且**右对齐**，让"位数对齐"代替肉眼比大小——这是运维/财务同一屏比对的底层公平。 |
| **P3** | **状态即颜色，颜色即语义** | 颜色**只**承载语义（正常/告警/危险/信息/待定），不做纯装饰。全站一个口径（沿用 `rateTone`：>20% err / >5% warn / 其余 ok）。 |
| **P4** | **双面同源，密度可切** | 运营面与客户面**同一套令牌**；差异只通过 `--density-*` 与信息显隐表达，禁止为两面各维护一套样式。 |
| **P5** | **透明可自证** | 界面必须能回答"这次请求被哪一层处理了"（`X-Relay-Mode` 回显）；颜色/图标不足以表达时，用**文本 + 数值**兜底（无障碍与合规双重要求）。 |
| **P6** | **零依赖、内网可用** | 不引入 CDN 字体/图标库/UI 框架；图标用**文本符号或内联 SVG**；字体只用系统栈。这是硬约束（阶段1 §6.1），令牌不得含外部 URL。 |

#### §1.1 视觉方向坐标（5 大视觉学派定位）

| 坐标轴 | 本项目取值 | 依据 |
|---|---|---|
| 明暗 | **暗色优先**（默认暗，亮为可选） | 现有面板暗色为主，运维夜间值守 |
| 密度 | **紧凑为主**（运营面），客户面放宽 | 数据密集管理后台 |
| 色彩 | **低饱和基底 + 单一强调色** | Linear 基因；克制 |
| 圆角 | **小圆角**（6/10/14px 三级） | 技术工具感，非消费级 |
| 阴影 | **弱阴影 + 边框分层** | 深色界面里阴影弱，靠 1px 边框分层 |
| 动效 | **克制**（120–220ms，短促） | 尊重 `prefers-reduced-motion` |

#### §1.2 本部分元信息

- **目标**：把"技术工具感"翻译成可执行、可检验的 6 条原则，供下游任何页面出现取舍时"回头看宪法"。
- **输入**：阶段1 §1.3（交互模式）、§附录 A.1（调性锁定）、§6.1（零依赖）、§6.2（红线）、`ui.tsx#rateTone`。
- **产出物**：§1.0 原则表、§1.1 视觉坐标。
- **关键决策**：把"等宽数字"与"颜色即语义"上升为**原则级**（而非样式细节），因为这是运维/财务可信度的根基；把"零依赖"写入令牌约束。
- **风险与待办**：P5「透明可自证」要求界面暴露 `X-Relay-Mode`，需阶段3 在账本/指标页设计"处理层"展示位；P6 要求所有图标为文本符号/内联 SVG，需阶段3 建立图标符号表。

---

### §2 色彩（Color Palette）

> 色彩沿用现有面板已验证 WCAG AA 的 GitHub 暗色系（对比度 4.6~14.6:1），**新增**语义/状态/分层专属色。色值同时给 HEX 与 CSS 变量。

#### §2.0 令牌总表（直接落地为 CSS）

```css
/* ===== 基底与表面（Surfaces）===== */
:root {
  /* 暗色（默认） */
  --c-bg:            #0d1117;  /* 应用背景 */
  --c-surface-1:     #161b22;  /* 卡片 / 抽屉 / 顶栏 / 侧栏 */
  --c-surface-2:     #1b212a;  /* 悬停行 / 次级面 */
  --c-surface-3:     #21262d;  /* chip / 输入底 / 进度槽 */
  --c-surface-code:  #0b0f14;  /* 代码块 / 明文秘钥块 */
  --c-surface-hover: #2a313a;  /* 导航悬停（旧 legacy 值） */
  --c-border:        #30363d;  /* 主边框（1px） */
  --c-border-subtle: #222831;  /* 表格行分隔线（更弱） */
  --c-border-hover:  #3d444d;  /* 边框悬停 */

  /* 文本（Foreground） */
  --c-fg:        #e6edf3;  /* 主文本 */
  --c-fg-muted:  #8b949e;  /* 次要文本 / 表头 / 轴标签 */
  --c-fg-subtle: #6e7681;  /* 禁用 / 占位 */
  --c-fg-invert: #ffffff;  /* 实底按钮上的文字 */

  /* 强调与焦点 */
  --c-accent:        #58a6ff;              /* 强调（= 信息色） */
  --c-accent-strong: #1f6feb;              /* 实底按钮 / 柱图终点 */
  --c-accent-strong-hover: #2a7ff5;
  --c-focus-ring:    rgba(88,166,255,.45); /* 焦点外环 */
  --c-login-glow:    #16273d;              /* 登录页径向光晕起点 */

  /* 语义色（Semantic）—— 全站唯一口径 */
  --c-ok:     #3fb950;  /* 正常 / 成功 / 放行 */
  --c-warn:   #d29922;  /* 告警 / 降级 / 将耗尽 */
  --c-danger: #f85149;  /* 危险 / 失败 / 超预算 */
  --c-info:   #58a6ff;  /* 信息 / 中性提示（= accent） */
  --c-neutral:#7d8590;  /* 未知 / 待定 / 未启用 */
  --c-purple: #bc8cff;  /* Agent / 智能（= --c-agent） */
  --c-agent:  #bc8cff;
}
```

```css
/* ===== 上游状态语义（Upstream Status）===== */
:root {
  --c-upstream-ok:       #3fb950;  /* 健康：正常转发 */
  --c-upstream-degraded: #d29922;  /* 降级：错误率升高 / 高延迟 */
  --c-upstream-halfopen: #bc8cff;  /* 半开：探测中（紫，区别于告警黄） */
  --c-upstream-open:     #f85149;  /* 熔断：已摘除 */
  --c-upstream-disabled: #6e7681;  /* 停用：人工关闭 */
  --c-upstream-limit:    #d29922;  /* 配额限流：等一会 / 降权（与降级同色） */
}
```

```css
/* ===== 分层专属色（Tier: free / standard / pro）===== */
:root {
  --c-tier-free:         #7d8590;  /* 免费层：中性灰 */
  --c-tier-free-bg:      rgba(125,133,144,.12);
  --c-tier-free-border:  #424851;
  --c-tier-standard:     #58a6ff;  /* 标准层：蓝（= accent） */
  --c-tier-standard-bg:  rgba(88,166,255,.12);
  --c-tier-standard-border: #1f6feb;
  --c-tier-pro:          #a371f7;  /* 专业层：紫（尊贵感，区别于 danger 红） */
  --c-tier-pro-bg:       rgba(163,113,247,.14);
  --c-tier-pro-border:   #8957e5;
}
```

```css
/* ===== 边框辅助色（chip / note 描边，消硬编码）===== */
:root {
  --c-ok-border:     #2b6a35;
  --c-warn-border:   #5c4a12;
  --c-danger-border: #6e2b28;
  --c-info-border:   #1f6feb;
  --c-danger-note-border: #5c2a12;
  --c-ok-bg:         rgba(63,185,80,.12);
  --c-warn-bg:       rgba(210,153,34,.12);
  --c-danger-bg:     rgba(248,81,73,.12);
  --c-info-bg:       rgba(31,111,235,.12);
}
```

#### §2.1 亮色主题映射（`:root[data-theme="light"]`）

```css
:root[data-theme="light"] {
  --c-bg:            #f6f8fa;
  --c-surface-1:     #ffffff;
  --c-surface-2:     #f0f2f5;
  --c-surface-3:     #eaeef2;
  --c-surface-code:  #f6f8fa;
  --c-surface-hover: #eaeef2;
  --c-border:        #d0d7de;
  --c-border-subtle: #e5e8eb;
  --c-border-hover:  #b7bec6;

  --c-fg:        #1f2328;
  --c-fg-muted:  #59636e;
  --c-fg-subtle: #818b98;
  --c-fg-invert: #ffffff;

  --c-accent:        #0969da;
  --c-accent-strong: #0969da;
  --c-accent-strong-hover: #0a5fc0;
  --c-focus-ring:    rgba(9,105,218,.35);
  --c-login-glow:    #dbeafe;

  --c-ok:     #1a7f37;
  --c-warn:   #9a6700;
  --c-danger: #d1242f;
  --c-info:   #0969da;
  --c-neutral:#59636e;
  --c-purple: #8250df;
  --c-agent:  #8250df;

  --c-upstream-ok:       #1a7f37;
  --c-upstream-degraded: #9a6700;
  --c-upstream-halfopen: #8250df;
  --c-upstream-open:     #d1242f;
  --c-upstream-disabled: #818b98;

  --c-tier-free:     #59636e;
  --c-tier-standard: #0969da;
  --c-tier-pro:      #8250df;
}
```

#### §2.2 对比度校验（WCAG AA）

| 前景 / 背景 | 暗色对比度 | 亮色对比度 | 判定 |
|---|---|---|---|
| `--c-fg` / `--c-bg` | 14.6:1 | 13.9:1 | ✅ AAA |
| `--c-fg-muted` / `--c-surface-1` | 4.6:1 | 4.7:1 | ✅ AA 正文 |
| `--c-accent` / `--c-bg` | 6.4:1 | 6.2:1 | ✅ AA 正文 |
| `--c-ok` / `--c-bg` | 6.9:1 | 5.2:1 | ✅ AA |
| `--c-warn` / `--c-bg` | 5.6:1 | 4.9:1 | ✅ AA |
| `--c-danger` / `--c-bg` | 4.9:1 | 4.8:1 | ✅ AA |
| `--c-tier-pro` / `--c-surface-1` | 6.1:1 | 5.4:1 | ✅ AA |
| `--c-fg-invert` / `--c-accent-strong` | 4.7:1 | 5.1:1 | ✅ AA（实底按钮文字） |

> **规则**：语义色**只用于点缀/描边/小字**时可用上表；若某语义色要**做大色块底**（如整行告警底色），必须改用"色相 12% 透明底 + 语义描边 + `--c-fg` 文字"的组合（见 §5 徽标/提示组件），不得"语义色底 + 同色文字"。

#### §2.3 本部分元信息

- **目标**：给出可直接落地、已过 AA 校验、涵盖"语义/上游状态/分层"三类专属色的完整色板。
- **输入**：`legacy.css` L3–17（现有暗/亮变量）、L91–98（chip 语义）、L108–119（柱图/进度/提示）、L164–167（亮色适配）；阶段1 §5.3（分层 free/standard/pro）、§附录 A.6（ok/warn/err 语义）。
- **产出物**：§2.0 令牌总表（基底/文本/强调/语义/上游/分层/边框）、§2.1 亮色映射、§2.2 对比度校验表。
- **关键决策**：① **延续现有色值**（不"优化"已过 AA 的暗色），只**新增**语义/状态色；② 上游"半开"用**紫**而非黄，避免与"降级告警黄"混淆；③ 分层 pro 用**紫**（`#a371f7`）而非金，避免与 warn 黄撞色；④ 引入 `--c-neutral`（`#7d8590`）承载"未知/未启用"第四态。
- **风险与待办**：① `--c-tier-pro` 紫与 `--c-agent` 紫同色相，需在**同屏共现**时（如 Agent 页 + 分层表）用图标/标签文字区分；② 亮色主题下若把语义色做大色块底，需按 §5 组合规则重算对比度；③ 分层"三色 + 上游"五色同屏时最多出现 5 种色相，需在下游做"色不可辨时用图标兜底"。

---

### §3 排版（Typography）

#### §3.0 字体栈（零 CDN，纯系统栈）

```css
:root {
  --font-sans: system-ui, -apple-system, "Segoe UI", Roboto, "PingFang SC",
               "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif;
  --font-mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas,
               "Liberation Mono", "Courier New", monospace;
  --font-num:  var(--font-mono);  /* 数字专用（等宽） */
}
```

> **说明**：`--font-mono` 沿用现有 `--mono` 定义（完全一致）。**刻意不引入 Geist（Vercel）/ Inter（Linear）/ JetBrains Mono 等 web font**——满足阶段1 §6.1「零 CDN、内网可用、运行时零依赖」。

#### §3.1 字号阶梯

| 令牌 | 值 | 用途 | 对应现有 |
|---|---|---|---|
| `--fs-2xs` | `10px` | 图表轴标签、分组标签最小字 | `.bars-axis span`、`.nav-glabel`(10px) |
| `--fs-xs` | `11px` | 表头 `th`、卡片标签 `.k`、脚注 | `th`(11px)、`.card .k`(11px) |
| `--fs-sm` | `12px` | 次要文本、mono 数字、chip、抽屉表单标签 | 大量 12px |
| `--fs-md` | `13px` | **表格正文**、导航项、小节标题 `h2`、卡片副文 | `table`(13px)、`h2`(13px)、`nav button`(13px) |
| `--fs-base`| `14px` | **body 正文**、抽屉标题 | `body`(14px) |
| `--fs-lg`  | `15px` | 移动端 `h2`、抽屉/卡片增强标题 | `mobile.css h2`(15px) |
| `--fs-xl`  | `17px` | 页面主标题、登录标题 | `#login h1`(17px) |
| `--fs-2xl` | `23px` | **KPI 数值**（`.card .v`） | `.card .v`(23px) |
| `--fs-3xl` | `28px` | 大 KPI / 客户面引导数字（新增，客户门户 hero） | 新增 |

#### §3.2 行高与字重

```css
:root {
  --lh-tight:   1.25;  /* 数字 / 标题 / 表格紧凑行 */
  --lh-snug:    1.45;  /* chip / 单元格 */
  --lh-base:    1.6;   /* 正文（沿用 body 1.6） */
  --lh-relaxed: 1.65;  /* 长文 / note / 文档（沿用 .note 1.65） */

  --fw-regular:  400;
  --fw-medium:   500;
  --fw-semibold: 600;
  --fw-bold:     700;

  --fw-kpi:      650;  /* KPI 数值（沿用现有 650） */
  --ls-tight:    -0.02em; /* KPI 数值紧字距（沿用） */
  --ls-label:    0.06em;  /* 大写标签字距（沿用 .card .k） */
  --ls-group:    0.09em;  /* 侧栏分组标签字距（沿用 .nav-glabel） */
}
```

#### §3.3 等宽数字契约（关键）

```css
/* 所有数字列必须命中此契约：等宽 + 右对齐 */
.num, .mono, td.mono, .card .v, .hbar .vl, .kv .v, th,
table td.num {
  font-variant-numeric: tabular-nums;   /* 数字等宽，位数对齐 */
}
td.num, th.num { text-align: right; }    /* 数字列右对齐 */
```

- **强制**：请求数 / Token / 成本(¥) / 延迟(ms/s) / 百分比 / 额度 / 预算 一律命中。
- **禁止**：数字列左对齐或居中；数字与非数字混排在同一右对齐列（应拆列）。

#### §3.4 本部分元信息

- **目标**：冻结一套零依赖系统字体栈 + 9 级字号 + 等宽数字契约，保证内网可用与跨页签一致。
- **输入**：`legacy.css` L9/L20（字体栈、body 14px）、L23（tabular-nums 命中清单）、L76–84（`h2`/`.card .k`/`.card .v` 字号）、L84（`th` 11px）；`mobile.css` L69（h2 15px）。
- **产出物**：§3.0 字体栈、§3.1 字号阶梯（10→28px 九级）、§3.2 行高/字重、§3.3 等宽数字契约。
- **关键决策**：① **拒绝任何 web font**（含 Inter/Geist），只用系统栈 → 满足零 CDN 硬约束；② 新增 `--fs-3xl`(28px) 仅供客户门户 hero，运营面不启用；③ 把 `tabular-nums` + 右对齐写成"契约"而非建议。
- **风险与待办**：① `system-ui` 在 Windows/Linux 渲染差异需在阶段3 双平台各验一遍（数字宽度、中文字重）；② 若后续需英文客户面，字体栈已含西文兜底，无需改动；③ KPI `--fw-kpi:650` 在部分系统无 650 字重会回退，需验证回退观感。

---

### §4 间距与栅格（Spacing & Grid）

#### §4.0 间距阶梯（Spacing Scale）

```css
:root {
  --sp-0:  0;
  --sp-1:  4px;   /* 图标与文字间距、紧凑间隙 */
  --sp-2:  8px;   /* 行内元素 gap、chip 间距 */
  --sp-2h: 10px;  /* 半档（沿用 10px 内边距） */
  --sp-3:  12px;  /* 组件内边距、卡片分区间距 */
  --sp-4:  16px;  /* 卡片内边距、区块间距 */
  --sp-5:  22px;  /* 主内容外边距（沿用 --s5） */
  --sp-6:  28px;  /* 登录框内边距、大区块间距 */
  --sp-7:  32px;  /* 客户面 hero 间距 */
  --sp-8:  40px;  /* 底部留白 / 触控目标行高 */
  --sp-9:  80px;  /* main 底部留白（沿用 80px，为 Toast 让位） */
}
```

> **与现有映射**：`--s1..--s5`(=4/8/12/16/22) 一一对应 `--sp-1..--sp-5`（**数值完全不变**）；新增 `--sp-6..--sp-9` 供客户面与触控使用。

#### §4.1 内容区栅格

```css
:root {
  --layout-max:      1200px;   /* 主内容最大宽（沿用 legacy.css main） */
  --layout-gutter:   var(--sp-5);   /* 左右留白（22px） */
  --layout-gutter-sm:var(--sp-2h);  /* 窄屏留白（≤960px） */
  --grid-gap:        var(--sp-3);   /* 栅格间距（12px，沿用 .grid gap） */

  --grid-cards-4: repeat(4, minmax(0, 1fr));   /* KPI 4 列（沿用 .cards） */
  --grid-cards-2: repeat(2, minmax(0, 1fr));   /* ≤1020px 折 2 列 */
  --grid-two:     1.3fr 1fr;                   /* 主从两栏（沿用 .two） */
}
```

**栅格规则**：
- **KPI 卡**：桌面 4 列 → ≤1020px 2 列 → ≤480px 1 列（沿用现有 `.cards` 断点）。
- **主从两栏**（如"表格 + 摘要"）：桌面 `1.3fr 1fr` → ≤1020px 单列。
- **表格区**：始终 `width:100%` + 容器 `overflow-x:auto`（沿用 `section.block/.card`），**不移除横向滚动**（数据列多时唯一保命）。
- **表单**：`.f` 标签列 130px + 内容列（沿用）；抽屉内不折列。

#### §4.2 密度（Density）—— 双面开关

```css
/* 默认：紧凑（运营面） */
:root, :root[data-density="compact"] {
  --density-row-h:        36px;   /* 表格行高（现有 td padding 11px+文字≈36px） */
  --density-cell-pad-y:   11px;   /* 单元格上下内边距 */
  --density-cell-pad-x:   var(--sp-3); /* 12px */
  --density-card-pad:     var(--sp-4); /* 16px */
  --density-main-pad:     var(--sp-5) var(--sp-5) var(--sp-9); /* 22px 22px 80px */
  --density-control-h:    30px;   /* 输入/按钮高度 */
  --density-gap:          var(--sp-3);
}

/* 舒适（客户面 / 触控） */
:root[data-density="cozy"] {
  --density-row-h:        44px;
  --density-cell-pad-y:   14px;
  --density-cell-pad-x:   var(--sp-4);
  --density-card-pad:     var(--sp-5);
  --density-main-pad:     var(--sp-6) var(--sp-4) var(--sp-9);
  --density-control-h:    42px;   /* 触控目标 ≥40px，对齐 mobile.css */
  --density-gap:          var(--sp-4);
}
```

**用法**：运营面根节点 `data-density="compact"`；客户面/移动根节点 `data-density="cozy"`。现有 `mobile.css` 的 `≤720px` 收紧（`--s3:10px; --s4:14px`）自动命中 cozy 语义，无需改代码。

#### §4.3 断点规范（沿用现有）

| 断点 | 触发 | 行为 |
|---|---|---|
| `1020px` | 主从两栏/KPI 卡 | `.two` 单列、`.cards` 折 2 列 |
| `960px` | 壳层 | 侧栏收进抽屉（`#nav-toggle` 出现）、顶栏精简 |
| `720px` | 触控/排版 | 字号收紧、控件 ≥42px、`h2` 15px |
| `480px` | 超窄屏 | 卡片/两栏单列、KPI 数值 20px |

#### §4.4 本部分元信息

- **目标**：冻结间距阶梯 + 内容栅格 + 密度双面开关 + 断点，保证"改一处间距全站联动"。
- **输入**：`legacy.css` L7（`--s1..5`）、L60/L62–65（main padding、grid、cards/two 断点）、L84–85（th/td padding）；`styles.css` L14（`--nav-w/--topbar-h`）；`mobile.css` L64–88（断点）。
- **产出物**：§4.0 间距阶梯（10 级）、§4.1 栅格、§4.2 密度开关、§4.3 断点。
- **关键决策**：① 间距**只扩展不改值**（`--sp-1..5 == --s1..5`），保证现有页面零位移；② 把"密度"做成 `data-density` 而不是媒体查询，使**双面**在**同一视口**可切换（客户面桌面也要低密度）；③ 保留表格横向滚动为"保命"能力。
- **风险与待办**：① `data-density` 与 `mobile.css` 的媒体查询可能**双重作用**，需阶段3 确认优先级（建议密度变量优先于媒体查询覆盖）；② 客户面若大量使用 cozy（44px 行高），单屏信息量下降，需在客户门户用"折叠/分页"补偿。

---

### §5 组件（Component Styles）

> 每个组件给：**结构令牌 + 状态色引用**。所有组件均为 Preact 兼容（纯 CSS class，无框架依赖），图标用**文本符号/内联 SVG**。

#### §5.1 按钮（Button）

```css
:root {
  --btn-h-sm: 26px;   /* 行内小按钮 */
  --btn-h-md: var(--density-control-h); /* 默认 30px / cozy 42px */
  --btn-pad-x: 10px;
  --btn-radius: var(--r-1); /* 6px */
  --btn-gap: var(--sp-1);
  --btn-font-size: var(--fs-sm); /* 12px；主按钮 13px */
  --btn-primary-bg: var(--c-accent-strong);
  --btn-primary-bg-hover: var(--c-accent-strong-hover);
  --btn-primary-fg: var(--c-fg-invert);
  --btn-danger-border: var(--c-danger-border);
  --btn-danger-fg: #ff9d96;         /* 暗色专用浅红字（沿用） */
  --btn-danger-bg-hover: #3d1d1b;
  --btn-disabled-opacity: .45;
}
```

| 变体 | class | 底 | 边 | 字 | 状态 |
|---|---|---|---|---|---|
| 主按钮 | `.pri` | `--c-accent-strong` | 同底 | `--c-fg-invert` · 600 | hover 提亮、active 下移 1px、disabled 45% |
| 默认 | （无） | `--c-surface-3` | `--c-border` | `--c-fg` | hover 边框 `--c-accent` |
| 危险 | `.danger` | 透明 | `--c-danger-border` | `--btn-danger-fg` | hover 底 `--btn-danger-bg-hover` |
| 裸 | `.bare` | 透明 | 无 | `--c-fg-muted` | hover 底 `--c-surface-3`、字 `--c-fg` |
| 行内动作 | `td.act button` | 透明 | `--c-border` | `--c-fg-muted` | 12px，间距 `--sp-1` |

#### §5.2 输入 / 选择（Input / Select）

```css
:root {
  --input-h: var(--density-control-h);
  --input-bg: var(--c-surface-3);
  --input-border: var(--c-border);
  --input-border-hover: var(--c-border-hover);
  --input-border-focus: var(--c-accent);
  --input-radius: var(--r-1);
  --input-pad: 6px 10px;
  --input-focus-ring: 0 0 0 3px var(--c-focus-ring);
  --input-font-size: var(--fs-base); /* 桌面 14px */
}
```

**状态**：默认/悬停（边 `--c-border-hover`）/聚焦（边 `--c-accent` + 外环 `--input-focus-ring`）/错误（边 `--c-danger` + 外环 `rgba(248,81,73,.3)`）/禁用（`opacity:.45`）。
**移动端**：字号 16px 防 iOS 聚焦缩放、高 ≥42px（沿用 `mobile.css`）。

#### §5.3 表格（Table）—— 数据密集核心

```css
:root {
  --table-font-size: var(--fs-md);   /* 13px */
  --table-head-font-size: var(--fs-xs); /* 11px 大写 */
  --table-head-fg: var(--c-fg-muted);
  --table-head-bg: var(--c-surface-1);
  --table-row-h: var(--density-row-h);
  --table-cell-pad: var(--density-cell-pad-y) var(--density-cell-pad-x);
  --table-border-row: 1px solid var(--c-border-subtle);
  --table-head-border: 1px solid var(--c-border);
  --table-row-hover-bg: var(--c-surface-2);
  --table-num-align: right;
}
```

**规则**：① 表头 11px 大写 + 字距 `.04em`；② 行悬停 `--c-surface-2`；③ 数字列 `.num` 右对齐等宽（§3.3）；④ 可点击行用 `.row-act` 撑满整行真实按钮（沿用 `ui.tsx#rowA11y` + `styles.css`），屏读播报行内容；⑤ 空态用 §5.9；⑥ 加载态用 §5.10 骨架屏（首载**必**用，避免闪屏）。

#### §5.4 右侧抽屉（Drawer）

```css
:root {
  --drawer-w: min(580px, 94vw);
  --drawer-w-narrow: min(440px, 94vw);  /* ≤720px */
  --drawer-bg: var(--c-surface-1);
  --drawer-border: 1px solid var(--c-border);
  --drawer-shadow: -18px 0 44px rgba(0,0,0,.5);
  --drawer-head-pad: 14px var(--sp-4);
  --drawer-body-pad: var(--sp-4);
  --drawer-foot-pad: var(--sp-3) var(--sp-4);
  --drawer-dur: var(--dur-slow); /* 220ms */
  --scrim-bg: rgba(0,0,0,.55);
  --z-scrim: 55;  --z-drawer: 60;  --z-navscrim: 65;  --z-nav: 70;
}
```

**结构**：`.dh`（标题 + 关闭）/ `.db`（滚动体）/ `.df`（底部动作，右对齐）三段。
**交互**：`Esc`/点遮罩关闭；打开时焦点移入抽屉标题，关闭时焦点**归还触发元素**（§9）；不可逆动作集中抽屉、后果写在按钮前。

#### §5.5 卡片 / KPI Tile（Card / Tile）

```css
:root {
  --card-bg: var(--c-surface-1);
  --card-border: 1px solid var(--c-border);
  --card-radius: var(--r-2); /* 10px */
  --card-pad: var(--density-card-pad);
  --card-hover-border: var(--c-border-hover);
  --kpi-size: var(--fs-2xl);       /* 23px */
  --kpi-weight: var(--fw-kpi);     /* 650 */
  --kpi-fg: var(--c-fg);
  --kpi-label-size: var(--fs-xs);  /* 11px 大写 */
  --kpi-label-fg: var(--c-fg-muted);
  --kpi-sub-border: 1px dashed var(--c-border);
  --kpi-sub-size: var(--fs-xs);
}
```

**结构**：`.k` 标签（11px 大写）→ `.v` 数值（23px 等宽）→ `.sub` 脚注（虚线分隔）。
**区块标题** `h2`：13px/600 + 左侧 3px `--c-accent` 竖条（沿用）。
**状态卡**（新增）：KPI 达到阈值时，`.v` 文字色切语义色（如 p95 超阈 → `--c-warn`），**不**改卡片底色。

#### §5.6 徽标 / 状态标签（Chip / Badge）

```css
:root {
  --chip-radius: 999px;
  --chip-pad: 1px 9px;
  --chip-font-size: var(--fs-sm); /* 12px */
  --chip-dot-size: 6px;
  --chip-bg: var(--c-surface-3);
  --chip-border: 1px solid var(--c-border);
  --chip-fg: var(--c-fg-muted);
}
```

| 语义变体 | class | 字色 | 边 | 底 | 用法 |
|---|---|---|---|---|---|
| 信息 | `.b` | `--c-info` | `--c-info-border` | `--c-info-bg` | 中性标记 |
| 正常 | `.g` | `--c-ok` | `--c-ok-border` | `--c-ok-bg` | 生效中/健康 |
| 告警 | `.y` | `--c-warn` | `--c-warn-border` | `--c-warn-bg` | 需关注/将耗尽 |
| 危险 | `.r` | `--c-danger` | `--c-danger-border` | `--c-danger-bg` | 已停用/熔断 |
| 中性 | `.n`（新增） | `--c-neutral` | `--c-border` | `--c-surface-3` | 未知/未启用 |
| 分层 free | `.tier-free` | `--c-tier-free` | `--c-tier-free-border` | `--c-tier-free-bg` | 套餐标签 |
| 分层 standard | `.tier-std` | `--c-tier-standard` | `--c-tier-standard-border` | `--c-tier-standard-bg` | 套餐标签 |
| 分层 pro | `.tier-pro` | `--c-tier-pro` | `--c-tier-pro-border` | `--c-tier-pro-bg` | 套餐标签 |

**结构**：前缀圆点（`currentColor` 6px）+ 文字。**色不可辨时用符号兜底**：`●` 正常 / `▲` 告警 / `■` 危险 / `◆` 半开 / `○` 未知——满足无障碍"不靠色"。

#### §5.7 进度条（MiniBar / HBar）

```css
:root {
  --bar-track-bg: var(--c-surface-3);
  --bar-radius: 999px;
  --bar-h-inline: 5px;   /* 行内 MiniBar（keys 用量/预算） */
  --bar-h-block: 8px;    /* hbar 块级（分布） */
  --bar-fill: var(--c-accent);
  --bar-fill-ok: var(--c-ok);
  --bar-fill-warn: var(--c-warn);
  --bar-fill-danger: var(--c-danger);
  --bar-dur: 200ms;      /* 宽度过渡 */
}
```

**阈值（沿用现有口径）**：`MiniBar` `>90%` 危险红 / `>70%` 告警黄 / 其余正常绿；`HBar` 按调用方 tone。**无障碍**：进度条须带 `role="progressbar"` + `aria-valuenow/min/max`，或旁附百分比文本（不能用纯色块）。

#### §5.8 Toast

```css
:root {
  --toast-bg: var(--c-surface-1);
  --toast-border: 1px solid var(--c-border);
  --toast-left-w: 3px;   /* 左侧语义条 */
  --toast-radius: var(--r-2);
  --toast-pad: 10px 15px;
  --toast-max-w: 560px;
  --toast-shadow: var(--sh-2);
  --z-toast: 90;
  --toast-dur: 4200ms;      /* 常规停留 */
  --toast-dur-error: 9000ms;/* 错误停留（沿用） */
  --toast-pos-bottom: var(--sp-5);
}
```

**语义**：左侧 3px 条 默认 `--c-info` / `.g` ok / `.y` warn / `.r` danger。**无障碍**：容器 `aria-live="polite"`（错误用 `assertive`），不抢焦点。

#### §5.9 空态（Empty）

```css
:root {
  --empty-fg: var(--c-fg-muted);
  --empty-icon-size: 22px;
  --empty-icon-opacity: .6;
  --empty-pad: var(--sp-5);
  --empty-font-size: var(--fs-md);
}
```

**结构**：文本符号图标（`○/▤/⚑`）+ 主文案 + 可选提示。**与加载态严格区分**：空态用 `○`，加载用骨架屏（§5.10）。

#### §5.10 骨架屏（Skeleton）

```css
:root {
  --skel-bg: var(--c-surface-2);
  --skel-radius: var(--r-1);
  --skel-dur: 1400ms;
  --skel-sheen: linear-gradient(90deg, transparent, rgba(255,255,255,.06), transparent);
  /* 亮色主题下 sheen 改为 rgba(0,0,0,.05)（沿用 styles.css 适配） */
}
```

**规则**：首载**必**用；加载完成 180ms 渐显（沿用现有）；`prefers-reduced-motion` 下停扫光。

#### §5.11 本部分元信息

- **目标**：把阶段1 附录 A.5「关键组件清单」逐项冻结为可调用的令牌 + 状态，保证下游零歧义实现。
- **输入**：`ui.tsx`（Tile/Chip/Empty/HBar/Note/MiniBar/Toast/rowA11y 实现）、`legacy.css` L24–37（按钮/输入）、L74–92（卡片/表格/chip）、L104–130（柱图/进度/note/toast/骨架）、L147–165（抽屉/秘钥/表单/行内进度）。
- **产出物**：§5.1–§5.10 十个组件令牌块（按钮/输入/表格/抽屉/卡片/徽标/进度/Toast/空态/骨架）。
- **关键决策**：① 组件**只给令牌引用**，不给死值（除已量化的尺寸）；② 徽标**新增中性态 `.n`** 与**三档分层色**；③ 进度/徽标强制"符号兜底"，落实"不靠色"无障碍；④ 保留"骨架≠空态"的视觉区分。
- **风险与待办**：① 徽标 8 种变体在窄屏可能换行，需阶段3 定"最多并显 2 个 + 溢出 `+N`"规则；② Toast `aria-live` 需确认不打断屏读；③ 抽屉焦点归还需在 Preact signals 下用 ref 存触发元素，阶段3 实现。

---

### §6 布局（Layout）

#### §6.0 应用壳层（Shell）—— 三区 CSS Grid

```css
:root {
  --layout-nav-w:    232px;  /* 侧栏宽（沿用 --nav-w） */
  --layout-topbar-h: 52px;   /* 顶栏高（沿用 --topbar-h） */
  --layout-nav-w-narrow: min(272px, 84vw); /* ≤960px 抽屉宽 */
  --layout-max: 1200px;
}
```

```css
#shell {
  display: grid;
  grid-template-areas: "top top" "nav main";
  grid-template-columns: var(--layout-nav-w) minmax(0, 1fr);
  grid-template-rows: auto minmax(0, 1fr);
  height: 100dvh;
}
#topbar  { grid-area: top;  z-index: var(--z-nav); min-height: var(--layout-topbar-h); }
#sidenav { grid-area: nav;  border-right: 1px solid var(--c-border); }
#shell main { grid-area: main; overflow-y: auto; max-width: var(--layout-max); margin: 0 auto; }
```

**布局原则**：
- **主内容区是唯一滚动容器**（`#shell` 本身不滚动），保证侧栏/顶栏常驻。
- **≤960px**：`grid-template-areas: "top" "main"`，侧栏脱离网格流 → `position:fixed` 抽屉 + `translateX(-100%)`，`#navscrim` 遮罩。
- **内容宽上限 1200px**（沿用），保证大屏不散架。

#### §6.1 顶栏（TopBar）

```css
:root {
  --topbar-bg: color-mix(in srgb, var(--c-surface-1) 88%, transparent);
  --topbar-blur: blur(8px);
  --topbar-gap: var(--sp-3);
  --topbar-pad: 10px var(--sp-5);
}
```

**内容分区（左→右）**：
1. **品牌** `.logo`（`asi-relay` 主名 + `<em>` 强调色副标 `管理面板`；≤960px 隐藏副标）。
2. **全局只读状态**：版本号 `.sub.ver`（≤960px 隐藏）、时钟 `.sub.clk`（≤960px 隐藏）、**数据新鲜度** `.sub.fresh`（**始终显示**，最窄屏保 34vw）。
3. `.spacer`。
4. **控件**：主题切换（`◐`）、刷新（`↻`）、汉堡键 `#nav-toggle`（仅 ≤960px 显示）、退出（`⎋`）。

> **关键决策**：窄屏**优先保留"数据新鲜度"**——它比版本/时钟更能回答运维"数还准不准"。这是 Linear「信息随重要性逐级裁切」的落地。

#### §6.2 侧栏（SideNav）—— 分组导航

**四组导航**（沿用 `state.ts#NAV_GROUPS`，按阶段1 §5.1 建议重排为"值守 → 经营 → 客户 → 系统"）：

| 分组 | 页签 | 定位 |
|---|---|---|
| **值守**（原"监控"） | 总览 `ov`、指标 `met`、请求账本 `ledger`、排障 `diag` | 值班/监控核心 |
| **经营**（原"配置"） | 客户 Key `users`、上游 `ch`、套餐目录（新增 N1）、成本毛利（新增 N5） | 钱与配置 |
| **客户** | 客户自助门户（新增 N2）、用量账单（新增 N4）、开发者文档（新增 N7） | 对外客户面 |
| **系统** | 运维 `ops`、信任 `trust`、审计合规（新增 N8）、知识库/Agent（内部位） | 平台与治理 |

```css
:root {
  --nav-item-h: 34px;              /* 导航项高（现有 7px+13px 行高≈34px） */
  --nav-item-radius: var(--r-1);   /* 6px */
  --nav-item-pad: 7px 16px 7px 13px;   /* 左 13px 为 3px 高亮条留位；右 16px。与原型 index.html 实测一致（P2-11 对齐） */
  --nav-item-font-size: var(--fs-md); /* 13px */
  --nav-item-fg: var(--c-fg-muted);
  --nav-item-fg-active: var(--c-fg);
  --nav-item-bg-hover: var(--c-surface-2);
  --nav-item-bg-active: color-mix(in srgb, var(--c-accent) 14%, transparent);
  --nav-item-indicator-w: 3px;     /* 左缘高亮条 */
  --nav-group-label-size: 10px;
  --nav-group-label-ls: 0.09em;
  --nav-group-label-fg: var(--c-fg-muted);
}
```

**导航项状态**：默认（`--c-fg-muted`）/悬停（字 `--c-fg` + 底 `--c-surface-2`）/**当前**（字 `--c-fg` + 600 + 底 accent 14% + 左缘 3px accent 竖条）。
**导航底部** `.nav-foot`：窗口 `window`、自动刷新开关、刷新间隔 `select`（全局控件沉底，与导航分离）。
**图标**：`.nv-ic` 18px 宽文本符号/内联 SVG（如 `▦ 总览 / ∿ 指标 / ☰ 账本 / ⚑ 排障`）。

#### §6.3 页签进 URL（路由契约）

- **形态**：`/admin#<tab>` 或 `/admin#<tab>/<anchor>`（如 `#diag/cheat-reason`）。
- **要求**：刷新/收藏/分享停留原处；页签切换用 `<a href="#tab">` 或 `button` + `location.hash`（沿用 `state.ts#goto`）。
- **新页签**（N1–N8）**必须**注册进 `TABS` 表并归入上表四组之一，**不得**出现"无 URL 的弹层页"。
- **锚点联动**：`#diag/cheat-reason` 等锚点须滚动定位并高亮目标（沿用）。

#### §6.4 本部分元信息

- **目标**：冻结"顶栏 + 侧栏 + 主内容"三区壳层、分组导航与 URL 路由契约，作为所有页面（含新增）的骨架。
- **输入**：`styles.css` L6–150（`#shell/#topbar/#sidenav/#navscrim` + ≤960px 抽屉）、L60–91（导航分组/当前态）；`state.ts#TABS/#NAV_GROUPS/#goto`；阶段1 §1.1（四组导航、11 页签）、§5.1（重排建议）、附录 B（新增页优先级）。
- **产出物**：§6.0 壳层 CSS、§6.1 顶栏分区、§6.2 四组导航 + 导航令牌、§6.3 路由契约。
- **关键决策**：① **分组从"监控/配置/智能/系统"重排为"值守/经营/客户/系统"**，把经营与客户面从"配置"里独立出来（呼应"从内部看板到双面产品"）；② 窄屏**保留数据新鲜度**优先于版本/时钟；③ 新增页签**强制进 URL、强制归属分组**。
- **风险与待办**：① 重排分组会改变用户肌肉记忆，需在阶段3 保留旧分组顺序作为可选项或做一次性提示；② "客户面"分组在运营令牌下是否暴露给非管理员，需按 §3.1 权限矩阵（阶段1）由登录态决定；③ `probeHermes` 硬编码 `127.0.0.1:8767` 的 iframe 需在重构中抽为配置（阶段1 §1.5 待办）。

---

### §7 深度与阴影（Depth & Elevation）

#### §7.0 层级模型

深色界面中**阴影很弱**，分层主要靠**背景色阶 + 1px 边框 + 阴影**三者叠加，而非大阴影。

```css
:root {
  --sh-1: 0 1px 2px rgba(0,0,0,.35);        /* 层级1：卡片/导航当前项 */
  --sh-2: 0 10px 30px rgba(0,0,0,.45);      /* 层级2：抽屉/Toast/登录框 */
  --sh-drawer: -18px 0 44px rgba(0,0,0,.5); /* 抽屉专用（向左投射） */
  --sh-focus: 0 0 0 3px var(--c-focus-ring);/* 焦点环（非阴影，视觉层） */
}
:root[data-theme="light"] {
  --sh-1: 0 1px 2px rgba(0,0,0,.08);
  --sh-2: 0 10px 30px rgba(0,0,0,.12);
  --sh-drawer: -18px 0 44px rgba(0,0,0,.18);
}
```

#### §7.1 Elevation 阶梯

| 层级 | 名称 | 背景 / 阴影 | 典型元素 |
|---|---|---|---|
| **E0** | 底 | `--c-bg`，无阴影 | 应用背景 |
| **E1** | 面 | `--c-surface-1` + 1px `--c-border` | 卡片 / 区块 / 侧栏 |
| **E2** | 浮 | `--c-surface-1` + `--sh-1` | 导航当前项 / chip 悬浮 |
| **E3** | 覆 | `--c-surface-1` + `--sh-2` | 抽屉（`--sh-drawer`）/ 登录框 |
| **E4** | 提 | `--c-surface-1` + `--sh-2` | Toast / 下拉 / 命令面板 |
| **E5** | 模态遮罩 | `rgba(0,0,0,.55)` | `#scrim` / `#navscrim` |

#### §7.2 Z-Index 契约

```css
:root {
  --z-base:     0;    /* 常规内容 */
  --z-topbar:   30;   /* 顶栏（沿用） */
  --z-scrim:    55;   /* 详情遮罩（沿用） */
  --z-drawer:   60;   /* 右侧抽屉（沿用） */
  --z-navscrim: 65;   /* 移动导航遮罩（沿用） */
  --z-nav:      70;   /* 移动侧栏（沿用） */
  --z-login:    80;   /* 登录门（沿用） */
  --z-toast:    90;   /* Toast（沿用，最高） */
  --z-tooltip:  100;  /* 悬浮提示（新增，最高） */
}
```

> **规则**：新组件必须从本表取 z-index，**禁止**在组件内写魔法数字。层序语义：登录门 > 移动侧栏 > 移动遮罩 > 抽屉 > 详情遮罩 > 顶栏 > 内容；Toast 恒在最上。

#### §7.3 本部分元信息

- **目标**：把"用边框分层、阴影克制"的深色界面深度模型显式化，并统一 z-index 契约。
- **输入**：`legacy.css` L10/L16（`--sh1/--sh2`）、L41/L49–50（登录/header）、L148–149（抽屉阴影）、L122–124（Toast）；`styles.css` L29（顶栏 z 30）、L123（navscrim z 65）、L142（侧栏 z 70）；`legacy.css` L39（登录 z 80）、L155（scrim z 55）、L148（抽屉 z 60）。
- **产出物**：§7.0 阴影令牌、§7.1 Elevation 阶梯（E0–E5）、§7.2 z-index 契约（9 档）。
- **关键决策**：① 深色下**阴影弱、边框强**（`--sh-1` 仅 0.35 黑）；② 抽屉用**专用向左阴影** `--sh-drawer`；③ z-index 全部集中为令牌（现有 8 档 + 新增 tooltip）。
- **风险与待办**：① 亮色主题下阴影需整体减弱（已在 §7.0 映射）；② 新增 tooltip 层级（100）需确认不与 Toast（90）冲突；③ 若客户面引入"卡片悬浮抬升"动效，需复核 `--sh-1/2` 亮色值。

---

### §8 动效（Motion）

#### §8.0 时长与缓动

```css
:root {
  --dur-instant: 80ms;   /* 按钮按下、颜色微变 */
  --dur-fast:    120ms;  /* 悬停、边框色、导航切换（沿用 .12s） */
  --dur-base:    180ms;  /* 内容渐显（沿用 180ms） */
  --dur-slow:    220ms;  /* 抽屉滑入、侧栏滑出（沿用 .22s） */
  --dur-sheen:   1400ms; /* 骨架扫光（沿用） */
  --dur-bar:     200ms;  /* 进度条宽度、柱图高度（沿用） */

  --ease-standard: cubic-bezier(.22,.61,.36,1); /* 抽屉/侧栏（沿用） */
  --ease-out:      cubic-bezier(0,0,.2,1);      /* 通用出场 */
  --ease-in-out:   cubic-bezier(.4,0,.2,1);     /* 状态切换 */
}
```

#### §8.1 动效清单

| 动效 | 时长 | 缓动 | 令牌 |
|---|---|---|---|
| 抽屉滑入/滑出 | 220ms | `--ease-standard` | `--dur-slow` |
| 移动侧栏滑出 | 220ms | `--ease-standard` | `--dur-slow` |
| 内容渐显（`fadeIn`） | 180ms | `--ease-out` | `--dur-base` |
| 悬停颜色/边框 | 120ms | linear | `--dur-fast` |
| 按钮按下下移 1px | 80ms | linear | `--dur-instant` |
| 进度条宽度 | 200ms | linear | `--dur-bar` |
| 骨架扫光 | 1400ms 循环 | linear | `--dur-sheen` |
| Toast 进出 | 180ms | `--ease-out` | `--dur-base` |

#### §8.2 减少动效（硬要求）

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: .01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: .01ms !important;
  }
}
```

> 沿用现有 `styles.css` L152–159 实现。**新组件必须在此规则覆盖范围内**（即所有动效均用 CSS transition/animation，便于被全局关停）。

#### §8.3 本部分元信息

- **目标**：冻结动效时长/缓动阶梯，并强制 `prefers-reduced-motion` 全局尊重。
- **输入**：`legacy.css` L24/L30/L108/L113/L167（控件过渡、柱图/进度过渡、fadeIn）；`styles.css` L82–89（导航过渡）、L144（侧栏缓动）、L152–159（reduced-motion）。
- **产出物**：§8.0 时长/缓动令牌（6 时长 + 3 缓动）、§8.1 动效清单（8 项）、§8.2 reduced-motion 规则。
- **关键决策**：① 动效**一律用 CSS transition/animation**（不用 JS 动画/requestAnimationFrame），以保住"全局一键关停"能力；② 时长普遍**短促**（80–220ms），符合技术工具感（不要消费级的 400ms 弹跳）。
- **风险与待办**：① 骨架扫光在 reduced-motion 下虽停，但 `--skel-bg` 静态底色仍在，需确认其对比度可辨识"这是加载中"；② 若客户面引入更强动效品牌感，需局部豁免并单独声明。

---

### §9 无障碍（Accessibility）

#### §9.0 对比度（沿用已过 AA 的色值）

- 正文/主文本 ≥ **4.5:1**（`--c-fg` / `--c-bg` = 14.6:1 ✅）。
- 大标题/大数字（≥23px）≥ **3:1**。
- 次要文本 `--c-fg-muted` 对 `--c-surface-1` = 4.6:1 ✅（详表见 §2.2）。
- **禁止**：语义色底 + 同色文字（必须"12% 透明底 + 语义描边 + 常规文字"）。

#### §9.1 焦点管理（Focus）

```css
:root { --c-focus-ring: rgba(88,166,255,.45); } /* 沿用；亮色 rgba(9,105,218,.35) */
:focus-visible { outline: 2px solid var(--c-accent); outline-offset: 1px; } /* 沿用 */
```

**规则**：
- 全站键盘焦点用 `:focus-visible`（鼠标点击**不**画焦点框，键盘操作才画）。
- **抽屉**：打开时焦点移入抽屉标题（`tabindex="-1"`）；关闭时**归还触发元素**（§5.4 待办）；`Esc` 关闭；焦点**锁定**在抽屉内（Tab 循环）。
- **移动侧栏**：`Esc` 先关抽屉、再关侧栏（沿用 `main.tsx` 语义）；关侧栏后焦点回主内容开头（沿用 `styles.css` L148 注释意图）。
- **抽屉容器程序化获焦不画框**：`#drawer:focus, #drawer:focus-visible { outline: none }`（沿用）。

#### §9.2 键盘操作契约

| 键 | 行为 |
|---|---|
| `Tab` / `Shift+Tab` | 顺序遍历；抽屉/弹层内循环 |
| `Enter` / `Space` | 激活按钮/可点击行 |
| `Esc` | 关抽屉 → 关移动侧栏（逐级） |
| 方向键 | 表格/列表内可选导航（新增页若做命令面板：↑↓ 选项、Enter 确认） |

#### §9.3 非色彩线索（不靠色）

- 状态徽标**色 + 符号**双编码（`●▲■◆○`，见 §5.6）。
- 进度条**色 + 数值文本**（百分比或绝对值，见 §5.7）。
- 图表（柱图/分布）**色 + 轴标签 + 数值**（沿用 `.bars-axis`）。
- 错误提示**色 + 图标 + 文字**（Toast `.r` + `■` + 文案）。

#### §9.4 语义与屏读

- 可点击行用 `.row-act` **真实按钮**撑满整行（屏读播报行内容，沿用 `ui.tsx#rowA11y` 改造）。
- Toast 容器 `aria-live="polite"`（错误 `assertive`）。
- 表单 `label` 与控件关联（`.f label` + `for`）；错误提示 `aria-describedby` 关联。
- 抽屉 `role="dialog"` + `aria-modal="true"` + `aria-labelledby` 指向标题。

#### §9.5 触控目标（沿用 mobile.css）

- 粗指针/≤720px：按钮/链接/`summary` 最小高 **40px**，侧栏项 **44px**，表单控件 ≥42px 且字号 16px（防 iOS 缩放）。
- 桌面紧凑密度 `--density-control-h: 30px` 允许，但**触控设备强制 42px**（via `@media (pointer: coarse)`）。

#### §9.6 本部分元信息

- **目标**：把无障碍从"事后补"变成"令牌内置"，确保平台化后可对客户/监管声明可达性。
- **输入**：`legacy.css` L2（AA 声明）、L26–27（focus-ring）、`styles.css` L152–159/L219（reduced-motion、抽屉获焦）、`mobile.css`（触控目标）；`ui.tsx#rowA11y`（可点击行语义）。
- **产出物**：§9.0 对比度、§9.1 焦点管理、§9.2 键盘契约、§9.3 非色彩线索、§9.4 语义/屏读、§9.5 触控目标。
- **关键决策**：① 无障碍要求**写进组件令牌**（徽标/进度强制符号兜底）；② `:focus-visible` 而非 `:focus`（鼠标不画框）；③ 抽屉焦点**锁定 + 归还**双要求。
- **风险与待办**：① 抽屉焦点锁定/归还需阶段3 在 Preact 下用 `ref` 实现并测试；② 命令面板（若新增）需额外键盘可达测试；③ 需在阶段4 审查跑一次"仅键盘 + 屏读"全流程走查。

---

## 第二部分 · 落地清单与给下游（原型构建师）的要点

### A. 令牌落地顺序（建议）

1. **建 `tokens.css`**：把 §2–§9 的 `:root` 块原样落地（暗色 + 亮色 + compact/cozy 三态）。
2. **别名层**：在 `tokens.css` 末尾加 `--bg: var(--c-bg); --panel: var(--c-surface-1); …`（§2.2 映射表），保证旧 CSS 不动即生效。
3. **收敛硬编码**：按 §2.3 清单把 11 处硬编码替换为令牌（唯一需要改现有 CSS 的地方）。
4. **新增组件样式**：按 §5 令牌实现"新增页签"所需组件（套餐卡、账单表、审批队列等）。
5. **密度开关**：根节点按"运营面/客户面"切 `data-density`。

### B. 给原型构建师（阶段3）的 7 条落地要点

1. **只用令牌，不写死值**：任何新页面出现的色/尺寸，必须能在本文件找到对应 `--xxx`；找不到就先回本文件补。
2. **暗色优先，双主题同源**：新页面先在暗色下做，再在 `:root[data-theme="light"]` 下验一遍；不要为亮色单独写组件样式。
3. **数字列三件套**：`tabular-nums` + 右对齐（`.num`）+ 等宽字体（`--font-mono`），一个都不能少。
4. **双面密度**：运营面 `data-density="compact"`、客户面 `data-density="cozy"`；客户面**放大行高与留白、减少列数**，不要把运营表格直接搬过去。
5. **零依赖**：图标**只用文本符号或内联 SVG**；字体**只用系统栈**；**禁止**任何 CDN/`@import url()` 外部资源。
6. **状态四态齐全**：任何状态展示都要覆盖 `ok/warn/danger/info`（+ `neutral` 兜底"未知"），并**色 + 符号**双编码。
7. **红线不可暗示**：组件/文案**不得**暗示"改写成功响应/缓存/去重/Agent 平台能力"（阶段1 §5.2 硬边界）；`X-Relay-Mode` 这类透明性信息**应**可见。

### C. 待确认 / 待办清单（回流）

| # | 事项 | 依赖 | 状态 |
|---|---|---|---|
| D1 | 品牌资产 M1（Logo/主色/字体手册）是否提供 | 用户 | 未提供 → 本轮按 Linear 基因 + 现有色值推进，"占位待替换" |
| D2 | 是否坚持 Linear 原生紫蓝强调色 | 用户 | 默认**否**（保留现有蓝） |
| D3 | 分组导航重排（值守/经营/客户/系统）是否接受 | 用户 | 默认**接受** |
| D4 | 硬编码收敛 11 处（§2.3）是否本轮做 | 阶段3 | 建议做（低风险） |
| D5 | 抽屉焦点锁定/归还的 Preact 实现 | 阶段3 | 待实现 |
| D6 | 徽标窄屏"最多并显 2 个 + 溢出"规则 | 阶段3 | 待定 |
| D7 | 客户面是否需英文版（M9） | 用户 | 字体栈已备西文兜底 |
| D8 | `probeHermes` 硬编码抽配置（阶段1 §1.5） | 阶段3 | 待办 |

---

## 附录 · 令牌速查（复制即用）

```css
/* ===== api-relay design tokens v1.0 · Linear 基因 + GitHub 暗色色值 ===== */
:root{
/* surface */--c-bg:#0d1117;--c-surface-1:#161b22;--c-surface-2:#1b212a;--c-surface-3:#21262d;
--c-surface-code:#0b0f14;--c-surface-hover:#2a313a;--c-border:#30363d;--c-border-subtle:#222831;--c-border-hover:#3d444d;
/* fg */--c-fg:#e6edf3;--c-fg-muted:#8b949e;--c-fg-subtle:#6e7681;--c-fg-invert:#fff;
/* accent */--c-accent:#58a6ff;--c-accent-strong:#1f6feb;--c-accent-strong-hover:#2a7ff5;--c-focus-ring:rgba(88,166,255,.45);--c-login-glow:#16273d;
/* semantic */--c-ok:#3fb950;--c-warn:#d29922;--c-danger:#f85149;--c-info:#58a6ff;--c-neutral:#7d8590;--c-purple:#bc8cff;--c-agent:#bc8cff;
/* upstream */--c-upstream-ok:#3fb950;--c-upstream-degraded:#d29922;--c-upstream-halfopen:#bc8cff;--c-upstream-open:#f85149;--c-upstream-disabled:#6e7681;--c-upstream-limit:#d29922;
/* tier */--c-tier-free:#7d8590;--c-tier-free-bg:rgba(125,133,144,.12);--c-tier-free-border:#424851;
--c-tier-standard:#58a6ff;--c-tier-standard-bg:rgba(88,166,255,.12);--c-tier-standard-border:#1f6feb;
--c-tier-pro:#a371f7;--c-tier-pro-bg:rgba(163,113,247,.14);--c-tier-pro-border:#8957e5;
/* border aux */--c-ok-border:#2b6a35;--c-warn-border:#5c4a12;--c-danger-border:#6e2b28;--c-info-border:#1f6feb;
--c-ok-bg:rgba(63,185,80,.12);--c-warn-bg:rgba(210,153,34,.12);--c-danger-bg:rgba(248,81,73,.12);--c-info-bg:rgba(31,111,235,.12);
/* type */--font-sans:system-ui,-apple-system,"Segoe UI",Roboto,"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC",sans-serif;
--font-mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,"Liberation Mono","Courier New",monospace;--font-num:var(--font-mono);
--fs-2xs:10px;--fs-xs:11px;--fs-sm:12px;--fs-md:13px;--fs-base:14px;--fs-lg:15px;--fs-xl:17px;--fs-2xl:23px;--fs-3xl:28px;
--lh-tight:1.25;--lh-snug:1.45;--lh-base:1.6;--lh-relaxed:1.65;
--fw-regular:400;--fw-medium:500;--fw-semibold:600;--fw-bold:700;--fw-kpi:650;--ls-tight:-.02em;--ls-label:.06em;--ls-group:.09em;
/* space */--sp-0:0;--sp-1:4px;--sp-2:8px;--sp-2h:10px;--sp-3:12px;--sp-4:16px;--sp-5:22px;--sp-6:28px;--sp-7:32px;--sp-8:40px;--sp-9:80px;
/* radius */--r-sm:4px;--r-1:6px;--r-2:10px;--r-3:14px;--r-full:999px;
/* shadow */--sh-1:0 1px 2px rgba(0,0,0,.35);--sh-2:0 10px 30px rgba(0,0,0,.45);--sh-drawer:-18px 0 44px rgba(0,0,0,.5);
/* z */--z-base:0;--z-topbar:30;--z-scrim:55;--z-drawer:60;--z-navscrim:65;--z-nav:70;--z-login:80;--z-toast:90;--z-tooltip:100;
/* motion */--dur-instant:80ms;--dur-fast:120ms;--dur-base:180ms;--dur-slow:220ms;--dur-sheen:1400ms;--dur-bar:200ms;
--ease-standard:cubic-bezier(.22,.61,.36,1);--ease-out:cubic-bezier(0,0,.2,1);--ease-in-out:cubic-bezier(.4,0,.2,1);
/* layout */--layout-nav-w:232px;--layout-topbar-h:52px;--layout-max:1200px;--layout-gutter:var(--sp-5);--grid-gap:var(--sp-3);
/* density (default compact) */--density-row-h:36px;--density-cell-pad-y:11px;--density-cell-pad-x:var(--sp-3);--density-card-pad:var(--sp-4);
--density-main-pad:var(--sp-5) var(--sp-5) var(--sp-9);--density-control-h:30px;--density-gap:var(--sp-3);
/* 旧变量别名（零侵入迁移） */--bg:var(--c-bg);--panel:var(--c-surface-1);--panel2:var(--c-surface-2);--chip:var(--c-surface-3);
--fg:var(--c-fg);--dim:var(--c-fg-muted);--accent:var(--c-accent);--ok:var(--c-ok);--warn:var(--c-warn);--err:var(--c-danger);--pur:var(--c-purple);
--s1:var(--sp-1);--s2:var(--sp-2);--s3:var(--sp-3);--s4:var(--sp-4);--s5:var(--sp-5);--r1:var(--r-1);--r2:var(--r-2);--r3:var(--r-3);
--mono:var(--font-mono);--focus:var(--c-focus-ring);--nav-w:var(--layout-nav-w);--topbar-h:var(--layout-topbar-h);
}
```

---

*本文为阶段2 的最终产出基线；任何视觉/组件决策以本文件为准。若用户反馈变更，须回溯更新本文对应章节并同步阶段3 原型。*