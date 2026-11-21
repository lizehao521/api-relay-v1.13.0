# 交付物索引（readme/）

本目录是作品的「环境依赖说明 / 部署步骤 / 运行指南」，与赛题要求逐项对应。当前版本 **v1.13.0**。

## 文件

| 文件 | 内容 |
|---|---|
| `README.md` | 本文件：交付物索引 + 部署要点 |
| `码道应用总结.md` | 使用华为云码道（CodeArts）开发本作品的过程总结（需求 → 生成 → 测试 → 迭代） |
| `开源组件说明.md` | 用到的开源组件与许可证清单（合规声明） |
| `更新说明-v1.13.0.md` | **当前版本**更新记录（商户 token 券闭环 M0 / 商业扩展材料 / 测试 505） |
| `更新说明-v1.12.0.md` | 历史版本（模型链重设计 / 主配置与阶梯分离 / 中文档位链名） |
| `更新说明-v1.11.0.md` | 历史版本记录（平台四件套、线上部署实录） |
| `更新说明-v1.8.0.md` | 历史版本更新记录 |
| `环境依赖与一键安装.md` | **环境依赖说明 + 一键安装**（对应规范 readme 第 1 项） |
| `install.sh` | **一键安装脚本（Linux/macOS）**：`bash readme/install.sh`（校验 Node → 装依赖 → 构建） |
| `install.ps1` | **一键安装脚本（Windows）**：`powershell -ExecutionPolicy Bypass -File readme\install.ps1` |
| `评分标准对照与自评表.md` | **100 分评分标准逐维度 → 包内证据对照**（交付自评，供评委定位） |
| `组合方案部署说明.md` | **本作品为什么是两层 + 一台机器怎么跑通**：8787 底座 / 8788 工作台的端口拓扑、nginx 与 CSP 覆盖、上线踩过的三个真实坑 |
| `线上部署说明.md` | 线上实例的网络 / 安全组注意事项 |
| `api-relay.service` | systemd 单元文件（Linux 上常驻运行） |
| `../ppt/商业扩展-VibePay融合方案.pdf` | **商业扩展方案（12 页详版）**：商户 token 券闭环（M0）如何承接 AI 应用收款，Vibe Pay 融合路径 M0–M4 |
| `../ppt/附属商业篇-权益中枢.pdf` | **附属商业篇（9 页精简版）**：定位一句话 + 已有权益内核 + 单店成本测算 + 单店盈亏与回本门槛 + 风险与合规 + 路线图，供答辩现场快速过 |

## 运行环境

- Node.js ≥ 22.5.0（使用内置 `node:sqlite`，无需额外数据库）。
- 后端**零第三方运行期依赖**；管理面板为 `dist-admin/` 静态产物（Vite 构建）。

## 部署与运行要点

1. 进入 `project/`，`npm install`（仅装构建期依赖：typescript / vite / tsx 等）。
2. `npm run build` —— 编译后端（`dist/`）并构建管理面板（`dist-admin/`）。
3. 准备配置：以 `relay-net.yaml` 为完整示例；上游与客户端密钥一律走 `{ENV:...}` 插值，**不落明文**。
4. 启动：`node --disable-warning=ExperimentalWarning dist/cli.js serve --config relay-net.yaml`（或 `npm run start`）。
5. 常驻：参考 `api-relay.service`（`systemctl enable --now api-relay`）。
6. 自检：`curl http://127.0.0.1:8787/healthz`；管理面板 `http://<host>:8787/admin`。
7. 测试：`npm test`（单元 + 端到端，当前 **505 项全绿**；2026-11-03 实跑 505/505）。
8. 商户闭环（M0）接口：`GET/POST /admin/api/merchant/{quota,vouchers,redemptions}`，详见 `更新说明-v1.13.0.md` §1。
9. 组合方案的应用层 CodeLens：源码在 `project/codelens/`，构建与安装见 `组合方案部署说明.md` §3（8789 仅本机监听，8788 经 nginx 对外）。

## 线上实例（本作品）

- 评委展示页：`http://1.92.92.200:8787/judge`（含作品介绍、架构图、演示视频、只读看板入口）。
- 视频直链：`http://1.92.92.200:8787/judge/video.mp4`。
- CodeLens 工作台（组合方案应用层）：`http://1.92.92.200:8788/?token=codelens2026`（免密直链，点开即用）；备用 Basic Auth 账号 `demo` / `codelens2026`。
- 网络提示：云安全组已放行 **22 / 8787 / 8788**；8788 为 nginx 入口，CodeLens 本体仅监听 `127.0.0.1:8789`，不对外。

> 完整工程说明见 `project/README.md`；架构 / 设计 / 研究见 `project/docs/`；决策记录见 `project/DECISIONS.md`；
> 打包规范见 `project/docs/竞赛作品打包指南.md`。