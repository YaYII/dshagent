# 接入本地 LLM 中转（LiteLLM 网关）

客服系统默认模型路由指向**宿主机上的本地 LiteLLM 网关**，而不是直连某一家公网
上游。本文记录接线方式、验证证据与回滚方法。

## 1. 为什么接中转

本地网关（`~/ai-gateway`，`llm-gateway` 命令管理）把多家上游聚合成一个
OpenAI 兼容端点，并在**同一个模型名**下挂多个上游做分流与故障转移：

```
127.0.0.1:4000 ─┬─► Command Code   （主，按 CMD_API_KEY / _2 / _3 顺序）
                ├─► AgentRouter    （备，需伪装 UA，见 8787 代理）
                └─► NooCool        （备）
```

对客服的价值：某家额度用尽或被熔断时自动切下一家，访客不会因此拿到
「暂时查不到」。直连单家时，那家挂了客服就挂了。

## 2. 网络：为什么不能用 host.docker.internal

网关只把端口发布到**宿主回环**：

```sh
-p 127.0.0.1:4000:4000     # 只有宿主能连，容器连 127.0.0.1 是它自己
```

容器里的 `host.docker.internal` 指向宿主网关 IP（`172.x.x.x`），那里没有监听，
所以连不上——这与 `~/ai-gateway` 无关，是回环绑定 + Docker 网络的必然结果。

**做法：两个容器共享一个用户自定义网络，按容器名访问。**

| 位置 | 配置 |
|---|---|
| `~/.local/bin/llm-gateway` | `NETWORK="llm-shared"`，`_run()` 里 `--network "$NETWORK"`（网络不存在则创建） |
| `customer-service/deploy/docker-compose.yml` | dsh-agent 服务加 `networks: [dshagent, llm-shared]`；`llm-shared` 声明为 `external: true` |
| profile（`cordis.patch.yml`） | provider `litellm`，`baseURL: http://llm-gateway:4000/v1` |

两个要点：

- **默认 `bridge` 网络不做容器名解析**（Docker 已知限制），必须用用户自定义网络；
  这一点实测过：接上 `bridge` 后 `llm-gateway:4000` 仍然 `fetch failed`。
- `llm-shared` 在客服 compose 里是 `external`：生命周期归网关脚本管，
  `docker compose down` 不会把网关的网络一起拆掉。

## 3. 配置

`.env`（不进版本库）：

```sh
LITELLM_MASTER_KEY=<~/ai-gateway/gateway.env 里的 LITELLM_MASTER_KEY>
```

profile 的 `agent-default-model`：

```yaml
- id: agent-default-model
  config:
    provider: litellm
    model: deepseek/deepseek-v4.1-flash
```

**回滚到直连**：把 `provider` 改回 `commandcode` 即可——两边模型名相同，不需要动
preset 或其它配置。

## 4. `reasoning_effort` 的坑（与直连一致）

网关对 `deepseek-v4.1-flash` 强制开启思考，实测：

| 参数 | 结果 |
|---|---|
| `reasoning_effort: "off"` | ❌ HTTP 400 `Invalid option: expected one of "low"\|"medium"\|"high"\|"xhigh"\|"max"` |
| `"low"` | ⚠️ 会思考，小 `max_tokens` 下推理段吃光配额、正文为空 |
| `"medium"` | ✅ 正常产出 |

因此 profile 里该 provider 的 `reasoningEfforts` 把 `off` 映射成 `null`
（**不下发**该字段），而不是下发 `"off"`。**任何小 `max_tokens` 的辅助调用
（如会话标题）都要留足推理预算**，见 `cordis.patch.yml` 的 `session-title-llm`
（`maxOutputTokens: 512`）。

## 5. 验证证据（实测）

```sh
# 网关本身
curl -H "authorization: Bearer $LITELLM_MASTER_KEY" http://127.0.0.1:4000/v1/models
#   → 200，9 个模型，含 deepseek/deepseek-v4.1-flash

# 容器内按名可达（关键：证明网络接对了）
docker exec dshagent-app node -e \
  'fetch("http://llm-gateway:4000/health/liveliness").then(r=>console.log(r.status))'
#   → 200 "I'm alive!"

# 重启网关后网络仍在（证明写入脚本的改动生效）
llm-gateway restart && docker inspect llm-gateway \
  --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}'
#   → llm-shared
```

端到端（访客 API，`/api/guest/chat`）：

| 场景 | 结果 |
|---|---|
| 知识库问答（热线号码） | 200，6.5s，答案正确并带来源 |
| 合约核对（走 `lookup_*` 工具） | 200，8.7s，金额/日期与接口一致，繁体界面回繁体 |

网关侧日志确认请求确实经过中转：

```
INFO: 172.29.0.3:40818 - "POST /v1/chat/completions HTTP/1.1" 200 OK
```

`172.29.0.3` 就是客服容器在 `llm-shared` 网络上的地址。

回归：六套件 300 项断言全过（gate-check 76、http-exits-check 25、
output-gate-check 65、gate-dom-check 94、lookup-check 29、duplicate-turn-check 11）。

## 6. 运维注意

- **网关是单点**：它挂了客服就不可用（此时可临时把 `provider` 改回
  `commandcode` 直连应急）。网关自身 `--restart unless-stopped`，开机自启。
- 改了 `gateway.env`（如换 key）必须 **重建**网关容器：`llm-gateway restart`，
  `docker restart` 不会重读 `--env-file`。
- 新机器部署：先 `llm-gateway start`（会创建 `llm-shared`），再起客服 compose；
  顺序反了 compose 会因找不到外部网络而报错。
