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
## 输出前自审门禁（新增能力）

客服/访客回答中的**图形围栏**（`mermaid` / `chart` / `image` / `html`）在送达访客之前，
必须经过**确定性校验**；不通过则**降级剥离**。**绝不把坏图或原始围栏源码交给访客。**

### 分级门禁（文字流式保留，块级先审后渲染）

- **文字**：仍走流式（Delta 照常下发），不受影响；
- **图形块**：主机侧**跨分帧围栏状态机**把块从 delta 流中**摘出**，以结构化 `block` 事件下发；
  **围栏源码不出现在任何载荷字段**（口径 B），块源码仅以 **base64**（`sourceB64`）承载；
- **访客端**：块先落**占位元素**，判定合格后才渲染；判定依据**真机实测**（`naturalWidth` 等），
  判据不达标则替换为**可读降级文案**。

### 三出口收口（不可绕过）

`/api/guest/chat`、`/api/guest/chat/stream`、`/api/guest/history` **三个出口**均由主机侧同一门禁处理，
**不依赖提示词或前端自觉**。

### 判定职责分层

| 层 | 职责 |
|---|---|
| **主机侧** | 结构性判定：IMG1 图片路径白名单、chart 数据结构、html 非空/字节上限、超预算、未闭合、流中止 |
| **访客端（真机）** | 渲染后实测：空图、异常比例、`naturalWidth`、脚本类 html 等**只能真机判定**的项 |
| **留痕** | 真机结论经 `/api/guest/render-report` 回传，落 `ctx.logger.warn`（前缀 `guest.output-gate`，7 字段） |

### 关键语义（易误读，务必按此理解）

- **`blockResults[id]`** 是**门禁放行终态**（`'passed' | 'degraded'`），有**四种**来源：
  ① 主机侧即降级 ② 真机回传 `degraded` ③ 真机回传 `passed` ④ **等待窗口内未收到回传 → `passed`**；
- **`passed` ≠ 真机已验证** —— 它只表示「对该访客保持可见/未被判负」；真机证据的归属地是**留痕**；
- **不做模型重写**：本机制**没有**二次模型生成、**不回改已上屏内容**（REP1）；未通过即降级。

### 生效条件（**按实际挂载判定，不可按目录推断**）

- `web/guest/**`、`deploy/nginx.conf`、`deploy/kb/` → **bind-mount，改文件即生效**；
- `plugins/**`、`presets/**`、`deploy/profile/**` → **烘焙进镜像，须重建镜像才生效**（仅重启无效）。

> ⚠️ **`serviceVersion` 是镜像构建戳**：改源码值**不等于**生效；须重建镜像后
> `curl /api/guest/health` 的 `version` 才反映新值。

### 完整交付材料

见 `docs/output-self-review-delivery.md`（判别器基线、制品指纹、未验证项、回滚路径、已知权衡）。

## 已知权衡（未闭合围栏）

**闭合判据**要求「整行仅同类围栏字符」，而**起始判据允许前导内容**（为防缩进/引用块泄漏）——
**开/闭判据有意不对称**。故当闭合行含前导内容（如表格单元格 `| x | ``` |`）时该行不被认作闭合，
块视为**未闭合**，按其安全语义**扣留其后全部内容至文末**。

- **代价**：畸形输出（模型写了未闭合围栏）之后的正文字符一并不可见；
- **为何不改**：需求 P4/P6 要求**任何路径都不得外发原始围栏源码**；放宽闭合判据会在
  「块体内容恰好含表格行 + 围栏」时**提前闭合**，从而**重开泄漏口**；
- **待决**：若产品方要求保留尾文，须走 **requirements 修订**（涉及开/闭判据不对称性的重新定义），
  并同步两侧实现与用例。

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
     【输出前自审门禁】fence-machine 摘块 → 结构化 block（源码不出载荷）
              │
              ▼
     Markdown 回复 + 来源 + blockResults → 游客前端渲染
        ├─ 文字：流式照常
        └─ 图形块：占位 → 真机判定 → 渲染 / 降级文案（结论回传留痕）
```
