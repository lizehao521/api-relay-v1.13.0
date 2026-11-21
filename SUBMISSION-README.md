# api-relay 作品提交包说明（v1.13.0）

本包为「2026 华为开发者大赛 · 智能体创新赛」区域赛作品提交材料，按《作品提交规范》组织，
**命名**：`api-relay+落幕+v1.13.0+li1119489753@outlook.com`（作品名称+队伍名称+版本号+联系方式）。

> **一句话定位**：api-relay 是**智能体的基础设施层**——错误可执行 · 数据可信 · 损耗可度量。
> 我们没有再造一个 Agent，而是做所有 Agent 都要站的那层地基。

## 1. 包结构（对应提交规范要求的 5 部分）

| 目录 | 内容 | 对应材料 |
|---|---|---|
| `ppt/` | 作品整体介绍 **PDF**（14 页：场景背景/方案设计/核心功能/码道应用/创新亮点/落地规划）+ **商业扩展 PDF**（12 页详版：Vibe Pay 融合方案，权益内核 ↔ AI 应用收款）+ **附属商业篇 PDF**（9 页精简版：单店测算 / 单店盈亏 / 风险与合规 / M0–M4 路线）+ 答辩文稿 | 整体介绍 PPT |
| `project/` | **完整工程源码**（OpenAI 兼容聚合网关 + 管理面板），含 `docs/`、`dist/`、`dist-admin/`（构建产物同批次重建，可直接运行） | 作品 Demo / 源码 |
| `video/` | 演示视频 `api-relay-demo.mp4`（≤3 分钟）+ 在线链接 + 分镜脚本 | 功能演示视频 |
| `codearts_proof/` | 码道（CodeArts）使用证明：使用总览（**42 个真实会话 / 5.70 亿 tokens**，覆盖平台四件套与线上部署）、Prompt 证据存档、截图清单与 **18 张截图**（`screenshots/S-01~S-18.png`） | 码道使用证明 |
| `readme/` | 索引、**环境依赖与一键安装（含 `install.sh`）**、部署步骤、开源组件说明、码道应用总结、**评分标准对照与自评表** | 说明文档 |

> 附加材料（增强"界面交互专业度/专业贴合"证据）：`design-proto/`（交互原型 + 4 份审查文档，审查 PASS 24/25）、`deliverables/`（竞品与产品策略分析）。

## 2. 版本说明

- 包名与包内版本统一为 **v1.13.0**，与 `project/package.json` 的 `version` 一致。
- 本版为**商业化闭环 M0 + 商业扩展材料**迭代：新增商户 token 券闭环（额度池 → 发券 → 领券发 Key → 核销计费，6 条管理接口）与 12 页商业扩展 PPT；网关协议与面板 14 页签不变。v1.12.0 的配置治理（主档/阶梯分离、中文档位链名）继续保留；详见 `readme/更新说明-v1.13.0.md`。
- 源码与 `dist/`、`dist-admin/` **同批次重建**（`npm run build`，含前端 `vite build`），二者一致、可直接运行。
- 交付前实跑校验（2026-11-03）：`npm test` **505/505 全绿**、`npm run e2e` **40/40 全绿**；解压本包后 `npm run demo` **5/5 项自检通过**；M0 商户接口已随源码部署到线上 `/admin/api/merchant/*` 并验证 200。
- 本版包含近期改进：**商业化闭环 M0（商户 token 券）**——额度池 → 发券 → 领券发 Key → 核销计费全链路，含 6 条商户管理接口与 21 项新增测试（见 `readme/更新说明-v1.13.0.md` §1）；**平台化四件套**（多租户/RBAC、计费账务、分布式状态原语、协议适配 + REQ-03 流式错误帧；见 `project/DECISIONS.md` ADR-025~032）、客户 key 额度机制、一致性/可观测性修复，以及内置 Agent 的 **L3→L4 升级方案 + 审查报告**（`project/docs/AGENT-L3-L4-*.md`）。

## 3. 复现（零密钥，约 3 分钟）

要求 Node **≥ 22.5.0**。

```bash
# 一键安装（Linux/macOS）
bash readme/install.sh
# 一键安装（Windows / PowerShell）
powershell -ExecutionPolicy Bypass -File readme\install.ps1
# 等价手动步骤
cd project && npm install && npm --prefix frontend install && npm run build

# 离线复现（mock 上游，无需任何密钥）
cd project && npm run mock     # 终端 A
cd project && npm run start    # 终端 B → 打开 http://127.0.0.1:8787/admin
# 或一键 Demo（自动起 mock+网关并跑 5 项自检）
bash project/demo.sh
```

Windows：`readme/环境依赖与一键安装.md` §2.2 提供了等价 PowerShell 命令。

## 4. 评分标准对照

逐维度（功能完备度 30 / 码道深度使用 25 / 专业贴合与创新 25 / 技术架构与工程质量 15 / 交付规范性 5）
的证据定位见 **`readme/评分标准对照与自评表.md`**。

## 5. 有意排除（不在本包内）

- `node_modules/`：依赖由 `package.json`/`package-lock.json` 声明，`install.sh` 一键安装。
- `data/`：运行时数据库（`relay.db`/`kb.db` 及 WAL），首次运行自动创建。
- 调试产物：`project/.verify/`、`project/.verify-r2/`、`_dev-notes/`（未发布版本说明与旧包备份）。
- **敏感文件**：`api-relay-root-pwd.txt`、`id_api_relay`、`.relay.env`、各私有 `*.pem`——**一律不入包**。
- 工具元数据：`.git/`、`.arts/`、`.codeartsdoer/`、`.opencode/`、`.resultverify/`、`.merkle-snapshot.json`。

## 6. 线上演示

- 评委展示页：`http://121.36.29.96:8787/judge`（作品介绍 + 架构图 + 演示视频 + 只读看板入口）。
- 网络：云安全组已放行 **22 / 8787**；如需访问演示实例 **8788**，请在华为云控制台放行入方向 TCP 8788（`readme/线上部署说明.md`）。

进一步阅读：`project/README.md`、`project/docs/`（架构/设计/部署/研究）、`project/DECISIONS.md`、`project/docs/竞赛作品打包指南.md`。