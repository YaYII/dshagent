# 输出前自审门禁 — V7 复验报告（t23：t22 干净 EOF 悬挂修复闭环）

> 角色：verifier（对抗验证者，**只写本报告路径，未修改任何实现代码**）
> 日期：2026-09-11
> 承接任务：**t23「V7 复验 t22」**（依赖 t22，已完成）
> 前序报告：`output-self-review-verification.md`（V1）、`-v2.md`（V2）、`-v3.md`（V4/V5）、`-v4.md`（V6，均保留不动）

**总判定：✅ t22 修复真闭环——8 项验收逐条通过，未发现回归。**

---

## 0. 被测制品与证据层级

### 0.1 停手确认与冻结（本次执行了完整三步）

```
$ 三次采样（间隔 12s），t22 已 completed：
  采样1: index=44428422e97c2644 gate-dom=edb7ea547cd1313b out-gate-check=0261192cfa4285f8
  采样2: index=44428422e97c2644 gate-dom=edb7ea547cd1313b out-gate-check=0261192cfa4285f8
  采样3: index=44428422e97c2644 gate-dom=edb7ea547cd1313b out-gate-check=0261192cfa4285f8
```

### 0.2 被测制品（t22 完成态）

| 文件 | sha256 前 16 | 字节 |
|---|---|---|
| `web/guest/index.html` | **`44428422e97c2644`** | 133961 |
| `web/guest/assets/output-gate.js` | `11ebac8964857f0a` | 31718 |
| `web/guest/tests/output-gate-check.mjs` | `0261192cfa4285f8` | — |
| `web/guest/tests/gate-dom-check.mjs` | `edb7ea547cd1313b` | — |
| `plugins/output-gate/src/engine.ts` | `2da07bdce590e6ad` | 主机侧未变 |
| `plugins/output-gate/src/fence-machine.ts` | `259485406ad2c8af` | 未变 |

### 0.3 二元组三重标识

```
① 实例 health:      {"ok":true,"version":"verify-local-1"}   （自建源码实例，见 §7 未能验证）
② 该实例响应体页面: sha256 前16 = 44428422e97c2644  = 磁盘 index.html 同指纹（逐字节一致）
③ 该实例 SSE 含 block-open / block 原始帧: 见 §3（事件序列 ["text","block-open","block","text"]）
④ 声明：未使用 10800 作判据（本节全部结论取自 10900 源码实例 / 进程内 OutputGateService / jsdom）
```

### 0.4 证据层级（G-ANCHOR）

| 层级 | 本次使用处 |
|---|---|
| 线上制品 | §0.3②；§3 原始事件序列 |
| 行为/事件序列 | §1 真机 DOM（含时刻与文案）；§2 真 socket 重置；§4 计时实测 |
| 制品指纹 | §5 反证实验的 sha256 前后校验 |

---

## 1. [1][2] 干净 EOF 后 `pending` 块在有限时间进入终态

**路径：fence-fallback（无 block 事件）｜证据层级：行为（真实渲染，非读代码推断）**

**判据**：干净 EOF（已收到 delta、无 `done`、连接正常关闭）后，`pending` 块须在有限时间进入**可读降级终态**，不再无限悬挂。

```
$ xvfb-run -a node /tmp/cs-verify/prep-p9-verify.mjs      （A 情形：仅 stream 被替换为「有 delta+block-open，无 done」）
=== A 干净 EOF ===
  终态文本: "说明文字。 | The diagram is temporarily unavailable; please refer to the text above."
  含围栏=false 含源码=false pre>code=0
  收敛时刻: 1021ms
  块节点数=2 pending文案残留=false
  判定: ✅ 已进终态
```

- **收敛时刻 = 1021ms**（对照 t22 修复前：我在 t22 前实测为 **55s 仍 `["pending"]`、永不收敛**）；
- 可见文案为**可读降级**「The diagram is temporarily unavailable; please refer to the text above.」；
- **断言有效性**：判据要求「**存在块节点** + 无 `pending/loading/validating` + **无 pending 文案残留**」——
  避免块节点数为 0（整条回答被错误态替换）时**空洞通过**。本次块节点数 = 2，非空洞。

→ **[1] 通过**（有限时间进入终态，附实测时刻与可见文案）。
→ **[2] 通过**：终态文本**不含**围栏标记（`含围栏=false`）与块体源码（`含源码=false`、`pre>code=0`）。

**DOM 片段（终态）**：

```
说明文字。 |
<div data-block-state="degraded" data-block-key>…The diagram is temporarily unavailable; please refer to the text above.…</div>
```

---

## 2. [3] 真 socket 重置 / 中途 kill 的既有降级行为未回归

**证据层级：行为（真实 socket 摧毁，非干净 EOF）**

用自建 `/__dropsse/`（发出 `meta`+`delta`+`block-open` 后 `res.socket.destroy()`；`curl` 实测 `exitcode=18`，确认是**真重置**而非 EOF）：

```
=== B 真 socket 重置 ===
  1s ["pending"] :: 说明文字。 | Preparing the graphic…
  2s [] :: Network unstable, retrieving your answer…      ← 进入恢复态（既有行为）
  …
  25s [] :: Sorry, something went wrong: network error
  终态块状态: [] | 块节点数=0
含围栏=false 含源码=false pre>code=0
  判定: ⚠️ 无块节点（无法判定，需查是否被替换为错误态）
```

汇总口径：**B 情形 悬挂 0（回归对照通过）**。说明：B 走的是既有 `catch` → `recoverReply` 路径；由于该 URL 由我的桩提供、其 `history` 无真答案，20s 轮询窗口耗尽后正常显示错误文案（**这是既有设计行为，非本次回归**；REG6 的"恢复出答案"我在 V2 §4.1 已对**真实后端**验证通过）。

> **⚠️ 我在本节踩过并修掉了一个**桩缺陷**（必须记录，避免后人误判）：
> 第一次跑 B 时得到 `G.normalizeBlockType is not a function`，块节点 0、判定"无块节点"。
> 根因是**我的 `/__dropsse/` 路由未服务 `/assets/*`**（404）→ 页面退化为 `G = NO_GATE` →
> 由 `NO_GATE` 缺 `normalizeBlockType` 成员而抛错。**这是 harness bug，不是产品缺陷**
> （该 `NO_GATE` 不完整性我已单独报告）。修路由后 B 的表现恢复正常（见上表）。

---

## 3. [4] `done` 正常到达路径未回归

**路径：口径 B（主机侧下发 block 事件）｜证据层级：行为（真实事件序列 + 计时）**

```
$ node --import tsx/esm /tmp/cs-verify/t20-settle-window.mjs
answerWaitBudgetMs=600（夹具默认，块未回传应等待≈600ms）: settle 耗时 599ms | blockResults={...:"passed"}
判据：600ms 窗口下 settle 耗时应在 ~600ms 量级（明显 >0）→ ✅ 窗口确实生效
```

- **收尾窗口语义不变**：`settle()` 实测 **599ms**（T1 判据 ≤600ms，且非 0ms 静默失效）；
- **块仍按既有 `passed`/`degraded` 流程结算**（`blockResults` = `{"...":"passed"}`）。

**两块构型（真机 DOM）**：

```
$ xvfb-run -a node /tmp/cs-verify/twoblock-final.mjs
=== 终态 === [{"key":"blk-two-m","state":"passed"},{"key":"blk-two-i","state":"passed"}]
svg=1 img=1 figure=1 | 含围栏=false 含源码=false pre>code=0
AS-14① 判定（两块都 passed + 无泄漏）: ✅ PASS
```

→ 一轮含 `mermaid`+`image` 两块**均达 `passed`**，第二块未被降级。→ **[4] 通过**。

---

## 4. [5] 新增断言真能拦住回归（**反证实验**）

**这是本任务最重要的一项**：不仅要证明"修好了"，还要证明**是我说的那行代码修的**，且**我的判据不是空洞的**。

**手法**：原地备份 `index.html` → 删除 t22 新增的 `if (!done) degradePendingGates(chatEl)` → 跑干净 EOF 情形 → **finally 立即还原** → 校验 sha256。

```
$ xvfb-run -a node /tmp/cs-verify/t23-invalidation.mjs
index.html sha16 = 44428422e97c2644          ← 改动前

=== 对照组（t22 收尾路径在位） ===
  1s ["degraded","degraded"] :: 说明文字。 | The diagram is temporarily unavailable; …
  终态块状态: ["degraded","degraded"] | 块节点数=2
  收敛时刻: 1022ms
  判定: ✅ 已进终态且无泄漏

=== 实验组（移除 `if (!done) degradePendingGates(chatEl)`） ===
  1s ["pending"] :: 说明文字。 | Preparing the graphic…
  10s ["pending"] :: 说明文字。 | Preparing the graphic…
  20s ["pending"] :: 说明文字。 | Preparing the graphic…
  30s ["pending"] :: 说明文字。 | Preparing the graphic…
  终态块状态: ["pending"] | 块节点数=1
  收敛时刻: 未收敛（30s）
  判定: ❌ 悬挂 1

════ [5] 反证判定 ════
  对照组: 收敛 1022 | 悬挂 0
  实验组: 收敛 未收敛 | 悬挂 1
  移除后重现悬挂、判据失败: ✅ 断言能拦住回归（该收尾路径确为修复原因）
  制品还原: ✅ sha256 前后一致
```

**双重结论**：
1. **该收尾路径确为修复原因**——移除它，`pending` 永久悬挂**精确重现**（30s 未收敛）；
2. **我的判据不是空洞的**——它能区分"修好"与"未修"两种状态（对照组 pass / 实验组 fail）。

**未改制品**：`index.html` sha256 前后一致（`44428422e97c2644`）。→ **[5] 通过**。

---

## 5. [6] 四条脚本全绿且退出码 0

```
gate-check            exit=0   76/76 项断言通过
http-exits-check      exit=0   25/25 项断言通过
output-gate-check     exit=0   全部 59 项通过
gate-dom-check        exit=0   全部 71 项通过       ← 较 t20 期的 68 新增 3 项（t22 相关）
```

→ **[6] 通过**（`gate-dom-check` 新增的 3 项正覆盖本次干净 EOF 修复）。

---

## 6. [7][8][9] 报告要素、清理

### 6.1 [7] 判据行不含易变值；结论标明路径

- **判据行不使用 sha/字节数等易变事实**；sha 仅作为 **§0.2 被测对象标识**出现（呼应 v3.2.12 的 **G-ANCHOR-5**）。
- 每条结论均标注**路径**：§1/§2 为 **fence-fallback**（并注明 ② 为"仅 stream 被替换"）；§3/§4 为 **口径 B** 或进程内服务；§5 为真实 DOM。

### 6.2 [8][9] 清理

```
$ 残留验证进程: (无)
端口 10900 / 10901 / 10902 / 10903: free     ← 全部释放
docker ps: dshagent-nginx「Up 8 hours」、dshagent-app「Up 8 hours (healthy)」 ← 未重启/未重建
```

反证实验的临时改写**已还原并经 sha256 校验一致**。→ **[8][9] 通过**。

---

## 7. 未能验证项（不默认通过）

| # | 条目 | 原因 |
|---|---|---|
| 1 | 该修复在**线上 10800** 的真实生效 | 容器为旧构建（无 output-gate 插件），须重建方可验；本次按要求**未重建** |
| 2 | `serviceVersion = 2026-09-10.10` | 被测为自建源码实例（返回 `verify-local-1`），设计如此 |
| 3 | B 情形「恢复出答案」的端到端 | 本次 B 用桩提供的 stream（其 history 无真答案），故只验证了"既有降级行为未回归"；**REG6 的完整恢复链路**已在 V2 §4.1 对**真实后端**验证通过 |

---

## 8. 遗留项（不属 t23 范围，但请勿遗漏）

| 项 | 状态 | 说明 |
|---|---|---|
| **`NO_GATE` 不完整** | ⚠️ **仍未开任务** | 门禁资产缺失时页面退化为 `G = NO_GATE`，而 `NO_GATE` 未提供页面调用的 5 个成员（`normalizeBlockType`/`chooseBlockSource`/`decodeBlockPayload`/`blockTimeoutMs`/`DEFAULT_MAX_ASPECT_RATIO`），`GATE_STATES` 亦缺 `pending/loading/validating` → **整条回答失败**（"Sorry, something went wrong: G.normalizeBlockType is not a function"），违反 `index.html:255` 自述与 C8「资产拿不到时不阻塞页面脚本……文字回答与来源引用照常工作」。**medium**。本次因我的桩路由 404 而**实际复现**（§2 备注）。 |

---

## 9. 复核建议（供 t15）

1. **勿重复修 t22**：已闭环（§1/§4/§5），尤其**不要**把 `if (!done) degradePendingGates(chatEl)` 移走——反证实验已证明它是修复的必要条件；
2. **反证实验务必"原地改写 + finally 还原"**：复制测试/制品文件到临时目录会因其 `import.meta.url` 路径解析而**两组皆失败**，得到无效结论（我在 t20 已踩过同一坑）；
3. **B 情形（socket 重置）需服务 `/assets/*`**：否则页面退化为 `NO_GATE` 而抛出无关错误（§2 备注），会被误读为回归；
4. **建议优先处置 `NO_GATE` 遗留项**（§8）：它是**唯一已知的"门禁资产缺失即整条回答失败"**路径，与用户原始诉求「避免错误内容直达用户」直接相关。
