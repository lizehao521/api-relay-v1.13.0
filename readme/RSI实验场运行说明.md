# RSI 受控自我改进实验场 · 运行说明

## 1. 环境依赖

- Node.js ≥ 22（用到 `node --test` 与原生 fetch）
- git（沙箱提交链）
- 可选：Microsoft Edge + puppeteer-core（仅 `dashboard/verify-render.mjs` 渲染校验用，非运行依赖）

## 2. 一键自检

```bash
cd project/rsi-lab
npm test          # 期望：53 tests / 53 pass / 0 fail
```

## 3. 演示运行

```bash
# 观测看板（零依赖 HTTP，127.0.0.1:18800）
node dashboard/server.mjs
# 浏览器打开 http://127.0.0.1:18800

# 自改进循环（需 credentials.local.json 与本地 CodeLens 18791；详见项目主 readme）
node runner/run-loop.mjs --rounds 3
```

## 4. 结构

```
rsi-lab/
  runner/    verdict.mjs（R1–R6 判据）、gate.mjs（接缝）、one-round.mjs（单轮+超时留痕）、
             run-loop.mjs（多轮+扩靶子）、milestone.mjs（靶子模板）、lib.mjs（沙箱/评测/提示词）
  dashboard/ data.mjs + server.mjs + index.html（四态判定列、账本链、17 轮明细）
  tests/     53 条单测（R1–R6 对抗、超时留痕、看板数据层）
  sandbox/   靶子工程（git 10 提交，HEAD=bad34ff 0.958）
```

## 5. 开源组件说明

- 运行依赖：**零第三方**（纯 Node 内置模块）
- 开发/校验依赖：`puppeteer-core`（headless Edge 渲染校验）、`ssh2`（部署期临时使用，不在本目录）

## 6. 码道在 RSI 开发中的应用总结

本实验场从判据移植、循环接线、超时留痕、看板增强到 53 条单测，全部由码道会话直接生成与重构；排错环节（并发评测空输出、看板加载失败）也通过码道定位根因并落地修复，属于「需求 → 生成 → 自测 → 修复」的完整闭环。
