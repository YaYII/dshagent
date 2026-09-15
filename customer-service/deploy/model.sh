#!/usr/bin/env bash
# ============================================================
# 客服系统底层模型管理
#
#   model.sh list              列出所有可用 provider 与模型
#   model.sh current           显示当前默认模型（新访客会话用它）
#   model.sh set <provider> <model>
#   model.sh free              切到免费档（AgentRouter，经本地中转）
#   model.sh paid              切回付费档（经本地中转，多上游容灾）
#   model.sh effort <off|low|medium|high|max>
#
# 原理：DSH 把「默认模型」存在设置命名空间 agent-default-model 里，改完**立即
# 生效**（实测：改完不重启，访客端下一轮就走新模型——中转站请求日志可证）。
# 本脚本走 DSH 自己的设置 RPC，等价于在 Admin 界面里改，但不需要点界面。
# ============================================================
set -uo pipefail

SCRIPT_PATH="$0"
while [ -L "$SCRIPT_PATH" ]; do SCRIPT_PATH="$(readlink -f "$SCRIPT_PATH")"; done
DEPLOY_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
[ -f "$DEPLOY_DIR/.env" ] && . "$DEPLOY_DIR/.env"
ADMIN_PORT="${ADMIN_PORT:-10801}"
CONTAINER="${CONTAINER:-dshagent-app}"
API="http://127.0.0.1:${ADMIN_PORT}"

_green() { printf '\033[32m%s\033[0m\n' "$*"; }
_red()   { printf '\033[31m%s\033[0m\n' "$*"; }
_dim()   { printf '\033[2m%s\033[0m\n' "$*"; }

# Admin 每次启动生成一次性 token，只出现在容器日志里；用它换一个会话 cookie。
_token() {
  docker logs "$CONTAINER" 2>&1 \
    | grep -o 'http://127.0.0.1:3080/?token=[A-Za-z0-9_-]*' | tail -1 | sed 's/.*token=//'
}

_cookie_jar() {
  local jar; jar="$(mktemp)"
  local token; token="$(_token)"
  if [ -z "$token" ]; then _red "取不到 Admin token：确认 $CONTAINER 在运行"; rm -f "$jar"; return 1; fi
  if ! curl -s -m 10 -c "$jar" -o /dev/null "${API}/?token=${token}"; then
    _red "Admin 未就绪（${API}）"; rm -f "$jar"; return 1
  fi
  echo "$jar"
}

# 调 DSH 的 Typert RPC：POST /api/<method>，信封含 type/method/payload.args。
_rpc() {
  local method="$1" args="$2" jar="$3"
  curl -s -m 20 -b "$jar" -H 'content-type: application/json' \
    -X POST "${API}/api/${method}" \
    -d "{\"type\":\"client-request\",\"rpcId\":\"cli-$$-$RANDOM\",\"method\":\"${method}\",\"payload\":{\"args\":${args}}}"
}

cmd_list() {
  local jar; jar="$(_cookie_jar)" || return 1
  _rpc "session/modelCatalog" '{}' "$jar" | python3 -c "
import json,sys
d=json.load(sys.stdin)
v=(d.get('result') or {}).get('value') or {}
default=(v.get('default') or {})
print('默认: %s / %s' % (default.get('provider'), default.get('model')))
print()
for g in v.get('groups') or []:
    print('[%s] %s' % (g.get('id'), g.get('name')))
    for m in g.get('models') or []:
        mark = ' ← 当前' if m.get('id') == default.get('model') and g.get('id') == default.get('provider') else ''
        print('    %-34s %s%s' % (m.get('id'), m.get('name'), mark))
"
  rm -f "$jar"
}

cmd_current() {
  local jar; jar="$(_cookie_jar)" || return 1
  _rpc "settings/describe" '{}' "$jar" | python3 -c '
import json,sys
d=json.load(sys.stdin)
for s in ((d.get("result") or {}).get("value") or {}).get("namespaces") or []:
    if s.get("ns") == "agent-default-model":
        print("当前默认模型:", json.dumps(s.get("value"), ensure_ascii=False))
'
  rm -f "$jar"
}

cmd_set() {
  local provider="$1" model="$2" effort="${3:-}"
  local jar; jar="$(_cookie_jar)" || return 1
  local section="{\"provider\":\"${provider}\",\"model\":\"${model}\""
  [ -n "$effort" ] && section="${section},\"reasoningEffort\":\"${effort}\""
  section="${section}}"
  local out; out="$(_rpc "settings/replace" "{\"ns\":\"agent-default-model\",\"section\":${section}}" "$jar")"
  rm -f "$jar"
  if printf '%s' "$out" | grep -q '"ok":true'; then
    _green "✅ 默认模型已切换：${provider} / ${model}${effort:+ (effort=${effort})}"
    _dim "   立即生效，无需重启；新访客会话即用该模型。已有会话保持原模型。"
  else
    _red "切换失败：$(printf '%s' "$out" | head -c 300)"
    return 1
  fi
}

case "${1:-}" in
  list)    cmd_list ;;
  current) cmd_current ;;
  set)
    [ $# -ge 3 ] || { _red "用法: model.sh set <provider> <model> [effort]"; exit 1; }
    cmd_set "$2" "$3" "${4:-}"
    ;;
  # 两个常用档位：都经本地中转（litellm），差别是网关侧的上游数量。
  free)  cmd_set litellm ar/deepseek-v4-flash ;;
  paid)  cmd_set litellm deepseek/deepseek-v4.1-flash ;;
  effort)
    [ $# -ge 2 ] || { _red "用法: model.sh effort <off|low|medium|high|max>"; exit 1; }
    # 只改推理等级：先读当前 provider/model，再整体写回
    jar="$(_cookie_jar)" || exit 1
    read -r P M <<EOF
$( _rpc "settings/describe" '{}' "$jar" | python3 -c '
import json,sys
d=json.load(sys.stdin)
for s in ((d.get("result") or {}).get("value") or {}).get("namespaces") or []:
    if s.get("ns")=="agent-default-model":
        v=s.get("value") or {}
        print(v.get("provider",""), v.get("model",""))
' )
EOF
    rm -f "$jar"
    [ -n "$P" ] || { _red "读不到当前模型"; exit 1; }
    cmd_set "$P" "$M" "$2"
    ;;
  *)
    sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
