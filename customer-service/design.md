# dshagent 客服系统改造设计

> 版本: v1 | 日期: 2026-09-04 | 基线: deepseek-harness dd6322d60 (0.1.2-alpha.3)

## 1. 目标与范围

把 deepseek-harness（DeepSeek Harness）源码 checkout 改造为 **Docker 化智能客服系统**：

- **Admin 端**：保留 DSH Web GUI（天然具备 AI 模型配置/会话/插件管理），仅做品牌白标 + 隐藏无关入口。
- **Guest 端**：面向终端用户的纯聊天客服窗口。匿名 + 服务端限流；回答可渲染 **Markdown/HTML（图表）+ 图片**。
- **知识库**：以 **Obsidian vault 目录**为客服知识库（vault 目录 bind-mount 进容器，只读检索），与客服系统同机同服务。
- **运行**：Docker 容器化（本机验证），数据持久化；最终以 `dshagent` 名称推送到用户 GitHub 新仓库（全新初始提交）。

## 2. 架构总览```
                    宿主机 / 同一台服务器
┌───────────────────────────────────────────────────────────────┐
│  Docker network (客服系统 compose)                              │
│  ┌─────────────────────┐        ┌───────────────────────────┐ │
│  │  nginx (入口反代)     │        │  obsidian vault 目录       │ │
│  │  /admin → dsh web   │        │  (只读 bind-mount,         │ │
│  │  /guest → guest api │        │   KB 原始内容)              │ │
│  └─────────┬───────────┘        └─────────────┬─────────────┘ │
│            │                                 │                │
│  ┌─────────▼──────────────────────────────────▼─────────────┐ │
│  │ dsh-agent (单进程, 官方 dsh-base+dsh-web-app bundle)        │ │
│  │  · Admin session (web profile, agent preset=客服)         │ │
│  │  · Guest session (同一进程, preset=游客瘦身, 受限工具)      │ │
│  │  · knowledge-search 插件 (只读检索 vault 目录, 向量可选)    │ │
│  │  · DSH_HOME 持久化卷 (settings/credentials/sessions)      │ │
│  └───────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────┘
```

- 单 dsh 进程承载 Admin + Guest 两种会话：会话由 **agent preset** 决定工具与 persona（客服 preset / 游客瘦身 preset），进程共用模型路由、知识库、持久化。
- 对外只暴露 nginx：`/admin`（需管理员鉴权，建议独立端口/路径）、`/guest`（游客 API）。dsh web 绑定 `127.0.0.1`（官方安全设计拒绝 `0.0.0.0`），由 nginx 反代。
- 知识库：`/kb`（vault 目录）只读挂载 + 检索插件。文本检索用文件扫描 + 简单向量/关键词（无外部服务），答案可附引用。

## 2.1 客服能力模型（能力边界）

客服智能体**不是编码 Agent**，能力面刻意收窄为「问答 + 数据」：

| 能力 | 工具 | Admin 客服 | Guest 游客 |
|---|---|---|---|
| 回答用户问题 | —（模型对话） | ✅ | ✅ |
| 检索知识库（Obsidian vault） | `knowledge_search` | ✅ | ✅ |
| 调用外部 API 获取数据（查订单/产品/价格…） | `api_get` | ✅ | ✅（只读，同白名单） |
| 把结果/案例写入知识库 | `kb_write` | ✅ | ⛔ 不注册 |
| 渲染图表/图片辅助解释 | 前端富渲染 | ✅ | ✅ |

**明确不做**（无任何权限，也不注册这些工具）：
- ❌ 无 shell / 终端命令（无 tool-bash/pwsh/terminal）
- ❌ 无文件系统读写（无 tool-fs/编辑器），唯一可写路径是经 `kb_write` 写入 vault 知识库目录
- ❌ 无子代理 / 工作流 / 代码执行 / 网页浏览
- ❌ `api_get` 只允许配置白名单内的 http(s) 目标；`kb_write` 路径限制在 vault 根内且默认禁止覆盖

客服"最大的能力 = 调 API 取数 + 写回知识库"；它永远无法触达底层终端。

## 3. 组件与插件清单（保留 / 裁剪）

### 3.1 官方内核 bundle —— 保留（客服系统底座）

| Bundle | 作用 | 决策 |
|---|---|---|
| `@deepseek-ai/dsh-base` | session/agent-loop/llm/fs/sandbox/approval/tools/web 核心 | ✅ 保留 |
| `@deepseek-ai/dsh-web-app` | 浏览器面 Web GUI（天然 Admin），webserver/ui-* | ✅ 保留（Admin） |

内核里的关键能力（全部保留）：agent/session、llm（多 provider 路由）、模型路由与设置页、会话持久化、权限/sandbox、附件（图片）、富文本 Markdown 渲染。

### 3.2 第三方业务 bundle —— 从客服 profile 移除（不修改源码，改 profile 组合）

| 原 profile bundle | 作用 | 决策 |
|---|---|---|
| `@xmanrui/dsh-im` | 多会话 IM 界面/工作区 | ⛔ 客服不需要（Admin 用官方 UI） |
| `dsh-plugin` | 社区插件装载器 | ⛔ 移除（非客服功能） |
| `dsh-routing-suite` | 路由套件 | ⛔ 移除 |
| `dsh-univer-office` | Office 套件（表格/PPT/文档） | ⛔ 移除（客服不需要） |
| `aegis` | Aegis 方法包/技能 | ⛔ 移除（非客服） |
| `@nanmicoder/dsh-agent-teams` | 多智能体团队 | ⛔ 移除（客服单会话问答） |
| `dsh-better-sidebar` | 侧栏美化/终端 | ⛔ 移除（保持精简） |
| `dsh-pipeline-kernel` | 管线内核（任务板） | ⛔ 移除（非客服） |
| `@deepseek-ai/dsh-agiteam` | AGI 团队开发引擎 | ⛔ 移除（非客服） |

### 3.3 本地 insert 插件 —— 客服 profile 不装载（不修改源码，改组合层）

| insert id | 作用 | 决策 |
|---|---|---|
| `memory-cerebrate` | 虫群记忆（Brain 8765） | ⛔ 客服知识库改用 Obsidian vault |
| `dsh-obsidian` | Obsidian REST+Brain 双知识 | ⚠️ 改写为 vault 只读检索（保留 obsidian 概念，去掉 REST/Brain 依赖） |
| `code-review` / `project-wiki` / `code-architecture` / `program-cognition` | AI 代码工程闭环 | ⛔ 移除（非客服） |
| `dsh-ppt-suite` | 公司 PPT | ⛔ 移除（非客服） |
| `dsh-web-search` | SearXNG 搜索 | ⛔ 移除（客服无需外网搜索；如需联网可后续加） |
| `directory-picker-browse` | 浏览器目录选择 | ⛔ Admin 官方 UI 自带；保留与否后续定 |

> 说明：**删除 ≠ 改内核源码**。客服 profile（cordis.patch.yml / profile package.json）只装载官方内核 + 客服插件；第三方代码留在仓库中作为可选功能，由 profile 组合决定是否运行。源码删除仅限「仓库内客服不需要且会误导」的样例/文档（阶段5收尾时定）。

### 3.4 新增（客服专属）

| 件 | 位置 | 说明 |
|---|---|---|
| 客服 profile | `deploy/customer-service/profile/cordis.patch.yml` 等 | 官方内核 + 客服 preset + knowledge 插件 + 白标 |
| 客服 preset | `packages/preset/agent-presets/presets/customer-service/` | persona=客服助手、受限工具集（无代码执行，允许检索+引用） |
| 游客瘦身 preset | 同上 `guest/` | 只读知识库检索 + 纯对话 |
| knowledge 检索插件 | `packages/<group>/knowledge-search/`（新包） | 只读扫描 vault 目录 + 简单检索，注入上下文 |
| Guest 前端 | `apps/guest-web/`（新 Vite 应用） | 纯聊天界面，Markdown+HTML 图表/图片渲染 |
| Guest 后端通道 | 复用 api session-controller / 新增轻量 JSON 网关 | 匿名会话 + 限流 |
| 部署 | `deploy/` Dockerfile + compose + nginx + .env.example | 单服务 |
| 文档 | `docs/customer-service/*` | 本设计 + 部署 + 验收 |

## 4. 模型路由 / Admin 配置（复用）

- Admin 的「设置 → 模型」页已经能管理 provider/key/默认模型（写 settings.yaml / .credentials.yaml）。
- 客服会话默认模型/路由从 settings 读取；客服 preset 可钉默认模型，Admin 仍可改。
- provider 现成多路（agentrouter/commandcode2/…），容器内以 env + settings 注入。

## 5. 知识库（Obsidian vault）接入

- 部署时 `docker compose` 把 vault 目录只读挂到容器 `/kb`。
- 客服 knowledge-search 插件提供 `knowledge_search` 类工具给客服 preset：扫描 `.md`，按标题/正文做关键词+向量（可选，无需外部服务）检索，返回片段+源文件路径；检索结果随用户问题注入模型上下文并附引用。
- 内容更新：vault 文件变化即重新索引（或按需懒索引 + TTL），无需重启。
- Admin 无需改 Obsidian；编辑 vault 即客服知识更新。

## 6. 会话与界面

### Admin（保留官方 Web GUI）
- 官方 DSH Web 界面：模型设置、会话、知识库管理（未来）。
- 白标：标题/logo（`DSH_CLIENT_TITLE`）、隐藏与客服无关设置入口（如插件/技能等，按需 disable client 行）。

### Guest（游客）
- 纯聊天入口（无设置、无开发者面）。
- 会话：匿名（服务端 session cookie / 内存 id），**限流**（每 IP/每会话 每分钟 N 条）。
- 渲染：回答为 Markdown + 图片。**实测约束**：官方 `ui-primitives` Markdown 管道把 raw HTML 当纯文本（防 XSS 设计，render.tsx case 'html'），图片只放行协议白名单；「HTML 图表」不能靠官方管道，由 **Guest 前端自实现受限富渲染**（识别模型输出的专用图表标记 → 白名单渲染图表/卡片；普通 HTML 一律转义为文本，杜绝 XSS）。图片走附件或白名单 URL。

## 7. Docker 化约束与方案

- **不能 `npm i` 官方包**（npm 上 dsh-base/web-app 仅 0.0.1-rc 占位、dsh-cli 未发布）→ 镜像内基于本 checkout **pnpm workspace 构建**（`pnpm install --frozen-lockfile` → `pnpm run build`），运行时 `pnpm dsh --profile customer-service`。
- 官方 `--host 0.0.0.0` 被拒（防 RCE）→ 容器内 dsh 绑 `127.0.0.1:3080`，**nginx 反代对外**（/admin、/guest）。
- 持久化：`DSH_HOME` 挂卷（settings.yaml / .credentials.yaml / sessions / storages）；vault 只读挂 `/kb`。
- 健康检查 + 数据卷 + .env 注入 API key。

## 8. 阶段计划

1. **客服 profile 骨架**：新 profile 只装 dsh-base + dsh-web-app + 客服 preset，本机第二实例（独立 DSH_HOME/端口）验证可启动、可聊天、模型路由正常。验证裁剪无副作用。
2. **知识库 + preset**：vault 只读检索插件、客服/游客 preset、检索→上下文→引用闭环。
3. **Guest 前端**：Vite 应用（纯聊天 + HTML/图表 + 图片）+ 匿名会话通道 + 限流。Admin 白标与入口分离。
4. **Docker**：Dockerfile（workspace build + 运行）、compose（app+nginx+卷）、健康检查、.env；容器内端到端验证（Admin 聊天 + Guest 问答 + KB 命中）。
5. **GitHub 同步**：全新仓库 `YaYII/dshagent`，全新初始提交（保留文件树、弃上游历史），配置说明。
6. **收尾**：验收文档、知识库沉淀、交付汇报。

## 9. 验收标准

- Admin 端：Docker 起后能登录/聊天/配置模型 provider；无第三方开发插件入口。
- Guest 端：匿名可问答，限流生效；回答可渲染 Markdown/HTML 图表与图片；可引用知识库。
- 知识库：客服问题能命中 vault 内容并附来源。
- Docker：`docker compose up` 一条命令起；数据/知识库更新不丢；本机浏览器两端口可访问。
- GitHub：`YaYII/dshagent` 仓库含全部源码 + 部署文档，可 clone 即跑。

## 10. 非目标

- 不迁移/保留上游 git 历史（全新初始提交）。
- 不做多客服坐席人工接管、工单流转（后续可加）。
- 不改 deepseek-harness 官方内核行为；裁剪只发生在 profile/preset 组合层。
