# 输出前自审门禁 — 主机侧契约（口径 B）

> 版本：**v6**｜日期：2026-09-10｜判据基线：`customer-service/docs/output-self-review-requirements.md`（**v3.2.4 冻结版**）
> 实现：`customer-service/plugins/output-gate/`（主机侧）+ `customer-service/plugins/guest-server/`（三条出口收口）
> 读者：访客前端（`customer-service/web/guest/**`，I2）、验证与验收（verifier / reviewer）

本文只描述**已经实现并实测通过**的线协议与判定口径。条款编号沿用需求 **v3.2.4**（`E/P/C/SRC/IMG/REP/D/V/O/G/T/REG/Q` 系列）。

> **版本沿革（避免误用旧基线）**：本文 v2 曾以「需求 v2」为基线，包含**定向重写（RH 系列）**与
> `gate.rewrite.*` 配置键。需求 v3.2 已**删除定向重写**（REP1）、v3.2.3 已把**配置面冻结为 8 键**、
> v3.2.4 重录了 G-FREEZE 基线。本文 v3 按 v3.2.4 全面对齐；**`RH` 前缀与 `rewrite.*` 键不再有效**。

## 1. 一句话契约

主机侧在访客桥的每个出口上强制运行围栏状态机：受控图形围栏（` ```mermaid `/` ```chart `/
` ```image `/` ```img `/` ```html `）从文字流里被摘出，作为结构化块下发，**围栏分隔符与块体
源码明文不出现在任何访客载荷里**（含 SSE `delta` 与 `done`）。块源码以 **base64** 承载
（`sourceB64`），访客端解码后交给真机渲染器裁决。因此「绝不把原始围栏源码交给访客」由主机侧
保证，不依赖提示词，也不依赖访客端自觉（E2/E7）。

## 2. 出口清单与统一终态（E1/E3/E4）

三个出口共用同一净化实现（`OutputGateService.gateReply` / `beginTurn`）：

| 出口 | 终态形态 |
|---|---|
| `POST /api/guest/chat` | `{ reply, sources, blocks, blockResults, degradedIds, gate }` |
| `POST /api/guest/chat/stream` | SSE：`meta` → N×( `delta` \| `block-open` \| `block` ) → `done` |
| `GET /api/guest/history` | `{ sessionId, messages: [{ role, text, blocks?, blockResults?, degradedIds? }] }` |

`done` 与 `/chat` 的载荷字段逐字同形；`history` 的 assistant 消息带同样的三个附加字段。
同一份回答在三条出口的 `blocks`/`blockResults`/`degradedIds` 完全一致（实测见
`tests/http-exits-check.mjs` 的「三出口终态一致」用例）。

### ⚠️ `blocks[].decision` 与 `blockResults[id]` **语义不同，取值域也不同**（v3.2.12 澄清）

两者**极易被当成同一件事**（V3 由此报出 D-1：实现用 `decision` 的取值填 `blockResults`，`tsc --strict` 报 TS2322）。
此处冻结区分：

| 字段 | 取值域 | 语义 | 是终态吗 |
|---|---|---|---|
| `blocks[].decision` | `'render'` \| `'degraded'` | **主机侧判定**：`render` = 源码交真机裁决（**中间态**）；`degraded` = 主机侧已定降级（终态） | 否（`render` 是中间态） |
| `blockResults[blockId]` | `'passed'` \| `'degraded'` | **门禁放行终态**：该块对访客的**最终可见性裁定**。`passed` = 保持可见；`degraded` = 已替换为可读替代。**取值有四种来源，见下表** | **是** |
| `degradedIds[]` | 块 id 数组 | 与 `blockResults` **同判据恒等**：`degradedIds = { id \| blockResults[id] === 'degraded' }`（不得出现第二条分叉判据） | 是 |

#### `blockResults[blockId]` 的四种取值来源（穷举，冻结）

| # | 情形 | 取值 | 说明 |
|---|---|---|---|
| 1 | 主机侧结构判定即降级（非法路径／畸形 chart／超限／未闭合等） | `degraded` | 主机侧权威结论 |
| 2 | 真机回传 `outcome: 'degraded'` | `degraded` | 真机判负 |
| 3 | 真机回传 `outcome: 'passed'` | `passed` | 真机判正 |
| 4 | **等待窗口（`gate.answerWaitBudgetMs`）内未收到任何回传** | **`passed`** | 窗口耗尽后一次性定稿；块**在访客侧已经渲染并可读**，故按"保持可见"收尾 |

第 4 种情形为何**只能**取 `passed`（而非 `degraded`）：定稿发生在 `awaitReports` 之后、`payload()` 一次性产出；
此时该块**已经被访客看到且可读**。若记为 `degraded`，`/history` 回放时访客端的终态采纳逻辑（`adoptDoneBlocks`）会把这个
**当时正常显示**的块重新剥离，**与访客实际所见不一致**。故 `passed` 是行为正确解。

> ### ⚠️ `passed` **不等于**「真机已验证」
>
> `passed` 只声明一件事：**该块对访客保持可见 / 未被判负**。它**不**声明真机对它做过验证——
> 第 4 种情形（未回传）就没有任何真机结论，但仍记 `passed`。
> **真机验证证据的归属地是留痕，不是 `blockResults`**：留痕字段 `outcome ∈ passed|degraded`（O2）才承载真机结论；
> 未回传的块在留痕侧**没有** `outcome` 记录。任何"`blockResults[id] === 'passed'` ⇒ 真机已验证"的推断**均为误读**。

**判定规则（一句话）**：`decision` 回答"这块交给谁定"，`blockResults` 回答"这块**最后对访客可见吗**"。
**两个字段的取值域不可互换**（这正是 D-1 的修复口径：按接口声明填 `passed|degraded`，不得直接透传 `decision`）。

**前端消费路径与兼容性（已核，实测）**：访客端**只判否定条件**——
`degradedIds.includes(blockId)` 或 `blockResults[blockId] === 'degraded'`
（真实消费点：`web/guest/index.html` 的 `adoptDoneBlocks()`，由 `done` 分支调用；
等价判据亦见 `web/guest/assets/output-gate.js` 的 `planBlocks` 内 `verdict === 'degraded'` 分支），
对 `'passed'` **不做等值判断**、仅作为"非降级"落到默认渲染路径 ——
**这正是 `blockResults` 取 `'passed'` 不破坏既有行为的依据**（前端**只判否定条件**，从不判 `=== 'passed'`）。
因此：`blockResults` 取值为 `'passed'`（**放行终态语义**，含未回传情形）时**不破坏任何既有行为**；
但若误填成 `'render'`，前端虽仍走默认路径，**契约语义已被破坏**（且 `tsc --strict` 会拒绝），故仍须按声明修正。

**刷新不会重新暴露源码**（E4）：`history` 从会话日志读到的是模型原文（可能含围栏），
服务端**重新过一遍同一门禁**再回放，因此与当轮终态一致。

## 3. 结构化块载荷

```jsonc
{
  "blockId": "blk-17e8d9bc-0",   // 会话内唯一，回传幂等键的一部分
  "blockType": "mermaid",         // mermaid | chart | image | html（img 已归一化）
  "sourceBytes": 20,              // 块体 UTF-8 字节数
  "decision": "render",           // render = 交真机裁决；degraded = 主机侧已定降级
  "sourceB64": "Zmxvd2NoYXJ0IFRECiBBLS0+Qgo=",  // 仅 decision=render 时存在
  "reason": "chart-invalid",      // 仅 decision=degraded 时存在（O2 枚举）
  "imagePath": "/uploads/banner_cs_9af26b7f16.png",  // 图片块：已过白名单 + IMG6 归一化的**站点相对路径**
  "imageCaption": "账单示意"       // 图片块说明
}
```

- `decision: 'degraded'` 的块**不带 `sourceB64`**：主机侧已确定它不可显示（D2：不留未通过校验的内容）。
- `decision: 'render'` 的块源码只在 `sourceB64` 里；访客端须**把 base64 解码为 UTF-8 文本**后渲染。
  ⚠️ **不要直接用 `atob`**：`atob` 返回 **latin1** 字节串，含中文/多字节字符的块体（如 `A[停电]`）
  会被损坏。请按「base64 → 字节 → UTF-8」解码（零依赖手写实现即可）。**本契约不限定实现方式，只约束结果**：
  解码结果须与主机侧 `sourceBytes` 声明的 UTF-8 字节数一致，且多字节内容往返无损。
- `block-open` 事件只含 `{ blockId, blockType }`，用于在块尚未闭合时先渲染 `data-block-state="pending"` 占位
  （P4：pending 期间块内容不得进入 DOM）。

### SSE 事件序列

```
event: meta          data: { sessionId, version, gate }
event: notice        data: { text }                       // 限流提醒（可选）
event: delta         data: { text }                       // 正文，逐帧（不含任何图形源码）
event: block-open    data: { blockId, blockType }          // 起始围栏已确认
event: block         data: { ...BlockPayload }             // 块闭合：裁决结论 + 源码承载
event: done          data: { reply, sources, blocks, blockResults, degradedIds, gate }
```

每个块**最多一个** `block` 事件（v3.2 无 `block-replace`）。

`gate` 字段（`meta` 与 `done` 都带，单点可调）：

```jsonc
{ "blockTimeoutMs": 1500, "answerWaitBudgetMs": 600, "libraryLoadTimeoutMs": 8000,
  "maxBlockBytes": 32768, "reportPath": "/api/guest/render-report", "reasons": [ /* O2 枚举 */ ] }
```

## 3.5 图片地址：白名单、归一化与两条通道（IMG1–IMG8）

### 两类判定**不可混为一谈**（captain 裁决，v3.2 / CF-2）

| 判定 | 性质 | 处置 |
|---|---|---|
| **IMG1 路径白名单**（+ IMG6 归一化、C5 归属） | **确定性、无网络依赖** | ✅ **硬门禁**：主机侧在载荷里拦截，非法即 `degraded` 且不下发 `imagePath`；前端零出站请求 |
| **C6 可达性探测**（同源 `HEAD`） | **依赖源站与 nginx 缓存状态** | ⚠️ **仅留痕**（O2 `reason=image-unreachable`），**不参与放行**、不进载荷 |

**C6 不得参与放行的依据**：`deploy/nginx.conf:53` 有 `proxy_cache_valid 404 10m` —— 源站**瞬时** 404 会被
缓存 10 分钟，期间**所有**引用该图的回答都会被降级。这是「缓存状态决定内容」的不可预测漂移，不属于
「确定性否证」；可达性只有真机能裁决（C4 `decode()` + `naturalWidth`），与 C0/C7 单一事实源一致。

### 图片块下发时机（E5 / T4）

图片块**不做可达性等待**：路径判定完成后**随流同步下发** `block` 事件；探测只是**事后异步旁路**——
即使探测挂起或失败，也不推迟 `block` 下发与 `delta` 帧间隔。载荷里**没有**任何「未决」字段。

---

**主机侧唯一的图片判定是「路径合法性」（IMG1 + C5）**，确定性、无网络依赖：

```
^/uploads/[A-Za-z0-9_.-]+\.(png|jpe?g|gif|webp|avif|svg|bmp)$     （大小写不敏感）
```

拒绝：`..` / 嵌套目录 / 查询串（`?`、`#`）/ 绝对 URL（除下方 IMG6 归一化）/ 协议相对 `//host/…` /
其它协议 / `data:` / 行内空白与换行 / 任何百分号编码（`%2e`、`%2f` 可伪装 `..` 与 `/`）。
扩展名白名单依据 KB 实测在用集合（jpg/JPG/png/jpeg/svg + 常见格式）；`pdf`/`zip`/`docx` 虽在 KB
但**不是图片，不得入白名单**。

### IMG6：自家源站绝对 URL **必须先归一化再校验**（不得一刀切拒绝）

KB 实测存在绝对 URL 配图（`deploy/kb/car-model.md:4724`、`car-model.md:4979`、`ev-tip.md:917`、
`ev-tip.md:931`，均为 `https://www.cem-macau.com/uploads/image_3f5b3a38a0.png`）。按字面「禁绝对 URL」
会**误杀合法既有配图**，因此冻结为：

1. **先归一化**：仅接受**精确主机** `www.cem-macau.com` / `cem-macau.com` 且路径形如
   `/uploads/<文件名>` 的绝对 URL，归一化为 `/uploads/<文件名>`；
2. **再走白名单**：判定对象始终是归一化后的站点相对路径；
3. 其余任何主机一律拒绝——`https://evil.example.com/uploads/a.png` 不因「长得像自家」而放行。

实现：`normalizeSelfSiteUrl()` → `checkImagePath()`（`src/block-rules.ts`，单一实现，前端须同一语义）。

### IMG3：下发路径必须同源化

载荷里的 `imagePath` **一律是站点相对路径**（`/uploads/<文件名>`），绝不能是绝对 URL——否则访客端会
向外部主机发请求（泄漏 IP/UA）。实现上 `imageSrcPath()` 返回的就是归一化后的路径；访客端拼
`${API_BASE}/uploads/…`。

### 两条图片通道（IMG2）与主机侧口径

| 通道 | 形态 | 主机侧口径 |
|---|---|---|
| A：围栏块 | ` ```image ` 围栏 | **归主机侧**：摘成结构化块，路径过 IMG1+IMG6；非法即 `degraded`/`image-path-invalid`，**不下发 `imagePath`** |
| B：行内 Markdown | 正文里的 `![alt](url)` | **不归主机侧**：行内图片不是围栏块，主机侧**不额外解析**。它的拒绝由**访客端 `inlineMd`** 执行，且必须调用**同一个**白名单判定函数（单一实现），非法路径**零出站请求** |

**口径一致性要求**：通道 A 的载荷路径已由主机侧校验并归一化；通道 B 由访客端用同一规则自行判定。
两条通道**不得出现「围栏图被校验、行内图绕过」的漏洞**：前端必须复用同一 `checkImagePath`
（`web/guest/assets/output-gate.js` 已导出），而不是各写一份正则。

**html 围栏内的图片（IMG7）**：`img-src` 收紧为 `'self' data:`，外部主机图片由 CSP 阻断——属于访客端
沙箱配置，主机侧不参与。

## 4. 判定分层（C0/C7：单一事实源）

| 判据 | 归属 | 主机侧行为 |
|---|---|---|
| 图片地址白名单（IMG1） | **主机侧确定性**（与访客端逐字同构） | 非法即 `degraded`，不下发 `imagePath` |
| chart 数据结构（C3） | **主机侧确定性** | 非法即 `degraded`/`chart-invalid` |
| html 非空 + ≤ `maxBlockBytes`（C4） | **主机侧确定性** | 超限即 `degraded`/`html-invalid` |
| 空块、流中止未闭合（P6/P8） | **主机侧结构性** | 即 `degraded` |
| mermaid 语法与几何（C1/C5） | **真机** | 只判空块；非空一律 `render`，等真机结论 |
| 图片自然尺寸（C2） | **真机** | 不判；`imagePath` 直接下发 |
| html 渲染高度（C3） | **真机** | 不判 |
| 图片**可达性**（C6） | 服务端探测 | **只写留痕**，不参与放行（v3.2）；超时/5xx/重定向一律不拒 |

### chart 的判定边界：只判**结构**，不判**语义**（C7）

`checkChartData` 只做**数据结构**检查，与 C7「服务端不做 chart 语义解析」不冲突：

| 判（结构） | 不判（语义） |
|---|---|
| `JSON.parse` 是否成功 | 数值是否"合理"（业务上界、单位、量级、趋势） |
| 顶层是否为**非空数组** | 数组项数是否符合业务预期 |
| 每项是否有非空 `label`\|`name` 字符串 | 标签文案是否与知识库一致 |
| 每项 `value`\|`count` 是否为 `Number.isFinite` 且 ≥ 0 | 数据是否与图表类型匹配、是否该用别的图形 |

即：**凡是需要"理解业务含义"才能下的结论，一律交真机与人工，主机侧不判**。同样的边界适用于
`html`（只判非空与字节上限，不解析 DOM 语义）与 `mermaid`（只判空块，不解析语法与几何）。

---

主机侧**不做**几何校验、**不调用** `mermaid.render()`、**不依赖** jsdom（C7 实测：jsdom 下
`render()` 必然抛 `getBBox is not a function`，用它当判据只会误拒真机能显示的块）。

**图片可达性探测**（`gate.serverImageProbe`）：主机侧可选地对 `imagePath` 做一次 `HEAD` 探测，
结论**只写留痕**（`reason=image-unreachable`）。它不参与任何放行分支；开关关闭、探测超时或
网络不通都只是跳过该项（C6/C8）。

> **v3.2 裁决（CF-2）**：C6 明确为「仅留痕」。可达性判定依赖网络与缓存状态（`deploy/nginx.conf:53`
> 的 `proxy_cache_valid 404 10m` 会把源站瞬时 404 缓存 10 分钟，期间所有引用该图的回答都会被
> 误降级），因此它**不属于**「确定性否证」，不得参与放行。硬门禁只有一条：**IMG1 路径白名单**
> （确定性正则、无网络依赖）。两者不可混为一谈。

## 5. 识别口径（P1/P2，比 CommonMark 更保守）

只要出现「≥3 个同类围栏字符 + 首个词是受控关键字」即按受控块处理，**不要求行首**——
"行首才算是围栏"的宽松口径正好会给源码漏出留门（`curl` 载荷里就会出现 ` ```mermaid `）。
代价：极少数把 ` ```mermaid ` 当字面量提到的句子会被摘成块并降级，按 D2「宁可放弃图形内容、
绝不回退为源码展示」处理。

- 普通代码块（` ```python ` 等）**保持现状**：整块原文照旧透传（N2③）。但其中出现的图形围栏
  仍会被摘出——否则该出口的原始报文就会命中 ` ```mermaid `（E7）。
- 未闭合围栏（含流尾半截 info 如 `"```mer"`）整段扣留，以 `degraded` 收尾。

## 6. 输出前替换与终态（REP1–REP5，v3.2）

- **不做事后重写（REP1，冻结）**：门禁**不调用模型**、不二次生成、不重新提问、不回改已进入
  访客 DOM 的内容。因此配置里没有任何 `rewrite.*` 键，留痕里也没有 `rewritten` 状态。
  （v2 的 RH1–RH7「定向重写」已随 v3.2 删除。）
- **替换时机（REP2）**：未通过的块**尚未上屏**（处于占位态），直接替换为可读等价文字后才输出
  ——「改完才给用户看」，而不是「先给用户看再去改」。
- **替换内容（REP3）**：① 有语义等价正文时保留正文、只去图形；② 无等价正文时按类型给 i18n
  降级文案（D3）；③ 连文案都写不出（极端）→ 丢弃该块、保留前后文字，整条回答仍可用。
- **终态唯一性（REP4）**：`degraded` 是终态，不重试、不递归、不影响 `done`。
- **已上屏永不回改（REP5）**：块进入 `passed`/`degraded` 后，DOM 不再被门禁改写。

**预算语义（P7 v3.2：并行，非串行总配额）**：各块判定**并行**推进、互不串行占用预算；多块
回答不得因「预算被前一块吃掉」而降级。`gate.blockTimeoutMs`（1500ms）是**单块**判定上限；
`gate.answerWaitBudgetMs`（600ms）重新定义为**「`done` 前结算的收尾窗口」**——到点仍未结算的块
按降级终态收尾，**不得阻塞 `done`**（T1：门禁不得推迟 `done` 超过 600ms）。

## 7. 真机回传端点（O3）

```
POST /api/guest/render-report
{ sessionId, blockId, blockType, reason, sourceDigest, sourceBytes, occurredAt, outcome }
→ 202 { ok: true, applied: boolean } | 400 { error }
```

- body ≤ 8KB；`blockType` ∈ 四类；`reason` 必须命中白名单（O2 枚举 + 访客端同构细分
  `image-path-invalid`、`library-unavailable`）；`outcome` ∈ `passed|degraded`。
- 服务端**只记录、不做放行决策**（C0）；回传失败不得影响访客（前端 fire-and-forget 吞异常）。
- `applied=false` 表示该轮已结束或回传重复——仍然会写留痕（便于聚合）。回传**永不引发内容变更**
  （REP1）：它是统计信号，不是修复指令。

## 8. 留痕（O1/O2/O4）

主机侧 `guest-server`/`output-gate` 经 `ctx.logger.warn` 输出，统一前缀 `guest.output-gate`，
七字段固定：

```
guest.output-gate sessionId=<id> blockType=<mermaid|chart|image|html> reason=<O2枚举> \
  sourceDigest=<sha256 前16位> sourceBytes=<n> occurredAt=<epochMs> outcome=<passed|degraded>
```

服务端 `sourceDigest` 是 **sha256 前 16 位**（可复算）；访客端 `output-gate.js` 的 `shortDigest` 是
**FNV-1a 双种子**（浏览器无法引第三方哈希库，且该摘要不承担完整性证明）。

> **前后端摘要算法不同是已裁决接受的**（captain 裁决）：两者**只用于各自的去重与聚合**，
> **不跨端比对**。因此不要用访客端回传的 `sourceDigest` 去校验服务端算出的摘要是否一致——
> 服务端侧的聚合键统一用 sha256，访客端侧的去重键用它的本地摘要。

## 9. 给访客端（I2）的对接要点

1. `delta` 帧仍是正文（受控块已摘除）；直接按现有流式渲染上屏即可，**不需要**再解析围栏。
2. 收到 `block-open` → 立刻渲染 `data-block-state="pending"` 占位（文案走 i18n `gatePreparing`）。
3. 收到 `block`：
   - `decision: 'degraded'` → 渲染可读替代（按 `blockType` 选 D3 的 i18n 键），**不得**回退为源码。
   - `decision: 'render'` → 把 `sourceB64` 解码为 **UTF-8 文本**（**不要用 `atob`**，它返回 latin1，会损坏含中文的块体；按 base64→字节→UTF-8 解码），再交给真机校验与渲染（mermaid 渲染、chart 判定、
     图片 `decode()`、html 沙箱），通过则替换占位；失败则降级 + 回传。
4. `done` 帧带完整答案与全部块，是定稿依据：未收到 `block` 的块也必须在 `done` 时定稿（P6 终态唯一性）。
   `done.gate` 覆盖页面默认预算。
5. 回传只送 `{blockId, blockType, reason, sourceDigest, sourceBytes, occurredAt, outcome}`，
   **不含源码**；摘要算 `output-gate.js` 的 `shortDigest`（服务端只用于聚合，不比对本字段与服务端 sha256）。
6. 图片块优先用 `imagePath`（主机侧已过 IMG1 白名单，且已完成 IMG6 归一化）；`sourceB64` 仅用于
   `mermaid`/`chart`/`html`。
7. **没有 `block-replace` 事件**（v3.2 删除事后重写）：每个块最多一个 `block` 事件；`done` 即终态。
   已 `passed`/`degraded` 的块不再变化（REP4/REP5）。
8. **渲染期计时口径全部由 `meta.gate` / `done.gate` 下发**（`applyGateConfig` 逐键采纳，缺项才用页面默认值）：

   | 字段 | 下发来源 | 语义 | 游客端默认（服务端不下发时） |
   |---|---|---|---|
   | `blockTimeoutMs` | `gateConfigPayload()` | 单块 `validating` 判定上限 | `1500` |
   | `answerWaitBudgetMs` | `gateConfigPayload()` | `done` 前结算的**收尾窗口**（并行语义，非串行总配额） | `600` |
   | `libraryLoadTimeoutMs` | `gateConfigPayload()` | 渲染器（mermaid 库）就绪上限，**不计入判定计时**（P5） | `8000` |
   | `maxBlockBytes` | `gateConfigPayload()` | 单块字节上限 | `32768` |
   | `reportPath` | `gateConfigPayload()` | 回传端点路径 | `/api/guest/render-report` |
   | `reasons` | `gateConfigPayload()` | 回传原因白名单（O2 枚举），前端据此裁剪 | — |

   **四个计时口径互不替代**：`libraryLoadTimeoutMs` 只控制"等库就绪"这一段，**不占用** `blockTimeoutMs`；
   否则首次加载 3.4MB 的 mermaid 资产时，首图必然被判超时而误降级（P5 的分离理由）。
   该字段**确实存在于 `GateConfigPayload` 并经三条出口的 `meta`/`done` 下发**（`gateConfigPayload()` 单一实现），
   前端 `applyGateConfig` 已逐键消费——**不需要**依赖前端兜底默认值。

## 10. 配置（G1/G1a，全部走 Schemastery `Config`；与需求 v3.2.4 §13 **逐字对齐为 8 键**）

> **配置面无 `rewrite.*`**（REP1，v3.2 已删定向重写）。下表 8 键即**全部**可调项；其中 `blockTimeoutMs`/`answerWaitBudgetMs`/`libraryLoadTimeoutMs`/`maxBlockBytes`/`reportPath` 经 `gateConfigPayload()` **下发访客端**（见 §9.8），`enabled`/`serverImageProbe`/`serverImageProbeTimeoutMs` 为**主机侧内部**开关、不下发。

| 键 | 默认值 | 说明 |
|---|---|---|
| `gate.enabled` | `true` | 总开关；`false` 时三出口行为等同改造前（回滚用） |
| `gate.blockTimeoutMs` | `1500` | 单块 `validating` 判定超时（captain 冻结） |
| `gate.answerWaitBudgetMs` | `600` | `done` 前结算的收尾窗口（P7 并行语义） |
| `gate.libraryLoadTimeoutMs` | `8000` | 渲染器（mermaid 库）就绪上限；与判定计时**分离**，否则首图必被误降级 |
| `gate.maxBlockBytes` | `32768` | 单块字节上限，超出直接降级 |
| `gate.serverImageProbe` | `true` | 图片可达性探测开关；结论**仅留痕**（C6） |
| `gate.serverImageProbeTimeoutMs` | `2000` | 探测超时；超时不拒绝 |
| `gate.reportPath` | `/api/guest/render-report` | 真机回传端点路径 |

**不存在 `rewrite.*`**（REP1）。安全不变量（IMG1 正则、沙箱属性）固定，不进 Config。

**关于 §13 表里的 `gate.jsdomPrecheck`**：本实现**不提供**该键，理由是条款之间的约束关系——
C7 把 jsdom 预检定义为「**可选**、默认关闭、结论**不得用于拒绝**」，而 G1「**未在验收用例中被使用的键
不得保留**」与 Q5「不留未使用抽象」要求删除它；AS-7 的逐键覆盖清单里也没有它。不实现（而不是实现一个
永远不该开的开关）是 C7 的最强合规形态：**服务端完全没有 jsdom 依赖，也就不存在"用错判据"的可能**。
若部署方要求保留该键，请同时把覆盖用例补进 AS-7，再通知本插件加回。
组合层（`customer-service/deploy/profile/cordis.patch.yml`）已显式写出全部键。
**行序有意义**：`output-gate` 必须排在 `guest-server` 之前——`guest-server` 用
`ctx.get('outputGate')` 取门禁服务；门禁缺失时它只发一条主机侧警告并降级为「不净化」（组合配置错误可见）。

## 11. 验证入口

```sh
# 纯逻辑砖块 + 门禁引擎（含 REP/GEN/AS-11 分帧；断言数以脚本实际输出为准）
node --import tsx/esm customer-service/plugins/output-gate/tests/gate-check.mjs
# 真实 HTTP 三出口载荷取证（/chat、/chat/stream、/history、render-report、留痕、REP/O3）
node --import tsx/esm customer-service/plugins/output-gate/tests/http-exits-check.mjs
```

两份脚本覆盖：跨分帧围栏识别（AS-11：1 字符/帧 + 随机切片 + 多块同帧）、未闭合围栏、四类围栏判定
与降级、图片白名单（IMG1/IMG6/IMG8 全矩阵）、探测仅留痕、无几何校验、**输出前替换（REP1–REP5：
无模型调用、无 rewritten、终态不可改写）**、并行预算（P7：多块不互占预算）、留痕七字段与聚合、
三出口一致、GEN1/GEN2/GEN4 契约、插件形态与配置可覆盖、注册可回滚。访客端 DOM 侧取证（V1–V5、P3–P6）由 I2 的 `web/guest/tests/output-gate-check.mjs`
与真机采样负责。

## 12. 明确的非目标

- 服务端不解析 mermaid/chart 语义、不做几何校验（N2①、C7）。
- 不改普通代码块的展示行为（N2③）。
- **不做事后重写（N2①/REP1）**：门禁不调用模型、不回改已上屏内容。
- 不引入任何新依赖（T5/Q3）：只用 Node 内建。
- 不改 Admin（官方 GUI）链路（N1）。

## 13. 修订记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v6 | 2026-09-10 | **修正指名错误（T14-5）**：§2 曾两处指名 `applyBlockResults`，而该符号在实现中**不存在** （全仓检索仅文档自身命中） ⇒ 改为真实消费点 **`adoptDoneBlocks()`**（`web/guest/index.html`）与等价判据 `output-gate.js` 的 `verdict === "degraded"` 分支；并补明「前端**只判否定条件**」是 `passed` 不破坏行为的依据。**文档错、实现无错**。 |
| v5 | 2026-09-10 | **§2 补齐 `blockResults` 第四种来源并纠正误导措辞**：语义由"块终态（真机通过后记 `passed`）"改为**门禁放行终态**并**穷举四种来源**（主机侧降级／真机 `degraded`／真机 `passed`／**等待窗口内未回传 → `passed`**）；新增**「`passed` ≠ 真机已验证」**显式声明（真机证据归属留痕 O2）；`degradedIds[]` 改为与 `blockResults` **同判据恒等**。 |
| v4 | 2026-09-10 | **§2 字段语义澄清**：明确 `blocks[].decision`（主机侧判定，`render` 为中间态）与 `blockResults[id]`（块**终态**，`passed|degraded`）取值域与语义**不同、不可互换**；给出 D-1 的修复口径；并记录前端消费路径的**兼容性实测**（前端只判 `=== 'degraded'`，故 `passed` 不破坏行为）。 |
| v3 | 2026-09-10 | 按需求 v3.2.4 全面对齐（D-1）：删重写相关、`blockTimeoutMs` 200→1500、配置键对齐 8 键、补 `libraryLoadTimeoutMs` 下发说明、`atob` 措辞改为不限实现方式、去掉硬编码断言计数。 |
| v2 | 2026-09-10 | 初版（以需求 v2 为基线，含 RH 系列与 `gate.rewrite.*`）——**已失效**，见 v3 的版本沿革说明。 |
