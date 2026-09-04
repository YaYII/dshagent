#!/usr/bin/env bash
# ============================================================
# start_dshagent_all — 启动 dshagent 智能客服系统（Docker 一键）
#   游客端   http://127.0.0.1:10800/
#   Admin 端 http://127.0.0.1:10800/admin/
# 管理 token 见容器日志：docker compose logs dsh-agent（启动行 ?token=...）
# ============================================================
set -uo pipefail

# 解析脚本真实路径（支持软链接调用，如 /usr/local/bin/start_dshagent_all）
SCRIPT_PATH="$0"
while [ -L "$SCRIPT_PATH" ]; do
  SCRIPT_PATH="$(readlink -f "$SCRIPT_PATH")"
done
DEPLOY_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
PROJECT_ROOT="$(cd "$DEPLOY_DIR/../.." && pwd)"
COMPOSE_FILE="$DEPLOY_DIR/docker-compose.yml"
ENV_FILE="$DEPLOY_DIR/.env"

echo "=============================================="
echo "  dshagent 智能客服系统 - 启动中"
echo "=============================================="

# ── 0. 依赖检查 ──
if ! command -v docker &>/dev/null; then echo "[错误] docker 未安装"; exit 1; fi
if ! docker compose version &>/dev/null; then echo "[错误] docker compose 不可用"; exit 1; fi
if [ ! -f "$ENV_FILE" ]; then
  echo "[提示] 缺少 .env，从模板创建（请先填入模型 API key）"
  cp "$ENV_FILE.example" "$ENV_FILE"
  echo "       请编辑 $ENV_FILE 填入 CMD_API_KEY_2（或其它 provider key）后重试"
  exit 1
fi

# ── 1. 构建镜像（首次或代码变更时）──
echo ""
echo "[1/3] 构建客服镜像（首次较慢，后续有缓存）..."
cd "$DEPLOY_DIR"
docker compose build 2>&1 | tail -2

# ── 2. 启动服务 ──
echo ""
echo "[2/3] 启动 dsh-agent + nginx..."
docker compose up -d 2>&1 | tail -4

# ── 3. 等待就绪 + 健康检查 ──
echo ""
echo "[3/3] 等待服务就绪（健康检查）..."
READY=0
for i in $(seq 1 40); do
  if curl -s -o /dev/null "http://127.0.0.1:${HTTP_PORT:-10800}/api/guest/health" 2>/dev/null; then
    READY=1; break
  fi
  sleep 3
done

echo "=============================================="
if [ "$READY" = "1" ]; then
  echo "  ✅ dshagent 客服系统已就绪"
  echo ""
  echo "  🌐 游客端（智能客服对话）: http://127.0.0.1:${HTTP_PORT:-10800}/"
  echo "  🔐 Admin 管理端         : http://127.0.0.1:${HTTP_PORT:-10800}/admin/"
  echo ""
  echo "  管理 token 查看: cd $DEPLOY_DIR && docker compose logs dsh-agent | grep -o 'token=[A-Za-z0-9_-]*' | tail -1"
else
  echo "  ⚠️  服务启动超时，请检查: cd $DEPLOY_DIR && docker compose logs dsh-agent"
fi
echo "=============================================="
exit $([ "$READY" = "1" ] && echo 0 || echo 1)
