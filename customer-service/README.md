# dshagent — 智能客服系统

基于 DeepSeek Harness（deepseek-harness 源码）改造的 **Docker 化智能客服系统**：

- **Admin 端**：官方 DSH Web GUI —— 配置 AI 模型/provider、查看会话、管理知识库。
- **Guest 游客端**：纯聊天对话页 —— 匿名问答、自带限流；回答由知识库驱动并可
  渲染 Markdown / 表格 / 条形图 / 图片，客服可附带来源引用。
- **知识库**：Obsidian vault 目录只读挂载，编辑 vault 即更新客服知识。
- **部署**：Docker compose 单机运行（dsh-agent + nginx）；游客与 Admin 分占两个端口。

## 快速开始

```bash
cd customer-service/deploy
cp .env.example .env        # 填 AGENTROUTER_API_KEY
docker compose up -d --build
# 游客端 http://<host>:10800/    管理端 http://<host>:10801/
```

详见 [deploy/README.md](deploy/README.md)。

## 架构

```
               对外 nginx :10800 / :10801
            :10800 (游客)            :10801 (Admin)
                 │                        │
     Guest 前端(静态)             官方 DSH Web GUI
        │  /api/guest/*                 │
        ▼                              ▼
        └──────── dsh-agent :127.0.0.1:3080 ────────┘
          · 官方内核 bundle（dsh-base + dsh-web-app）
          · customer-service / customer-service-guest preset（瘦身工具集）
          · knowledge-search（vault 只读检索） · guest-server（匿名 API + 限流）
          · /kb = Obsidian vault（只读）· DSH_HOME 卷（settings/sessions）
```

## 目录

- `design.md` — 改造设计（裁剪清单 / 架构 / 验收标准）
- `presets/` — Admin 客服 preset 与游客瘦身 preset
- `plugins/` — knowledge-search 检索插件、guest-server 游客 API 桥
- `web/guest/` — 游客前端（单文件 HTML）
- `deploy/` — Dockerfile / compose / nginx / profile / 部署说明

## 裁剪说明

客服 profile 只装载官方纯净内核（`@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`），
不装任何第三方业务 bundle（agiteam / 任务板 / 团队编排 / Office / PPT / 搜索等，
见 [design.md](design.md) 的裁剪清单）。第三方代码保留在仓库中但不由客服
profile 装载，避免攻击面与维护负担。
