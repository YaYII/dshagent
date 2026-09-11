# 输出前自审门禁 — V2 确认性复验报告

> 角色：verifier（对抗验证者，**只写本报告路径，未修改任何实现代码**）
> 日期：2026-09-10
> 承接任务：**t8「V2 确认性复验」**（已终态 `failed`：A–G 行为面全通过，因发现 F-6 判 failed）
> 判据基线：`customer-service/docs/output-self-review-requirements.md`
> 前序报告：`output-self-review-verification.md`（V1，保留不动；其 §0.0 基线失效声明继续有效）

> **⚠️ 编号已统一（读正文前请先看 §6.2 对照表）**：V1 阶段存在**两套互不一致的 F 编号**
> （t5 回报一套、V1 报告 §5 一套），本报告此前混用，导致 §2.2/§2.3 都写"F-2"、`D-1` 与 t5 撞号。
> 现已统一为：**F-1** 超长 info、**F-2** 资产重复加载、**F-3** 冻结依据不符、**F-4** `scanGates` 死代码、
> **F-5** 未闭合围栏（原误标 F-2）、**F-6** `blockResults` 取值域（原误标 D-1）、
> **P9-1** 干净 EOF 不降级（本轮新增）。**F-4 沿用 requirements §16.4 的既有含义，未被重定义。**

**本报告为两轮合并稿**：第一轮（提交 t8）为 A–G 全清单 + 证据层级 + F-1/F-2/F-3 复验；
第二轮（captain 要求补测）新增 **REG6 通过**、**P9-1 新 finding**、**F-6 改号**、**F-4 实质证据（§6.3）**，
并把 20:29 前的门禁行为证据**全部重采**（§3.10）。


---

## 0. 锁版证据与证据层级

### 0.1 判据基线版本（实测）

```
$ head -2 customer-service/docs/output-self-review-requirements.md
# 客服输出前自我审核 — 需求清单与验收标准（v3.2.11）
```

> ⚠️ **版本沿革（实测记录）**：captain 的开工信号指定 **v3.2.10（625 行 / 92 条）**；
> 实测磁盘为 **v3.2.11（679 行）**。v3.2.11 相对 v3.2.10 新增：
> ① 录入新基线（`e597f642…`，本轮又被更新，见 §0.2）；② 新增 §16.4 F-4/F-4b 独立核验（含 1 条 low finding F4B-1）；
> ③ §16.3 补记第 5 条流程失责。
> 本报告按 **v3.2.11** 执行（它包含 v3.2.10 的 G-ANCHOR 方法论与全部判据）。

### 0.2 被测制品（二元组）与漂移记录

**本轮实际取证的制品**（全部证据采集于 **20:45–20:53**）：

| 侧 | 文件 | sha256(16) | 大小 |
|---|---|---|---|
| 前端 | `web/guest/index.html` | **`07a073ceb7049a22`** | 131367 B |
| 前端 | `web/guest/assets/output-gate.js` | **`11ebac8964857f0a`** | 31718 B |
| 前端 | `web/guest/assets/package.json` | `a51bff776fdd5322` | 44 B |
| 主机 | `plugins/output-gate/src/fence-machine.ts` | `fd6e9cbc227268e2` | — |
| 主机 | `plugins/output-gate/src/engine.ts` | `6027b330a385b1b9` | — |
| 主机 | `plugins/output-gate/src/block-rules.ts` | `dafca4575e9be224` | — |
| 主机 | `plugins/output-gate/src/index.ts` | `4d39bb58624a0e49` | — |
| 主机 | `plugins/guest-server/src/index.ts` | `99110840bc1bb7ed` | — |

`grep -c "block-open" web/guest/index.html` = **6**

### 0.3 ⚠️ 关于 `f0dc41832` 与 `/tmp/bak.html` 的辨析（避免复核者误判）

captain 在本轮指令中把 **`f0dc41832cd79106`（128477 B）** 称为"当前有效基线"，并要求若不符则停手。
**实测：该值是旧内容，磁盘上已是 `07a073ceb7049a22`（131367 B）。** 决定性证据（**内容层**，非 mtime）：

```
$ sha256sum /tmp/bak.html          → f0dc41832cd79106   128477 B
$ sha256sum web/guest/index.html   → 07a073ceb7049a22   131367 B
$ diff /tmp/bak.html web/guest/index.html | grep -c '^[<>]'
107
$ for f in /tmp/bak.html web/guest/index.html; do grep -c scanGates $f; done
4      ← bak.html（旧）
0      ← 磁盘（新，含 F-1 死代码清理）
```

→ **`/tmp/bak.html` 的内容恰等于 captain 坚持的基线值**；磁盘文件是更新的一版。
→ **新旧判据不能只看"sha 是否相等"，要看内容包含关系**：`07a073ce` 含 `scanGates` 清理（v3.2.11 §16.4 记录的 F-4 删除），`f0dc41832` 不含 → 后者是**更早**的版本。
→ 另说明：**`/tmp/bak.html` 不是本 verifier 创建**；我的全部脚本不引用该路径（`grep -rn "bak.html" /tmp/cs-verify/*.mjs /tmp/cs-verify/*.sh` → 无命中）。**我从未写入 `customer-service/web/guest/index.html`。**

### 0.4 证据层级标注（G-ANCHOR，v3.2.10 §16.2）

判据优先级：`线上制品 > 行为/事件序列 > 制品指纹 > 符号存在 > 措辞 > 主观陈述`。本报告逐项标注：

| 证据层级 | 本报告中的用途 |
|---|---|
| **线上制品** | 三出口原始报文（§3.3）、实例响应体指纹（§0.5） |
| **行为/事件序列** | 真机 DOM 快照、SSE 帧序列、`scanGates` 运行期调用计数、F-2 两轮行为对照 |
| **制品指纹** | §0.2 基线表、G-ANCHOR-4 前后校验 |
| **符号存在** | 仅用于**定位**，不作为结论依据（如 F-2 的 `mermaidLoadFailed`） |

### 0.5 二元组三重标识

**① 被测实例 health**

```
$ curl -s http://127.0.0.1:10900/api/guest/health
{"ok":true,"version":"verify-local-1"}
```

**② 被测实例自己服务的页面 sha256（取自实例响应体，非工作区推断）**

```
$ curl -s http://127.0.0.1:10901/ | sha256sum | cut -c1-16
07a073ceb7049a22          ← 与磁盘 index.html 逐字节一致
$ curl -s http://127.0.0.1:10901/assets/output-gate.js | sha256sum | cut -c1-16
11ebac8964857f0a          ← 与磁盘 output-gate.js 逐字节一致
$ grep -c "block-open" <实例响应体>
6
```

**③ 该实例 SSE 含 `block-open`/`block` 事件（原始帧）**

```
$ grep -o '^event: [a-z-]*' v4-stream.txt | sort | uniq -c
      2 event: block
      2 event: block-open
    314 event: delta
      1 event: done
      1 event: meta
```

**④ 声明：未使用 10800 作判据。**

**⑤ 本轮重采的原始帧（21:08，真实模型轮，非桩）**

```
$ curl -s -X POST http://127.0.0.1:10901/api/guest/session     → {"sessionId":"guest-3bbef0fa-…"}
$ curl -sN -X POST http://127.0.0.1:10901/api/guest/chat/stream -H 'content-type: application/json' \
    -d '{"sessionId":"guest-3bbef0fa-…","message":"请直接用 mermaid 代码块输出一个三节点流程图：A 开始 -> B 处理 -> C 结束。只输出图，不要解释。","lang":"zh"}'
event: meta
data: {"sessionId":"guest-3bbef0fa-…","version":"verify-local-1","gate":{"blockTimeoutMs":200,…}}

event: block-open
data: {"blockId":"blk-611f52cb-0","blockType":"mermaid"}

event: block
data: {"blockId":"blk-611f52cb-0","blockType":"mermaid","sourceBytes":61,"decision":"render","sourceB64":"Zmxvd2NoYXJ0IFRECiAgICBBW+W8gOWni10gLS0+IEJb5aSE55CGXQogICAgQiAtLT4gQ1vnu5PmnZ9dCg=="}
```

`grep -c '```'` = **0**（帧内无任何围栏明文）；AS-3 正则 `[`~]{3,}\s*(mermaid|chart|image|img|html)` 命中 **0**。
`sourceB64` 解码 = `flowchart TD\n    A[开始] --> B[处理]\n    B --> C[结束]\n`（UTF-8 无损，与 `sourceBytes:61` 一致）。

> 说明：首轮用「用 mermaid 画一个停电报修流程」时，真实模型**拒绝绘图**（答"无可提供的官方步骤说明"），
> 无图形块 → 该轮 407 帧全为 `delta`。改用显式指令后一次即产出 2 个 mermaid 块。
> 这也如实印证 §4 第 6 条（图形块产出率由模型决定，非受控）。

### 0.6 端口映射（显式记录，避免复核者踩坑）

| 端口 | `/` 的内容 | 性质 |
|---|---|---|
| **10901 / 10903** | **guest 页**（sha = `07a073ce…`，`block-open`=6） | ✅ **被测页面来源** |
| 10900 | dsh web 鉴权页（sha `3aad6226…`，`block-open`=0） | 后端真实例的 web 端 |
| 10902 | **本 verifier 自建的双协议桩**（`stub-api.mjs`，返回 "no route"） | ⚠️ 见下 |

> ⚠️ **重要澄清**：captain 曾把 `:10902` 的 `render-report → 202` 当作"新门禁后端就位"的证据。
> **该推断方向相反**：`10902` 是我为双协议对照实验自建的桩（`stub-2protocol`），对**任何**载荷都返回 202。
> 决定性反证（行为层）：
> ```
> :10900 render-report + 非法载荷 → 400      ← 真门禁后端（有字段校验）
> :10902 render-report + 非法载荷 → 202      ← 桩，无条件应答
> :10901 SSE meta.version        → "verify-local-1"  ← 指向 10900 真实例
> ```
> **`:10900` 才是真门禁后端**；端口命名未标注用途是我的疏忽，特此说明以避免污染 t6 记录。

### 0.7 清理方式（已执行）

```sh
for p in 10900 10901 10902 10903; do
  kill "$(ss -ltnp 2>/dev/null | grep ":$p" | grep -o 'pid=[0-9]*' | cut -d= -f2 | head -1)" 2>/dev/null
done
rm -rf /tmp/cs-verify
```

运行中容器全程**未重启、未重建**。

---

## 1. 结论总表

| # | 验收项 | 结论 | 证据层级 | 章节 |
|---|---|---|---|---|
| 1 | **F-1（T 方案）：超长 info 围栏泄漏（V1 blocker）** | ✅ **已修复** | 行为 + 载荷 | §2.1 |
| 2 | **F-5（原 R 方案 F-2，已改号）：未闭合围栏块体进 DOM** | ❌ **结案：系本 verifier 的桩缺陷，非前端缺陷** | 行为 | §2.2 |
| 3 | **F-2（T 方案）：mermaid 资产重复加载（captain 提出）** | ✅ **已修复** | 行为（真机双向） | §2.3 |
| 4 | F-3（R 方案）：冻结依据称"F-2 已修复" | ❌ **撤回：系编号撞车误读**（见 V3 §7.1） | 文档 + 行为 | §2.4 |
| 5 | A 源码封堵 6 点（真机逐点表） | ✅ 6 点 / 失败 0 | 行为 | §3.1 |
| 6 | B 图片双通道 / IMG1–IMG8 | ✅ 通过（IMG7 经完整 html 块路径 + 网络层零出站实证） | 行为 | §3.2 |
| 7 | C 三出口一致 + 载荷无源码 | ✅ 通过 | 线上制品 | §3.3 |
| 8 | D 多块并行 + T1 ≤600ms | ✅ 2 块均 passed；**+0ms** | 行为 | §3.4 |
| 9 | E 可达性仅留痕（C6） | ✅ 载荷逐字节一致 | 制品 | §3.5 |
| 10 | F 降级终态 / 组件不可用 | ✅ 通过 | 行为 | §3.6 |
| 11 | G 不回归 | ✅ 通过 | 行为 + 事件序列 | §3.7 |
| 12 | 补测：T1 A/B、IMG7、AS-6 | ✅ 三项完成 | 行为 | §3.4/§3.2/§3.8 |
| 13 | 补测：REG6 断流自愈 | ✅ **通过**（本轮新增） | 行为 | §4.1 |
| 14 | **F-6（本轮新增）：`blockResults` 取值域违约** | ✅ **已修复并复验**（21:48 落地；t8 提交时仍成立） | 线上制品（原始帧） | §2.5 |
| 15 | **P9-1（本轮新增）：干净 EOF 时 `pending` 块永不降级** | ❌ **open（medium）** | 行为 | §4.1 |
| 16 | F-4（requirements §16.4）：`scanGates` 死代码 | ✅ **已删除**（复验：全仓 0 命中） | 制品 | §6.2 |

**总判定：A–G 行为面全通过；V1 的 finding 全部闭环（其中 F-5 已结案为**桩缺陷**，非产品缺陷）；本轮新增 F-6（**已于 21:48 修复并复验**）与 P9-1（**仍 open**）。**

> **编号已统一**：V1 的任务回报与 V1 报告**各用一套编号**（前者 F-1=超长 info，后者 F-1=`scanGates`），
> 本报告曾混用两套，导致 §2.2 与 §2.3 都写成"F-2"、`D-1` 与 t5 的 `D-1` 撞号。
> **本轮已改号并给出对照表（§6.2）**——改号前请先读该表，避免修复者对错靶子。


> **本轮新增复验轮（2026-09-10T20:29 之后）**：我在提交前复核制品指纹时发现主机侧
> `plugins/output-gate/src/fence-machine.ts` 的 mtime 为 **20:29:14**，**落在我取证窗口之内**
> （V1 期记录为 `fd6e9cbc227268e2`，现为 `259485406ad2c8af`）。按 G-ANCHOR「证据必须对应制品」，
> 凡在 20:29 之前采集的门禁行为证据一律**失效重采**。§3.9 记录重采清单与结果。

---

## 2. Findings 复验

### 2.1 F-1（T 方案；V1 blocker）超长 info 围栏泄漏 — ✅ 已修复

**证据层级：行为 + 载荷（非符号检索）**

```
$ node --import tsx/esm /tmp/cs-verify/repro-longinfo.mjs
/api/guest/chat:        status=200 载荷含 "```mermaid" = false
/api/guest/chat/stream: status=200 载荷含 "```mermaid" = false
/api/guest/chat/history: status=400 载荷含 "```mermaid" = false
```

V1 取证时（旧制品）为 `true` / `true` → **干净的 before/after 对照**。

**双向分支断言**（captain 指定）：

```
### 超长 info：mermaid + 520A（F-1 原始输入）
  TEXT 长度: 5 | 含 ```mermaid: false | 含 ```: false      ← 受控词 → 整段扣留并摘块
### 超长 info：mermaid + 空格 + 520B
  TEXT 长度: 5 | 含 ```mermaid: false | 含 ```: false      ← 同上
### 超长 info：非受控词 mmd + 520A
  TEXT 长度: 541 | 含 ```mermaid: false | 含 ```: true     ← 非受控 → 按 N2③ 透传（正确）
```

→ **受控→扣留 / 非受控→透传** 双向语义均正确。

### 2.2 F-5（原 R 方案 F-2，已改号）— ❌ **结案：系本 verifier 的桩缺陷，非前端缺陷**

> **⚠️ 结论已更正，请先读这段。** 本节曾记「未闭合围栏块体在 `fence-fallback` 下进 DOM」为 **low finding**。
> 经 captain 裁决 + 我独立根因追查，**该现象的根因在我的取证桩 `/tmp/cs-verify/stub-api.mjs`，
> 不是前端缺陷**。F-5 已结案为**桩缺陷**。下面保留更正过程与两项实测。

**证据层级：行为（真机 DOM 快照 + 帧级协议读数）**

#### ① 根因：桩把「按设计分片发送」实现成了「整段重复 9 次」

桩的 case 表**自己**标明 case 8 是 4 个分片（并与 case 9「整段一帧」明确区分）：

```js
'8': ['说明文字。\n', '```mermaid\n', 'flowchart TD\n', '  A[停电] --> B[报修]\n'],   // ← 设计为 4 个分片
'9': ['说明文字。\n```mermaid\nflowchart TD\n  A[停电] --> B[报修]\n'],                 // ← 整段单帧（对照）
```

而原实现先 `pieces.join('')` 再把**整段**放进数组，于是**每个 tick 重发整段，共 9 次**：

```js
const naiveReply = pieces.join('')                                        // 第 56 行
for (const line of [naiveReply]) send('delta', { text: line })            // 第 86 行：9 tick × 整段
```

前端按**增量**协议累加（`streamed += data.text`，与真实后端一致，见 ③），于是 `streamed` 得到
**9 个重复副本**（长度 48→432 字节）。

#### ② 机制量化：重复副本如何制造「已闭合」假象

旧前端普通代码块的闭口判据是**裸 `/^```/`**（不要求整行仅围栏字符）——而重复副本里的
`` ```mermaid `` 行**恰好以 ``` 开头**，于是被误判为"闭合行"：

```
$ node /tmp/cs-verify/mech-case8.mjs
单条长度=48 字节；9 副本长度=432 字节

【设计意图】4 个分片各发一次（合计 1 条），单条未闭合围栏：
   开栏次数=1 | 落为正文段落的块体行=0 → ✅ 无泄漏
【桩现状】整段 ×9 副本（页面按增量累加）：
   开栏次数=5 | 落为正文段落的块体行=8 → ❌ 泄漏
   泄漏行样例: ["flowchart TD","  A[停电] --> B[报修]","flowchart TD"]
```

→ **泄漏是"重复副本"派生出来的**，不是前端在**按设计意图**下发时的行为。

#### ③ 独立验证：真实后端的 delta 协议语义是**增量**

```
$ curl -sN -X POST http://127.0.0.1:10900/api/guest/chat/stream -H 'content-type: application/json' \
    -d '{"sessionId":"guest-c613ba42-…","message":"请用一句话说明澳门电费缴纳方式。","lang":"zh"}'
    （真实源码实例 10900，meta.version=verify-local-1；delta 帧数 222）
前 5 帧: ["澳门","电","费","目前","提供"]
各帧长度和: 391 | 拼接长度: 391
累积协议特征(每帧以前缀开头): false
→ 判定: 增量（每帧为新增片段）
末 3 帧: ["十分","抱歉","。"]
```

**确认 captain 的独立判断成立**：
- 前端 `streamed += data.text`（`index.html:2515`）是**增量消费**；
- 真实后端（本次实测 10900，及 captain 在 10800 的实测）都是**增量生产**——**两侧一致**；
- **累积协议（每帧重发全文）不出现在任何真实后端行为中**；
- **单靠内容无法区分两种协议**（engineer-frontend 的决定性论证，我认同）：一帧 `"谢谢"` 既可能是
  增量的新增片段，也可能是累积的全文；因此前端**不能**靠内容判断协议，必须与后端约定固定语义。
  ⚠️ **若未来后端改为累积语义，前端必须相应调整**（即 captain 批准的长度守卫方案：
  `data.text.length > streamed.length && startsWith(streamed)` —— 累积时替换而非追加）。

#### ④ 修桩后复跑：28/89 → **0/89**

按设计意图逐片各发一次（不再 `join('')` 后重复），重跑同一脚本、同一 URL：

```
$ xvfb-run -a node --import tsx/esm /tmp/cs-verify/c8-evidence.mjs
=== ⑥ 未闭合围栏：流式期块体源码进入访客 DOM ===
采样点: 89 | 命中块体源码的采样点: 0          ← 修桩前为 28
[exit=0]
```

帧数核对（确认桩已按设计意图发送，且**未动** case 9 对照组）：

```
case 8 的 delta 帧数 = 4      ← 4 个分片，各发一次（原为 9 次重发整段）
case 9 的 delta 帧数 = 1      ← 整段单帧对照，保持独立未改
case 9 的 delta 内容 = {"text":"说明文字。\n```mermaid\nflowchart TD\n  A[停电] --> B[报修]\n"}
```

#### ⑤ 结论与措辞（供交付说明采用）

> **F-5 经根因追查，系 stub 的 `join('')` + 固定 9 tick 实现与 case 表设计意图不符；
> 修正桩后无泄漏，不是前端缺陷。**

**辅助证据（captain 亦已核实，我复核一致）**：`plugins/` 源码中**无** `proto`/`naive`/`case` 逻辑
（grep 0 命中）——`?proto=naive&case=8` 是**桩自己加的参数**，真实后端不识别。

> **教训（记入 §6）**：我用「本地构造的夹具/桩」代替真实序列，导致把**桩缺陷**误判为产品缺陷。
> 这正是 G-ANCHOR 四例共性「用间接证据代替直接证据」——**桩必须与设计意图一致，且桩行为本身也要被验证**。

> **本节另有一处历史读数**：V1/早前记为 **28/90**，本轮同一现象复现为 **28/89**（采样点数差 1，
> 系采样时序边界），属同一现象的两次采样，不构成差异。

### 2.3 F-2（T 方案；captain 提出）mermaid 资产重复加载 — ✅ 已修复

**证据层级：行为（captain 指定的真机双向判据）**

```
=== 轮1：mermaid 资产 404（/nommd/）===
  mermaid 请求数: 1                      ← 修复前为 9
  回答文本长度: 95 | svg: 0 | 降级块: 2
  含围栏: false | 含裸源码: false | pre>code: 0
=== 轮2：切到资产正常路径 ===
  mermaid 请求数: 1
  回答文本长度: 68 | svg: 1 | 降级块: 0   ← 恢复后能出图

F-2 C8 行为判据：✅ PASS
```

→ **单轮请求 9→1**；**非永久失败**（下轮恢复出图）；资产缺失时访客看不到未校验内容、回答不失败。

> 按 captain 要求**未使用** `grep 'mermaidPromise = null'` 作判据（该符号修前修后都命中）。

### 2.4 F-3 — ❌ **撤回：系编号撞车导致的误读（captain 指正成立）**

> **本节结论已作废**，保留于此以防后人重复该误读。更正理由与原文引用见
> **V3 报告 §7.1**（`output-self-review-verification-v3.md`）。

**曾被记录为**：「V1 时文档 v3.2.9 冻结依据称『F-2 已修复』但行为未变 → 记录该不一致」。

**实际上**：文档里的 **F-2 指的是 mermaid 资产 404 反复重试**，文档**从未**声称「未闭合围栏已修复」。
两条证据来自文档自身：

- `requirements.md:461`（G-ANCHOR 表）：「**F-2 是否已修**：间接证据=符号存在（`grep mermaidPromise`）／直接证据=行为存在」；
- `requirements.md:5`：「依据：**F-2 已修复**（写者回报停手）→ 采集末次基线」。

而「未闭合围栏」是我在 V1 里**用另一套编号**标的 F-2。两套同号 finding 被我混为一谈 →
得出「文档撒谎」的错误结论。**这正是 captain 要求统一编号的实际动因。**

**更正后的结论**：
- 文档所称的 F-2（资产重复加载）**确已修复**（V2 §2.3 独立复验通过）；
- 「未闭合围栏」改号为 **F-5**（V2 §2.2 通过）；
- **不存在**「冻结依据与行为不符」这一缺陷。

---

## 2.5 F-6（本轮新增 finding，**原写作 D-1，已改号**）— ✅ **已修复（21:48:21 落地，本报告已复验）**

> **⚠️ 时序很重要，请先读这段**：F-6 在我**提交 t8（21:35，判 failed）之后**、本报告写作期间，
> 由修复方于 **21:48:21** 落地（`engine.ts` 指纹 `6027b330a385b1b9` → `2da07bdce590e6ad`）。
> 因此：**t8 的 `failed` 判定在提交时成立**（当时线上报文确实发 `render`）；
> **而本报告定稿时 F-6 已闭环**。下面 ①②③ 保留**修复前**原始证据（证明问题成立），
> ④ 给出**修复后**复验。**不要**据本节的 ❌ 去重复修一个已修的缺陷。

**一句话**：修复前，三出口载荷里的 `blockResults` 实际下发的是块**结构性裁决值** `"render"`，
而接口声明与 P3/P5 冻结词表规定该字段取值域是 `'passed' | 'degraded'`；严格模式类型检查直接报错。

**证据层级：线上制品（原始 SSE 帧 + 实测载荷）**

### ① 线上制品实证（原始帧，**修复前**）

```
$ curl -sN -X POST http://127.0.0.1:10901/api/guest/chat/stream \
    -H 'content-type: application/json' \
    -d '{"sessionId":"guest-3bbef0fa-…","message":"请直接用 mermaid 代码块输出一个三节点流程图…"}'
event: block
data: {"blockId":"blk-611f52cb-0","blockType":"mermaid","sourceBytes":61,"decision":"render",…}
event: done
data: {"reply":"","sources":[],"blocks":[…],"blockResults":{"blk-611f52cb-0":"render","blk-611f52cb-1":"render"},"degradedIds":[],…}
```

`/chat` 与 `/history` 同形（独立复核见 §3.3）：

```
—— /chat ——
  围栏泄漏: false | blocks: 1 | blockResults: {"blk-dd460eb9-0":"render"} | degradedIds: []
—— /history ——
  围栏泄漏: false | blocks: 1 | blockResults: {"blk-dd460eb9-0":"render"} | degradedIds: []
```

### ② 声明与实现冲突（严格类型检查，原始输出）

```
$ cd /home/as-workstation01/Documents/project/dshagent
$ npx tsc --noEmit --strict --target es2022 --module nodenext --moduleResolution nodenext \
    --skipLibCheck --ignoreConfig customer-service/plugins/output-gate/src/engine.ts
customer-service/plugins/output-gate/src/engine.ts(379,7): error TS2322: Type '"render" | "degraded"' is not assignable to type '"degraded" | "passed"'.
  Type '"render"' is not assignable to type '"degraded" | "passed"'.
[exit=2]
```

（同次检查另有 `TS2591 node:crypto/Buffer` 与 `TS5097 .ts 扩展名` 报错，系我单文件直检未带本仓
tsconfig 所致，**与本条无关**，仅 TS2322 是本条证据。）

实现侧两处：

- `engine.ts:127` `blockResults: Record<string, 'passed' | 'degraded'>`（声明域）
- `engine.ts:379` `blockResults[block.blockId] = block.decision`（`decision: 'render' | 'degraded'`，`engine.ts:111`）

### ③ 严重度判定：medium（**不是** blocker，也不是纯文档瑕疵）

**未造成访客可见缺陷**——访客前端只做「是否 degraded」判定，`'render'` 与 `'passed'` 同路径通过：

```
$ grep -n "verdict" web/guest/assets/output-gate.js
300:    const verdict = results[blockId]
301:    if (blockType === null || verdict === 'degraded' || item.decision === 'degraded') {
```

**但它确实违约**：

- 契约把 `blockResults` 与 `blocks`/`degradedIds` 并列为三出口逐字同形字段（`docs/output-gate-contract.md:27/69/32`），
  却未声明 `blockResults` 的取值域；实现自报 `'passed'|'degraded'` 而实际发 `'render'` → **接口自述与线上报文不符**。
- 需求文档把 `passed` 定义为**块终态**（第 66 行「块进入 `passed`（显示图形）…后不再变化」、
  第 143 行 P3 状态机 `absent → pending → loading → validating → passed`、第 145 行 P5「③ 通过 → `passed`」）。
  当前 `blockResults` 从不取值 `passed`，**该字段无法表达 P3/P5 的终态语义**。
- 严格模式类型检查失败：任何按下游声明消费该字段的第三方客户端会拿到未声明取值。

### ④ 需澄清的语义（修复者必须先定，勿直接改字面）

`blockResults` 的设计意图是「真机裁决结论 + 尚无回传按结构性结论记 `passed`」（`engine.ts:126` 注释）。
`engine.ts:284 recordReport()` 会把真机 `outcome` 记进 `block.reported`，但 **`payload()` 未读 `reported`**，
故真机降级结论**不会**反映到终态 `blockResults`。因此两种修法语义不同：

- **A（按声明改实现）**：`decision==='render'` 的块，若 `reported?.outcome==='degraded'` → 记 `degraded`，
  否则记 `passed`；即 `blockResults` 变成「真机终态」。需同步 `degradedIds` 语义。
- **B（按实现改声明/契约）**：承认 `blockResults` 就是结构性裁决，取值域改为
  `'render' | 'degraded'`，并在契约 §2 明确写死取值域。

**我未自行选定 A/B**——这改变对外契约与 P3/P5 语义归属，属实现/产品决策，超出我的 inScope。
（修复方后续选择了 **A**，见下。）

### ⑤ 修复后复验（21:52，`engine.ts` = `2da07bdce590e6ad`）— ✅ 已闭环

**新实现**（`engine.ts` `payload()`，单一判据、`degradedIds` 与 `blockResults` 恒等）：

```ts
const outcome: 'passed' | 'degraded' = block.decision === 'degraded'
  ? 'degraded'
  : (block.reported?.outcome === 'degraded' ? 'degraded' : 'passed')
blockResults[block.blockId] = outcome
if (outcome === 'degraded') degradedIds.push(block.blockId)
```

**类型检查**（F-6 的关键错误已消失）：

```
$ npx tsc --noEmit --strict … --ignoreConfig customer-service/plugins/output-gate/src/engine.ts
… (仅剩 TS2591/TS5097 系"单文件直检未带本仓 tsconfig"噪声，与 F-6 无关)
$ … | grep -c "TS2322"
0                                        ← 修复前为 1（engine.ts(379,7)）
```

**线上载荷**（真实实例 10901 → 10900，实模型轮，原始 `done` 帧）：

```
$ curl -sN -X POST http://127.0.0.1:10901/api/guest/chat/stream …（"请直接用 mermaid 代码块输出三节点流程图"）
blockResults: {"blk-ebc2438c-0":"passed","blk-ebc2438c-1":"passed"}
degradedIds: []
blocks[].decision: ["mermaid:render","mermaid:render"]
取值域是否 ⊆ {passed,degraded}: true
是否仍出现 render: false
含 ``` : 0
```

→ **两套取值域已正确分离**：`blockResults` ∈ `{passed,degraded}`（终态语义，兑现 P3/P5），
`blocks[].decision` 仍为 `{render,degraded}`（结构性裁决，契约 §3 原义）。
这正是我在上面列的**修法 A**，且额外把 `degradedIds` 与 `blockResults` 收敛为**单一判据**（消除了分叉风险）。

**回归复验（修复后全部通过）**：

| 检查 | 结果 |
|---|---|
| `gate-check.mjs` | **73/73**（较修复前 67 项**新增 6 条**，覆盖新取值域） |
| `http-exits-check.mjs` | **25/25**（较修复前 20 项**新增 5 条**，含"全载荷三出口均无未决字段"） |
| 前端 `output-gate-check.mjs` | 58/58 |
| `gate-dom-check.mjs` | 61/61 |
| F-1 三出口 | `/chat` false / `/stream` false / `/history` false |
| 对抗矩阵 54 例 | **54 通过 / 0 失败** |

**遗留提醒**：修复后 `blockResults` 对「等待窗口内未收到任何回传」的块记 `'passed'`，
即 **`passed` 不等于"真机已验证"**，只表示"对访客保持可见/未被判负"——新实现的注释已写明此点，
与 O2 留痕分工一致（真机证据归 `outcome`，不放 `blockResults`）。复核者不应把 `passed` 读成"真机通过"。

### ⑥ 一处「未能验证」（不作为 F-6 证据）

我为验证 A 语义做了回传探针，但**该次回传被服务端拒绝**，故不能据此断言「真机结论丢失」：

```
一轮 blockResults: {"blk-b694d68c-0":"render"}
回传 status: 202 {"ok":true,"applied":false}        ← 回传未生效（该轮 turn 已结算）
history blockResults: {"blk-b694d68c-0":"render"}
```

`applied:false` 说明该 `blockId` 在服务端已不再等待裁决，属**探针时序不合法**（`done` 已定稿），
非实现缺陷证据。F-6 的成立**只依赖①②③**（线上报文 + 类型检查 + 契约/需求条文）。
A 语义是否真会丢结论，**未能验证**，原因：需在 `block` 事件与 `done` 之间、且在同一 turn 结算窗口内回传，
我的进程外探针无法稳定卡入该窗口。

---

### 3.1 A 源码封堵 6 点（真机逐点表，SRC3）

**证据层级：行为**

| 源码封堵点 | `pre>code` | 围栏可见 | 源码可见 | 早时点(≤2s)泄漏 | 终态 |
|---|---|---|---|---|---|
| ① mermaid 容器初始内嵌源码（流式期） | 0 | false | false¹ | 0/19 | passed |
| ② mermaid 渲染失败分支 | 0 | false | false | 0/19 | degraded |
| ③ `renderImageBlock` 路径非法回退 | 0 | false | false | 0/19 | degraded |
| ④ `renderChart` 非数组回退 | 0 | false | false | 0/19 | degraded |
| ⑤ `renderChart` JSON 解析异常回退 | 0 | false | false | 0/19 | degraded |
| ⑥ `renderMarkdown` 未闭合图形块分支 | 0 | false | false | **0/19** | degraded |

**SRC3 逐点结论：6 点，失败 0 点。**

> ¹ **断言口径修正记录（必须写明）**：① 首轮自动判据报"源码可见"，经复核为**我的断言用词过宽**——
> 判据里用了裸词 `flowchart`，命中的是 mermaid 产出的 **SVG 类名** `class="flowchart"`，而非源码。
> 精确判据（`flowchart TD`）实测 0 泄漏；独立复核 `chk-early.mjs 6` → **全程泄漏采样点 0 / 89**。
> 同类修正共三次，详见 §6。

**逻辑层预跑**（逐字符喂入、逐帧检查正文）：`SRC3 逐点结论：6 点，失败 0 点`。

### 3.2 B 图片双通道 / IMG1–IMG8

**IMG1 白名单**：22 条样例，合法误拒 0、非法误放 0。
**IMG3 同源化 / IMG6 归一化**（实测）：`https://www.cem-macau.com/uploads/image_3f5b3a38a0.png` → 归一化为 `/uploads/image_3f5b3a38a0.png` 且 `decision=render`（**不误杀**）；外部域名 → `degraded/image-path-invalid` 且不下发 `imagePath`。

**IMG7（CSP）—— 本轮升级为「完整 html 块路径」实证**（证据层级：行为）

```
html 块 iframe 存在: true | sandbox: allow-scripts
srcdoc 的 CSP 片段: img-src 'self' data:
控制台 CSP 违规: ["Loading the image 'https://evil.example.com/track.png' violates ... img-src 'self' data:. The action has been blocked.",
                 "Loading the image 'https://evil.example.com/track2.png' violates ... blocked."]
对 evil 的实际请求数: 0
```

→ 走**真实 `renderHtmlBlock` 产出路径**（`iframe.html-frame` + `srcdoc`）验证：`img-src` 无 `https:`，两张外部图**均被阻止且零出站**。

**IMG7 再升级（本轮，证据层级：行为 + 网络层）**——补上「事件真实来源」与「零出站」两项硬证据：

```
$ xvfb-run -a node --import tsx/esm /tmp/cs-verify/img7-frame.mjs
iframe 文档 CSP: default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:;
                 font-src 'self' data:; form-action 'none'; base-uri 'none'; script-src 'nonce-…'
iframe 内 securitypolicyviolation 事件: [{"blockedURI":"https://evil.example.com/probe-live.png",
                                        "violatedDirective":"img-src","disposition":"enforce"}]
被拦图片自然宽度(0=未加载): 0
```

```
$ xvfb-run -a node --import tsx/esm /tmp/cs-verify/img7-egress.mjs
监听器已起: http://127.0.0.1:10905/
声明式外部图：监听器收到连接 = 0
运行时新建外部图：监听器收到连接 = 0
iframe 内 securitypolicyviolation 事件: [{"blockedURI":"http://127.0.0.1:10905/runtime.png","violatedDirective":"img-src"}]
监听器全部命中明细: []
Playwright request 事件（拦截前尝试，非出站）: ["http://127.0.0.1:10905/runtime.png"]
IMG7 判定（网络层零出站 0/2 + 帧内真实违规事件 img-src）: ✅ PASS
```

**为什么必须换成自控监听器**：Playwright 的 `request` 事件记录的是**被 CSP 拦截前的尝试**，
用它当"出站请求数"会把「已正确拦截」误判为「泄漏」——我一度据此输出 `❌ FAIL`，
经自控监听器（`127.0.0.1:10905` 我方 HTTP server）计数为 **0 连接**后改正（§6 第 7 条）。

**新增边界复核（本版新增「行内任意位置识别受控围栏」后）**：

| 输入 | 泄漏 | 块元素 | pre | 结果 |
|---|---|---|---|---|
| 缩进 3 空格围栏 | false | 1 | 0 | ✅ 正确摘为块 |
| 引用块 `> ````mermaid` | false | 2 | 0 | ✅ 降级 |
| 行首正常围栏（对照） | false | 1 | 0 | ✅ 渲染 |
| 正文提及 ` ```mermaid ` 一词 | false | 2 | 0 | 保守摘出并降级（**不泄漏**） |

### 3.3 C 三出口一致（证据层级：线上制品）

```
--- /chat/stream 原始报文 ---        --- /chat ---      --- /history ---
  ```mermaid     0                   泄漏: 0 0 0         泄漏: 0 0 0
  ```chart       0
  ```image       0
  ```html        0
  ```            0
  AS-3 正则命中: 0
```

SSE：`2 block / 2 block-open / 314 delta / 1 done / 1 meta`；`delta` 拼接无围栏。

### 3.4 D 多块并行 + T1（证据层级：行为）

**CF-1**：

```
① 流式期并行开判: mermaid 首次离开 pending = 840ms | image 首次 validating = 2445ms | done = 3612ms
   早于 done: true / true
② 两块终态: ["mermaid-src[passed]","chart[passed]","kb-image[passed]","gate-block[passed]"]
③ 终态 svg/img/pre: 1 / 1 / 0
④ done 之后的状态迁移（REP5 应为空）: []
```

**T1 A/B（3 次取中位）**：

```
门禁开（host 协议）: done 中位 3596 ms
门禁关等价（naive）: done 中位 3600 ms
→ 差值 = +4 ms（要求 ≤600ms）→ PASS
```

> 历轮结果一致性：−4ms / +3ms / +11ms / +8ms / −13ms / **+4ms**，均在噪声量级。

**AS-14①「一轮含 mermaid+image 两块，两块都达 passed」本轮重采（21:15）**：

```
$ xvfb-run -a node --import tsx/esm /tmp/cs-verify/twoblock-final.mjs   （18 个采样点 × 600ms）
  600ms  ["blk-two-m:passed","blk-two-i:passed"]
  1200ms ["blk-two-m:passed","blk-two-i:passed"]
  …（18 个采样点全部两槽 passed）
  10800ms ["blk-two-m:passed","blk-two-i:passed"]
=== 终态 === [{"key":"blk-two-m","state":"passed"},{"key":"blk-two-i","state":"passed"}]
svg=1 img=1 figure=1 | 含围栏=false 含源码=false pre>code=0
AS-14① 判定（两块都 passed + 无泄漏）: ✅ PASS
```

`twoblock-dom.mjs` 连跑 3 次亦**全 PASS**（`1 passed + 1 passed`，`svg=1 img=1`）。
**第二块未因第一块耗掉预算而降级**。

> ⚠️ **探针修正**：我最初用 `[data-block-state]` 采样，在 8s 时点读到
> `[passed, degraded, degraded] / img=0` 并一度拟判 AS-14① 失败。经查该选择器**还命中块内部占位节点**，
> 正确槽位选择器是 **`[data-block-key]`**；改正后连续 3 次全通过，且上表 18 点时间序列自 600ms 起即两槽 `passed`。
> 详见 §6 第 5 条。**不要**依据我中途那次 `❌` 输出改代码。

### 3.5 E 可达性仅留痕（C6，证据层级：制品）

```
probe=true  载荷 sha256: 29a242b5cb50d7800b6a9e8eb07ffce3
probe=false 载荷 sha256: 29a242b5cb50d7800b6a9e8eb07ffce3
逐字节一致: ✅ PASS
死链图片 decision: image:render（交真机 C4 裁决）
```

### 3.6 F 降级终态 / 组件不可用

四处回退真机终态 `pre>code` 全 0、落可读文案；组件不可用时回答仍成功（§2.3 轮1 已证）。
**降级顺序**：可读替代 > 丢弃该块 > 保留前后文字 —— 实测图片降级保留图注（REP3①）。

### 3.7 G 不回归（证据层级：行为 + 事件序列）

```
REG1 文字逐字流式：文本长度递增的采样点数 = 10 / 332
REG2 正常 mermaid 渲染：svg = 2
REG4 来源引用：.sources span = 1
无源码/围栏：含 ``` = false | 含裸 flowchart TD = false | pre = 0
mermaid 库请求数 = 1
```

**REG5 限流与攻击防护**：`200 200 200 429`；辱骂 `200 → 429`。

**实现者四套测试**（在冻结制品上复跑）：

| 套件 | 结果 | exit |
|---|---|---|
| `gate-check.mjs` | **67/67** | 0 |
| `http-exits-check.mjs` | **20/20** | 0 |
| `output-gate-check.mjs`（前端） | **58/58** | 0 |
| `gate-dom-check.mjs`（jsdom） | **61/61** | 0 |

**独立对抗矩阵**：**54 通过 / 0 失败**。

### 3.8 AS-6 留痕字段（补测完成，证据层级：行为）

```
=== ctx.logger.warn 实际行数: 2 ===
guest.output-gate sessionId=guest-… blockType=image reason=image-path-invalid sourceDigest=95a079cd4efe19a2 sourceBytes=33 occurredAt=1789042419671 outcome=degraded
guest.output-gate sessionId=guest-… blockType=chart reason=chart-invalid        sourceDigest=73cb3858a687a849 sourceBytes=2  occurredAt=1789042419672 outcome=degraded

AS-6 插件层：2 行，格式不符 0 行
聚合 stats(): {"…|image|image-path-invalid":1,"…|chart|chart-invalid":1}
```

七字段格式（前缀 `guest.output-gate` + `sessionId/blockType/reason/sourceDigest/sourceBytes/occurredAt/outcome`）**0 处不符**；摘要可复算；O4 聚合正确。

### 3.9 制品完整性（G-ANCHOR-4）

全部测试跑完前后各校验一次：

```
$ sha256sum -c （8 文件清单）
→ 全部 OK，exit=0
```

→ **测试未改写制品**。另经实验证伪"测试导致漂移"的假设：连跑四套测试前后，`index.html`/`output-gate.js` 指纹不变（`gate-dom-check.mjs` 仅写 `tests/gate-dom-snapshots.json`，不碰制品）。

### 3.10 制品时序核查与本轮**全量重采**（本轮新增，G-ANCHOR）

**发现**：提交前复核制品指纹时，主机侧 `fence-machine.ts` mtime = **2026-09-10T20:29:14**，
落在我本轮的取证窗口**之内**（V1 期记录 `fd6e9cbc227268e2` → 现 `259485406ad2c8af`）。

```
$ date -r plugins/output-gate/src/fence-machine.ts '+%Y-%m-%dT%H:%M:%S%z'
2026-09-10T20:29:14+0800   259485406ad2c8af
$ date -r plugins/output-gate/src/engine.ts       → 2026-09-10T17:44:08+0800  6027b330a385b1b9
$ date -r web/guest/index.html                    → 2026-09-10T20:38:50+0800  07a073ceb7049a22
$ date -r web/guest/assets/output-gate.js         → 2026-09-10T20:18:34+0800  11ebac8964857f0a
```

**第二起漂移（21:48:21，F-6 修复）——本报告定稿前发生**：

```
$ date -r plugins/output-gate/src/engine.ts '+%Y-%m-%dT%H:%M:%S%z'
2026-09-10T21:48:21+0800   2da07bdce590e6ad        ← 原 6027b330a385b1b9（17:44:08）
```

该次改动即 **F-6 的修复**（`payload()` 改四分支、`blockResults` 取值域收敛为 `'passed' | 'degraded'`，
见 §2.5④）。**影响面与处置**：

- F-6 相关条目**已在修复后重采**（§2.5④：类型检查 0 个 TS2322 + 线上载荷取值域正确 + 四套件复跑）；
- 其余 A–G 结论**建立在前端 + 非 `payload()` 主机路径上**，而修复只动 `engine.ts` 的 `payload()`，
  且修复后 `gate-check`/`http-exits` 复跑通过（73/73、25/25）、F-1 三出口与 54 例矩阵复跑通过 → **无回归**；
- **P9-1 不受影响**（属前端 `index.html`，该文件 20:38:50 后未再变，`07a073ceb7049a22` 与修复前同值）。

**修复后（本报告定稿时）制品指纹**：

| 文件 | sha256 前 16 | mtime |
|---|---|---|
| `web/guest/index.html` | `07a073ceb7049a22` | 20:38:50 |
| `web/guest/assets/output-gate.js` | `11ebac8964857f0a` | 20:18:34 |
| `plugins/output-gate/src/engine.ts` | **`2da07bdce590e6ad`** | **21:48:21** |
| `plugins/output-gate/src/fence-machine.ts` | `259485406ad2c8af` | 20:29:14 |
| `plugins/output-gate/src/index.ts` | `4d39bb58624a0e49` | 17:55:16 |
| `plugins/output-gate/src/block-rules.ts` | `dafca4575e9be224` | 17:43:50 |
| `plugins/guest-server/src/index.ts` | `99110840bc1bb7ed` | 17:33:33 |

> **给 t6/t9 复核者的提醒**：本轮制品在**一个工作时段内漂移两次**（20:29 `fence-machine.ts`、21:48 `engine.ts`），
> 两次都发生在取证/写报告期间。**G-FREEZE 的"两端停手 → 连续两次一致 → 另一方复核"三步在事实上未满足**；
> 建议 t6 先要求一次**显式停手确认**并复采基线，再据以判定。

**处置**：凡在 20:29 之前采集的**门禁行为**证据一律判为**失效并重采**（宿主未重启，端口 10900–10903
以隔离 `DSH_HOME=/tmp/cs-verify/home` 重建；未触碰 10800/10801 容器）。

**重采结果（全部在 20:29 之后、当前制品上取得）**：

| 复验项 | 采集时刻 | 结果 |
|---|---|---|
| F-1 三出口（`repro-longinfo.mjs`） | 21:07 | `/chat` false / `/stream` false / `/history` false |
| F-1 双向分支（`probe-overflow-now.mjs`） | 21:07 | 受控→扣留（无 ```）/ 非受控 `mmd`→透传 |
| 对抗矩阵 54 例（`adv-http.mjs`） | 21:08 | **54 通过 / 0 失败** |
| D 项 T1 A/B（`t1-ab.mjs`） | 21:11 | 门禁开中位 3602ms vs 关 3602ms → **差 0ms**（≤600ms） |
| E 项 C6（`e-parity-http.mjs`） | 21:10 | 开/关载荷 **sha256 同值** `29a242b5…`；死链图 decision=render |
| AS-6 留痕（`as6-plugin.mjs`） | 21:12 | 2 行，格式不符 **0**；O4 聚合正确 |
| G 项不回归（`g-regress.mjs`） | 21:12 | 逐字流式 6/332、svg=2、来源 1、无围栏/源码、库请求 1 |
| F 项降级顺序（`four-fallbacks.mjs`） | 21:13 | 8 例：非法全无源码；未闭合→可读文案 |
| A 项 SRC3 6 点（`src6-real.mjs`） | 21:10 | **6 点 / 失败 0**，早时点 0/19 |
| C8 非永久失败（`c8-verify.mjs`） | 21:09 | 89 采样点 0 泄漏、双 degraded、回答有效 |
| B 项双通道（`dual-verify.mjs`） | 21:10 | block-open 400ms → block 802ms → svg 847ms；1 容器 1 svg；无围栏 |
| B 项 IMG6 归一化（`probe-img3-relative.mjs`） | 21:10 | 自家绝对 URL → `/uploads/…`；外部域名 → degraded |
| D 项两块构型（`twoblock-final.mjs`） | 21:15 | 18 采样点全 `passed`；svg=1 img=1 figure=1；无围栏/源码 |
| F-2 重置粒度（`f2-reset.mjs`，干净 profile） | 21:21 | 轮1 请求 1/svg 0/降级 2；轮3 svg=1 降级 0 → 单轮 1 次尝试 |
| 边界围栏（`edge-fences.mjs`） | 21:19 | 缩进 3 空格 / 引用块 / 正文提及 一律**无泄漏**，`pre=0` |
| G 项限流（自控脚本） | 21:19 | 200×3 → **429**（`retryAfterSec:60` + 中文冷却文案） |
| G 项攻击防护 | 21:20 | 注入/逃逸/超大均 200 且无围栏无 `<script>`；空消息 400 |
| 四套件（gate-check/http-exits/output-gate-check/gate-dom-check） | 21:18 | **67/67、20/20、58/58、61/61** |
| G-ANCHOR-4 跑测后指纹 | 21:18 | 三文件指纹**不变**（`07a073ce` / `11ebac89` / `25948540`） |

**结论**：20:29 的 `fence-machine.ts` 改动**未使任何已通过项回归**。

---

## 4. 未能验证项（不默认通过）

| # | 条目 | 原因 |
|---|---|---|
| 1 | 配置逐键**生效**验证（AS-7） | 仅做默认值静态核对（8/8 一致）；未逐键改配置重启验证 |
| 2 | 断流自愈（REG6）与断流期块降级（P9） | 未模拟中途 kill 连接 |
| 3 | 图片阅读器交互（REG8 点击放大） | 仅核对 DOM 与代码存在 |
| 4 | HTML 预览高度自适应（REG7 高度部分） | 未测 iframe 高度随内容变化 |
| 5 | `serviceVersion` = `2026-09-10.10` | 被测为自建实例（`verify-local-1`），见 §0.5① |
| 6 | 真实模型图形块产出率 | 块类型分布由模型决定，非受控。实测：同一实例下「用 mermaid 画停电报修流程」被模型**拒绝绘图**（0 块），改显式指令后一次产出 2 块（§0.5⑤） |
| 7 | **F-6 中「真机 `degraded` 是否丢失」** | 我的进程外探针回传 `applied:false`（turn 已结算），**无法卡入 `block`→`done` 之间的结算窗口**；F-6 成立仅依赖线上报文+类型检查+契约条文（§2.5⑥） |
| 8 | 主机侧 `fence-machine.ts` 20:29 改动的**内容与意图** | 我只观测到 mtime/指纹变化与行为无回归；未取得改动人自述，亦无旧版副本可比对（`find` 全盘仅现版一份） |
| 9 | ~~断流自愈（REG6）/ P9~~ | **本轮已补测**，见 §3.11（REG6 通过；P9 发现 P9-1） |

### 4.1 本轮补测：REG6 通过、P9 发现新 finding（原「未能验证」第 2 项）

#### REG6「中途 kill 连接 → recovering → 恢复出答案」— ✅ 通过

走自建 `/__killmid/`（**真实后端 10900**，仅 `chat/stream` 这条在转发 >3000 字节即摧毁 socket，
`history` 仍可正常回放）。kill 前已转出 **52 个 delta 帧、无 done**（`curl exit=18`）。

```
=== REG6 断流自愈（真实后端 + 中途 kill）===
  5s  len=10 :: Searching…
  10s len=10 :: Searching…
  终态文本长度: 211
  终态文本: "可以，澳门电费的缴费渠道很多，柜台、电子支付、银行自动缴费都能办。 | 三点实用提示 | …资料来源：faq.md（付款方法）、page.md（如何缴交电费）。"
  含围栏=false 含源码=false pre>code=0
  「恢复出答案」: ✅
  REG6 判定: ✅ PASS
```

即断流后前端确实进入「Network unstable, retrieving your answer…」态并从 `history` 取回完整答案
（`recoverReply` 轮询窗口 20s，实测真机轮次约 14s，故窗口足够）。

> ⚠️ **我第一次跑 REG6 得到 ❌ FAIL，那是我的桩错**：我把页面开在 `10903`，而 `10903` 的
> 后端是我的 **桩**（`stub-2protocol`），其 `history` 没有真答案，故「恢复」必然失败。
> 改到 `10901`（→ 真实后端 `verify-local-1`）后通过。**不要**据我中途那条 FAIL 改代码。

#### P9「流中止」— ❌ 发现 P9-1（medium）：干净 EOF 时 `pending` 块永不降级

P9 原文：**SSE 断流** / `AbortController` / 硬截止（现状 45s）时，`pending|loading|validating`
的块按 P6 降级；已 `passed` 的块保持显示。

我按断流**方式**分成两种情形实测（均走**真实后端 10901**，仅 `chat/stream` 被替换）：

| 情形 | 手法 | 判据（55s 采样） | 结果 |
|---|---|---|---|
| A 连接重置 | 自建 `/__dropsse/`：发完 `block-open` 后 `res.socket.destroy()`（`curl exit=18`，真重置） | 悬挂态 0 / 泄漏 false | ✅ 已降级 |
| B **干净 EOF** | `fulfill` 下发 `delta`+`block-open` 后 **body 正常结束**（`chunk.done=true`），无 `done` | **悬挂态 1（`pending`）/ 泄漏 false** | ❌ **55s 仍悬挂** |

情形 B 的原始时间序列（真实后端，1s 采样，全程 `pending`）：

```
  5s ["pending"] :: 说明文字。 | Preparing the graphic…
 10s ["pending"] :: 说明文字。 | Preparing the graphic…
 25s ["pending"] :: 说明文字。 | Preparing the graphic…
 44s ["pending"] :: 说明文字。 | Preparing the graphic…
 45s ["pending"] :: 说明文字。 | Preparing the graphic…
 55s ["pending"] :: 说明文字。 | Preparing the graphic…
  终态块状态: ["pending"]
  P9 判定：55s 后悬挂态块=1 泄漏=false → ❌ 仍悬挂
```

P9 的另一半**成立**：若块已 `passed` 再遇 EOF，保持显示不回改（30s 采样全 `["passed"] svg=1`，
无源码泄漏）→ P9「已 `passed` 的块保持显示」✅。

**根因（代码级，证据层级：制品 + 行为一致）**：

- `index.html:2556` 的抛出条件是 `if (!done && !streamed) throw new Error('stream ended without reply')`。
  情形 B 下**已收到 delta**（`streamed !== ''`），故**不抛**；`streamError` 亦为空 → 整段 `catch` 不进入。
- 唯一会降级悬挂块的 `degradePendingGates(root)` 只有 4 个调用点（`index.html:1633/2393/2568/2601`）：
  - `2393`（收尾窗口耗尽）只在 `awaitGateSettlement()` 内，而后者**唯一调用点是 `done` 分支**（`2550`）；
  - `2568` 在 `catch` 内 —— 情形 B 不进入（见上）；
  - `2601` 是 `pagehide`；
  - `1633` 是定义处。
- `index.html:2462` 的 45s 硬截止 `setTimeout(() => controller.abort(), 45000)` 在
  **`fetch` 头返回后立刻被 `clearTimeout` 清掉**（`2472–2474` 的 `finally`），
  因此它**不覆盖流中途**，P9 所设想的「硬截止」兜底在 `done` 缺失时并不生效。
- `consumeSse` 的 25s stall 看门狗（`2010/2020`）只在**读取阻塞**时触发；情形 B 读到 EOF（`chunk.done`）
  会在 `2028` 正常 `break`，故不触发。

→ **净效果**：连接被重置（情形 A）时路径正常；但连接**正常关闭且缺 `done`** 时，
`pending` 占位会永久停留在「Preparing the graphic…」，直到用户刷新。

**未泄漏**（源码/围栏均未进 DOM），故不是 V1/SRC 级违约，而是 **P9「流中止须降级」的未覆盖分支** → medium。

**复现命令**：

```sh
# 情形 B（干净 EOF）：真实后端 10901，仅 chat/stream 被替换为「有 delta、无 done、正常结束」
xvfb-run -a node --import tsx/esm /tmp/cs-verify/p9-eof-real.mjs      # → 55s 仍 ["pending"]
# 情形 A（真重置）对照：
xvfb-run -a node --import tsx/esm /tmp/cs-verify/p9-final.mjs         # A 悬挂 0 / B 悬挂 1
# REG6：
xvfb-run -a node --import tsx/esm /tmp/cs-verify/reg6.mjs             # → ✅ PASS
```

---

## 5. 与 captain 指令的差异（如实记录）

| # | 指令内容 | 实测 | 处置 |
|---|---|---|---|
| 1 | 判据基线 **v3.2.10**（625 行 / 92 条） | **v3.2.11（679 行）** | 按 v3.2.11 执行（含 v3.2.10 全部判据） |
| 2 | 冻结基线 `index.html = f0dc41832…`（128477 B） | **`07a073ce…`（131367 B）** | 见 §0.3：`f0dc41832` 是**旧**内容（`/tmp/bak.html` 留存其副本）；按磁盘实际值取证 |
| 3 | 冻结基线 `output-gate.js = cdf2869a…` | **`11ebac89…`（31718 B）** | 同上 |
| 4 | `:10902 render-report 202 → 新门禁后端就位` | **`:10902` 是 verifier 自建桩** | 见 §0.6：真门禁后端是 `:10900`（非法载荷正确 400） |
| 5 | `:10902 /` 是 dsh web 鉴权页 | 是**本 verifier 桩的 404 文本** | 见 §0.6 |
| 6 | "guest 页在 10901/10903" | ✅ **正确** | 已写入报告 §0.6 |
| 7 | 主机侧 `fence-machine.ts = fd6e9cbc…`（冻结基线） | **`259485406ad2c8af`**，mtime **20:29:14**（落在取证窗口内） | 见 §3.10：20:29 前的门禁行为证据**全部重采**，结论无回归 |
| 8 | 早前称 `block-open = 0` | **6**（实例响应体实测） | 见 §0.5② |
| 9 | 「F-2 已修复 / 冻结基线已三方复核」（t8 description） | `f0dc41832` 实为 **F-2 修复前**页面（无 `matchControlledFence`） | 见 §6.1：该基线值本身过期，非回归 |
| 10 | 需求文档称 v3.2.10（625 行） | **v3.2.11（679 行）** | 按 v3.2.11 执行 |
| 11 | 「请 claim `t8`」（第二轮指令） | `t8` 我**上一轮已 claim 并已终态 `failed`**（attempt 1，21:35 提交） | 终态不可重开；本轮为**在原 tried attempt 上补充证据**，不改判据、不改 t8 结论 |
| 12 | 「finding 改号为 F-4/F-5：F-4=`scanGates`、F-5=未闭合围栏」 | **部分不成立**：`F-4` 在 requirements §16.4 **已被 `scanGates` 占用**（且已裁定删除） | 见 §6.2：`scanGates` 沿用 **F-4**（不重定义）、未闭合围栏改号为 **F-5** ✅；另把撞号的 `D-1` 改为 **F-6** |
| 13 | 「你已做"调用次数 0，包装成功 true"」 | ✅ 属实（V1 §4.2），本轮**原文引用**并补 `gate-dom-check.mjs:818` 复核 | 见 §6.3 |
| 14 | 「`scanGates` 在 `index.html:940` 有 NO_GATE 桩」 | **现状为 0 命中**（该桩随 F-4 清理已删除） | 我按**当前制品**复核（§6.2/§6.3）；指令所述为清理前快照 |

> **关于第 14 条**：captain 引用的 `index.html:940 scanGates: () => []` 与"`grep` 仅 3 处"是
> **F-4 清理之前**的读数；当前制品该符号全域 0 命中，`index.html:940` 现为 HTML 预览 iframe 代码。
> 这不影响 F-4 结论（结论一致：生产不可达），但**复核时须以当前制品为准**。

---

## 6. 我的断言口径修正记录（防后人误修正确的行为）

V1 §3.10 有两条被列为"失败"的用例，经复核**均为我的断言口径错，非产品缺陷**：

| # | 我的错误判据 | 正确判据 | 影响 |
|---|---|---|---|
| 1 | 把**裸 `` ``` ``** 当作泄漏判据 | 按 **AS-3 正则** `[`~]{3,}\s*(mermaid\|chart\|image\|img\|html)\b`；裸围栏属**普通代码块**，按 **N2③ 必须原样透传** | 修正后对抗矩阵 **50/3 → 54/0** |
| 2 | 用裸词 **`flowchart`** 匹配源码 | 用 **`flowchart TD`**（裸词会命中 SVG 类名 `class="flowchart"`） | 修正后 ① 项由"失败"转为通过 |
| 3 | 曾把图片 `decode` 超时判为产品缺陷 | 实为**我的代理发了 `cache-control: no-store`**，与线上 nginx（`max-age=2592000, immutable`）不符导致 | 对齐缓存语义后图片正常通过 |
| 4 | 用裸 `flowchart` 判 `four-fallbacks.mjs` 第 6 例"正常 mermaid 源码可见" | 同 #2：该命中是 **SVG 类名**。精确判据下该例 `pre>code=0`、无围栏 | 第 6 例実为**通过**（对照例） |
| 5 | 以 `[data-block-state]` 采样两块构型，8 秒时点读到 `1 passed + 2 degraded / img=0`，一度拟判 AS-14① 失败 | 正确选择器是 **`[data-block-key]`**（块槽位）；`[data-block-state]` 也命中内部占位节点 | 改正后**连续 3 次全通过**（§3.4） |
| 6 | 判定 IMG7 时要求主页面 `securitypolicyviolation` 有事件 | 违规事件派发在 **html 块 iframe 自身文档**（sandbox 不透明源），主页面监听器收不到 | 改为**帧内**取证 + 自控监听器测出站（§3.2） |
| 7 | 用 Playwright `request` 事件当作"出站请求数" | 该事件记录的是**被 CSP 拦截前的尝试**，非真实出站 | 改为自控 HTTP 监听器计数（实测 0/2） |
| **9** | **用桩的 `join('')` + 固定 9 tick「重发整段」当作 case 8「分片未闭合围栏」的真实序列**，并据此把泄漏记为**产品缺陷 F-5** | **桩必须与 case 表设计意图一致**（case 8 设计为 **4 个分片、各发一次**）；重发整段产生 **9 个重复副本**，其 ``` 起始行被旧前端**裸 `/^```/` 闭口判据**误判为"闭合行"，块体才漏成段落 | 修正桩后**同一脚本 28/89 → 0/89**；**F-5 结案为桩缺陷**（§2.2） |

> **第 9 条是本轮最严重的自身错误**：我**把取证桩的缺陷写成了产品 finding**。
> 这与 G-ANCHOR 四例共性「用间接证据代替直接证据」同型——拿**本地构造的桩**冒充**真实序列**，
> 且**未先验证桩本身与设计意图一致**。教训：**桩行为本身也要被验证**；用桩取证前须证明桩忠实于设计意图。
> 另：**F-6 的 D-1（`blockResults` 取值域）不属此类**——那条是**线上制品实测 + tsc 报错**双重直接证据，仍然成立。

**务必不要**依据 V1 §3.10 去"修复" N2③ 的正确行为；也**不要**依据我中途的 `❌` 输出改代码——
第 4/5/6/7/9 条均已证明是**我的探针/桩缺陷**（另加 REG6 首次 FAIL 是我选错端口，见 §4.1），产品行为正确。
**尤其不要**依据早前的 F-5 记载去修前端——**F-5 已结案为桩缺陷**。

### 6.1 冻结基线冲突的最终裁定（本轮新增）

V1/V2 早前引用的 `f0dc41832cd79106` 与磁盘/线上实测 `07a073ceb7049a22` 的差异，**本轮已定性**：

```
$ diff /tmp/cs-verify/served-index.html /tmp/cs-verify/page-serve.html | wc -l
130
$ grep -c scanGates           旧页: 4   新页: 0
$ grep -c matchControlledFence 旧页: 0   新页: 2
```

`f0dc41832` **不含** `matchControlledFence`（F-2 的行内任意位置围栏识别），即它是
**F-2 修复之前**的页面；`07a073ce` 含该函数且 `scanGates` 归零（后续清理已并入）。
两者为 **128477 B → 131367 B**。

**裁定**：criterion 12 要求「该实例响应体页面 sha256 前 16 = `f0dc41832cd79106`」这一**基线值本身已过期**，
不是实现回归。本轮以**实测值**报告（§0.5），并保留该差异不隐去。

---

### 6.2 ⚠️ 编号对照表（改号后必读，防止修复者对错靶子）

**问题根源**：V1 阶段存在**两套互不一致的 F 编号**，而本报告此前混用了它们：

- **T 方案**：`t5` 任务的回报文本（`F-1`=超长 info blocker、`F-2`=资产重复加载、`F-3`=嵌套围栏）
- **R 方案**：`docs/output-self-review-verification.md` §5（`F-1`=`scanGates` 死代码、`F-2`=未闭合围栏、`F-3`=冻结依据与行为不符）

两者 `F-1`/`F-2` 所指**完全不同** → 我此前在 §2.2 与 §2.3 都写"F-2"，属真实撞号。现按 captain 指令统一：

| 本报告现用编号 | 原写法（曾用） | 缺陷内容 | 严重度 | 状态 | 来源方案 |
|---|---|---|---|---|---|
| **F-1** | F-1 | 超长单行 info 使 ` ```mermaid ` 明文进载荷 | blocker（V1） | ✅ 已修复 | T |
| **F-2** | F-2（§2.3） | mermaid 资产 404 时单轮 9 次重复加载 | medium | ✅ 已修复 | T |
| **F-3** | F-3 | v3.2.9 冻结依据称"F-2 已修复"与行为不符 | medium | ❌ **撤回（编号撞车误读）** | R |
| **F-4** | （requirements §16.4） | `scanGates` 不可达抽象（死代码） | medium | ✅ 已删除 | R |
| **F-5** | **F-2（§2.2）** | 未闭合围栏块体在 `fence-fallback` 下进 DOM | low | ❌ **结案：桩缺陷（非产品缺陷）** | R |
| **F-6** | **D-1（§2.5）** | `blockResults` 取值域违约（发 `render`，声明 `passed\|degraded`） | medium | ✅ **已修复并复验**（21:48） | 本轮新增 |
| **P9-1** | （无） | 干净 EOF 时 `pending` 块永不降级 | medium | ❌ **open** | 本轮新增 |

**要点**：

1. `§2.2` 的编号由 **F-2 改为 F-5**（它是 R 方案的 F-2，与 T 方案的 F-2 不同）；
2. `§2.5` 的编号由我临时写的 **D-1 改为 F-6** —— `D-1` 与 `t5` 回报里的 `D-1`
   （`output-gate-contract.md` 仍以 requirements v2 为基线，low）**撞号**，故一并改掉；
3. **F-4 未被本报告重新定义**：它在 requirements §16.4 是 `scanGates` 死代码，本报告 §6.2 仅复验其删除结果，
   **不占用 F-4 去指别的缺陷**；
4. `F-7` 暂未使用（留给后续 finding）；
5. 第一轮的 **F-1（超长 info）/ F-3** 保留原名不变，与 V1 兼容。

**复验 F-4（`scanGates` 删除结果）**：

```
$ grep -rn "scanGates" customer-service/web/ customer-service/plugins/
(0 命中)
$ grep -c scanGates customer-service/web/guest/index.html
0
```

→ requirements §16.4 所述「全域删除」**成立**。同时兜底**活路径未被误伤**（§6.3）。

### 6.3 F-4 实质：「测试守护了一个不存在的路径」的可复核证据（captain 指定）

F-4 的要害**不是**"删掉一个没用的函数"，而是：**曾有 5 条单测在测一个生产永不可达的抽象**，
使读者误以为存在 `scanGates` 兜底。以下给出可直接复核的证据。

**① 生产不可达 —— 真机运行期调用计数桩（行为层，非符号检索）**

V1 §4.2 已做（此处原文引用，证据层级：行为/事件序列）：

```
包装成功: true
本轮 G.scanGates 调用次数: 0
→ 口径 B 下 scanGates 是否被使用: 否
```

方法：页面加载后把 `window.G.scanGates` 替换为**计数包装函数**（保留原实现并计数），
跑一轮真实回答后读计数。计数为 **0** → 生产路径确实不经过它。
（该桩脚本 `/tmp/cs-verify/scan-gates-probe.mjs` 现指向已删除符号，**属预期**——
requirements §386 明示："取证脚本若仍引用它们，说明用错了制品"。）

**② `gate-dom-check.mjs:818` 的"路径 B"实际测的是 `renderMarkdown`**

现状（本轮重读当前制品）：

```
$ sed -n '818,823p' customer-service/web/guest/tests/gate-dom-check.mjs
  check('路径 B（围栏兜底）：无 block 事件时 renderMarkdown 围栏分支仍可用 → 图形块照常渲染', () => {
    assert.equal(pathLegacy.blockHosts, 0, '兜底路径不建块槽位容器')
    assert.equal(pathLegacy.mermaidContainers, 1, '本地扫描应产出 1 个 mermaid 容器')
    assert.equal(pathLegacy.svg, 1, '兜底路径也应渲染出 SVG')
    assert.equal(pathLegacy.leaks, 0, '不得泄漏源码')
  })
$ grep -c "scanGates" customer-service/web/guest/tests/gate-dom-check.mjs
0
```

关键三点：

1. **用例标题已被改写**为「renderMarkdown 围栏兜底」——不再是原来的 `scanGates` 语义；
2. **该测试文件对 `scanGates` 的引用数为 0**；
3. 断言对象是 `pathLegacy`，由 `runPath('legacy')` 在 jsdom 里以"无 block 事件"运行页面得到，
   走的是 `renderMarkdown` 的围栏分支，**与 `scanGates` 无关**。

**③ 兜底活路径仍在（删除范围边界正确）**

```
$ grep -n "chooseBlockSource\|blockSourcePolicy\|fence-fallback" web/guest/index.html web/guest/assets/output-gate.js
web/guest/index.html:658:  if (blockSourcePolicy() === 'block-events') continue
web/guest/index.html:668:  if (blockSourcePolicy() === 'block-events') continue
web/guest/index.html:1059:  * 裁决规则在 output-gate.js 的纯函数 `chooseBlockSource`，页面不自己判。
web/guest/index.html:1078: function blockSourcePolicy() {
web/guest/index.html:1079:   return G.chooseBlockSource({ sawBlockEvent })
web/guest/assets/output-gate.js:181: function chooseBlockSource(input) {
web/guest/assets/output-gate.js:183:   return spec.sawBlockEvent === true ? 'block-events' : 'fence-fallback'
```

→ 单一裁决点 `chooseBlockSource` 存活，`fence-fallback` 分支仍可达（`index.html:658/668` 两处消费）。
**即：删掉的是不可达抽象，兜底能力本身未删。**

**④ 与 requirements §16.4 结论一致性**

requirements §16.4 已独立裁定「F-4 属 Q5 未使用抽象，删除正确」，并要求"路径 B 标签改为 renderMarkdown 围栏兜底、
测试体保留"。本轮复核**两条都成立**（①标题已改 ②测试体在且断言兜底路径）。

---

## 7. 复核建议（供 t6）

1. **基线以磁盘实测为准**（前端 `07a073ce` / `11ebac89`；主机侧 `engine.ts` **`2da07bdc`**、
   `fence-machine.ts` `25948540`），不要引用 `f0dc41832`/`cdf2869a`/`fd6e9cbc`/`6027b330`；
2. **端口映射**见 §0.6，尤其不要把 `:10902` 当门禁后端（那是我的桩）；
3. 未能验证项见 §4（其中原第 2 项 REG6/P9 **本轮已补测**，结论见 §4.1）如需纳入 t6 判据，请另派取证；
4. V1 报告保留不动；其 §0.0 基线失效声明继续有效，本报告为其确认性复验；
5. **F-6 已闭环**（§2.5：21:48 落地，A 方案 + 类型检查 0 个 TS2322 + 线上载荷取值域正确 + 四套件复跑通过）。
   复核时**不要重复修**，尤其**不要**反过来把 `blocks[].decision` 也改成 `passed`——
   两套取值域**本就不同**（`blockResults` 是终态，`blocks[].decision` 是结构性裁决），这是修法的要点；
6. **当前唯一 open 的实现缺陷是 P9-1（§4.1）**：干净 EOF（有 delta、无 `done`、连接正常关闭）时
   `pending` 块**永不降级**，访客会一直看到「Preparing the graphic…」直到刷新。
   medium，**未泄漏**（不属 SRC/V1 级）。根因与复现命令见 §4.1，建议优先派修；
7. 复核 AS-14①（两块并行）时**不要**依据我中途的 `❌` 输出——那是我的探针口径问题
   （§6 第 5 条；§3.4 已给 18 点时间序列，全 `passed`）；
8. **G-FREEZE 事实上未满足**（§3.10）：本轮制品在取证期间漂移两次（20:29、21:48）。
   建议先取一次**显式停手确认**并复采基线，再据以判定。

## 8. 本轮清理（item 14）

```
$ for pid in 226181 226210 231631 231633 231635; do kill "$pid"; done   # 源实例 + 双 guest-server + 桩
残留验证进程: (无)
端口 10900 / 10901 / 10902 / 10903: free        ← 全部释放
docker ps: dshagent-app「Up 5 hours (healthy)」、dshagent-nginx「Up 5 hours」 ← **未重启/未重建**
```

隔离方式：源实例以 `DSH_HOME=/tmp/cs-verify/home` + `--port 10900`（自选端口，避开 3080/10800/10801）启动；
guest 页由我自建 `guest-server.mjs`（`API_PORT`/`PORT` 环境变量）拼成同源站点。
容器侧**全程只读**：`/api/guest/health` 的一次探测仅用于**反面对照**（§0.6），从未作判据。

**第二轮（REG6/P9 补测）结束后的二次清理**：

```
$ for pid in $(ps -eo pid,args | grep -E "bin\.ts.*--port 10900|guest-server\.mjs|stub-api\.mjs" | grep -v grep | awk '{print $1}'); do kill "$pid"; done
残留验证进程: (无)
端口 10900 / 10901 / 10902 / 10903 / 10905: free     ← 全部释放（10905 为 IMG7 出站监听器）
docker ps --format '{{.Names}}\t{{.Status}}' | grep dshagent:
  dshagent-nginx  Up 6 hours
  dshagent-app    Up 6 hours (healthy)                 ← **仍未重启/未重建**
```

第二轮的临时设施（均在 `/tmp/cs-verify/`，不属仓库制品）：
`__dropsse/`（真 socket 重置）、`__killmid/`（真实后端 + 中途 kill）、
`p9-eof-real.mjs`（干净 EOF）、`p9-keep.mjs`（passed 保持）、`reg6.mjs`、`reg6b/6c.mjs`。


---

# 附：V3 增量复验（captain 正式契约；被测版本判别器 + 窗口双采样）

> 角色：verifier（**只写报告，未改实现代码**）
> 说明：本节为 captain 指定的 V3 正式契约执行结果。**V3 无独立任务载体**（t8 为终态、无 t26），
> 故按 captain 指示写入本文件（t8 载体），**不覆盖 V1 与本文件既有内容**。

## V3-0 被测版本判别器（先跑判别器才开工）

```
cd customer-service/web/guest
$ grep -c '五类围栏识别' tests/output-gate-check.mjs          → 0      （期望 0）
$ grep -rn 'matchFenceOpen\|matchFenceClose\|FENCE_LANGS' . | wc -l  → 0 行   （期望 0）
$ grep -rn 'scanGates' . | wc -l                              → 0 行   （期望 0）
$ sha256sum assets/output-gate.js | cut -c1-16                → 11ebac8964857f0a  （期望 ✓）
$ sha256sum index.html | cut -c1-16                           → e8fce50f84a5795f  （**captain 期望 e597f642 — 见 V3-0.1**）
$ node tests/output-gate-check.mjs                            → 61 项通过（**captain 期望 58 — 见 V3-0.1**）
```

**活路径计数**（captain 期望 `chooseBlockSource=3` / `blockSourcePolicy=3` / `gateBlockHtml=2`）：
```
blockSourcePolicy(html) = 3  ✓ ｜ gateBlockHtml = 2  ✓ ｜ block-open = 6  ✓
chooseBlockSource 全仓 = 7（index.html 5 处 + output-gate.js 2 处；captain 的"3"应为单文件口径）
```
→ **死代码清零三项全部通过**（清理无回退）；`output-gate.js` 与期望一致。

### V3-0.1 `index.html` 与测试项数不符的**原因查明（非中间态遗留，非我读错）**

```
$ date -r index.html            → 2026-09-11T00:27:19 起多次变更（实测 e8fce50f → 183d1123 → e8d46036 → e8fce50f）
$ curl -s http://127.0.0.1:10800/ | sha256sum | cut -c1-16  → e8fce50f84a5795f   （136597 B）
$ sha256sum 仓库 index.html | cut -c1-16                    → e8fce50f84a5795f   （与线上逐字节一致）
```
**线上 10800 与仓库磁盘一致，但都不是 `e597f642`（128426 B）**——该值系 captain 于 20:21:40 采集，
此后制品历经 **t18 / t19 / t22 / t25** 多轮落地修改，**基线已自然过期**（非任何一方读错）。

**开工前我做过活性检测，捕获到真实写入**（写入者为 `t25`，修正我上报的 `NO_GATE` 缺陷）：
```
采样1: index=e8fce50f84a5795f
采样2: index=183d1123ad1407a6   ← 变化
```
→ 我据此**停手等待**，直至 `t25 = completed` 且**双采样一致**才开工（captain 纪律第 3 条）。

### V3-0.2 取证窗口双采样（证明窗口内制品未变）

```
窗口起始（间隔 20s 两次一致）:
  e8fce50f84a5795f  index.html
  11ebac8964857f0a  assets/output-gate.js
  a51bff776fdd5322  assets/package.json
  57401a609aa84eb9  tests/output-gate-check.mjs
  789eaf2063f2b5f8  tests/gate-dom-check.mjs

窗口结束:
  e8fce50f84a5795f  index.html
  11ebac8964857f0a  assets/output-gate.js
  a51bff776fdd5322  assets/package.json
  57401a609aa84eb9  tests/output-gate-check.mjs
  789eaf2063f2b5f8  tests/gate-dom-check.mjs
```
→ **起止逐字节一致**，故本 V3 节全部读数锚定于**同一制品**。

**主机侧 5 文件**：`fence-machine.ts` = `259485406ad2c8af`、`engine.ts` = `2da07bdce590e6ad`、
`block-rules.ts` = `dafca4575e9be224`、`index.ts` = `4d39bb58624a0e49`、`guest-server/index.ts` = `99110840bc1bb7ed`。
> 注意：前两者与 captain 基线（`fd6e9cbc` / `6027b330`）**不同**——它们是 **t13 复验过的 F-6/D-1 修复（21:48）**
> 与更早的 `fence-machine` 变更（20:29），属**已落地且已复验**的改动，非未广播写入。

## V3-1 二元组三重标识

```
① 实例 health:      {"ok":true,"version":"verify-local-1"}
② 实例响应体页面:   sha256 前16 = e8fce50f84a5795f = 磁盘 index.html（逐字节一致）
③ SSE 原始帧:       见 V3-3（事件序列 ["text","block-open","block","text"]）
④ 声明:            未使用 10800 作判据（10800 仅用于 V3-0.1 的一致性对照）
```

## V3-2 [1] F-4 / F-4b 闭环

```
$ grep -rn 'scanGates' web/ plugins/          → 0
$ grep -rn 'matchFenceOpen|matchFenceClose|FENCE_LANGS' → 0
$ grep -c '五类围栏识别' tests/output-gate-check.mjs   → 0
```
**活路径未误伤**：`blockSourcePolicy`=3、`gateBlockHtml`=2、`chooseBlockSource` 存活。

**「路径 B（围栏兜底）」改名后仍通过**：
```
$ grep -n "路径 B" web/guest/tests/gate-dom-check.mjs
826:  check('路径 B（围栏兜底）：无 block 事件时 renderMarkdown 围栏分支仍可用 → 图形块照常渲染', …)
832:  await (async () => check('路径 B 流式期：兜底必须逐帧解析…', …)
$ node web/guest/tests/gate-dom-check.mjs   → 全部 74 项通过（exit=0）
```
→ 用例标题已改指**活路径**（`renderMarkdown` 围栏兜底），且**仍通过**。→ **通过**。

## V3-3 [2] A′ 早时点（SRC5）

```
$ xvfb-run -a node --import tsx/esm /tmp/cs-verify/src6-real.mjs
| 源码封堵点 | pre>code | 围栏可见 | 源码可见 | 早时点(≤2s)泄漏 | 终态 |
| ① mermaid 容器初始内嵌源码 | 0 | false | false | 0/19 | passed |
| ② mermaid 渲染失败分支     | 0 | false | false | 0/19 | degraded |
| ③ renderImageBlock 非法回退| 0 | false | false | 0/19 | degraded |
| ④ renderChart 非数组回退   | 0 | false | false | 0/19 | degraded |
| ⑤ renderChart JSON 异常回退| 0 | false | false | 0/19 | degraded |
| ⑥ renderMarkdown 未闭合分支| 0 | false | false | 0/19 | degraded |
SRC3 逐点结论：6 点，失败 0 点
```
→ **通过**（6 点、早时点 0/19 泄漏）。

## V3-4 [3] D：CF-1 + T1

```
$ xvfb-run -a node /tmp/cs-verify/twoblock-final.mjs
=== 终态 === [{"key":"blk-two-m","state":"passed"},{"key":"blk-two-i","state":"passed"}]
svg=1 img=1 figure=1 | 含围栏=false 含源码=false pre>code=0
AS-14① 判定（两块都 passed + 无泄漏）: ✅ PASS

$ xvfb-run -a node --import tsx/esm /tmp/cs-verify/t1-ab.mjs
门禁开（host）: done 中位 3591 ms
门禁关（naive）: done 中位 3601 ms
T1 判据：done 时延差 = -10 ms（要求 ≤600ms）→ PASS
```
→ **通过**（两块均 `passed`；T1 差 −10ms）。

## V3-5 [4] E：C6 载荷逐字节一致

```
$ node --import tsx/esm /tmp/cs-verify/e-parity-http.mjs
probe=false 载荷 sha256: cb6ac9e0e9b42a079f857b3173eb9ccc
逐字节一致: ✅ PASS
死链图片 decision: ['image:render:/uploads/banner_cs_9af26b7f16.png', 'image:render:/uploads/dead-link-404.png']
```
→ **通过**（探测开关载荷同 sha256；死链仍 `render` 交真机 C4）。

## V3-6 [5] F 降级 + C8（含我上报的 `NO_GATE` 缺陷已修复验证）

```
$ xvfb-run -a node --import tsx/esm /tmp/cs-verify/four-fallbacks.mjs
1 非法 mermaid: 无源码   2 图片路径非法: 无源码   3 chart 非数组: 无源码   4 chart 畸形 JSON: 无源码
5 空 html: 无源码       6 正常 mermaid（对照）: 源码以文本形式可见（**正确**，见 V3-10）
7 正常图片（对照）: 无源码  8 未闭合围栏（流尾截断）: 无源码
```
→ 四处回退 `pre>code`=0。**通过**。

**C8 组件缺失（`assets/output-gate.js` 404，其余全真）**：
```
$ xvfb-run -a node /tmp/cs-verify/prep-nogate.mjs
文本: "说明文字。 | The diagram is temporarily unavailable; please refer to the text above."
svg=0 | 块状态: ["degraded"] | 含围栏=false 含源码=false pre>code=0
页面内错误文案: (无)
回答是否可用（非错误/恢复态）: true
判定：✅ 资产缺失时仍健壮（回答可用、无泄漏）
```
→ **通过**。**且这是对我上报缺陷的修复确认**：修复前同一条件得到
`Sorry, something went wrong: G.normalizeBlockType is not a function`（整条回答失败），
现为**可读降级 + 回答可用**（`t25` 已修 `NO_GATE` 缺成员问题）。

## V3-7 [6] G 回归 + 限流/辱骂阻断

**⚠️ 先说一处我自己的工具错（已改正，避免后人误判）**：首次跑 G 时我把 10901 接到了**桩**（`stub-2protocol`）而非真实后端，
导致限流用例全 404；**修正接线后重跑**。另 `g-regress.mjs` 采样窗口偏短（约 10s），
而真实模型首块到达约 10.5s，故会读到 `svg=0` 的**中间态**——**加长等待后实测通过**（见下）。

```
$ xvfb-run -a node /tmp/cs-verify/g-diag.mjs        （真实后端 10901 → 10900，加长采样）
  9.0s  len=108 svg=0 src=0 states=["loading"]
 10.5s  len=776 svg=2 src=1 states=["passed","passed"]   ← 终态
 21.0s  len=776 svg=2 src=1 states=["passed","passed"]
终态 svg= 2 sources= 1 mermaidSrc容器= 2
mermaid 资源请求: 1 | 错误: []
```
→ **文字流式 ✓（len 递增）、正常 mermaid 渲染 ✓（svg=2）、来源引用 ✓（sources=1）、无源码/围栏 ✓**。

**限流与攻击防护**（真实后端）：
```
$ node /tmp/cs-verify/rate-limit.mjs
状态码分布: {"200":3,"429":1}；第 4 次出现 429
429 报文: {"error":"request blocked","blocked":true,"retryAfterSec":60,"message":"…请先冷静一下，约 1 分钟后再继续咨询…"}
判定: ✅ PASS

$ node /tmp/cs-verify/attack.mjs
注入 system prompt 覆盖: status=200 | 围栏泄漏=false | 含<script>=false
围栏逃逸尝试:            status=200 | 围栏泄漏=false | 含<script>=false
超大输入:                status=200 | 围栏泄漏=false | 含<script>=false
空消息:                  status=400
```
→ **通过**。

## V3-8 [7] B：IMG7 CSP 真机零出站

```
$ xvfb-run -a node /tmp/cs-verify/img7-egress.mjs
iframe 内 securitypolicyviolation 事件: [{"blockedURI":"http://127.0.0.1:10905/runtime.png","violatedDirective":"img-src"}]
监听器全部命中明细: []                       ← 自控监听器收到连接 0
Playwright request 事件（拦截前尝试，非出站）: ["http://127.0.0.1:10905/runtime.png"]
IMG7 判定（网络层零出站 0/2 + 帧内真实违规事件 img-src）: ✅ PASS
```
→ **通过**（真机帧内违规事件 + **网络层零出站**）。

## V3-9 [8][9] F-5 结案复跑 + `EventSource` 自查

**F-5 修桩后复跑**：
```
$ xvfb-run -a node --import tsx/esm /tmp/cs-verify/c8-evidence.mjs
=== ⑥ 未闭合围栏：流式期块体源码进入访客 DOM ===
采样点: 89 | 命中块体源码的采样点: 0        ← 修桩前 28
```
桩已按设计逐片发送（case 8 = 4 帧、**case 9 = 1 帧对照保留**）。→ **28/89 → 0，结案为桩缺陷** ✅

**`EventSource` 自查**：**无一项证据受影响**——15 个取证脚本 + t17 脚本命中均为 **0**；
页面实现为 `res.body.getReader()`（fetch 流式读）；唯一命中 `toolfacts.mjs` 是我自己的事实核查脚本。

## V3-10 [10] 判别器与编号对照（写入报告，以防"我测的是哪一版"）

**F-5 对照表与 F-3 撤回已在 §6.2 / §2.4**（F-4=`scanGates`、F-5=未闭合围栏→桩缺陷、F-6=`blockResults`、P9-1=干净 EOF 悬挂）。

**清单核对要点**：`four-fallbacks` 第 6 例「正常 mermaid: 源码以文本形式可见」——该例是**对照例**，
其 `secret` 标记为裸词 `flowchart`，命中的是 mermaid 产出的 **SVG 类名 `class="flowchart"`**，
`pre>code = 0`、无围栏。**非泄漏**（V2 §6 第 4 条已记录同一口径错）。

## V3-11 结论与未能验证项

**A–G 复核结论**：V3-2 ~ V3-9 **全部通过**；F-5 结案为桩缺陷；`NO_GATE` 缺陷（我上报）**已由 t25 修复并实测验证**。

**未能验证（不默认通过）**：

| # | 条目 | 原因 |
|---|---|---|
| 1 | 修复在**线上 10800** 的真实生效 | 容器为旧构建（无 output-gate 插件），须重建方可验；本次按要求**未重建** |
| 2 | `serviceVersion = 2026-09-10.10` | 被测为自建源码实例（`verify-local-1`），设计如此 |
| 3 | REG8 图片阅读器交互（点击放大） | 仅核 DOM 与代码存在，未做交互点击验证 |
| 4 | REG7 HTML 预览高度自适应 | 未测 iframe 高度随内容变化 |
| 5 | 配置逐键**生效**（AS-7） | 仅核对默认值与夹具一致性，未逐键改配置重启验证 |
| 6 | 真实模型图形块产出率 | 非受控：实测 7 次同义请求仅 1 次产出块（6 次礼貌拒答 + 0 块）；故真机出图**不作判据** |

## V3-12 清理

```
残留验证进程: (无)
端口 10900 / 10901 / 10902 / 10903: free
docker ps: dshagent-nginx「Up 9 hours」、dshagent-app「Up 9 hours (healthy)」 ← 未重启/未重建
```
隔离方式：源实例 `DSH_HOME=/tmp/cs-verify/home` + `--port 10900`；guest 页由自建 `guest-server.mjs` 拼接；
`10901 → 真实后端 10900`、`10903 → 桩 10902`（health 版本号可区分）。容器侧只读。
