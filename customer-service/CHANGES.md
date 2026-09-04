# 客服系统改造 — 裁剪与能力说明

本文回答两个问题：**这个仓库改造成了什么**、**哪些东西被删/被禁用了**。

## 仓库是什么

根目录是 DeepSeek Harness（`dsh`）完整源码 —— 一个全插件化的 Agent 运行时。
改造后它运行的是**客服系统**：会话内核 + 模型路由照用，但客服会话的能力被
preset 收窄为「问答 + 知识库 + API」。

## 删了什么 / 禁用了什么

### 已删除（仓库级）

| 项 | 说明 |
|---|---|
| `测试商城2/` | 一次 agiteam 流程遗留的**空壳目录**（0 文件），与客服无关，已删 |

### 客服 profile 不装载（组合层裁剪，源码保留）

客服 profile（`customer-service/deploy/profile/`）只装载官方纯净内核
`@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`，**不装**以下第三方
业务 bundle（代码仍在仓库但客服进程永不加载）：

- `@xmanrui/dsh-im`（IM 界面/工作区）
- `dsh-plugin`（社区插件装载）
- `dsh-routing-suite`（路由套件）
- `dsh-univer-office`（Office 文档/表格/PPT）
- `aegis`（方法包）
- `@nanmicoder/dsh-agent-teams`（多智能体团队）
- `dsh-better-sidebar`（侧栏/终端美化）
- `dsh-pipeline-kernel`（管线任务板）
- `@deepseek-ai/dsh-agiteam`（AGI 团队开发引擎）

以及本地开发机 profile 里那些（Cerebrate 记忆 / code-review / 项目 wiki /
PPT / 代码架构自检 / SearXNG 搜索等）—— 全部不进入客服镜像。

### 客服会话能力收窄（preset 层，最重要）

客服不是编码 Agent，**没有也不会有**以下能力（工具根本不注册，非仅提示）：

- ❌ shell / 终端命令（bash、pwsh、persistent terminal）
- ❌ 文件系统读写（fs、编辑器）
- ❌ 子代理 / 工作流 / 代码执行 / ralph 迭代
- ❌ 网页浏览搜索
- ❌ 计划模式 / goal / todo 等开发辅助

客服会话**只有**这些工具：

| 工具 | 作用 | Admin 客服 | 游客 |
|---|---|---|---|
| `knowledge_search` | 检索 Obsidian 知识库（vault） | ✅ | ✅ |
| `api_get` | 调用白名单内外部 API 取数（订单/产品/价格…） | ✅ | ✅ |
| `kb_write` | 把结果/案例写入知识库 vault | ✅ | ⛔ 游客无写权限 |

**为什么保留全部官方源码包？** 因为 dsh 是 monorepo：`packages/*` 相互
依赖、tsc 全量编译（`tsconfig.host.json`）会编译所有包与 `scripts/`、`website/`。
删任何被引用的包都会让镜像构建失败。客服系统与"写代码工具"的切割点在
**组合层（profile/preset）**而非源码层 —— 这是本架构的正确裁剪面：能力
边界由"会话装载什么"决定，与"仓库里有什么源码"无关。

## 两个交互窗口

- **Admin（`/admin`）**：官方 DSH Web GUI。可配置 AI 模型/provider/key、
  查看会话、管理知识库内容。
- **游客（`/`）**：纯聊天页。匿名、按 IP 限流；回答可渲染 Markdown /
  表格 / 条形图 / 图片；客服回答可带知识库来源引用。

## 数据流

```
游客提问 ──► guest-server (/api/guest/chat)
              │
              ▼
     customer-service-guest preset 会话（单 agent 单轮）
      ├─ knowledge_search → /kb（Obsidian vault，只读）
      ├─ api_get → 白名单外部 API（读数据）
      └─（客服 preset 另可 kb_write 写回 /kb）
              │
              ▼
     Markdown 回复 + 来源 → 游客前端渲染（图表/图片）
```
