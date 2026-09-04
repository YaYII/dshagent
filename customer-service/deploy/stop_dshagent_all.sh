#!/usr/bin/env bash
# ============================================================
# stop_dshagent_all — 停止 dshagent 智能客服系统（保留数据卷）
# 数据（会话/设置/知识库写入）在 dsh-home 卷与 ./kb，down 不丢失；
# 彻底清空（慎用）: docker compose down -v
# ============================================================
set -uo pipefail

SCRIPT_PATH="$0"
while [ -L "$SCRIPT_PATH" ]; do
  SCRIPT_PATH="$(readlink -f "$SCRIPT_PATH")"
done
DEPLOY_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"

echo "=============================================="
echo "  dshagent 客服系统 - 停止中"
echo "=============================================="
cd "$DEPLOY_DIR"
docker compose down 2>&1 | tail -4
echo "  ✅ 已停止（数据卷保留，start_dshagent_all 可随时再起）"
