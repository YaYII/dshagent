#!/usr/bin/env bash
# dshagent 客服系统 — 容器入口
#
# 1. 初始化 DSH_HOME：客服 profile + 客服 preset（组合文件里引用 /app 固定路径）
# 2. 启动客服 profile（官方纯净内核 + 客服 preset + guest-server 桥）
# 3. dsh web 绑定 127.0.0.1:3080（官方安全设计拒绝 0.0.0.0），由 nginx 反代对外
set -euo pipefail

DSH_HOME="${DSH_HOME:-/dsh-home}"
PROFILE_NAME="${DSH_PROFILE:-customer-service}"
mkdir -p "$DSH_HOME/profiles" "$DSH_HOME/.agent-presets"

# ── 客服 profile：package.json（bundles=官方纯净两件套）+ cordis.patch.yml ──
# 每次启动从镜像内模板同步（幂等覆盖），保证升级/改配置即时生效；DSH_HOME
# 卷只持久化运行时数据（settings/sessions…），不持久化组合文件。
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE_NAME"
mkdir -p "$PROFILE_DIR"
cp /profile-src/package.json "$PROFILE_DIR/package.json"
cp /profile-src/cordis.patch.yml "$PROFILE_DIR/cordis.patch.yml"
printf '[]\n' > "$PROFILE_DIR/cordis.yml"

# ── 客服 preset：customer-service / customer-service-guest（含插件引用）──────
install_preset() {
  local src="/presets-src/$1" dst="$DSH_HOME/.agent-presets/$1"
  rm -rf "$dst"; mkdir -p "$dst"
  cp -r "$src/." "$dst/"
}
install_preset customer-service
install_preset customer-service-guest

# ── profile patch 里的插件绝对路径：Docker 内 /app/customer-service 已固定 ──
#（profile/presets 组合文件均以 /app/customer-service/... 引用，见各文件注释）

# ── 启动 ────────────────────────────────────────────────────────────────────
cd /app
echo "[dshagent] booting profile '$PROFILE_NAME' (DSH_HOME=$DSH_HOME)"
exec node --import tsx apps/cli/src/bin.ts --profile "$PROFILE_NAME" \
  --no-open --host 127.0.0.1 --port "${DSH_PORT:-3080}" \
  ${DSH_EXTRA_ARGS:-}
