# 输出前自审门禁 — V6 复验报告（t20：t18 + t19 两处修复闭环）

> 角色：verifier（对抗验证者，**只写本报告路径，未修改任何实现代码或测试代码**）
> 日期：2026-09-10
> 承接任务：**t20「V6 复验两处修复」**（依赖 t18、t19，均已完成）
> 前序报告：`output-self-review-verification.md`（V1）、`-v2.md`（V2）、`-v3.md`（V4/V5，保留不动）

**总判定：✅ 两处修复均真闭环——9 项验收逐条通过，未发现回归。**

---

## 0. 被测制品与证据层级

### 0.1 判据版本（实测）

```
$ head -2 customer-service/docs/output-self-review-requirements.md
# 客服输出前自我审核 — 需求清单与验收标准（v3.2.12）
```

### 0.2 被测制品（t18/t19 完成态）

| 文件 | sha256 前 16 | 说明 |
|---|---|---|
| `web/guest/index.html` | **`b3c0d0c909f4d925`** | t18 修复（本次对象） |
| `web/guest/assets/output-gate.js` | `11ebac8964857f0a` | 未变 |
| `plugins/output-gate/tests/gate-check.mjs` | `444e6816ac7abb4e` | t19 修复（本次对象） |
| `web/guest/tests/gate-dom-check.mjs` | `33430484dcc9821d` | t18 相关（「路径 B」标签） |
| `plugins/output-gate/src/engine.ts` | `2da07bdce590e6ad` | 主机侧，未变 |
| `plugins/output-gate/src/fence-machine.ts` | `259485406ad2c8af` | 未变 |
| `plugins/output-gate/src/index.ts` | `4d39bb58624a0e49` | 未变 |
| `plugins/output-gate/src/block-rules.ts` | `dafca4575e9be224` | 未变 |
| `plugins/guest-server/src/index.ts` | `99110840bc1bb7ed` | 未变 |

### 0.3 证据层级（G-ANCHOR）

| 层级 | 本次使用处 |
|---|---|
| 行为/事件序列 | §1/§2 真机等价 DOM（jsdom）；§3 真实 `OutputGateService` 事件序列；§4 计时实测 |
| 制品指纹 | §5 夹具键与断言（`grep` 原文 + 反证实验） |
| 符号存在 | 仅用于 §2 [4]「闭合判据已更换」这一符号性事实 |

> 两条路径**显式区分**（本报告每条结论均标注）：
> **口径 B** = 主机侧下发 `block` 事件（`blockSourcePolicy() === 'block-events'`）；
> **fence-fallback** = 无 `block` 事件时前端 `renderMarkdown` 自行按围栏兜底（旧后端 + 新前端）。

---

## 1. [1] t18 修复有效性：形态 I/II 消失

**路径：fence-fallback（无 block 事件）｜证据层级：行为（真实渲染 DOM）**

判据：内层**受控**围栏的**标记与块体**不得进入访客可见正文（既不在 `<p>`，也不在 `<pre><code>`）；
应被摘为块（`data-block-key` 槽位 → 可读降级文案）。

```
$ node /tmp/cs-verify/t20-inner-fence.mjs        （jsdom 真机等价环境，仅内存，不改制品）
=== ① 行首内层受控围栏 ===
  可见标记 ```mermaid : false
  块体落 <p>（正文泄漏）: false
  块体落 <pre><code>: false
  块槽位数: 1
  判定: ✅ 已被摘出
=== ② 行中内层受控围栏 ===
  可见标记 ```mermaid : false
  块体落 <p>（正文泄漏）: false
  块体落 <pre><code>: false
  块槽位数: 1
  判定: ✅ 已被摘出
=== ③ 缩进内层受控围栏 ===
  可见标记 ```mermaid : false
  块体落 <p>（正文泄漏）: false
  块体落 <pre><code>: false
  块槽位数: 1
  判定: ✅ 已被摘出
[t20[1][2] 预备结论] 三种内层位置: ✅ 全部安全
```

**结构证明**（① 的 DOM）：

```
<p>说明：</p><pre><code>print(1)</code></pre>
<div class data-block-state data-block-key><div data-block-state>
  The diagram is temporarily unavailable; please refer to the text above.
</div></div><p>结束。</p>
```

→ 外层 `python` 仍是普通代码块（**N2③ 语义保留、未误伤**）；内层受控围栏被**摘为块**并落
**可读降级文案**；标记与块体**均未进入访客正文**。**t18 目标达成。**

> **形态 I/II 的现状**：t17 曾记录形态 I（标记+块体落外层 `<pre><code>`）与形态 II（块体源码落正文 `<p>`）。
> 本次三种内层位置实测**两者均不再出现**（`落<p>` 与 `落<pre><code>` 同时为 false）。

### 1.1 ⚠️ 必须声明：t17「用例 H」不是缺陷，不得计入失败

我复跑 t17 的探针 `/tmp/t17-e7-probe3.mjs`（5 例），**只有 H 报 `bodyOwners:["p"]`**。逐字核其夹具：

```js
`说明：\n\n```python\nprint(1)\n```\ngraph TD\n  X[a]\n```\n\n结束。\n`
```

该夹具**不含任何"受控围栏"**：` ```python ` 被**裸 ``` 正常闭合**，其后的 `graph TD` / `X[a]`
是**真正的正文**，渲染成 `<p>` 是**完全正确**的行为（N2③：非受控语言不属门禁范围）。

→ **t17 的真实 finding 是 A/B/E（行首/缩进/4 反引号内层「受控」围栏），现已全部安全。**
**若把用例 H 计入失败，会把正确行为判成缺陷**——与我 F-5 的教训同型（判据口径错 → 假 finding）。
本报告据此**不把 H 计入任何失败项**。

---

## 2. [2][4] 内层围栏位置覆盖与闭合判据

### 2.1 [2] 行首与行中均被覆盖

见 §1：①**行首**（`` ```mermaid ``）、②**行中**（`x ```mermaid`）**均被摘出**；
另补 ③**缩进**（`  ```mermaid`）亦安全。→ **[2] 通过**（判据要求的两位置 + 一额外位置全覆盖）。

### 2.2 [4] 闭合判据差异：**未保留，已对齐**

t18 把普通代码块分支的裸 `/^```/` 替换为与受控分支同口径的 `isClosingFence(lines[i], plainChar, plainRun)`：

```
$ grep -n "isClosingFence(lines\[i\], plainChar, plainRun)" customer-service/web/guest/index.html
（命中；注释写明：「闭合判据与受控分支同口径（不硬编码长度/字符）：裸 /^```/ 会把内层
 ` ```mermaid ` 当闭合行而在错误位置截断，余下块体随之落入正文段落。」）
```

→ 按判据 [4]「**若未保留差异，给出对齐后的证据**」路径判定：**证据即 §1 的三位置实测**
（对齐后内层受控围栏不再被误判为闭合行，块体不再落 `<p>`）。→ **[4] 通过**。

---

## 3. [3] 口径 B 未回归

**路径：口径 B（主机侧下发 block 事件）｜证据层级：行为（真实 `OutputGateService` 事件序列）**

```
$ node --import tsx/esm  （真实 OutputGateService，enabled:true）
[3] 事件: ["text","block-open","block","text"] | 正文: "说明。\n结尾。"
[3] 块: ["mermaid:render"] | AS-3 命中: false
```

→ 受控块**仍被摘为块**（1 块、`mermaid:render`）、`block-open`/`block` 事件**正常下发**、
正文**不含任何受控围栏序列**（AS-3 正则 `[`~]{3,}\s*(mermaid|chart|image|img|html)` 未命中）。
→ **[3] 通过（无回归）**。

---

## 4. [5] t19 修复有效性：夹具与收尾窗口

**证据层级：制品指纹 + 行为（计时实测）**

### 4.1 非法键已清零、夹具含正确键

```
$ grep -rn 'visitorWaitBudgetMs' customer-service/plugins/ | wc -l
0                                        ← 缺陷所在面已清零
$ grep -n 'answerWaitBudgetMs' customer-service/plugins/output-gate/tests/gate-check.mjs
61: * （captain 冻结取值见需求 §10；`answerWaitBudgetMs` 生产默认 600ms）。
64: * 曾因本表缺少 `answerWaitBudgetMs` 导致 `Math.max(0, undefined) === NaN` →
70:  answerWaitBudgetMs: 600,              ← 夹具已含正确键
```

### 4.2 收尾窗口确实生效（非 0ms 静默失效）

```
$ node --import tsx/esm /tmp/cs-verify/t20-settle-window.mjs
answerWaitBudgetMs=600（夹具默认，块未回传应等待≈600ms）: settle 耗时 598ms | blockResults={...:"passed"}
判据：600ms 窗口下 settle 耗时应在 ~600ms 量级（明显 >0）→ ✅ 窗口确实生效
```

→ **598ms**（对照 t19 所述"失效时为 0ms"），窗口确实在等待。→ **[5] 通过**。

> **[5] 另附一条独立读数**：t19 新增的断言 `夹具保真：DEFAULTS 与生产 Config 逐键等价`
> 比原要求**更强**——它不仅检查键存在与为正，还**逐键比对夹具与生产 `Config` 默认值**
> （`plugin.Config({ gate: {} }).gate`），属根因级防护（防"夹具与生产再次分叉"）。

---

## 5. [6] 防退化断言确实能拦住回归（两项反证实验）

**判据要求「人为把该键改回缺失/非法，断言须失败」。我做两项：摘键 与 值分叉（后者更严）。**

> **方法说明（重要）**：两项实验均为「**原地改写 → 跑 → finally 立即还原 → 校验 sha256**」。
> 我第一版曾把测试文件**复制到临时目录**再跑，结果**对照组也失败**（该脚本按
> `dirname(fileURLToPath(import.meta.url))` 解析制品路径，复制后相对路径失效）——
> **两组都因无关原因失败，证明不了任何事**，该版实验已作废。改用原地改写后结果如下。

### 5.1 实验 A：摘除 `DEFAULTS.answerWaitBudgetMs`

```
$ node /tmp/cs-verify/t20-assert-inval.mjs
=== 对照组（原样，DEFAULTS 含 answerWaitBudgetMs）===
  退出码: 0    76/76 项断言通过
=== 实验组（摘除 DEFAULTS.answerWaitBudgetMs 后）===
  退出码: 1    74/76 项断言通过
  命中断言信息: DEFAULTS.answerWaitBudgetMs 必须是有限数（缺键会得到 undefined → NaN → 窗口恒假失效）
制品还原校验: ✅ sha256 前后一致（未留改动）
```

### 5.2 实验 B：值分叉（夹具 600 → 601，比"缺键"更严）

```
$ node /tmp/cs-verify/t19-fork-guard.mjs
对照组（原样）: 退出码=0 | 76/76 项断言通过
实验组（夹具 600→601，与生产默认分叉）: 退出码=1   75/76 项断言通过
  命中信息: 夹具保真：DEFAULTS 与生产 Config 逐键等价，且收尾窗口为有限数
制品还原: ✅ sha 一致
```

→ 该断言**连"值不一致"都能拦住**，非仅防缺键。→ **[6] 通过**（两项反证均捕获，且制品已还原）。

---

## 6. [7][8][9] 套件、标注与清理

### 6.1 [7] 四条脚本全绿且退出码 0

```
$ node --import tsx/esm plugins/output-gate/tests/gate-check.mjs       → exit=0  76/76 项断言通过
$ node --import tsx/esm plugins/output-gate/tests/http-exits-check.mjs → exit=0  25/25 项断言通过
$ node web/guest/tests/output-gate-check.mjs                          → exit=0  全部 59 项通过
$ node web/guest/tests/gate-dom-check.mjs                             → exit=0  全部 68 项通过
```

> 断言数较 t13 期(**67/73**、**20/25**、58、61)均有增长：主机 `gate-check` 现 **76**、
> `gate-dom-check` 现 **68** —— 新增断言正覆盖本轮两处修复。→ **[7] 通过**。

### 6.2 [8] 证据层级与路径标注

- 本报告每条结论均标注**证据层级**（§0.3 表）与**路径**（口径 B vs fence-fallback，§1/§3 标题）；
- **判据行不内嵌易变值**：本文引用 sha 仅出现在 §0.2 的制品表中作为**被测对象标识**，
  而非判据本身（呼应 v3.2.12 新增的 **G-ANCHOR-5「判据不得内嵌易变事实」**）。→ **[8] 通过**。

### 6.3 [9] 清理

```
残留验证进程: (无)
端口 10900 / 10901 / 10902 / 10903: free     ← 全部释放
docker ps: dshagent-nginx「Up 8 hours」、dshagent-app「Up 8 hours (healthy)」 ← 未重启/未重建
```

本次复验以 **jsdom 内存环境** + **进程内 `OutputGateService`** 为主，**未长期占用端口**；
两处反证实验的临时改写**均已还原并经 sha256 校验一致**。→ **[9] 通过**。

---

## 7. 未能验证项（不默认通过）

| # | 条目 | 原因 |
|---|---|---|
| 1 | t18 修复在**线上 10800** 的真实生效 | 容器为旧构建（无 output-gate 插件），须重建方可验；本次按要求**未重建**（G-ANCHOR：自建/本地环境不得冒充线上构建） |
| 2 | t18 修复在**真 Chrome**（非 jsdom）的表现 | 本次 §1 用 jsdom 真机等价环境；t17 曾做过真 Chrome 复核（其结论独立成立），但我**未对本轮最终制品再做一次真 Chrome 复核** |
| 3 | `serviceVersion = 2026-09-10.10` | 源实例返回 `verify-local-1`（自建实例，设计如此） |
| 4 | 配置逐键生效（AS-7） | 仅核默认值与夹具一致性，未逐键改配置重启验证 |

---

## 8. 遗留项（不属 t20 范围，但请勿遗漏）

| 项 | 状态 | 说明 |
|---|---|---|
| **P9-1**（干净 EOF 时 `pending` 块永不降级） | ❌ **仍未修** | 我在 t20 期间复核：`index.html:2585` 仍是 `if (!done && !streamed) throw`，`degradePendingGates` 调用点仍 4 处。**t22 待做、t23（V7）待我复验** |
| **`NO_GATE` 不完整**（门禁资产缺失 → 整条回答失败） | ⚠️ **未开任务** | 我实测：404 `assets/output-gate.js` 时 `G.normalizeBlockType is not a function`，整条回答变 "Sorry, something went wrong"，违反 `index.html:255` 自述与 C8。页面调用的 5 个 `G.*` 成员未被 `NO_GATE` 提供（另 `GATE_STATES` 缺 `pending/loading/validating`）。**建议至少记为已知残留** |

---

## 9. 复核建议（供 t15 / t23）

1. **勿重复修 t18/t19**：两处均已闭环（§1–§5），尤其**不要**因 t17「用例 H」的 `bodyOwners:["p"]`
   而回退 t18 的闭合判据对齐——那是**正确行为**（§1.1）；
2. **t23 可直接复用**本报告的 `t20-inner-fence.mjs`（内层围栏三位置）、
   `t20-settle-window.mjs`（窗口计时）、`t20-assert-inval.mjs` / `t19-fork-guard.mjs`（反证）；
3. **反证实验务必"原地改写 + 还原"**：复制测试文件会因其 `import.meta.url` 路径解析而**两组皆失败**（§5 方法说明）；
4. **G-FREEZE 仍建议先取显式停手确认**：本轮制品在本会话内多次变更
   （`07a073ce` → `b3c0d0c9` → `b64cb126` → `b3c0d0c9`），t18/t19 现已 `completed`，是较稳定的取基线时机。
