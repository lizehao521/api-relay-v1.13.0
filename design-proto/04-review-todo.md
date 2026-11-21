# 审查需完成清单（design-proto · 阶段4 衍生）· 执行回填版

> 性质：**可勾选待办清单**（原型/文档已按本清单执行；运行时代码不改）
> 来源：`design-proto/04-review.md`（复审版 **v1.2**，第 3 轮复审；结论 **PASS**，24/25，**P0=0、P1=0**）
> 配套：`03-prototype-spec.md` §9、`05-delivery.md`
> 执行：2026-10-26 · 回滚基线 git `4ed0d18`（逐项 commit 见 §提交索引）
> 状态图例：✅ 已完成 ｜ ⏸ 待真值/待后端 ｜ 🖐 待人工 ｜ ⬜ 未开始

---

## 0. 放行门禁定义（原 + 本轮新增）

| 门禁 | 规则 | 来源 |
|---|---|---|
| **原门禁** | 5 维度每维 ≥3 且 **P0=0** 且 **P1≤3** → PASS | `04-review` L6 |
| **新增门禁** | **真机全流程走查必做**（§D）——`inert`/`backdrop-filter`/`100dvh` 兼容性 + 键盘/屏读走查 | 本清单 §D（用户确认） |

> §D 未全过 → **不放行到交付**。

## 1. 图例

- 勾选：`- [ ]` 待办 / `- [x]` 已完成；优先级 **P0**/**P1**/**P2**

---

## A. AC 验收清单未闭环项

- [x] **A1 · AC-03**【P1】`#/diag/cheat-reason` 锚点滚动 + 高亮 —— ✅ 已完成
  - 实现：`tpl-diag` 增 `id="cheat-reason"` 速查块；路由新增 `applyAnchor()`（`scrollIntoView` + `.anchor-target` 高亮 2.2s）；`hashchange` 同页锚点分支。
  - 证据：`.anchor-target` CSS、`id="cheat-reason"`、`function applyAnchor()`、`afterRender();applyAnchor();`、`else { applyAnchor(); }`；校验脚本四项 true。
- [ ] **A2 · AC-27**【P1】`client` 仅见自身 `tenantId` → **⏸ 待真值**
  - 处置：原型层已达成字段/交互；后端 `tenantId` 过滤（Q6）待落地。登记见 `04-review-pending-values.md` C2（REQ-07）。

---

## B. P2 残留

- [x] **B1 · P2-9**【P2】8 处低频静态控件 —— ✅ 已完成（按"README 明示静态示意"口径）
  - 证据：`prototype/README.md` 新增「🟡 P2-9 静态控件清单」逐处标注（route/billing/observ/audit/ops/docs/portal-win/more-actions）。
- [x] **B2 · P2-10**【P2】`#/diag/cheat-reason` 锚点定位 —— ✅ 已完成（与 A1 同源）
- [x] **B3 · P2-11**【P2】`--nav-item-pad` 对齐 —— ✅ 已完成（回溯更新 `02-design-system.md` §6.2 至原型实测 `7px 16px 7px 13px`）
- [x] **B4 · P2-12**【P2】`button` 内嵌 `select` 标记 —— ✅ 已完成（`#portal-win` 改 `label` + `button.b,label.b` 令牌样式）
  - 证据：校验脚本 `button>select still present : false`。
- [x] **B5 · P2-13**【P2】docs 表 `✅/❌` emoji —— ✅ 已完成（改 `●/○` 并加两处图例）
  - 证据：校验脚本 `emoji ✅/❌ still present : false`。

---

## C. 交付阶段残留建议

- [ ] **C1**【P1】示意数据 → 真值（M1 品牌 / M2 定价）—— **⏸ 待真值**（不编造）
- [ ] **C2**【P1】后端实现依赖（REQ-01/02/09/12、REQ-07、REQ-03）—— **⏸ 待后端**
- [ ] **C3**【P1】迁移点（原型→Preact）—— **⏸ 待落地**
  - 处置：三项登记于 `04-review-pending-values.md`（C1/C2/C3 三表）。

---

## D. 真机全流程走查（**必做门槛**）★

> 已产出**脚本 + 记录模板**：`design-proto/04-review-walkthrough.md`。**人工执行**（本环境无真机）。

- [ ] **D1 · 浏览器兼容实测**【P1】—— 🖐 待人工
- [ ] **D2 · 键盘可达全流程**【P1】—— 🖐 待人工
- [ ] **D3 · 屏读走查**【P1】—— 🖐 待人工
- [ ] **D4 · 走查脚本化留证**【P1】—— 🖐 待人工（§5 自动化预检已可跑：`node .verify_proto.cjs`）

---

## E. 文档一致性回填（`05-delivery` 未随 `04` v1.2 同步）

- [x] **E1**【P2】`05-delivery` 审查报告版本 `v1.1` → `v1.2` —— ✅ 已完成（L7/L35/L511）
- [x] **E2**【P2】`05-delivery` 原型大小 `140,707B/1840行` → 真值 —— ✅ 已完成（L6/L70/L511 回填；附录 C 增 r1 增补）
- [x] **E3**【P2】§8.2 版本口径同步 v1.2 —— ✅ 已完成

---

## F. 新交付物（已补 AC + 审查报告）

- [x] **F1** 为 `AGENT-L3-L4-升级方案.md` 补 AC 验收清单 —— ✅ 已完成：`project/docs/AGENT-L3-L4-验收清单.md`（AC-01~AC-34）
- [x] **F2** 质量审查报告 —— ✅ 已完成：`project/docs/AGENT-L3-L4-审查报告.md`（5 维 24/25，PASS，P0=0）

---

## 汇总（回填后）

| 段 | 项数 | 已完成 ✅ | 待真值/后端 ⏸ | 待人工 🖐 | 优先级 |
|---|---|---|---|---|---|
| A AC 未闭环 | 2 | 1 | 1 | 0 | P1×2 |
| B P2 残留 | 5 | 5 | 0 | 0 | P2×5 |
| C 交付残留建议 | 3 | 0 | 3 | 0 | P1×3 |
| D 真机走查（★门槛） | 4 | 0 | 0 | 4 | P1×4 |
| E 文档一致性 | 3 | 3 | 0 | 0 | P2×3 |
| F 新交付物 | 2 | 2 | 0 | 0 | — |
| **合计** | **19** | **11** | **4** | **4** | — |

> **当前结论**：可本地闭环项（A1、B1–B5、E1–E3、F1–F2）**11/19 已完成**并逐项 commit；A2/C 为**待真值**、D 为**待人工**（用户口径："到时候云服务器操作"）。**§D 未过 → 未达交付终态。**

## 提交索引（回滚点 · git）

| commit | 内容 |
|---|---|
| `4ed0d18` | baseline（执行前快照 · 回滚点；0 密钥入库） |
| `024ab40` | A1+B2 锚点定位/高亮 |
| `90d940b` | B3 `--nav-item-pad` 对齐 |
| `f62385f` | B4+B5 portal 去 `button>select` + docs 表 `●/○` |
| `14e023d` | B1 README 静态控件清单 |
| `eed5faa` | E1-E3 05 文档一致性回填 |
| `433b812` | D 真机走查手册 |
| `f35b56e` | C 待真值/待后端登记表 |
| （F） | F1+F2 L3-L4 方案 AC + 审查报告 |

> **任意回滚**：`git reset --hard <commit>`；或 `git revert <commit>`。

> **回写约定**：A2/C/D 完成后把 `[ ]` 改 `[x]` 并附证据；§D 全部勾选前视为"未达交付终态"。