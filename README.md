# dshagent — 智能客服系统

基于 [DeepSeek Harness](README.harness.md)（`dsh`，全插件化 Agent 运行时）改造的
**Docker 化智能客服系统**。内核与会话引擎照用 DeepSeek Harness，客服会话的
能力被收窄为「问答 + 知识库 + API」——**不是编码 Agent，没有任何终端/代码
执行能力**。

## 两个交互窗口

| 入口 | 面向 | 说明 |
|---|---|---|
| `/` | **游客** | 智能客服对话页：匿名问答、按 IP 限流；回答可渲染 Markdown / 表格 / 条形图 / 图片，可带知识库来源引用 |
| `/admin` | **管理员** | 官方 DSH Web GUI：配置 AI 模型/provider/key、查看会话、管理知识库 |

## 客服能力模型

| 能力 | 工具 | Admin 客服 | 游客 |
|---|---|---|---|
| 回答问题 | 对话 | ✅ | ✅ |
| 检索知识库（Obsidian vault） | `knowledge_search` | ✅ | ✅ |
| 调用外部 API 取数（订单/产品/价格…） | `api_get`（白名单） | ✅ | ✅ |
| 把结果/案例写回知识库 | `kb_write` | ✅ | ⛔ |
| 渲染图表/图片辅助解释 | 前端富渲染 | ✅ | ✅ |

**永不提供**：shell/终端、文件系统（除经 kb_write 写 vault）、子代理、代码执行、网页浏览。

## 快速开始（Docker）

```bash
cd customer-service/deploy
cp .env.example .env     # 填 CMD_API_KEY_2（或改 profile 用你的 provider）
docker compose up -d --build
# 游客端 http://<host>:8080/     管理端 http://<host>:8080/admin/
```

知识库：把 Obsidian vault 目录（或任意 Markdown 知识文件夹）作为
`KB_VAULT_DIR`（默认 `./kb`）挂进容器 `/kb`，编辑即更新客服知识。

详见 [customer-service/README.md](customer-service/README.md) 与
[customer-service/deploy/README.md](customer-service/deploy/README.md)。

## 目录

- `customer-service/` — 客服系统全部改造（设计、preset、插件、前端、部署）
  - `design.md` 改造设计 · `CHANGES.md` 裁剪与能力说明
  - `presets/` 客服/游客 preset · `plugins/` 检索/API/游客桥插件
  - `web/guest/` 游客前端 · `deploy/` Docker/compose/nginx/profile
- 其余为 DeepSeek Harness 官方源码（内核，构建必需；README.harness.md 是上游说明）

## 授权

DeepSeek Harness 上游为 MIT（见 [LICENSE](LICENSE)）；本仓库在其上叠加客服改造。
