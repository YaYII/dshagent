# dshagent 客服系统 — 部署

Docker 单机部署：一个 `dsh-agent` 服务（DeepSeek Harness 官方内核 + 客服
preset + guest HTTP 桥）+ 一个 `nginx` 入口。**两个独立端口、两个交互窗口**：

| 端口 | 面向 | 说明 |
|---|---|---|
| `10800`（游客） | 游客 | 智能客服对话页：匿名问答，回答可渲染 Markdown/表格/条形图/图片 |
| `10801`（Admin） | 管理员 | 官方 DSH Web GUI：配置 AI 模型/provider、查看会话、插件管理 |

> 端口可用环境变量覆盖：`GUEST_PORT` / `ADMIN_PORT`（默认 10800 / 10801）。

## 快速开始

```bash
cd customer-service/deploy
cp .env.example .env          # 填写模型 API key（默认 commandcode，CMD_API_KEY_2）
mkdir -p kb                   # 客服知识库目录（Obsidian vault 文件夹）
# 把 Obsidian vault 内容放进 kb/（或把 KB_VAULT_DIR 指向真实 vault 路径）
docker compose up -d --build
```

- 游客端：`http://<host>:10800/`
- 管理端：`http://<host>:10801/`（首次访问按 dsh web 的 token 握手；
  管理 token 打印在 `docker compose logs dsh-agent` 启动行）

## 知识库（Obsidian）

- `KB_VAULT_DIR`（默认 `./kb`）只读挂载进容器 `/kb`，即客服检索的知识库。
- 直接编辑 vault 中的 Markdown 即更新客服知识（检索按需扫描 + 短 TTL 缓存，
  无需重启）。
- 建议：把 Obsidian vault 目录本身作为 `KB_VAULT_DIR`（如
  `KB_VAULT_DIR=/path/to/my-vault`），Obsidian 里改完即生效。

## AI 模型配置

- 开箱默认路由 `commandcode`（公网 OpenAI 兼容端点），key 从 `.env` 的
  `CMD_API_KEY_2` 注入（profile 静态 provider 含 commandcode/agentrouter/
  noocool 多个可选，见 `customer-service/deploy/profile/cordis.patch.yml`）。
- 管理端「设置 → 模型」可继续添加/切换其它 OpenAI 兼容 provider（写
  DSH_HOME 持久卷 settings.yaml），客服会话默认路由跟随。
- ⚠️ **模型网关必须容器可达**：dsh web 绑容器内回环（官方安全设计），
  模型 API 由容器主动外连。若 AgentRouter 网关跑在宿主机且只绑
  `127.0.0.1`，容器连不上（bridge 网络到不了宿主机回环）。解决：
  网关绑 `0.0.0.0`（或经 extra_hosts + host-gateway 访问宿主机任意网卡
  地址），或直接在 profile 配公网 OpenAI 兼容端点（如
  `https://newapi.noo.cool/v1`，key 填对应 `*_API_KEY`）。

## 数据与安全

- `dsh-home` 卷持久化 settings/credentials/sessions（`docker compose down`
  不丢；`down -v` 清空）。
- dsh web 只绑容器内 `127.0.0.1:3080`（官方安全设计拒绝 0.0.0.0），对外
  仅 nginx 的 10800（游客）与 10801（Admin）两个端口。
- 游客会话使用独立瘦身 preset（customer-service-guest）：只读知识库检索 +
  对话，无任何 shell/文件/网络/管理能力；guest API 自带按 IP 限流。
- 生产建议：nginx 前置 TLS，Admin 端口（10801）加访问控制（IP 白名单
  或基础认证）。

## 本地开发（不构建镜像）

```bash
# 1) 建客服 profile（官方纯净内核 + 客服 preset + guest 桥）
export DSH_HOME=/tmp/dsh-dev-home
mkdir -p $DSH_HOME/profiles/customer-service
cp customer-service/deploy/profile/package.json $DSH_HOME/profiles/customer-service/
cp customer-service/deploy/profile/cordis.patch.yml $DSH_HOME/profiles/customer-service/
printf '[]\n' > $DSH_HOME/profiles/customer-service/cordis.yml
# 2) 装 preset（把组合里的 /app/customer-service 替换为仓库绝对路径，vaultRoot 改本地）
mkdir -p $DSH_HOME/.agent-presets
sed "s|/app/customer-service|$PWD/customer-service|g" customer-service/presets/customer-service/agent.cordis.yml > $DSH_HOME/.agent-presets/customer-service/agent.cordis.yml
# 3) settings/credentials 指向真实 DSH_HOME 或复制；模型 key 注入环境
AGENTROUTER_API_KEY=xxx node --import tsx apps/cli/src/bin.ts --profile customer-service --no-open --port 3080
```

## 目录结构

```
customer-service/
├── design.md                 # 改造设计（裁剪清单/架构/验收）
├── presets/
│   ├── customer-service/      # Admin 客服 preset（persona + 知识检索）
│   └── customer-service-guest/ # 游客瘦身 preset（只读 + 对话）
├── plugins/
│   ├── knowledge-search/      # vault 只读检索工具插件
│   └── guest-server/          # /api/guest/* HTTP 桥（会话/聊天/限流）
├── web/guest/                 # 游客前端（单文件 HTML，无构建）
└── deploy/
    ├── Dockerfile             # 源码构建镜像
    ├── docker-compose.yml     # dsh-agent + nginx
    ├── nginx.conf             # / = 游客，/admin = 管理端
    ├── entrypoint.sh          # 容器入口（初始化 profile/presets 后启动）
    ├── profile/               # 客服 profile 组合（bundles + patch）
    └── .env.example           # 环境变量示例
```
