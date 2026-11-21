# api-relay 一键安装与构建脚本（Windows / PowerShell 等价版）
# 用法：在作品包根目录执行
#   powershell -ExecutionPolicy Bypass -File readme\install.ps1
# 要求：Node.js >= 22.5.0
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
Set-Location (Join-Path $root "project")

Write-Host "[1/3] 校验 Node 版本（需 >= 22.5.0）..."
node -e "const a=process.versions.node.split('.').map(Number);if(a[0]<22||(a[0]===22&&a[1]<5)){console.error('需要 Node >= 22.5.0，当前 '+process.version);process.exit(1)}console.log('Node '+process.version+' OK')"
if ($LASTEXITCODE -ne 0) { throw "Node 版本不满足要求（需 >= 22.5.0）" }

Write-Host "[2/3] 安装构建依赖（后端 + 前端）..."
npm install --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw "后端依赖安装失败" }
if (Test-Path "frontend/package.json") {
  npm --prefix frontend install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw "前端依赖安装失败" }
}

Write-Host "[3/3] 构建产物（dist/ 后端 + dist-admin/ 管理面板）..."
npm run build
if ($LASTEXITCODE -ne 0) { throw "构建失败" }

Write-Host ""
Write-Host "✓ 安装与构建完成。"
Write-Host "  终端A（离线 mock 上游）: cd project; npm run mock"
Write-Host "  终端B（启动网关）      : cd project; npm run start"
Write-Host "  管理面板               : http://127.0.0.1:8787/admin"
Write-Host "  一键 Demo（自动自检）   : cd project; npm run demo"