# 客服系统测试指南

面向「要自己动手验一遍」的同事：两条入口、每步看什么、失败了怎么查。
全部命令可直接复制。默认端口：游客端 **10800**，Admin 端 **10801**。

---

## 0. 先看服务在不在

```sh
curl -s http://127.0.0.1:10800/api/guest/health
# {"ok":true,"version":"2026-09-11.12"}   ← version 要与本次发布一致
```

版本号对不上说明容器还是旧镜像，`bash customer-service/deploy/start_dshagent_all.sh` 重启。

---

## 1. 游客端（访客视角）

浏览器打开 **http://127.0.0.1:10800/**

| 测什么 | 怎么看 |
|---|---|
| 打字机效果 | 提问后文字应逐字出现，不是整段蹦出 |
| 合約/账单查询 | 问「幫我查合約 0070878510 的賬單」→ 金额/到期日/用电量应来自业务系统 |
| 图表渲染 | 问「用 mermaid 画一张停电报修流程」→ 图应真实渲染出来 |
| 图片查看 | 回答里的图片点一下应放大 |
| HTML 卡片 | 问「用 html 做一个缴费方式卡片」→ 卡片应正常显示、无「查看源码」按钮 |
| 换语言 | 右上角切 English → 回答应变成英文（**不是**知识库原文的繁中） |
| 新对话 | 点「新对话」→ 界面清空，重新开始 |
| 刷新保历史 | 按 F5 → 之前的对话还在 |
| 反滥用 | 同一会话连续刷无意义内容 → 先警告，再触发 60 秒封禁提示 |

命令行等价（不想开浏览器时用）：

```sh
SID=$(curl -s -X POST http://127.0.0.1:10800/api/guest/session | python3 -c 'import json,sys;print(json.load(sys.stdin)["sessionId"])')
curl -s -X POST http://127.0.0.1:10800/api/guest/chat \
  -H 'content-type: application/json' \
  -d "{\"sessionId\":\"$SID\",\"message\":\"幫我查合約 0070878510 的賬單\",\"lang\":\"zh\"}" \
  | python3 -c 'import json,sys;print(json.load(sys.stdin)["reply"])'
```

---

## 2. Admin 端（内部视角，能查访客记录）

### 2.1 拿登录链接

**直接跑脚本**（推荐，打印的就是能点开的地址）：

```sh
bash customer-service/deploy/admin-url.sh            # 用人能访问的网卡 IP
bash customer-service/deploy/admin-url.sh 127.0.0.1  # 只要本机访问
```

想手工取也行：

```sh
docker logs dshagent-app 2>&1 | grep -o 'http://127.0.0.1:3080/?token=[A-Za-z0-9_-]*' | tail -1
```

⚠️ **日志里那条 `127.0.0.1:3080` 不能直接点**——那是容器内地址（回环 + 容器内端口）。
把主机与端口换成宿主上的 **10801** 才是对外入口，例如：

```
http://192.168.1.44:10801/?token=PjjMBdXLQUu9tNF_wzgT7JWzJUrNhzrl0C2Rwutmd7Y
```

看到 **"dsh web authentication required; reopen the URL printed by dsh web"** 就是
这两件事之一：① 点的是容器内 3080 那条；② 链接过期了（token 每次重启都重新生成）。
重跑 `admin-url.sh` 即可。首次打开会弹测试公告，点 **Continue**。

### 2.2 在 Admin 里跟「客服助手」对话（自己测 Agent）

Admin 端不只是看记录，本身就是一个能对话的界面，用的 preset 是 **客服助手**
（知识库驱动、不执行代码/文件操作），跟访客端是**两套独立会话**。

> ⚠️ **首次使用必须先添加一个工作区**。部署默认没有注册任何工作区，而新建会话
> 必须有工作区，否则点「选择工作区」只弹预设列表、点了也不会有输入框——
> 界面看起来「点了没反应」，实际是缺工作区。工作区一旦加过就存在 `dsh-home`
> 卷里，重启不丢。

1. 打开 §2.1 的 Admin 链接，首次弹窗点 **Continue**。
2. 点标题行 **Workspaces / 工作区** 右侧那个 **添加工作区** 图标（`aria-label="添加工作区"`）。
3. 目录选择器里点 **编辑路径**，填入目录（推荐 `/kb`，即知识库根），回车；
   在列表里选中该目录，点 **打开**。
4. 添加成功后底部立即出现输入框（`发消息或做任务…`）。默认 preset 就是
   **客服助手**（输入框上方会显示），直接输入问题回车即可。
5. 想换 preset：点输入框上方的 preset 名称（如「客服助手」），会列出
   标准模式 / PTC 模式 / 极简模式 / 创造模式 / **客服助手** / **客服访客**。
   - **客服助手**：内部视角，可检索知识库并读写知识库（`kb_write`）。
   - **客服访客**：与访客端同一套能力（只读），可用来对比两个视角的差别。
   - 编码模式（标准/PTC/极简/创造）会拿到文件与 Shell 工具，工作区路径即其可操作
     范围——**别把工作区设成 `/`** 再用编码模式。

会话行右侧可切换 **对话 / 轨迹 / 系统提示词** 三个页签：查「模型实际收到了什么
系统提示词」「这轮走了哪些工具、耗时多少」都在这里，排查 Agent 行为时很有用。

### 2.3 查访客对话记录（这是最常问的）

1. 左侧栏点 **Workspaces** 标题（展开工作区列表）。
2. 点 **Ungrouped** 这一行（默认是**折叠**的——只显示组名，看不到会话，很多人以为「没有记录」）。
3. 展开后看到访客会话按时间倒序排列，标题就是访客的第一句话（例：`客服熱線是多少？ 18min`）。
4. 点 **Show 67 more sessions** 可继续展开（每组默认只显示 5 条，多的折叠在此）。
5. 点任意一条 → 右侧完整回放该访客的问答，包含当时的图表与图片。

也可以用搜索框按关键词找（标题、问题内容都能搜）。

### 2.4 你能看到的记录范围

- 每一轮访客问答本身（问题 + 客服完整回答，含渲染块）。
- 会话标题、最后活动时间、运行状态。

**看不到**（设计如此）：访客的 IP、地理位置、浏览器指纹。系统按「会话」记录，不做访客画像。

---

## 3. 数据存在哪（要直接查文件时）

| 内容 | 位置 |
|---|---|
| 会话记录（含完整问答） | 容器 `/dsh-home/sessions/--kb--/<sessionId>/session.jsonl.zstd` |
| 会话标题/摘要缓存 | `/dsh-home/storages/session_projcache/sessions/<sessionId>.json` |
| 知识库答不到的问题 | `/kb/待补充问题.md`（HTTP 经 `/api/guest/*` 写入，落地在容器 `/dsh-home/unanswered/`） |

```sh
# 会话总数
docker exec dshagent-app sh -c 'ls /dsh-home/sessions/--kb-- | wc -l'

# 读一条会话（zstd 压缩，容器内解）
docker exec dshagent-app sh -c 'node -e "
const fs=require(\"fs\"),zlib=require(\"zlib\");
const f=process.argv[1];
const buf=zlib.zstdDecompressSync(fs.readFileSync(f));
const lines=buf.toString(\"utf8\").split(\"\n\").filter(Boolean);
console.log(\"事件数:\",lines.length);
for(const l of lines.slice(0,3))console.log(l.slice(0,200));
" /dsh-home/sessions/--kb--/<SESSION_ID>/session.jsonl.zstd'
```

> ⚠️ 清理测试数据**必须按精确 id 删**，不要用通配符：
> `docker exec dshagent-app rm -rf /dsh-home/sessions/--kb--/guest-<完整id>`
> 之前有一次用通配符误删了 149 个真实访客会话目录，无法恢复。

---

## 4. 自动化回归（改代码后跑）

### 4.1 在容器里跑（需要 workspace 依赖的那几套）

这些套件 import `@deepseek-ai/cordis` / `jsdom`，宿主仓库没装全依赖，在容器里跑：

```sh
docker exec dshagent-app sh -c 'cd /app &&
  node --import tsx/esm customer-service/plugins/output-gate/tests/gate-check.mjs &&        # 76
  node --import tsx/esm customer-service/plugins/output-gate/tests/http-exits-check.mjs &&  # 28
  node --import tsx/esm customer-service/plugins/api-client/tests/lookup-check.mjs &&       # 34
  node customer-service/web/guest/tests/output-gate-check.mjs &&                            # 65（assets 是 CJS，别加 tsx）
  node customer-service/web/guest/tests/gate-dom-check.mjs'                                 # 104（jsdom 真页面）
```

改了测试文件但不想整组重建镜像时，直接拷进去（秒级）：

```sh
docker cp customer-service/web/guest/tests/gate-dom-check.mjs \
  dshagent-app:/app/customer-service/web/guest/tests/gate-dom-check.mjs
```

### 4.2 在宿主跑（Playwright / 真实对话）

在 `Chrome` 目录下执行（Playwright 装在那里），需要容器在跑、且模型可用：

```sh
cd /home/as-workstation01/Documents/project/Chrome
D=/home/as-workstation01/Documents/project/dshagent

node $D/customer-service/plugins/guest-server/tests/duplicate-turn-check.mjs  # 16 一问一答 + 多步轮历史归并
node $D/customer-service/web/guest/tests/paycode-check.mjs                    # 22 付款码：解码还原 + 静区/模块 + 刷新重放
node $D/customer-service/web/guest/tests/html-frame-check.mjs                 # 10 HTML 预览按内容自适应
node $D/customer-service/web/guest/tests/ui-audit.mjs                         # 对比度/溢出/中文行宽 + 截图
```

八套件合计 **355** 项断言，全过才算改动可信。

### 4.3 判据怎么选的（两条硬规矩）

1. **能独立复算的，绝不调用被测代码复算自己。** 付款码条码不能只断言「图出来了」——
   编码错了不会报错，只会让访客扫出**错误的数字**，比不显示更糟。因此
   `paycode-check.mjs` 从渲染出的 SVG 里把条空读回来、按 Code128 规范解码，再与
   **业务系统接口**当前返回的付款码逐字比对（期望值也是现取的，不是写死的）。
2. **一条渲染异常不得吃掉访客的答案。** 正文渲染串在整轮的 try 里，任何渲染异常
   都会被当成「断流」；恢复路径再抛一次就没人接了，气泡永远停在「正在恢复」。
   所以逐帧入口包了 `safeRenderStream`（抛错退化为纯文本），判据按行宽/块数断言，
   不按「必须抛错」断言。历史上真踩过：一行写错变量名（`fence.lang` 用了外层必为
   null 的 `fence`），任何普通代码块都会让整轮回答消失。

---

## 5. 出问题怎么查

| 症状 | 先查什么 |
|---|---|
| 页面打不开 | `docker ps` 看 `dshagent-app`/`dshagent-nginx`；`docker logs dshagent-app --tail 50` |
| 游客端转圈不出字 | nginx 必须 `proxy_buffering off`（SSE），见 `deploy/nginx.conf` |
| Admin 页面能开但没数据、控制台 403 | nginx Admin 段必须是 `proxy_set_header Host $http_host`（带端口）；用 `$host` 会剥端口，与浏览器 Origin 失配导致 /api 全 403 |
| 会话标题变成半截句子 | 容器日志搜 `title output reached maxOutputTokens`；网关强制思考，`session-title-llm.maxOutputTokens` 要够大（当前 512） |
| 合約/账单查不到 | 见 `docs/cem-ai-api-verification.md`：`withAddress` 只认 `1/0`、`level=3` 会超时、不存在的合約号返回 500 |
| 改了 nginx.conf 不生效 | nginx.conf 是单文件挂载，需 `docker compose up -d --force-recreate nginx` |
| 两个端口突然都连不上（`http=000`）但容器都是 Up | 多半是**只重启了 `dshagent-app`**：nginx 用 `network_mode: service:dsh-agent` 共享网络命名空间，dsh-agent 一重启，nginx 还挂在旧命名空间上，两个端口一起废。修：`docker compose up -d --force-recreate nginx`。**改配置请整组 `docker compose up -d`，别用 `docker restart dshagent-app`** |
| Admin 里点工作区/预设没反应、不出现输入框 | 没有注册工作区（新建会话必须有工作区）。见 §2.2 添加一个；工作区存在 `dsh-home` 卷里，重启不丢 |
| Admin 提示 "dsh web authentication required" | 点的是容器内地址（`127.0.0.1:3080`），或 token 过期。跑 `bash customer-service/deploy/admin-url.sh` 拿新链接 |
| 想换客服的底层模型 / 换免费模型 | `bash customer-service/deploy/model.sh list\|current\|free\|paid`，**立即生效不用重启**。见 `docs/model-management.md` |
| 刷新后同一句问话出现两条回答（或回答只有一句「我先查一下」） | 历史投影必须**按 turn 归并**：一个 agent step 一条 `assistant/message`，且旧记录里还有「语言说明唤醒新 turn」留下的孤儿回答。查 `docs`→`guest-server/src/index.ts` 的 `readHistoryFromLog`；回归用 `duplicate-turn-check.mjs` 的 F/G/H 段 |
| 付款码出来了但扫不出来 / 扫出来数字不对 | 条码编码错不会报错，只会让访客缴错费。跑 `paycode-check.mjs`（从 SVG 反解数字并与接口比对）；静区必须 ≥10 模块、模块 ≥2px |
| 回答只显示「网络不稳定，正在为您恢复回答…」一直不动 | 走的是断流恢复路径：说明流式中**渲染抛异常**被当成了断流，或恢复端拿不到 `active=false` 的终态。看浏览器控制台的 `pageerror` 栈（`renderMarkdown` / `renderStreamMarkdown`） |

排错时开容器日志实时看：

```sh
docker logs -f dshagent-app
```
