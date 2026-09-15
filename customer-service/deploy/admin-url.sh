#!/usr/bin/env bash
# ============================================================
# 打印**可直接点开**的 Admin / 游客端地址。
#
# 为什么需要它：dsh web 启动时打印的是 `http://127.0.0.1:3080/?token=…`，那是
# **容器内**地址（127.0.0.1 是容器回环、3080 是容器内端口），直接点打不开，会看到
# "dsh web authentication required; reopen the URL printed by dsh web"。
# 对外入口是宿主上的 ADMIN_PORT（默认 10801，nginx 反代到容器 3080）。
# 另外 token 每次重启都会重新生成，所以旧的链接过期是正常的——用本脚本重新取。
#
# 用法：
#   admin-url.sh            用本机第一个非回环 IPv4 拼地址（同事从别的机器访问用这个）
#   admin-url.sh 127.0.0.1  本机访问
#   admin-url.sh <域名或IP> 指定对外地址
# ============================================================
set -uo pipefail

SCRIPT_PATH="$0"
while [ -L "$SCRIPT_PATH" ]; do SCRIPT_PATH="$(readlink -f "$SCRIPT_PATH")"; done
DEPLOY_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
[ -f "$DEPLOY_DIR/.env" ] && . "$DEPLOY_DIR/.env"

ADMIN_PORT="${ADMIN_PORT:-10801}"
GUEST_PORT="${GUEST_PORT:-10800}"
CONTAINER="${CONTAINER:-dshagent-app}"

HOST="${1:-}"
if [ -z "$HOST" ]; then
  # 取第一个非回环 IPv4 作为「别人能访问的地址」；取不到就退回本机
  HOST="$(ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -1)"
  [ -z "$HOST" ] && HOST="127.0.0.1"
fi

TOKEN="$(docker logs "$CONTAINER" 2>&1 \
  | grep -o 'http://127.0.0.1:3080/?token=[A-Za-z0-9_-]*' | tail -1 | sed 's/.*token=//')"

if [ -z "$TOKEN" ]; then
  echo "取不到 Admin token：确认容器 $CONTAINER 正在运行（docker ps），"
  echo "必要时先启动：bash $(dirname "$0")/start_dshagent_all.sh"
  exit 1
fi

cat <<EOF
游客端（访客视角）: http://${HOST}:${GUEST_PORT}/
Admin（内部视角） : http://${HOST}:${ADMIN_PORT}/?token=${TOKEN}

提示：
  · token 每次重启都会变，旧链接失效属正常——重跑本脚本即可。
  · 首次访问 Admin 需在工作区标题行点「＋ 添加工作区」注册一个目录（如 /kb），
    否则点预设不会有输入框。
  · 切换底层模型：bash $(dirname "$0")/model.sh list|current|free|paid
EOF
