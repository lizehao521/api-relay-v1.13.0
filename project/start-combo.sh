#!/usr/bin/env bash
# 组合方案一键启动：api-relay（底座 :8787）+ CodeLens（工作台 :8789）
#
#   ./start-combo.sh            读取同目录 combo.env
#   ./start-combo.sh stop       停止两个服务
#   ./start-combo.sh status     查看状态
#
# 密钥只从 combo.env / 环境变量读取，不写入仓库与日志。
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(pwd)"
NODE_BIN="${NODE_BIN:-node}"
RELAY_PID="$ROOT/logs/relay.pid"
CODELENS_PID="$ROOT/logs/codelens.pid"

usage() { echo "用法: $0 [start|stop|status]"; }

check_node() {
  "$NODE_BIN" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' 2>/dev/null || {
    echo "需要 Node >= 22，当前: $("$NODE_BIN" -v 2>/dev/null || echo '未找到')" >&2
    exit 1
  }
}

load_env() {
  if [ -f combo.env ]; then
    set -a; . ./combo.env; set +a
  fi
  : "${NVIDIA_API_KEY_1:?请设置 NVIDIA_API_KEY_1（combo.env 或环境变量）}"
  : "${NVIDIA_API_KEY_2:?请设置 NVIDIA_API_KEY_2（combo.env 或环境变量）}"
  : "${RELAY_KEY_CODELENS:?请设置 RELAY_KEY_CODELENS（combo.env 或环境变量）}"
  : "${RELAY_ADMIN_TOKEN:?请设置 RELAY_ADMIN_TOKEN（combo.env 或环境变量）}"
}

wait_http() {
  local url="$1" name="$2" i=0
  while [ "$i" -lt 40 ]; do
    if curl -fsS -m 2 "$url" >/dev/null 2>&1; then
      echo "  $name 就绪: $url"
      return 0
    fi
    i=$((i + 1)); sleep 1
  done
  echo "  $name 启动超时: $url（见 logs/）" >&2
  return 1
}

render_codelens_env() {
  local f="$ROOT/codelens/server/.env"
  [ -f "$f" ] && return 0
  umask 077
  {
    printf '%s\n' \
      'HOST=127.0.0.1' \
      'PORT=8789' \
      'NODE_ENV=production' \
      'AGENT_DB_PATH=./data/codelens.db' \
      'SANDBOX_ROOT=./workspace' \
      "AGENT_APPROVAL_SECRET=$(openssl rand -hex 32)" \
      "LLM_SERVER_API_KEY=$RELAY_KEY_CODELENS" \
      'TRIAL_MODE_ENABLED=true' \
      'TRIAL_BASE_URL=http://127.0.0.1:8787/v1' \
      'TRIAL_MODEL=moonshotai/kimi-k3.1-pro' \
      'TRIAL_PROVIDER=nvidia' \
      'TRIAL_DAILY_LIMIT=50' \
      'MODEL_SOURCE_URL=http://127.0.0.1:8787/v1/models' \
      'MODEL_SOURCE_FORMAT=openai' \
      'MODEL_SOURCE_ALLOW_INSECURE=true' \
      'MODEL_SOURCE_ALLOW_PRIVATE=true' \
      'MODEL_REFRESH_INTERVAL_MS=3600000' \
      'AGENT_MAX_CONCURRENT=1' \
      'AGENT_MAX_TOOL_CALLS=30' \
      'AGENT_TASK_BUDGET_MS=180000'
  } > "$f"
  chmod 600 "$f"
  echo "  已生成 codelens/server/.env（含密钥，勿提交）"
}

start() {
  check_node
  load_env
  mkdir -p logs data
  [ -d dist ] || { echo "缺少 dist/，先执行 npm run build" >&2; exit 1; }
  [ -d codelens/server/dist ] || { echo "缺少 codelens/server/dist，先在 codelens 内构建" >&2; exit 1; }
  [ -d codelens/server/dist-client ] || { echo "缺少 codelens/server/dist-client，先构建 client 并复制" >&2; exit 1; }
  [ -f codelens/server/node_modules/typescript/package.json ] || {
    echo "缺少 CodeLens 运行依赖（typescript 为运行必需），先执行：" >&2
    echo "  cd codelens/server && npm ci && cd ../.." >&2
    exit 1
  }

  if curl -fsS -m 2 http://127.0.0.1:8787/healthz >/dev/null 2>&1; then
    echo "api-relay 已在运行"
  else
    rm -f "$RELAY_PID"
    echo "启动 api-relay ..."
    nohup "$NODE_BIN" --disable-warning=ExperimentalWarning dist/cli.js serve \
      --config config/relay-nvidia.yaml > logs/relay.log 2>&1 &
    echo $! > "$RELAY_PID"
  fi
  wait_http "http://127.0.0.1:8787/healthz" "api-relay"

  render_codelens_env

  if curl -fsS -m 2 http://127.0.0.1:8789/api/health >/dev/null 2>&1; then
    echo "CodeLens 已在运行"
  else
    rm -f "$CODELENS_PID"
    echo "启动 CodeLens ..."
    ( cd codelens/server && nohup "$NODE_BIN" dist/app.js > "$ROOT/logs/codelens.log" 2>&1 & echo $! > "$CODELENS_PID" )
  fi
  wait_http "http://127.0.0.1:8789/api/health" "CodeLens"

  cat <<EOF

组合方案已启动
  底座 api-relay : http://127.0.0.1:8787   （管理面板 /admin，评委页 /judge）
  工作台 CodeLens: http://127.0.0.1:8789
  试用上游状态   : http://127.0.0.1:8789/api/v1/agent/trial-status

停止：$0 stop
EOF
}

stop() {
  for pair in "relay:$RELAY_PID" "codelens:$CODELENS_PID"; do
    name="${pair%%:*}"; f="${pair#*:}"
    if [ -f "$f" ] && kill -0 "$(cat "$f")" 2>/dev/null; then
      kill "$(cat "$f")" 2>/dev/null || true
      echo "已停止 $name (pid $(cat "$f"))"
    fi
    rm -f "$f"
  done
}

status() {
  for pair in "relay:$RELAY_PID" "codelens:$CODELENS_PID"; do
    name="${pair%%:*}"; f="${pair#*:}"
    if [ -f "$f" ] && kill -0 "$(cat "$f")" 2>/dev/null; then
      echo "$name: 运行中 (pid $(cat "$f"))"
    else
      echo "$name: 未运行"
    fi
  done
  echo "8787: $(curl -s -o /dev/null -w '%{http_code}' -m 2 http://127.0.0.1:8787/healthz || echo down)"
  echo "8789: $(curl -s -o /dev/null -w '%{http_code}' -m 2 http://127.0.0.1:8789/api/health || echo down)"
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  status) status ;;
  *) usage; exit 1 ;;
esac