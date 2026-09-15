# 底层模型管理

客服系统的模型由**本地 LLM 中转（LiteLLM 网关）**统一提供：网关把 Command Code /
AgentRouter / NooCool 聚合成一个 OpenAI 兼容端点，同一模型名挂多个上游做故障转移。
客服侧只认 provider `litellm`，具体走哪家由网关决定。

## 〇、两层拓扑（先分清这个，否则会误判「已经不用 Command Code 了」）

```
访客/Admin
   │
   ▼  第一层：客服 → 本地中转（provider = litellm）
本地 LiteLLM 网关  http://llm-gateway:4000/v1
   │
   ▼  第二层：中转 → 上游（由网关配置决定）
Command Code（主力）/ AgentRouter（v4 兜底）/ NooCool / DeepSeek 官方
```

**第一层确实已经没有直连了**：客服默认 provider 是 `litellm`，客服容器没有任何公网
出站连接（实测 `/proc/net/tcp` 里非内网连接数为 0），所有模型请求都发给本地网关。

**但第二层仍然是 Command Code 在干活**：`deepseek/deepseek-v4.1-flash` 经别名落到
`deepseek-v4.1-flash`，其 `api_base` 就是 `https://api.commandcode.ai/provider/v1`。
**v4.1 flash 只有 Command Code 一家提供**，中转站没换掉它，只是替客服去调它。
第三方那几家是 v4 的兜底，只在 v4.1 整个账号池挂掉时才接手。

> 客服 profile 里仍声明了 `commandcode` / `agentrouter` / `noocool` 三个 provider，
> 它们只在 Admin 的模型选择器里可选（应急切换用），默认路由不走。
> 要彻底断掉某个 provider，直接从 `apiAllowlist` 那几行删掉即可。

## 一、三个层级，别混用

| 层级 | 改什么 | 在哪改 | 生效范围 |
|---|---|---|---|
| ① Provider | 网关地址、密钥、可用模型清单 | Admin → **设置 → 模型**，或 `deploy/profile/cordis.patch.yml` | 需要重建容器（改组合文件时） |
| ② **默认模型** | 新会话用哪个模型 | `deploy/model.sh`（推荐）或 Admin 会话里的模型选择器 | **立即生效，无需重启** |
| ③ 单会话模型 | 当前这一段对话用哪个 | 会话输入框上方的「选择模型」 | 只影响该会话后续轮次 |

访客端（`/api/guest/*`）用的是 **②**：新访客会话创建时读取 `agent-default-model`
设置命名空间。

## 二、常用操作

```sh
cd customer-service/deploy

./model.sh list       # 列出所有 provider 与模型（含当前标记）
./model.sh current    # 显示当前默认模型
./model.sh free       # 切到免费档（AgentRouter，经网关）
./model.sh paid       # 切回付费档（经网关，多上游容灾）
./model.sh set litellm ds/deepseek-v4-pro          # 指定任意 provider/model
./model.sh effort medium                            # 只改推理等级
```

`model.sh` 走的是 DSH 自己的设置 RPC，等价于在 Admin 界面里改，但不依赖点界面。

## 三、为什么「立即生效」

DSH 的 `agent-default-model` 是一个**设置命名空间**，插件注释写得很明确：
composition 里的值只是初值，挂了 settings provider 之后「用户层实时读取」
（`packages/core/agent-default-model/src/index.ts`）。所以写设置即改默认，
不需要重新部署。

**实测证据**（不是推断）：

```sh
./model.sh free    # 默认改成 ar/deepseek-v4-flash
# 不重启，直接跑一轮访客对话
curl -s -X POST http://127.0.0.1:10800/api/guest/chat -H 'content-type: application/json' \
  -d '{"sessionId":"<新会话>","message":"客服热线是多少？","lang":"zh"}' >/dev/null
tail -1 ~/ai-gateway/ua-log.jsonl     # 网关侧记录本轮实际用的模型
# → "model": "ar/deepseek-v4-flash"    ✅ 换过去了
```

反向再切一次（`./model.sh paid`），网关日志随即变回
`deepseek/deepseek-v4.1-flash`。两个方向都验过。

> ⚠️ **手工编辑 `settings.yaml` 不生效**。我试过直接往容器里的
> `/dsh-home/settings.yaml` 追加 `agent-default-model:`，文件改了但访客端仍然走旧
> 模型（网关日志可证）。设置 provider 有自己的写入路径，**必须走 RPC/界面**。

## 四、为什么默认是 v4.1 flash（稳定性链）

客服默认 `litellm / deepseek/deepseek-v4.1-flash`。这个名字在网关侧不是「一个模型」，
而是一条**带故障转移的链**（`~/ai-gateway/config.yaml`）：

```
deepseek/deepseek-v4.1-flash          ← 客服用的模型名
  └─ router.model_group_alias
       deepseek/deepseek-v4.1-flash → deepseek-v4.1-flash
       └─ Command Code 账号池
            主账号 weight=1000、后备 weight=1（用权重逼近顺序使用）
            为什么不用随机分流：prompt cache 按账号隔离，分散会让各账号都命中不了
            缓存，输入按 $0.15/M 计（缓存价 $0.003/M，差 50 倍）→ 额度烧得更快
            └─ router.fallbacks
                 deepseek-v4.1-flash → ["deepseek-v4-flash"]
                 （v4.1 目前只有 Command Code 一家提供，所以留了第三方兜底）
```

关键参数（都是踩过坑才定的，别随手改）：

| 参数 | 值 | 为什么 |
|---|---|---|
| `cooldown_time` | **600**（不是 3600） | 3600 的教训：一次瞬时限流被锁 1 小时，解锁后再撞一次又锁 1 小时，把「几分钟的限流」放大成「全天不可用」。600 让它几分钟自愈 |
| `RateLimitErrorAllowedFails` | 0 | 429 = 账号额度用尽，立即熔断，别继续往这个账号打 |
| `BadRequestErrorAllowedFails` | 10 | 400 是客户端参数问题，惩罚上游会把健康账号误冷却 |
| `InternalServerErrorAllowedFails` | 10 | 500（含 AgentRouter 的敏感词拦截）是单请求问题，冷却整个部署 1 小时毫无益处 |

**结论**：默认就该是 v4.1 flash——它背后是多账号池 + 第三方兜底；而免费档
（`ar/deepseek-v4-flash`）只有一个上游，没有这层保护。要压成本再切免费，接受单点。

## 五、免费档实测结论

AgentRouter 免费档（`ar/deepseek-v4-flash`）跑真实客服流程，四类任务全部正常：

| 任务 | 结果 |
|---|---|
| 知识库检索 | ✅ 答出热线号码并给出处 `faq.md` |
| 合约核对（工具调用） | ✅ 走 `lookup_*`，金额/日期与 CEM 接口一致 |
| 图形渲染 | ✅ mermaid 与 html 块均 `render/passed`，正文无围栏源码 |
| 反枚举 | ✅ 问「我名下有幾多張合約」照样拒绝并索要合约号 |

**两个注意点**：

1. 免费档**只有一个上游、没有故障转移**——这正是默认仍用付费档的原因。要压成本
   可以切免费，但要接受单点。
2. 免费档同样**强制思考**：给 80 token 时推理段就吃光配额、正文为空
   （`finish_reason=length`），700 token 才稳定出正文。

## 六、Admin 界面里怎么改（不跑脚本时）

1. **管理 provider / 密钥 / 模型清单**：设置 → **模型** → 每个 provider 右侧「编辑」，
   或「添加自定义提供方」。API key 存在 DSH 的凭据库（`dsh-home`），不写进仓库。
2. **改单会话模型**：会话输入框上方点「选择模型」→「模型」选具体模型，「推理等级」
   单独一档。
3. **改默认模型**：界面上的模型选择器会写默认值（与 `model.sh set` 同一条链路）。
   自动化点这个二级菜单不稳定（悬浮层），所以给了 `model.sh` 作为可靠入口。
