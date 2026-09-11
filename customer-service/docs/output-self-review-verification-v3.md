# 输出前自审门禁 — V4 复验报告（t13：D-1 修复闭环）

> 角色：verifier（对抗验证者，**只写本报告路径，未修改任何实现代码**）
> 日期：2026-09-10
> 承接任务：**t13「V4 复验 D-1」**（依赖 t12 已完成）
> 前序报告：`output-self-review-verification.md`（V1）、`output-self-review-verification-v2.md`（V2，保留不动）

**总判定：✅ D-1 修复**真闭环**——8 项验收逐条通过，未发现回归。**

---

## 0. 被测制品与证据层级

### 0.1 判据版本（实测，非转述）

```
$ head -2 customer-service/docs/output-self-review-requirements.md
# 客服输出前自我审核 — 需求清单与验收标准（v3.2.12）
```

> 文档在本次会话内已由 v3.2.11 演进到 **v3.2.12**（新增 G-ANCHOR-5「判据不得内嵌易变事实」等）。
> 这与 D-2（判据内嵌过期指纹）的处置方向一致。

### 0.2 被测制品（修复后）

| 文件 | sha256 前 16 | mtime |
|---|---|---|
| `plugins/output-gate/src/engine.ts` | **`2da07bdce590e6ad`** | **09-10 21:48:21** |
| `plugins/output-gate/src/fence-machine.ts` | `259485406ad2c8af` | 09-10 20:29:14 |
| `plugins/output-gate/src/index.ts` | `4d39bb58624a0e49` | 09-10 17:55:16 |
| `plugins/output-gate/src/block-rules.ts` | `dafca4575e9be224` | 09-10 17:43:50 |
| `plugins/guest-server/src/index.ts` | `99110840bc1bb7ed` | 09-10 17:33:33 |
| `web/guest/index.html` | `07a073ceb7049a22` | 09-10 20:38:50 |
| `web/guest/assets/output-gate.js` | `11ebac8964857f0a` | 09-10 20:18:34 |

**本次复验对象**：`engine.ts = 2da07bdce590e6ad`（即 t12 的 D-1 修复版）。
修复前该文件为 `6027b330a385b1b9`（17:44:08）。

### 0.3 证据层级（G-ANCHOR）

| 层级 | 本次使用处 |
|---|---|
| 线上制品 | §3 三出口原始 JSON、SSE `done` 帧 |
| 行为/事件序列 | §4 真实 `OutputGateService` 驱动、真机 DOM |
| 制品指纹 | §0.2、§2 声明域 grep |
| 符号存在 | 仅用于 §2「声明域未放宽」，**未**用于支撑行为结论 |

---

## 1. 结论总表

| # | t13 验收项 | 结论 | 证据 |
|---|---|---|---|
| 1 | TS2322 计数 = 0，且修复前后两次读数均贴出 | ✅ 通过 | §2.1 |
| 2 | `blockResults` 声明域仍为 `Record<string,'passed'｜'degraded'>`，无 `'render'`、无 `as` 绕过 | ✅ 通过 | §2.2 |
| 3 | 三出口实测取值只出现 `passed`/`degraded`，无 `render` | ✅ 通过 | §3 |
| 4 | `degradedIds` 与 `blockResults` 同判据恒等，无孤立 id | ✅ 通过 | §3、§4.1 |
| 5 | `blocks[].decision` 仍为 `'render'｜'degraded'`，`toPayload()` 行为不变 | ✅ 通过 | §2.3、§4.1 |
| 6 | 行为无回归：真机 degraded 仍降级、主机侧降级仍降级、正常块仍可见 | ✅ 通过 | §4 |
| 7 | `blockResults` 与 `blocks` 均不含 `pending`/`unresolved`/`probe`/`reachable`/`probeResult` | ✅ 通过 | §5 |
| 8 | 所起实例已清理、端口回收；未触碰 10800/10801 | ✅ 通过 | §6 |

---

## 2. 制品层证据

### 2.1 [1] TS2322 修复前后对照（含命令与退出码）

**修复前**（`engine.ts = 6027b330a385b1b9`，我在 V2 取证时的原始读数）：

```
$ cd /home/as-workstation01/Documents/project/dshagent
$ npx tsc --noEmit --strict --target es2022 --module nodenext --moduleResolution nodenext \
    --skipLibCheck --ignoreConfig customer-service/plugins/output-gate/src/engine.ts
customer-service/plugins/output-gate/src/engine.ts(379,7): error TS2322: Type '"render" | "degraded"' is not assignable to type '"degraded" | "passed"'.
  Type '"render"' is not assignable to type '"degraded" | "passed"'.
[exit=2]
$ … | grep -c "TS2322"
1
```

**修复后**（`engine.ts = 2da07bdce590e6ad`，本次复验）：

```
$ npx tsc --noEmit --strict --target es2022 --module nodenext --moduleResolution nodenext \
    --skipLibCheck --ignoreConfig customer-service/plugins/output-gate/src/engine.ts
customer-service/plugins/output-gate/src/engine.ts(23,28): error TS2591: Cannot find name 'node:crypto'. …
customer-service/plugins/output-gate/src/engine.ts(24,78): error TS5097: An import path can only end with a '.ts' extension …
customer-service/plugins/output-gate/src/engine.ts(33,8):  error TS5097: （同上）
customer-service/plugins/output-gate/src/engine.ts(365,27): error TS2591: Cannot find name 'Buffer'. …
customer-service/plugins/output-gate/src/fence-machine.ts(78,10): error TS2591: Cannot find name 'Buffer'. …
$ … | grep -c "TS2322"
0
```

→ **[1] 通过**。残留的 `TS2591`/`TS5097` 系「单文件直检未带本仓 tsconfig」所致（无 `@types/node`、未开 `allowImportingTsExtensions`），
**与 D-1 无关**，且**修复前后同样存在**，故不构成差异。

> **方法学声明（G-ANCHOR）**：我**未**把「TS2322 = 0」当作 D-1 闭环的唯一证据。
> 类型检查是**制品层**证据；下面 §3/§4 用**行为层**证据独立复核取值域与终态语义，
> 以免出现「类型过了但线上仍发错值」的情形。

### 2.2 [2] 声明域未被放宽（grep 原文）

```
$ grep -n "blockResults" customer-service/plugins/output-gate/src/engine.ts
127:  blockResults: Record<string, 'passed' | 'degraded'>
377:   * **`blockResults` 是主机侧发出的块终态**（取值域冻结为 `'passed' | 'degraded'`），
381:   * | 情形 | `blockResults[id]` |
389:   * （O2 `outcome ∈ passed|degraded`），不放 `blockResults`。
399:    const blockResults: Record<string, 'passed' | 'degraded'> = {}
402:      // 单一判据：degradedIds 与 blockResults 必须恒等，不得出现两条分叉判定。
406:      blockResults[block.blockId] = outcome
412:      blockResults,
```

```
$ sed -n '399,408p' …/engine.ts
    const blockResults: Record<string, 'passed' | 'degraded'> = {}
    const degradedIds: string[] = []
    for (const block of this.blocks) {
      // 单一判据：degradedIds 与 blockResults 必须恒等，不得出现两条分叉判定。
      const outcome: 'passed' | 'degraded' = block.decision === 'degraded'
        ? 'degraded'
        : (block.reported?.outcome === 'degraded' ? 'degraded' : 'passed')
      blockResults[block.blockId] = outcome
      if (outcome === 'degraded') degradedIds.push(block.blockId)
```

→ **[2] 通过**：声明域两处（接口 `:127`、局部 `:399`）**均为 `'passed' | 'degraded'`**，
**未加入 `'render'`**、**未删标注**、**未用 `as` 绕过**（局部显式标注 `const outcome: 'passed' | 'degraded' = …`，
是**收窄**而非放宽；若右侧推不出该类型，tsc 会当场报错——正是 §2.1 要验的机制）。

### 2.3 [5] `blocks[].decision` 声明域未变

```
$ grep -n "decision:" customer-service/plugins/output-gate/src/engine.ts
106:  /** 块体源码的 base64；仅 `decision: 'render'` 时存在。 */
111:  decision: 'render' | 'degraded'
190:  decision: 'render' | 'degraded'
322:      decision: 'degraded',
362:      decision: state.decision,
```

`toPayload()`（`engine.ts:355` 附近）仍以 `state.decision` 原样输出，**未把终态塞回块载荷**。

→ **[5] 通过**（行为侧另见 §4.1：真机 degraded 后 `blocks[].decision` 仍为 `render`）。

---

## 3. [3][4] 三出口实测取值域与恒等

**方法**：源码实例（`127.0.0.1:10900`，`serviceVersion=verify-local-1`）经自建 guest 站（`:10901`）取三出口原始报文。

```
$ curl -s -X POST http://127.0.0.1:10901/api/guest/session          → {"sessionId":"guest-eb901129-…"}
$ curl -s -X POST http://127.0.0.1:10901/api/guest/chat      -d '{…"message":"请直接用 mermaid 代码块输出三节点流程图：A->B->C。只输出图。"}'
$ curl -s      "http://127.0.0.1:10901/api/guest/history?sessionId=guest-eb901129-…"
```

```
--- /chat ---
blocks[].decision: ["render"]
blockResults: {"blk-9056d27a-0":"passed"}
degradedIds: []

--- /history ---
blocks[].decision: ["render"]
blockResults: {"blk-9056d27a-0":"passed"}
degradedIds: []

=== t13 判据 ===
[3] 取值域只含 passed/degraded: true | 实际: ["passed"]
[4] degradedIds 与 blockResults 恒等: true | 由 blockResults 推得: [] | 实际: []
[4] 无孤立 id: true []
[3] 三出口一致: true
[5] blocks[].decision 仍为 render/degraded: true
```

**SSE `done` 帧（第三出口）**：

```
event: done
data: {"reply":"","sources":[],"blocks":[…],"blockResults":{"blk-ebc2438c-0":"passed","blk-ebc2438c-1":"passed"},
       "degradedIds":[],…}
```

→ **[3] 通过**（三出口均只出现 `passed`/`degraded`，**无 `render`**；与修复前 `{"blk-…":"render"}` 形成干净 before/after）。
→ **[4] 通过**（`degradedIds` 恰为「`blockResults` 中值为 `degraded` 的 id 集合」，无孤立 id；三出口一致）。

> **本组样本均为「无降级块」**（`degradedIds` 为空）。空集相等不足以证明恒等，
> 故 §4.1 用**含降级块**的构造复验该恒等。

---

## 4. [6] 行为无回归（含 §4.1 反向用例）

### 4.1 主机侧降级 + 正常块并存（`OutputGateService.gateReply` 真实驱动）

**构造**：正常 `mermaid` 块 + 非法路径 `image` 块（`/uploads/../secret.png` → 主机侧必降级）。

```
$ node --import tsx/esm /tmp/cs-verify/t13-degrade2.mjs
服务: ok

=== 正常 mermaid + 非法图片（目录穿越） ===
  text: "前置。\n中段。\n后置。"
  blocks[].decision: ["mermaid:render","image:degraded"]
  blockResults: {"blk-b94b9da4-0":"passed","blk-b94b9da4-1":"degraded"}
  degradedIds: ["blk-b94b9da4-1"]
  围栏泄漏: false | 取值域⊆{passed,degraded}: true
  degradedIds≡blockResults: true
  decision→blockResults 映射正确: true

=== 单个正常 mermaid ===
  blocks[].decision: ["mermaid:render"]
  blockResults: {"blk-b94b9da4-0":"passed"}
  degradedIds: []
  围栏泄漏: false | 取值域⊆{passed,degraded}: true
  degradedIds≡blockResults: true
  decision→blockResults 映射正确: true
```

→ 主机侧降级的块 → `degraded` ✔；正常块 → `passed` 且 `decision=render` ✔；恒等在**非空集**下成立 ✔。

> **方法学提醒（t17 已记录的陷阱，我亦踩过一次）**：`engine.ts` **不导出 `DEFAULTS`**；
> 构造 `OutputGate` 时若漏 `enabled: true`，门禁**整体不生效**——我第一版脚本得到
> `text=""`、`blocks=[]`、`blockResults={}` 的**空载荷**，若误读会把「门禁没开」当成「无回归通过」。
> 本报告所有主机侧结论均取自 `enabled: true` 的构造（默认值源自 `tests/gate-check.mjs`）。

### 4.2 真机回传 `degraded` → 终态是否反映（修复前此路不通）

这是 V2 §2.5⑥ 明示「未能验证」的那一项（当时我的进程外探针回传被拒 `applied:false`）。
本次改用 **`beginTurn()` 取 `TurnGate`，在结算窗口内回传**，使 `recordReport` 真正生效：

```
$ node --import tsx/esm /tmp/cs-verify/t13-report.mjs
block 事件: blk-b94b9da4-0 decision=render
recordReport(degraded) 已生效: true

=== settle 终态 ===
blockResults: {"blk-b94b9da4-0":"degraded"}
degradedIds: ["blk-b94b9da4-0"]
blocks[].decision: ["mermaid:render"]
[6] 真机 degraded → blockResults[id]=degraded: true
[6] 同块进入 degradedIds: true
[6] blocks[].decision 未因此回改: render
```

→ **[6] 通过（关键项）**：真机判 `degraded` **确实反映到终态 `blockResults`/`degradedIds`**，
而 `blocks[].decision` **保持 `render`**（结构性裁决不被真机结论回改）。
**这同时补上了 V2 未能验证项**，并证明新实现的四分支语义与注释一致。

### 4.3 正常块访客仍可见（真机 DOM）

```
$ xvfb-run -a node --import tsx/esm /tmp/cs-verify/t13-machine.mjs
[6] 正常块（blockResults=passed）访客可见: svg= 1 | 槽位: ["blk-t13-m:passed"]
[6] 无泄漏: 含围栏= false pre>code= 0
[6] 判定: ✅ 可见
```

### 4.4 回归套件（修复后全绿，且断言数增加）

| 套件 | 修复前 | 修复后 |
|---|---|---|
| `plugins/output-gate/tests/gate-check.mjs` | 67/67 | **73/73** |
| `plugins/output-gate/tests/http-exits-check.mjs` | 20/20 | **25/25** |
| `web/guest/tests/output-gate-check.mjs` | 58/58 | **58/58** |
| `web/guest/tests/gate-dom-check.mjs` | 61/61 | **61/61** |

另跑：对抗矩阵 **54 通过 / 0 失败**；F-1 三出口 `false/false/false`（无 ```mermaid 泄漏）。
→ **无回归**，且主机侧新增 11 条断言覆盖新取值域。

---

## 5. [7] 未决字段检查

```
$ grep -rnE "pending|unresolved|probe|reachable|probeResult" customer-service/plugins/output-gate/src/engine.ts
（无输出；engine.ts 内这些词仅出现在注释的语义描述中，非载荷字段）
```

运行时对 `/chat` + `/history` 原始报文做同检查：

```
[7] 载荷含未决字段: 无
```

`GatePayload` 字段全集为 `text / blocks / blockResults / degradedIds / gate`；
`BlockPayload` 为 `blockId / blockType / sourceB64? / sourceBytes / decision / reason? / imagePath? / imageCaption?`
——**无任何「未决」字段**（与 E5/CF-3 一致：可达性只进留痕）。

→ **[7] 通过**。

---

## 6. [8] 清理

```
$ for pid in $(ps -eo pid,args | grep -E "bin\.ts.*--port 10900|guest-server\.mjs|stub-api\.mjs|serve-disc\.mjs" | grep -v grep | awk '{print $1}'); do kill "$pid"; done
残留验证进程: (无)
端口 10900 / 10901 / 10902 / 10903 / 10907: free     ← 全部释放
docker ps --format '{{.Names}}\t{{.Status}}' | grep dshagent:
  dshagent-nginx  Up 7 hours
  dshagent-app    Up 7 hours (healthy)                 ← **未重启/未重建**
```

隔离方式：源实例 `DSH_HOME=/tmp/cs-verify/home` + `--port 10900`（避开 3080/10800/10801）；
判别实验另起 `:10907` 专用服务器（见 §7）。容器侧**全程只读**。

→ **[8] 通过**。

---

## 7. 附带完成：F-3 更正 + F-5 判别实验（captain 指定）

### 7.1 F-3 更正：**系编号撞车导致的误读，现撤回**

V2 §2.4 曾记「文档称『F-2 已修复』与行为不符」。**经复核，这是我的误读**，captain 指正成立：

- 文档**自身**的 G-ANCHOR 表（`requirements.md:461`）把 F-2 锚定为
  「**F-2 是否已修**：间接证据=符号存在（`grep mermaidPromise`）／直接证据=行为存在（同一脚本 before/after）」；
- `requirements.md:5`「依据：**F-2 已修复**（写者回报停手）→ 采集末次基线」；
- 版本历史 `v3.2.9` 条目：「重录基线（**F-2 修复后**）」。

→ 文档里的 **F-2 = mermaid 资产 404 反复重试**（`mermaidLoadFailed` 入口短路），**确已修复**
（真机 9→1、下轮可恢复，V2 §2.3 已独立复验）。
文档**从未**声称「未闭合围栏已修复」——那是我在 V1 里用另一套编号（`F-2`=未闭合围栏）时，
把两套同号 finding 混为一谈所致。

**处置**：V2 §2.4 的 F-3 结论**撤回**（改为「不成立：系编号撞车」）。
编号已按 captain 指令统一，对照表见 V2 §6.2（其中 **F-4 沿用 requirements §16.4 的 `scanGates` 含义，未被重定义**）。

### 7.2 F-5 判别实验：**结论属「可能性 1」——泄漏来自具体可见元素**

> ## ⚠️ 本节结论已被后续追查**推翻**，请先读这段
>
> 本节证明的**事实**仍成立：我确实观察到**可见 `<p>` 元素**里的块体源码。
> 但**根因归属被我判错了**。后续根因追查（captain 裁决 + 我独立复验）表明，该现象
> **由我自己的取证桩 `stub-api.mjs` 造成**：桩把「case 8 设计为 4 个分片」实现成
> 「`join('')` 后每 tick 重发整段 ×9」，页面按**增量**累加得到 **9 个重复副本**；
> 重复副本中的 ``` 起始行被旧前端的**裸 `/^```/` 闭口判据**误判为"闭合行"，
> 块体因此漏成正文段落。**修正桩后同一脚本实测 28/89 → 0/89**。
>
> → **F-5 已结案为【桩缺陷，非前端缺陷】**，详见 **V2 §2.2**（含机制量化 + 真实后端协议独立性验证）。
> 本节以下内容保留为**更正过程证据链**，其"F-5 成立"的推论**请勿再引用**。
> **对 t20 的影响**：F-5 不再是待修的前端缺陷；但 t18 的「fence-fallback 源码泄漏（形态 I/II）」
> 目标**仍需独立复查是否同样受该桩影响**（t17 的形态 I/II 若用同一桩取证，结论需重估）。

captain 的静态分析（未闭合分支只产占位、源码只进内存台账）在**代码层是正确的**，
但我的实证显示**泄漏真实存在**，成因在**另一条路径**（`fence-fallback` 的正文重解析）。
为给出可直接复核的来源证据，我做了判别实验：

**实验条件（严格对齐 V1 取证）**：页面 = **`f0dc41832cd79106`（128477 B）** 的原始副本
`/tmp/cs-verify/served-index.html`，由自建 `:10907` 服务器提供；API 走桩 `proto=naive&case=8`（未闭合围栏、不下发 block 事件）。

```
$ cat disc.log
本实验服务的制品 sha256 前16 = f0dc41832cd79106 (128477 B)
（期望 f0dc41832cd79106 = V1 取证时的制品）
```

**三问的答案**：

| captain 的问题 | 实测 |
|---|---|
| URL 服务的 sha 是否 = `f0dc41832cd79106` | ✅ **是**（`curl -s …:10907/old/ \| sha256sum \| cut -c1-16` → `f0dc41832cd79106`）。§0 所述 `/tmp/served2.html`=127217 B（`b887772b`）是**另一次更早的**抓取，**未**用于 F-5 取证 |
| 静态文档里是否已含 `flowchart TD` | ❌ **否**（`grep -c "flowchart TD" <页面>` = 0）→ 源码来自**运行时回答**，非静态来源 |
| 泄漏元素是什么 | **可见的 `<p>` 元素**（非 script/style/注释/data-*） |

```
采样 40 点；命中（可见文本或可见元素含源码）19 点

=== 首次命中 ===
  时刻: 600 ms
  bubble.innerText 命中: true
  可见元素（非 script/style）: [
 { "tag": "P", "cls": "", "state": null, "key": null, "html": "<p>flowchart TD</p>" },
 { "tag": "P", "cls": "", "state": null, "key": null, "html": "<p>  A[停电] --&gt; B[报修]</p>" } ]
  pre>code 数: 0 []
  全 DOM 命中元素数: 2 [（同上两个 <p>）]

=== 末次命中 ===
  时刻: 3150 ms | 可见元素: [ 同上两个 <p> 重复出现 ]

=== 终态 ===
  innerText: "说明文字。\n\nThe diagram is temporarily unavailable; please refer to the text above.\n📄 page.md"
  outerHTML 长度: 304 | pre>code: 0
  页面文档静态含 "flowchart TD": false
```

**判定：属 captain 列的「可能性 1」**——
1. **泄漏来自具体元素**：`<p>flowchart TD</p>` 与 `<p>  A[停电] --&gt; B[报修]</p>`（**可见**、`tag=P`、无 `data-*`）；
2. **不是**「源码藏在 data-*/script/注释/不可见处」——探针已排除 script/style，且 `innerText` 同样命中，
   故 **F-5 无需降级或改述**：它是**访客直接可见**的正文段落；
3. **不是**取证对象错误——服务的正是 `f0dc41832cd79106`。

**与 captain 静态分析的调和**：`needsClose && !closed` 分支确实只产占位（captain 读码正确）。
泄漏发生在**该分支未被走到**的情形：`fence-fallback` 下 `renderMarkdown` 对正文做**重解析**时，
未闭合的图形块体被当作**普通段落**渲染 → 落 `<p>`。终态（3150ms 后）**会**收敛为可读文案，
故泄漏是**中间态**（`600–3000ms` 窗口，19/40 采样点命中），**终态无泄漏**。

> **对 F-5 严重度的修正建议**：F-5 的实际形态是「**中间态可见泄漏**（终态自愈）」，
> 而非「终态持续泄漏」。这与 V2 §2.2 记录的「28/90 采样点」一致（均为中间态采样）。
> 请 t20 复验时按此口径判定，并注意 t18 的修复目标正是这条 `fence-fallback` 路径。

---

## 8. 未能验证项（不默认通过）

| # | 条目 | 原因 |
|---|---|---|
| 1 | `serviceVersion = 2026-09-10.10` | 被测为自建实例（`verify-local-1`），容器未重建（G-ANCHOR 要求不得以自建实例冒充线上构建号） |
| 2 | 容器内（10800）该修复的实际生效 | 容器为旧构建（无 output-gate 插件），须重建后方可验；本次按要求**未重建** |
| 3 | 配置逐键生效（AS-7） | 仅做默认值核对，未逐键改配置重启验证 |

---

## 9. 复核建议（供 t14 / t15）

1. **t14 请独立核**：本报告 §2.2 的「声明域未放宽」是**符号层**证据，
   建议 t14 按 t13 契约思路直接比对 **契约 §2 的四来源表** vs **`payload()` 实际分支**，
   防止「文档自我认证」；
2. **§4.2 可复现**：`t13-report.mjs` 用 `beginTurn` + 窗口内 `recordReport` 是验证真机终态语义的可靠手法，
   建议 t20 复验时复用；
3. **勿重复修 D-1**：修复已闭环（§2/§3/§4）；特别**不要**把 `blocks[].decision` 也改成 `passed`
   ——两者取值域**本就不同**（`blockResults`=块终态，`decision`=结构性裁决），这是本次修法的要点；
4. **G-FREEZE 仍未满足**：制品在本轮内至少漂移两次（20:29 `fence-machine.ts`、21:48 `engine.ts`），
   建议 t15/t21 判定前先取一次**显式停手确认**并复采基线。

---

# 附：t14 独立核验 — 契约 §2 四来源表 ↔ 实现 `payload()` 分支一致性

> 角色：verifier（**只核验，不改制品**）
> 对象：`docs/output-gate-contract.md` §2（v5，2026-09-10 由 reviewer 改写）vs
> `plugins/output-gate/src/engine.ts` 的 `payload()`（`2da07bdce590e6ad`）
> 方法：**不重跑** t13 的三出口实测；只核**文字与分支的一致性**，并用**判别器**给出读数而非仅声明「已核对」。

**结论：契约与实现——【是】一致（四来源逐条对应、恒等表述与实现一致）；另发现 1 处 low 级文档引用失准（不影响语义）。**

## T14-1 [1] 四来源表 ↔ 实现分支逐条比对

**契约原文**（`output-gate-contract.md:46–53`，表头 + 四行）：

```
#### `blockResults[blockId]` 的四种取值来源（穷举，冻结）
| # | 情形 | 取值 | 说明 |
| 1 | 主机侧结构判定即降级（非法路径／畸形 chart／超限／未闭合等） | `degraded` | 主机侧权威结论 |
| 2 | 真机回传 `outcome: 'degraded'` | `degraded` | 真机判负 |
| 3 | 真机回传 `outcome: 'passed'` | `passed` | 真机判正 |
| 4 | **等待窗口（`gate.answerWaitBudgetMs`）内未收到任何回传** | **`passed`** | … |
```

**实现原文**（`engine.ts:399–408`）：

```ts
const blockResults: Record<string, 'passed' | 'degraded'> = {}
const degradedIds: string[] = []
for (const block of this.blocks) {
  // 单一判据：degradedIds 与 blockResults 必须恒等，不得出现两条分叉判定。
  const outcome: 'passed' | 'degraded' = block.decision === 'degraded'
    ? 'degraded'
    : (block.reported?.outcome === 'degraded' ? 'degraded' : 'passed')
  blockResults[block.blockId] = outcome
  if (outcome === 'degraded') degradedIds.push(block.blockId)
}
```

**逐条对齐**：

| 契约行 | 实现路径 | 判定 |
|---|---|---|
| 1 主机侧即降级 | `block.decision === 'degraded'` → `'degraded'` | ✅ 对应 |
| 2 真机回传 `degraded` | `block.reported?.outcome === 'degraded'` → `'degraded'` | ✅ 对应（备注：`decision==='render'` 时才会走到该三元右侧；`degraded` 块**先**被第 1 条判定，二者不冲突） |
| 3 真机回传 `passed` | `reported.outcome === 'passed'` → 三元落到末位 `'passed'` | ✅ 对应 |
| 4 窗口内未回传 | `reported === undefined` → 同样落到末位 `'passed'` | ✅ 对应 |

- **无遗漏分支**：契约 4 行均能在实现中定位到确定路径；
- **无多余分支**：实现仅 2 处判定（`decision`、`reported?.outcome`），无契约未列的第 5 种结果。
- 补充：**`engine.ts:377–391` 的语义注释**内含与契约**同形的四行表**，二者文字一致（`主机侧结构判定即降级 / 真机回传 degraded / 真机回传 passed / 窗口内未回传`）。

## T14-2 [4] 判别器读数（不重跑 t13；用真实 `OutputGateService` 分别驱动四条输入路径）

```
$ node --import tsx/esm /tmp/cs-verify/t14-branches.mjs
[情形1] decision=["degraded"] blockResults={"blk-b94b9da4-0":"degraded"} → 期望 degraded  ✅
[情形2] applied=true decision=["render"] blockResults={"blk-b94b9da4-0":"degraded"} → 期望 degraded  ✅
[情形3] applied=true decision=["render"] blockResults={"blk-b94b9da4-0":"passed"}   → 期望 passed    ✅
[情形4] decision=["render"] blockResults={"blk-b94b9da4-0":"passed"}                → 期望 passed    ✅

=== 恒等（degradedIds = {id | blockResults[id]===degraded}）===
  1 主机侧即降级:    derived=["blk-b94b9da4-0"] actual=["blk-b94b9da4-0"] → ✅
  2 真机回传 degraded: derived=["blk-b94b9da4-0"] actual=["blk-b94b9da4-0"] → ✅
  3 真机回传 passed:   derived=[]               actual=[]               → ✅
  4 窗口内未回传:      derived=[]               actual=[]               → ✅

契约 4 行 ↔ 实现 4 条输入路径： ✅ 四条均可驱动且取值符合契约
```

**这是「判别器」而非「声明」**：四条路径分别构造了**不同的输入**（非法路径／回传 degraded／回传 passed／完全不回传），
若实现把第 3、4 行混为一谈或把第 2 行错并到第 1 行，上表必有一行取值偏离。四行全中 → 分支与契约一致。

> 情形 2/3 的 `applied=true` 证明回传**真正生效**（未落入 F-6 取证时我遇到的 `applied:false` 时序陷阱）。

## T14-3 [2] 「`passed` ≠ 真机已验证」表述与误导措辞排查

**表述存在**（`output-gate-contract.md:59–64`）：

```
> ### ⚠️ `passed` **不等于**「真机已验证」
> `passed` 只声明一件事：**该块对访客保持可见 / 未被判负**。它**不**声明真机对它做过验证——
> 第 4 种情形（未回传）就没有任何真机结论，但仍记 `passed`。
> **真机验证证据的归属地是留痕，不是 `blockResults`**：留痕字段 `outcome ∈ passed|degraded`（O2）才承载真机结论；
> 未回传的块在留痕侧**没有** `outcome` 记录。任何"`blockResults[id] === 'passed'` ⇒ 真机已验证"的推断**均为误读**。
```

**逐处 grep**（契约全文含 `passed` 的行，共 16 处；逐处判定）：

```
$ grep -n "passed" docs/output-gate-contract.md
43  §2 字段表：`passed` = 保持可见（语义正确）
52  四来源表第 3 行：真机回传 passed → passed（**限定为该来源**，非泛指）
53  四来源表第 4 行：未回传 → passed（**限定为该来源**）
55/57 第 4 行取 passed 的理由（行为正确性论证）
59/61/62/63/64 「passed ≠ 真机已验证」显式声明（否定式，**正确**）
67 取值域不可互换（D-1 修复口径）
71/72 前端只判否定条件、passed 落到默认路径
247/300 REP5「已上屏永不回改」用 passed/degraded 指终态（与 §2 一致）
263/275 留痕字段 outcome ∈ passed|degraded（**真机证据归属地**，正确）
370 §13 修订记录：引用**被纠正的旧措辞**
```

**自动分类 + 人工判读（对我的分类脚本结果逐条落判，避免"脚本说通过"式空洞结论）**：

```
行 52   [② 限定该来源（正确）]            → 该行说的是"真机回传 passed 时取 passed"，不是泛指
行 63   [需人工判读] → 判读结果：该行断言"真机结论只由 O2 留痕承载"，是**强化**否定式，非误导
行 370  [③ 修订记录（引号内旧措辞）]      → §13 变更记录，引号内明确标为"被纠正的旧措辞"
反向核验：`grep -nE "passed.*(=|⇒|即|就是).*真机|真机.*(=|⇒).*passed"`（排除 不等于/误读/修订）
  → ✅ 无泛指句
```

**判定**：
- **不存在**暗示「`passed` 蕴含真机已验证」的**有效**语句。
- 唯一同现「真机通过后记 `passed`」字样的位置是 **`docs/output-gate-contract.md:370`（§13 修订记录）**，
  且处于**引号内、作为被纠正的旧措辞**出现（「语义由"块终态（真机通过后记 `passed`）"改为**门禁放行终态**」）。
  **属变更记录的正确写法，不构成误导** → 判 **通过**，仅作为下文 T14-4 的说明项记录。
- `grep -rn "真机通过后记" docs/` 仅命中该 1 处（修订记录），其余文档无残留。

## T14-4 [3] `degradedIds` 同判据恒等表述

**契约**（`:44`）：`degradedIds = { id | blockResults[id] === 'degraded' }（不得出现第二条分叉判据）`
**实现**（`engine.ts:406–407`）：`if (outcome === 'degraded') degradedIds.push(block.blockId)`
—— `outcome` 即写入 `blockResults` 的**同一个局部变量**，故恒等由构造保证（非两处独立判定）。
**判别器读数见 T14-2 末表**：4 种情形下 `derived == actual` 全部成立（含非空集情形 1/2）。→ **一致**。

## T14-5 发现的 1 处不一致（**文档错**，low）

| id | 严重度 | 问题 | 建议修复 |
|---|---|---|---|
| T14-5 | **low** | 契约两处引用 `web/guest/index.html` 的 **`applyBlockResults`**（`:56`、`:70`），但该符号**在全仓不存在**：`grep -rn "applyBlockResults" web/ plugins/ docs/` 仅命中契约自身这 2 行。真正消费 `blockResults` 的函数是 **`adoptDoneBlocks(data)`**（`index.html:1120` 定义，`:1121` 处 `const results = data.blockResults && …`）；另 `send()` 内 `:2529` 有注释提及同一权威终态。 | 把 `:56`/`:70` 的 `applyBlockResults` 改为 **`adoptDoneBlocks`**（或改为不指名的措辞：「访客端按 `degradedIds`/`blockResults[id]==='degraded'` 判定」）。**语义结论不受影响**（实测前端确实只判否定条件，见 `output-gate.js:301`），故 low。 |

**判定归属：契约错，实现无错。** 该处为**引用失准**（指名了一个不存在的符号），会误导后人按错误符号检索。

## T14-6 证据层级与未验证项

| 结论 | 证据层级 |
|---|---|
| 四来源逐条对应 | **制品指纹 + 行为序列**（`payload()` 原文 + 真实 `OutputGateService` 判别器读数） |
| `passed` 不蕴含真机已验证 | **措辞层**（契约文字）+ **制品层**（`engine.ts` 注释与实现一致）；按 G-ANCHOR 未以措辞支撑行为结论 |
| 恒等 | **行为序列**（T14-2 判别器，含非空集） |
| `applyBlockResults` 不存在 | **符号存在**（grep 层，用于证明「引用失准」这一符号性事实，恰当） |

**未能验证**：契约 §2 声称的「前端消费路径**已核、实测**」——我复核了 `output-gate.js:298–306`（只判 `=== 'degraded'`）
与 `index.html:1121`（`blockResults` 取值后按 `=== 'degraded'` 分流），**代码层与其一致**；
但我**未**为「`passed` 落到默认渲染路径」单造一条真机端到端用例（t13 §4.1 的真机 DOM 用例已覆盖
「正常块 `passed` → 访客可见」，可视为间接支持）。按纪律如实标注，不默认通过。

**未改任何制品**：本节仅追加报告文字；`engine.ts`/`contract.md` 均未改动。
