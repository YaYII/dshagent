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

Admin 每次启动生成一次性 token，写在容器日志里：

```sh
docker logs dshagent-app 2>&1 | grep -o 'http://127.0.0.1:3080/?token=[A-Za-z0-9]*' | tail -1
```

把输出里的 `127.0.0.1:3080` 换成 **`127.0.0.1:10801`** 再打开，例如：

```
http://127.0.0.1:10801/?token=5n8U85EtuIiWb8A7OMP3KYjbdIBGUeMeVXtcUuBQit8
```

> token 每次重启都会变，旧链接失效就重新取一次。首次打开会弹测试公告，点 **Continue**。

### 2.2 查访客对话记录（这是最常问的）

1. 左侧栏点 **Workspaces** 标题（展开工作区列表）。
2. 点 **Ungrouped** 这一行（默认是**折叠**的——只显示组名，看不到会话，很多人以为「没有记录」）。
3. 展开后看到访客会话按时间倒序排列，标题就是访客的第一句话（例：`客服熱線是多少？ 18min`）。
4. 点 **Show 67 more sessions** 可继续展开（每组默认只显示 5 条，多的折叠在此）。
5. 点任意一条 → 右侧完整回放该访客的问答，包含当时的图表与图片。

也可以用搜索框按关键词找（标题、问题内容都能搜）。

### 2.3 你能看到的记录范围

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

从仓库根目录执行（`tsx` 解析 workspace 包）：

```sh
cd /home/as-workstation01/Documents/project/dshagent

node --import tsx/esm customer-service/plugins/output-gate/tests/gate-check.mjs        # 76
node --import tsx/esm customer-service/plugins/output-gate/tests/http-exits-check.mjs  # 25
node --import tsx/esm customer-service/web/guest/tests/output-gate-check.mjs           # 65

# 浏览器 DOM 套件（Playwright 装在同级 Chrome 目录）
cd /home/as-workstation01/Documents/project/Chrome
node /home/as-workstation01/Documents/project/dshagent/customer-service/web/guest/tests/gate-dom-check.mjs  # 94
```

四套件合计 **260** 项断言，全过才算改动可信。

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

排错时开容器日志实时看：

```sh
docker logs -f dshagent-app
```
