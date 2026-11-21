#!/usr/bin/env bash
# api-relay 一键安装与构建脚本（对应《作品提交规范》readme 第 1 项）
# 用法：在作品包根目录执行  bash readme/install.sh
# 要求：Node.js >= 22.5.0
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/project"

echo "[1/3] 校验 Node 版本（需 >= 22.5.0）..."
node -e 'const a=process.versions.node.split(".").map(Number);if(a[0]<22||(a[0]===22&&a[1]<5)){console.error("✗ 需要 Node >= 22.5.0，当前 "+process.version);process.exit(1)}console.log("✓ Node "+process.version+" OK")'

echo "[2/3] 安装构建依赖（后端 + 前端）..."
npm install --no-audit --no-fund
if [ -f frontend/package.json ]; then
  npm --prefix frontend install --no-audit --no-fund
fi

echo "[3/3] 构建产物（dist/ 后端 + dist-admin/ 管理面板）..."
npm run build

echo
echo "✓ 安装与构建完成。"
echo "  终端A（离线 mock 上游）: cd project && npm run mock"
echo "  终端B（启动网关）      : cd project && npm run start"
echo "  管理面板               : http://127.0.0.1:8787/admin"
echo "  一键 Demo（自动自检）   : bash project/demo.sh"