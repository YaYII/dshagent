# 输出前自审门禁 — V8 复验报告（t26：`NO_GATE` 降级实现修复闭环）

> 角色：verifier（对抗验证者，**只写本报告路径，未修改任何实现代码**）
> 日期：2026-09-11
> 承接任务：**t26「V8 复验 NO_GATE 修复（t25）」**
> 前序报告：V1（`-verification.md`）、V2（`-v2.md`）、V4/V5（`-v3.md`）、V6（`-v4.md`）、V7（`-v5.md`）——**均未改动**

**总判定：✅ `NO_GATE` 修复真闭环——9 项验收逐条通过。**

---

## 0. 被测版本判别器（按契约硬性要求）

### 0.1 残余符号与活路径

```
残余符号（期望 0）:
  scanGates                          → 0
  matchFenceOpen|matchFenceClose|FENCE_LANGS → 0
  '五类围栏识别'（中间态特征串）        → 0

活路径（不应为 0）:
  blockSourcePolicy                  → 3
  gateBlockHtml                      → 2
  chooseBlockSource                  → 7
协议标记 block-open                  → 6
```

### 0.2 关键文件 sha256（前 16）+ 字节 + 时点

| 文件 | sha256 前16 | 字节 | mtime | 归属任务 |
|---|---|---|---|---|
| `web/guest/index.html` | `e8fce50f84a5795f` | 136597 | 01:22:16 | **t25（`NO_GATE` 修复）** |
| `web/guest/assets/output-gate.js` | `11ebac8964857f0a` | 31718 | 20:18:34 | — |
| `web/guest/tests/output-gate-check.mjs` | `57401a609aa84eb9` | 52464 | 00:28:23 | t25 |
| `web/guest/tests/gate-dom-check.mjs` | `789eaf2063f2b5f8` | 63470 | 00:29:33 | — |
| `plugins/output-gate/src/fence-machine.ts` | `b4947a070ab7fca7` | 19386 | 01:23:44 | **t28（注释修正）** |

**被测对象**：`index.html = e8fce50f84a5795f`（t25 修复后的 `NO_GATE` 桩）。

### 0.3 取证窗口起止双采样（按 [8]：判据用「判别器是否变化」，非「sha 必须等于起始值」）

```
窗口起始 == 窗口结束（间隔 20s 双采样，逐字节一致）:
  index.html                e8fce50f84a5795f
  assets/output-gate.js     11ebac8964857f0a
  tests/output-gate-check.mjs 57401a609aa84eb9
  tests/gate-dom-check.mjs  789eaf2063f2b5f8
→ 判别器四项均未变化 ⇒ 本报告全部读数锚定同一制品
```
> 说明：`fence-machine.ts` 在窗口内由 `t28` 修正注释（`3d8a481c` → `b4947a070ab7fca7`，**仅注释**）。
> 按 [8] 口径记录其变化；本任务结论全部落在**前端**，不受该注释影响。

---

## 1. [5][6] 主判据：可见文本 + 等恢复窗口耗尽

**路径：口径 B（主机侧下发 `block` 事件）＋ 门禁资产 404｜证据层级：行为（真实渲染 DOM）**

**手法**：仅 404 `assets/output-gate.js`（其余资产与 API 全真），**等 30s**（契约称恢复窗口约 23s 才显形），再判可见文本。

```
$ xvfb-run -a node /tmp/cs-verify/t26-nogate.mjs
被测 index.html sha16 = e8fce50f84a5795f (136597 B)
__dshGateAssetFailed = true （true = 走了 NO_GATE）

=== 终态（30s，恢复窗口已耗尽）===
  文本: "说明文字。 | 结尾文字。 | The diagram is temporarily unavailable; please refer to the text above. | 📄 page.md"
  DOM 片段: <div class="bubble">
              <p>说明文字。</p><p>结尾文字。</p>
              <div class="gate-blocks">
                <div class="gate-degraded" data-block-state="degraded">The diagram is temporarily unavailable; please refer to the text above.</div>
              </div>
              <div class="sources"><span>📄 page.md</span></div>
            </div>
  转圈残留=false | 块状态=["degraded"] | 含围栏=false 含源码=false pre>code=0
  pageerror/console.error: ["console: Failed to load resource: … 404 (Not Found)"]   ← 仅资产 404 本身，见 [5] 附注
```

**判定**：
- **[5] 通过**：可见文本**不含** `/TypeError|is not a function|出了点问题|Sorry/`；判定在**等满 30s、恢复窗口耗尽后**进行；`pageerror` **为空**，唯一 console.error 是资产自身的 404（附注性质，非页面异常）。
- **[6] 通过**：**文字照常**（`说明文字。` 与 `结尾文字。` 均在 → 证明是"降级"而非"整条失败"）；**图形块降级为可读文案**（`data-block-state="degraded"` + 英文可读文案）；**来源引用保留**（`📄 page.md`）；**无转圈**（`.spinner-sm` 不存在）；**无 pending 残留**；**无源码泄漏**（`pre>code`=0、无围栏、无块体源码）。

> **修复前对照**（我于 V3 §V3-6 实测同一条件）：
> `Sorry, something went wrong: G.normalizeBlockType is not a function` —— **整条回答失败**。
> 本次为**可读降级 + 回答可用**，即该缺陷已闭环。

---

## 2. [3] 4 个崩溃点的行为反证

**手法**：**原地改写 `index.html` → 跑 → `finally` 立即还原 → 校验 sha256**（不用"复制到临时目录"，
因该文件被浏览器按同源加载、复制会改变相对资产解析）。

### 2.1 实验组 1：移除 `NO_GATE.normalizeBlockType`

```
=== 对照组（t25 修复在位）===
  对照组: ✅ 通过 | 文本="说明文字。 | 结尾文字。 | The diagram is temporarily unavailable; …"
=== 实验组 1：移除 NO_GATE.normalizeBlockType ===
  移除 normalizeBlockType: ❌ 失败 | 文本="Sorry, something went wrong: G.normalizeBlockType is not a function"
```
→ **断言确实能拦住该崩溃点**（移除后精确重现修复前的错误串）。

### 2.2 实验组 2：`decodeBlockPayload` 返回 `block: null`（契约纪律提醒的那个坑）

```
文本: "Sorry, something went wrong: Cannot read properties of null (reading 'blockType')"
pageerror: （空）
→ 实验组2（block:null）失败: true ｜ 失败形态: null 解引用（预期）
制品还原: ✅ sha 一致
```
→ **断言能拦住该变体**；错误串正是契约所述「返回 null 会抛 `Cannot read properties of null`」。

> **我自己一处作废的实验（如实记录）**：实验组 2 的**第一版**我用正则把返回值改成了
> `block: null, void 0, ({}).x = {` —— 产生 **SyntaxError: Unexpected number**，页面整段脚本不执行
> （文本为空）。**那是语法错误而非 `block:null` 路径，结论无效**，我据此重做了变体（改为
> `block: null, __dead: {`），才得到上表的 null 解引用形态。原始无效读数见
> `/tmp/cs-verify/t26-verify-b2.mjs` 输出。
>
> **同理，对照组必须先确认"应当通过"**：本轮对照组 ✅ 通过，故两次实验组的失败才有解释力。

### 2.3 [4] 2 项完整性项走静态断言（**不参与行为反证**）

| 完整性项 | 静态断言读数 | 为何不做行为反证 |
|---|---|---|
| `blockTimeoutMs` | `NO_GATE.blockTimeoutMs = 1500`（与 §12 冻结默认一致） | 页面**无真实成员访问**：`grep -oE 'G\.[a-zA-Z_]+'` 的差集为空说明它虽被列出但删除后两套 **exit=0**——**engineer-frontend 已实测**「只删 `blockTimeoutMs` → 两套 exit=0」，属**预期行为**，故**不得**逐项试删后据此判失败（契约明确禁止） |
| `GATE_STATES` 六态 | `absent/pending/loading/validating/passed/degraded` **六态齐备**（逐态 grep 均 1 命中） | 缺键得 `undefined`（不抛错），仅使状态机判断失真，属完整性项而非崩溃点 |

**`NO_GATE` 覆盖性静态断言**（契约要求：键集 ⊇ 页面**真实访问**的全部 `G.<member>`）：
```
页面访问的 G.* 全集（18 项）  vs  NO_GATE 提供的键（20 项）
comm -23 <访问集> <提供集>  →  **空**（差集为空）
```
→ **无缺口**：`buildReport`/`createReportDeduper`/`decodeBlockPayload`/`shortDigest`/`textKeyFor`/`normalizeBlockType`/`chooseBlockSource`/`blockTimeoutMs`/`DEFAULT_MAX_ASPECT_RATIO` 等**均已补齐**。

---

## 3. [7] 四脚本 exit=0（timeout ≥120s，两套分别运行）

```
gate-check（host）          exit=0  76/76 项断言通过
http-exits-check（host）    exit=0  25/25 项断言通过
output-gate-check（frontend）exit=0  全部 61 项通过
gate-dom-check（frontend）   exit=0  全部 74 项通过
```
→ **[7] 通过**（均以 `timeout ≥150s` 分别运行，无超时）。

---

## 4. [2][8][9] 判别器节、窗口双采样、清理

- **[2] 通过**：§0.1/§0.2 给出残余符号（0）、活路径计数、协议标记（6）、关键文件 sha+字节+时点、归属任务。
- **[8] 通过**：§0.3 给出窗口起止双采样，判据为「判别器是否变化」——四项均未变化。
- **[9] 通过**：见 §5。

---

## 5. [9] 清理

```
残留验证进程: (无)
端口 10900 / 10901 / 10902 / 10903: free
docker ps: dshagent-nginx「Up 10 hours」、dshagent-app「Up 10 hours (healthy)」 ← 未重启/未重建
```
两次反证实验的临时改写**均已还原并经 sha256 校验一致**（`index.html` 保持 `e8fce50f84a5795f`）。→ **[9] 通过**。

---

## 6. 未能验证项（不默认通过）

| # | 条目 | 原因 |
|---|---|---|
| 1 | 该修复在**线上 10800** 的真实生效 | 容器为旧构建（无 output-gate 插件），须重建方可验；本次按要求**未重建** |
| 2 | `serviceVersion = 2026-09-10.10` | 被测为自建源码实例，本次以 jsdom/真机 + 桩驱动 |
| 3 | 其余 3 个崩溃点的**逐个**行为反证 | 契约要求"删任一个 → 断言必须失败"，我做了**建议项 `normalizeBlockType`**（崩溃点代表）+ **`decodeBlockPayload.block` 变体**两项；其余（`chooseBlockSource`/`DEFAULT_MAX_ASPECT_RATIO`）我以 §2.3 的**静态覆盖性断言**（差集为空）支撑，**未逐个做行为反证** |

---

## 7. 附：一处与我相关的外部更正（供 t27 知悉）

我于本轮曾报告 `fence-machine.ts` 注释「声称两侧闭合判据不一致」为**事实错误的旧主张**，
并指出**前端 `matchControlledFence`/`isClosingFence` 未剥 CR**、CRLF 输入下会泄漏源码（实测）。

**t28 已采纳并修正**（`fence-machine.ts = b4947a070ab7fca7`，仅注释）——新注释现写明：
```
 * 1. **行尾 `\r`（CRLF）**：本函数经 stripCr() 先剥 \r 再判定，前端**尚未剥**。
 *    故 CRLF 输入下两侧**不一致**——前端 matchControlledFence … 实测整篇 CRLF 时
 *    前端受控分支命中 0 行、两处围栏均落入普通代码块，标记与块体 …
```
→ **注释与实测一致**（我独立复跑同一判定得相同结论）。
**但前端那条 CRLF 未覆盖分支本身是否修复，不在 t26 范围**（t26 inScope 仅本报告文件）；
建议由 t27 或后续 repair 裁定。**当前可达性**：真实后端实测 **272 个 delta 帧含 `\r` 者 0** → 判潜在分支。
