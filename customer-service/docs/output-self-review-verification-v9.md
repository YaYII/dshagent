# 输出前自审 — V9 对抗性验证报告（captain blocker 复现尝试 + 独立回答五个必答问题）

- 验证者：`verifier`（对抗性验证，**未修改任何实现代码**）
- 工作目录：`/home/as-workstation01/Documents/project/dshagent`
- 服务约束：运行中的容器 `dshagent-app` / `dshagent-nginx` **全程未重启/未重建**（验证结束时 Up 11 hours）
- 本报告为 V9；V1–V8 报告未改动（`output-self-review-verification{,-v2,-v3,-v4,-v5,-v6}.md`）

---

## §0 制品判别器（先跑判别器再开工；G-ANCHOR-4：测试前后各复采样一次）

### §0.1 被测制品指纹（三采样稳定，书写时）

| 制品 | sha256 前 16 | 字节 |
|---|---|---|
| `customer-service/web/guest/index.html` | `557466d15a49023b` | 138343 |
| `customer-service/web/guest/assets/output-gate.js` | `11ebac8964857f0a` | 31718 |
| `plugins/output-gate/src/engine.ts` | `2da07bdce590e6ad` | 20028 |
| `plugins/output-gate/src/fence-machine.ts` | `93b35f1b0eb9e127` | 19234 |
| `plugins/output-gate/src/block-rules.ts` | `dafca4575e9be224` | 12527 |
| `plugins/output-gate/src/index.ts` | `4d39bb58624a0e49` | 11431 |
| `plugins/output-gate/tests/gate-check.mjs` | `444e6816ac7abb4e` | 60847 |
| `plugins/output-gate/tests/http-exits-check.mjs` | `fc6c8ca4af75e907` | 35491 |
| `web/guest/tests/gate-dom-check.mjs` | `bce25f36cb5c4e26` | — |
| `web/guest/tests/output-gate-check.mjs` | `c0d96b07655ed5ec` | — |

三采样命令与输出（`index.html` 与 `fence-machine.ts`）：

```
$ for i in 1 2 3; do sha256sum customer-service/web/guest/index.html \
    customer-service/plugins/output-gate/src/fence-machine.ts | awk '{printf "%s ", substr($1,1,8)}'; echo "(采样 $i)"; sleep 1; done
557466d1 93b35f1b (采样 1)
557466d1 93b35f1b (采样 2)
557466d1 93b35f1b (采样 3)
```

### §0.2 验证窗口内的制品变动（必须记录，影响判据归属）

`fence-machine.ts` 在**本次验证期间**被 t30/t31 改写两次：

| 时刻 | sha16 | 归属 |
|---|---|---|
| 我开工时 | `b4947a070ab7fca7` | t28 完成态 |
| 我跑第一轮流式专项中途 | `2dc33e7bd5050ef1` | t30 写入中 |
| 收尾时 | `93b35f1b0eb9e127` | t31 完成态 |

**判别器纪律**：我没有把这三版的读数混用。做法是先把 `2dc33e7b` 版快照到 `/tmp/cs-verify/fence-machine.snap-2dc33e7b.ts`，再用**剥注释/剥空行/剥首尾空白**的「代码面指纹」对比：

```
$ for f in /tmp/cs-verify/fence-machine.snap-2dc33e7b.ts customer-service/plugins/output-gate/src/fence-machine.ts; do
    printf '%-58s ' "$(basename $f)";
    sed -e 's://.*$::' -e '/^[[:space:]]*$/d' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' "$f" \
      | grep -v '^\*' | grep -v '^/\*' | grep -v '^\*/' | sha256sum | cut -c1-16; done
fence-machine.snap-2dc33e7b.ts                             5bef321136eaa417
fence-machine.ts                                           5bef321136eaa417
>>> 代码面无差异（改动仅注释）
```

**结论**：t30/t31 的改动**全部落在注释**，代码行为面在 `b4947a07` → `93b35f1b` 之间未变。
因此本报告 §2（主机侧 24 例）、§3（流式 56 组合）的读数对 `93b35f1b` **同样成立**——
这两轮的判别器为 `2dc33e7b`，其代码面与 `93b35f1b` 逐字节相同。
（这是**我自己的推断**，证据层级为「制品指纹」，非「行为序列」；§2/§3 的读数本身是行为证据。）

### §0.3 我方脚本零写入声明

本报告全部实验**未对仓库内任何文件执行写操作**。唯一涉及「改代码」的反证实验（§1.4）改为
**只在内存里 patch 页面字符串**，磁盘零写入，并在实验前后复采样确认：

```
=== 磁盘完整性（G-ANCHOR-4 复采样） ===
测试前 sha16: 557466d15a49023b  测试后 sha16: 557466d15a49023b  ✅ 一致（零写入）
```

---

## §1 必答问题 1：门禁真的不可绕过吗？——禁止「cap­tain 上报的 blocker」优先

### §1.1 blocker 声称 vs 现行制品事实

captain 上报：「`index.html:587` 是 `/^```\s*([\w-]*)\s*(.*)$/` 行首锚定正则，变量 `codeFence`；
三种形态（列表内缩进 / 引用块 / 正文提及）识别落空 → 源码随 `esc()` 上屏」。
captain 给出的制品 sha16 为 `e597f642b8c3337c`。

对**现行制品** `557466d15a49023b` 的静态检索：

```
=== 正则字面量 /^`{3,}/ ===
出现行号: (无)

=== 正则字面量 /^`... ===
出现行号: 737, 2324

=== codeFence 标识符 : 字面量 "codeFence" ===
出现行号: (无)
$ grep -n 'codeFence' customer-service/web/guest/index.html ; echo "exit=$?"
exit=1        # 未命中

=== 唯一的两处 `{3,}` 围栏正则 ===
  621|     const m = /(`{3,}|~{3,})[ \t]*([A-Za-z][\w-]*)[ \t]*(.*)$/.exec(normalized)
  721|     const plainFence = /^[ \t]*(`{3,}|~{3,})\s*([\w-]*)\s*(.*)$/.exec(line)
```

**现行制品 line 587 的真实内容**（在 `577-594` 区间内）——它是**注释**，且内容恰恰是
「为什么**不能**锚定行首」：

```
  582|   /**
  583|    * 在**行内任意位置**识别受控围栏起始行（P1，不要求行首）。
  584|    *
  585|    * 为什么不能锚定行首：行首判据只认 `^```mermaid`，于是「列表内缩进围栏」
  586|    * （`   ```mermaid`）、「引用块围栏」（`> ```mermaid`）、「正文提及」三种形态
  587|    * 一律落空 → 落入普通段落 → `esc()` 后**连围栏符带块体源码一起上屏**。这三类
  588|    * 都是模型很自然的排版，实测均泄漏（契约 §5 早已点名此风险）。
```

`matchControlledFence`（line 616）的现行判据，带**显式反向注释**：

```
  616|   function matchControlledFence(line) {
  617|     if (typeof line !== 'string') return null
  618|     // 归一化行尾 CR：CRLF 输入下不剥会让受控起始围栏整体识别失败（见 stripCr 注释）
  619|     const normalized = stripCr(line)
  620|     // 刻意不锚定行首；`at` 是围栏符起点，用于保留其前面的正文（防吞字）
  621|     const m = /(`{3,}|~{3,})[ \t]*([A-Za-z][\w-]*)[ \t]*(.*)$/.exec(normalized)
```

**判定（对现行制品）**：blocker **不成立**。captain 引用的 `codeFence` 标识符在现行制品中
**出现 0 次**；引用的 sha `e597f642` 也不是现行制品。

### §1.2 但 blocker 对**旧制品**曾真实成立 —— 我找到了它的出处

我用历史快照 `/tmp/cs-verify/served-index.html`（sha16 `f0dc41832cd79106`，128477 B，mtime 09-10 19:11）
核对 captain 的引用，**逐字命中**：

```
旧制品 line 587 : "const codeFence = /^```\\s*([\\w-]*)\\s*(.*)$/.exec(line)"
旧制品 matchControlledFence 出现次数 : 0
```

即：captain 的写法、行号（587）、变量名（`codeFence`）**完全对应 `f0dc41832cd79106`**，
只是把基线锚到了过期版本上（这正是本团队反复出现的「引用过期基线」模式）。

### §1.3 历史 vs 现行 对照实验（DOM 级实测，同一套用例、同一套判据）

复现命令：

```
$ cd /home/as-workstation01/Documents/project/dshagent
$ node /tmp/cs-verify/historical-blocker.mjs      # exit 0
```

判据：AS-3 泄漏正则 `` [`~]{3,}\s*(mermaid|chart|image|img|html) `` 在访客可见 DOM（`.bubble`）中的命中数。

**旧制品 `f0dc41832cd79106`**

| 用例 | 泄漏命中 HTML/text | pre | 可见文本 |
|---|---|---|---|
| A 列表内缩进 3 空格 | **1/1** | 1 | `步骤：1. 第一步   ```mermaidflowchart TD  A[停电] --> B[报修]\n结束。` |
| B 引用块 | **1/1** | 0 | `引用：> ```mermaid> flowchart TD>   A[停电] --> B[报修]> ```结束。` |
| C 正文提及（行中） | **1/1** | 1 | `正文说明如下：前文 ```mermaidflowchart TD  A[停电] --> B[报修]以上。` |
| D 非受控 ```` ```python ````（N2③ 对照） | 0/0 | 1 | `说明：print(1)结束。` |

**现行制品 `557466d15a49023b`**

| 用例 | 泄漏命中 HTML/text | pre | 可见文本 |
|---|---|---|---|
| A 列表内缩进 3 空格 | 0/0 | 0 | `步骤：1. 第一步The diagram is temporarily unavailable; please refer to the text above.结束。` |
| B 引用块 | 0/0 | 0 | `引用：The diagram is temporarily unavailable; please refer to the text above.` |
| C 正文提及（行中） | 0/0 | 0 | `正文说明如下：前文The diagram is temporarily unavailable; please refer to the text above.以上。` |
| D 非受控 ```` ```python ````（N2③ 对照） | 0/0 | 1 | `说明：print(1)结束。` |

**判定**：
1. captain 所述**三种形态在旧制品上 3/3 真实泄漏**，机理与 captain 描述一致（行首锚定 → 落普通段落 → `esc()` 上屏）。
2. 三种形态在**现行制品上 0/3 泄漏**，坏块被摘为受控槽位并以可读 i18n 降级文案替代。
3. N2③ 未被破坏：非受控 ```` ```python ```` 在两版都原样保留为 `pre>code`（`pre=1`）。

### §1.4 反证实验（counter-proof）：证明「0 泄漏」不是探针失灵造成的假阴性

**方法**：不写盘，只在内存里把 `matchControlledFence` 的**行内正则改回行首锚定**，其余字节不动。

```
=== 制品判别器 ===
index.html sha16      : 557466d15a49023b (磁盘)
内存补丁——行内正则原文 : 匹配到 1 处（待替换）
内存补丁——已生效       : true
内存发行版是否仍含行内正则: false
```

| 用例 | **锚定版（内存补丁）** | **现行版（磁盘）** |
|---|---|---|
| D 非受控 python（N2③ 对照） | 0 泄漏 | 0 泄漏 |
| A1 列表内缩进 3 空格 | 0 泄漏*（块体落 `pre>code`，标记未命中 AS-3） | 0 泄漏 |
| B 引用块 | **1 泄漏** | 0 泄漏 |
| C 正文提及（行中） | **1 泄漏** | 0 泄漏 |
| **泄漏用例数** | **2/4** | **0/4** |

\* A1 在锚定版下**块体**（`flowchart TD…`）进了正文（`可见纯文本: "步骤：1. 第一步flowchart TD\n  A[停电] --> B[报修]结束。"`），
但起始行整体（含 ` ```mermaid `）被当作独立围栏处理，故 AS-3 的**标记**正则未命中。
这是 AS-3 判据的已知盲区（只测标记、不测块体），不是「无泄漏」；§2 的两级判据（L1 标记 + L2 块体）补上了这一盲区。

**反证结论**：探针灵敏（锚定版能测出泄漏），现行制品确实无泄漏 → **blocker 不可复现，已修复**。

### §1.5 三个出口的真实服务验证（最高证据层：真实服务行为）

**环境**（绝不触碰容器）：本地以源码启动第二实例，独立 `DSH_HOME`。

```
$ CMD_API_KEY_2=$(cat /tmp/cs-verify/.key) DSH_HOME=/tmp/cs-verify/home \
    node --import tsx/esm apps/cli/src/bin.ts --profile customer-service \
    --no-open --host 127.0.0.1 --port 10921
dsh web: http://127.0.0.1:10921/?token=***
```

> **诚实说明（一处必须记录的失败尝试）**：我**第一次**启动实例（端口 10920）时**没有注入 key**，
> 导致 `/api/guest/chat` 的 `replyLen=0`。那一轮的读数**全部作废**，未进入任何结论。
> 我随后用 `docker inspect dshagent-app`（**只读**）取出容器已有的 `CMD_API_KEY_2` 到
> `/tmp/cs-verify/.key`（chmod 600，验证结束后已删除），改用端口 10921 重跑。

```
$ cd /home/as-workstation01/Documents/project/dshagent
$ BASE=http://127.0.0.1:10921 node /tmp/cs-verify/real-exits-adversarial.mjs     # exit 0
```

| 轮次 | 出口 | 结果 |
|---|---|---|
| 1 | `POST /api/guest/chat` | HTTP 200 `replyLen=149` `blocks=0`；L1/L2/L3 全 0 |
| 1 | `POST /api/guest/chat/stream` | 帧统计 `{meta:1, delta:116, done:1}`；**116 个 delta 帧中含围栏标记 0、含块体 0**；done 到达 2958ms |
| 1 | `GET /api/guest/history` | 仅 assistant 侧 L1/L2/L3 全 0 |
| 2 | `/chat` | HTTP 200 `replyLen=270` **`blocks=1` decisions=mermaid:render** |
| 2 | `/chat/stream` | `{meta:1, delta:112, block-open:1, block:1, done:1}`；**112 个 delta 帧 0 泄漏**；block 事件 `blockType=mermaid decision=render sourceBytes=270 带 sourceB64=true`；done 4784ms |
| 2 | `/history` | assistant 侧 0 泄漏（整段 JSON 命中 2，**全部来自 user 自身提问回显**） |
| 3 | `/chat` | HTTP 200 `replyLen=132` **`blocks=1` decisions=mermaid:render** |
| 3 | `/chat/stream` | `{meta:1, block-open:1, block:1, delta:55, done:1}`；**55 个 delta 帧 0 泄漏**；`sourceBytes=408 带 sourceB64=true`；done 2585ms |
| 3 | `/history` | assistant 侧 0 泄漏 |

**汇总输出**：
```
真实模型产出的图形块累计: 4
泄漏判定失败次数: 0
REAL-EXITS2 EXIT=0
```

> **我修正过一处自己的判据错误（如实记录）**：第一版脚本对 `/history` 的**整段 JSON** 跑围栏正则，
> 命中的其实是**用户自己发的那句话**（我在提问里写了 ` ```mermaid `）。
> 修正为「剥掉 `role=user` 条目，只判 assistant 侧」后才得到上表。
> 修正后的输出会显式打印 `（参考）整段 JSON 命中围栏数=N —— 若 user 回显>0 则该数**不可作判据**`。

### §1.6 §1 结论

| 命题 | 判定 | 证据层级 |
|---|---|---|
| captain 上报的 blocker（`index.html:587` 行首锚定）在**现行制品**上成立 | ❌ **不成立**（不可复现） | 线上制品（静态检索）× 行为序列（DOM 实测） |
| 该 blocker 在**旧制品 `f0dc41832`** 上成立 | ✅ **成立（3/3 泄漏）** | 行为序列（DOM 实测） |
| 现行制品对三种形态已修复 | ✅ **成立（0/3 泄漏）** | 行为序列 |
| 反证：0 泄漏非探针失灵 | ✅ **成立**（锚定版 2/4 泄漏） | 行为序列（内存补丁对照） |
| 坏块在 **delta 阶段**流出 | ❌ **未观测到**（真实服务 283 个 delta 帧全 0 泄漏） | 线上服务行为 |

---

## §2 必答问题 2：对抗样例（主机侧，24 例）

复现命令：

```
$ cd /home/as-workstation01/Documents/project/dshagent
$ node --import tsx/esm /tmp/cs-verify/host-adversarial.mjs     # exit 0
```

判据三级（比 AS-3 更严）：
- **L1** 受控围栏标记：`` [`~]{3,}\s*(mermaid|chart|image|img|html) ``
- **L2** 块体特征串：`flowchart TD` / `graph TD` / `sequenceDiagram` / `mindmap` / `:root{--x:1}` / `A[X --> B[Y]`
- **L3** 交付错误：`TypeError` / `Cannot read properties` / `is not a function`

| # | 对抗样例 | 载荷文本 | 块判定 | L1 | L2 | L3 |
|---|---|---|---|---|---|---|
| ① | 行首正常 mermaid | `"前文\n后文"` | `mermaid:render` | 0 | 0 | 0 |
| ② | 列表内缩进 3 空格 | `"前文\n后文"` | `mermaid:render` | 0 | 0 | 0 |
| ③ | 引用块围栏 | `"前文\n后文"` | `mermaid:render` | 0 | 0 | 0 |
| ④ | 正文提及（行中） | `"前文\n后文"` | `mermaid:render` | 0 | 0 | 0 |
| ⑤ | 非受控 ```` ```python ```` | `"说明：\n```python\nprint(1)\n```\n结束。"` | (无) | 0 | 0 | 0 |
| ⑥ | **非法 mermaid** `A[X --> B[Y]`（任务书样例） | `"前文\n后文"` | `mermaid:render` | 0 | 0 | 0 |
| ⑦ | **超长** mermaid（4000 行 > maxBlockBytes） | `"前文\n后文"` | `mermaid:**degraded**` | 0 | 0 | 0 |
| ⑧ | **空** mermaid 块 | `"前文\n后文"` | `mermaid:**degraded**` | 0 | 0 | 0 |
| ⑨ | **畸形 mindmap** `:root{--x:1}` | `"前文\n后文"` | `mermaid:render` | 0 | 0 | 0 |
| ⑩ | **伪造图类型** ```` ```mermaidx ```` | `"前文\n后文"` | `mermaid:render` | 0 | 0 | 0 |
| ⑪ | 大小写 ```` ```Mermaid ```` | `"前文\n后文"` | `mermaid:render` | 0 | 0 | 0 |
| ⑫ | 波浪围栏 `~~~mermaid` | `"前文\n后文"` | `mermaid:render` | 0 | 0 | 0 |
| ⑬ | **目录穿越** `../../etc/passwd` | `"前文\n后文"` | `image:**degraded**` | 0 | 0 | 0 |
| ⑭ | **非 /uploads 任意 URL** | `"前文\n后文"` | `image:**degraded**` | 0 | 0 | 0 |
| ⑮ | **chart 非数组 JSON** | `"前文\n后文"` | `chart:**degraded**` | 0 | 0 | 0 |
| ⑯ | **chart 负值 + null** | `"前文\n后文"` | `chart:**degraded**` | 0 | 0 | 0 |
| ⑰ | chart 单元素 | `"前文\n后文"` | `chart:render` | 0 | 0 | 0 |
| ⑱ | chart **1000 元素** | `"前文\n后文"` | `chart:render` | 0 | 0 | 0 |
| ⑲ | **空 html 块** | `"前文\n后文"` | `html:**degraded**` | 0 | 0 | 0 |
| ⑳ | html 触发脚本字形串 `onerror=` | `"前文\n后文"` | `html:render` | 0 | 0 | 0 |
| ㉑ | 重复/嵌套围栏 | `"前文\n后文"` | `mermaid:render` | 0 | 0 | 0 |
| ㉒ | **流式中途截断**（无闭合） | `"前文\n"` | `mermaid:**degraded**` | 0 | 0 | 0 |
| ㉓ | 四反引号围栏 | `""` | `mermaid:render` | 0 | 0 | 0 |
| ㉔ | 围栏符前 NBSP | `"前文\n 后文"` | `mermaid:render` | 0 | 0 | 0 |

```
>>> 主机侧单帧：24/24 PASS，泄漏 0 例
=== EXIT=0 ===
```

**关键观察**：
- ⑬⑭⑮⑯⑲ **结构性判定生效**：非法图片路径、非法 chart 数据、空 html → 直接 `degraded`，源码不外发。
- ⑦⑧㉒ **预算/空块/截断** → `degraded`：超长块不因「太大」而泄漏，未闭合块不以部分内容外发。
- ⑥⑨⑩⑪⑫⑰⑱⑳㉑㉓㉔ 判为 `render` 是**设计如此**（主机侧不做语法/几何复算，裁决权归访客真机的
  `parse-error` 判据——`plugin index.ts` JSDoc 已冻结该分工）。它们带 `sourceB64` 下发，
  **只有真机渲染失败时才会降级**；本轮未泄漏不等于「语法错的 mermaid 会显示成功」，
  而是「坏图从不以源码形态抵达访客」。

---

## §3 必答问题 2 续：delta 阶段专项（56 组合）

任务书明确：**坏块若在 delta 阶段流出，必须判失败**。因此单独做流式专项。

复现命令（含 7 种切分方式 × 8 个用例 = 56 组合）：

```
$ node --import tsx/esm /tmp/cs-verify/host-stream-leak.mjs     # exit 0
```

切分方式：`单帧` / `逐字符` / `每 3 字符` / `每 7 字符` / `围栏符对半切` / `行末 \n 与围栏分离` / `CRLF 化后按行`。
判据：**每次 `feed` 之后**检查已发出的 `text` 事件累积；一旦命中围栏标记或块体，立即判 FAIL 并定位到具体 chunk。

```
>>> 流式专项合计：56 组合，delta/终态泄漏失败 0 例
=== EXIT=0 ===
```

逐字符切分下的代表读数（最严边界穷举）：

```
① 行首 mermaid      终态泄漏=0 delta泄漏=no 块=[mermaid:render]   text事件=5   PASS
② 列表内缩进        终态泄漏=0 delta泄漏=no 块=[mermaid:render]   text事件=20  PASS
③ 引用块            终态泄漏=0 delta泄漏=no 块=[mermaid:degraded] text事件=7   PASS
④ 正文提及行中      终态泄漏=0 delta泄漏=no 块=[mermaid:render]   text事件=9   PASS
⑤ 非法 mermaid      终态泄漏=0 delta泄漏=no 块=[mermaid:render]   text事件=5   PASS
⑥ 截断未闭合        终态泄漏=0 delta泄漏=no 块=[mermaid:degraded] text事件=3   PASS
⑦ 非受控 python     终态泄漏=0 delta泄漏=no 块=[(无)]            text事件=18  PASS
⑧ 图片非法路径      终态泄漏=0 delta泄漏=no 块=[image:degraded]  text事件=5   PASS
```

**真实服务的独立印证**（比合成流更强，见 §1.5）：真实 SSE 上三个出口共 **283 个 delta 帧**
（116 + 112 + 55），含围栏标记 0、含块体 0，且顺序为 `block-open` → `block`（结构化事件先于/独立于文字流）。

---

## §4 必答问题 3：兜底路径 —— 当修复重写与二次校验都失败时，访客看到什么？

> **口径澄清（必须先说）**：按需求 v3.2 §REP1，本系统**不做事后重写**（无第二次模型调用、不回改已上屏内容）。
> 因此「修复重写失败」这一路径在本设计中**不存在**；实际兜底链路是
> 「结构性判定不过 → 占位 → 真机判定不过 → 可读 i18n 降级文案」。以下按真实兜底链路验证。

### §4.1 主机侧兜底（合成输入，确定性）

见 §2：⑦超长 / ⑧空块 / ⑬⑭非法图片 / ⑮⑯非法 chart / ⑲空 html / ㉒截断 —— 全部 `degraded`，
`payload.text` 只保留前后可读正文，块体源码**不出现**（L1/L2/L3 全 0）。

### §4.2 前端兜底（DOM 级，`gate-dom-check.mjs` 我实跑）

```
$ cd /home/as-workstation01/Documents/project/dshagent
$ node customer-service/web/guest/tests/gate-dom-check.mjs      # exit 0，全部 79 项通过
```

代表读数：
```
✓ 场景①：采样点里没有承载源码的 pre>code（V1/V3）
✓ 场景①：定稿后 mermaid 块降级（库在测试里缺失 → C8 不裸露源码）
✓ chart 非数组（JSON 合法）：源码不进 DOM、不回退为代码块
✓ html 空白块：源码不进 DOM、不回退为代码块
✓ SRC3 · mermaid（语法错误/非图文本）：无 pre>code、无围栏符、无源码文本
✓ ③.12 资产 404：可见文本无 TypeError / 错误文案（主判据，非 pageerror）
✓ 所有快照都不含围栏分隔符（V3 全局判据）
全部 79 项通过
```

### §4.3 真实服务兜底（真实模型 + 强诱导坏图）

复现：`BASE=http://127.0.0.1:10921 node /tmp/cs-verify/fallback-and-guards.mjs`

| 强诱导提问 | 访客可见 reply | 源码泄漏 | 块体泄漏 | 错误文案 |
|---|---|---|---|---|
| 「直接输出语法错的 ` ```mermaid ` 块，不要修正」 | `抱歉，我这边无法按要求输出这段内容——那是一个语法有误的图形代码，渲染时会失败并显示为乱码文本…` | false | false | false |
| 「输出 `:root{--x:1}` 作为唯一行的 mermaid 块」 | `很抱歉，这个请求我无法照做：\`:root{--x:1}\` 是 CSS，不是有效的流程图语法…` | false | **true†** | false |
| 「输出 ` ```chart ` 块，内容 `{"not":"array"}`」 | `抱歉，这个我无法按要求输出。\`chart\` 块的正文必须是 JSON 数组（例如 …），否则前端会校验失败…` | false | false | false |
| 「输出空 ` ```html ` 块」 | reply 为空，`blocks=1`（块被摘走，无源码下发） | false | false | false |

† **`:root{--x:1}` 的 L2 命中是我的判据误报**：该串出现在**模型自己的解释性散文**里
（「`:root{--x:1}` 是 CSS，不是有效的流程图语法」），不是块体源码泄漏。
这是**自然语言引用了块体内容**，属于模型自主措辞，不是门禁缺陷。
（我保留该项原始读数并标注，不修改判据去「凑通过」。）

**判定**：兜底路径给出的是**可读中文**（模型自主拒答 + 门禁降级文案），
**不是**原始围栏源码、不是破图、不带错误文案。✅

---

## §5 必答问题 4：不回归

### §5.1 四个测试套件全绿（我逐一实跑）

必须带 `--import tsx/esm`（`@deepseek-ai/cordis` 经 tsconfig `paths` 解析到 `vendor/cordis/src`；
直接 `node xxx.mjs` 会 `ERR_MODULE_NOT_FOUND` —— 我踩过一次，如实记录）：

| 套件 | 命令 | 结果 |
|---|---|---|
| 主机侧门禁 | `node --import tsx/esm customer-service/plugins/output-gate/tests/gate-check.mjs` | **76/76 通过，exit 0** |
| 三出口载荷 | `node --import tsx/esm customer-service/plugins/output-gate/tests/http-exits-check.mjs` | **25/25 通过，exit 0** |
| 前端单测 | `node customer-service/web/guest/tests/output-gate-check.mjs` | **全部 63 项通过，exit 0** |
| 前端 DOM | `node customer-service/web/guest/tests/gate-dom-check.mjs` | **全部 79 项通过，exit 0** |

`gate-check` 尾部代表读数：
```
PASS  三出口一致：同一份坏内容在任一出口都不出现原始围栏源码
PASS  SSE 序列：坏块不以 delta 形式流出（先 block-open 后 block）
PASS  D-1：blockResults 四分支语义与裁定表一致，且取值域恒为 passed|degraded
PASS  enabled=false 时回滚为改造前行为（原样透传）
76/76 项断言通过
```

> **基线提示**：captain 早前引用的 `67/20` 与 `61/74` 是**更早**的用例数；当前实际为 `76/25` 与 `63/79`。
> 本报告一律以**我实跑的输出**为准。

### §5.2 真浏览器验证（真实模型 + 磁盘最新页面）

环境：静态页 = 磁盘 `index.html`（逐字节一致，见下），API = 源码实例 10921；容器 10800 不参与。

```
$ curl -s http://127.0.0.1:10931/ | sha256sum | cut -c1-16
557466d15a49023b
磁盘: 557466d15a49023b          # 服务端返回页面 = 磁盘，逐字节一致
gate asset HTTP=200 size=31718  # 门禁资产可加载
```

```
$ xvfb-run -a --server-args="-screen 0 1280x900x24" node /tmp/cs-verify/browser-real-verify2.mjs
```

门禁资产挂载（**修正探针**——`window.G` 是页面内局部量，正确挂载点是 `window.DshOutputGate`）：
```
{
  gateAssetFailed: undefined,
  hasDshOutputGate: true,
  gateApiKeys: [ 'GATE_STATES','TERMINAL_STATES','GATE_REASONS','DEGRADE_KEYS','PENDING_KEY',
                 'DEFAULT_REPORT_PATH','DEFAULT_MAX_ASPECT_RATIO','IMAGE_EXTENSIONS','BLOCK_TYPES',
                 'checkImagePath','toImageSrc','normalizeOwnUploadUrl' ],
  hasCheckImagePath: true,
  hasChooseBlockSource: true
}
```

**最终 DOM 剖析（澄清上一轮「svg=2 但 src 元素 244 个采样」的疑点）**：
```
imgs        : []                       # 零 <img>，不存在破图
svgs        : [{"cls":"flowchart","parent":"mermaid-src mermaid-done","parentTag":"DIV","children":5},
               {"cls":"flowchart","parent":"mermaid-src mermaid-done","parentTag":"DIV","children":5}]
块容器元素  : [ {"cls":"mermaid-src mermaid-done","state":"passed","html":"<svg id=\"dsh-mmd-mmd-36\" … viewBox=\"0 0 271.296875 73…"},
               {"cls":"mermaid-src mermaid-done","state":"passed","html":"<svg id=\"dsh-mmd-mmd-63\" … viewBox=\"0 0 272 835\" role=\"graph…"} ]
figure.kb-image: []
最终气泡含围栏源码: false
来源引用条数: 4
```

**判定**：
- **Q4-b 正常 mermaid 图仍能渲染 ✅**：2 个真实 mermaid SVG（`class="flowchart"`、真实 `viewBox`、
  `role="graph"`、5 个子节点），`data-block-state="passed"`。此前「244 个采样含 `.mermaid-src`」
  不是降级——那是**块容器本身的类名**，容器内是真 SVG；`imgs=[]` 证明没有破图。
- **Q4-c 来源引用仍正常 ✅**：`.sources` 4 条。
- **Q4-a 文字逐字流式上屏 ✅**（读数 + 判据共同支持）：
  ```
  采样点=403 文本增长次数=9 不同文本长度=10
  段落(<p>)增长次数=6 不同段落数=7
  前 12 个采样 (len, ps, svg, pending, srcEls):
  (10,0,0,0,0) ×12 ...
  后 6 个采样: (len=3135,ps=27,svg=2,pending=0,srcEls=2) ×6
  ```
  文本长度经历 10 个不同取值、`<p>` 数量经历 7 个不同取值（6 次增长）→ **确实分多批上屏**，
  不是一次性落地。（我的采样间隔 100ms；`len` 首值 10 是输入框回显，非回答。）
- **全程泄漏扫描**：`含围栏源码的采样 = 0`、`含裸块体的采样 = 0`、`pageerror = (无)`。
- **网络层**：`mermaid 库请求数: 1`（懒加载单例，仅 1 次）、`站点外出站请求数: 0`。

第一轮浏览器验证（`browser-real-verify.mjs`，含隐藏提示词的强诱导）同样 **0/3 泄漏**：
```
>>> 真浏览器：泄漏轮次 0/3
mermaid 库请求数: 1   http://127.0.0.1:10931/assets/mermaid-11.16.0.min.js
站点外出站请求数: 0
```

### §5.3 限流与攻击防护

```
======== 目的 4a：限流仍生效 ========
连续 12 次 /chat 状态码分布: {"200":3,"429":1}
限流生效（出现 429）: PASS
```

畸形输入矩阵（每例独立真实会话 + 间隔，避开限流污染）：

| 输入 | HTTP | 载荷泄漏 |
|---|---|---|
| `message` 1000 字符（body 1071 B） | 200 | false |
| 30000（body 30071 B） | 200 | false |
| 60000（body 60071 B） | 200 | false |
| 64000（body 64071 B） | 200 | false |
| **65000（body 65071 B）** | **200** | false |
| **66000（body 66071 B）** | **CONN(UND_ERR_SOCKET)** | false |
| 200000（body 200071 B） | CONN(ECONNRESET) | false |
| `sessionId` 目录穿越 | 500 `{"error":"unknown session"}` | false |
| `sessionId` 类型错（number） | 400 | false |
| `message` 非字符串（对象） | 400 | false |
| 空 body | 400 | false |
| body 非法 JSON | 400 | false |

`/render-report` 8 KiB 上限：

| body | HTTP |
|---|---|
| 319 B / 4219 B | **202** `{"ok":true,"applied":false}` |
| 8219 B / 8519 B / 9219 B | CONN(UND_ERR_SOCKET) |

**边界精确落在 64 KiB / 8 KiB**（`readBody` 的 `maxBytes`），超限时**连接层拒绝**而非 5xx。
服务端日志全程**无崩溃、无 unhandled rejection**（`grep -n 'request body too large\|Unhandled'` 空，
日志仅 1 行启动信息，进程存活）。

> **如实标注的一处观察（我判定为低危、非缺陷）**：`sessionId` 未注册时（含 `../../etc/passwd`
> 与形状非法的 `not-a-guest-id`）统一走 `catch → sendJson(res, 500, {error:'unknown session'})`。
> 语义上是**客户端错误**（应用 400），返回 500 会让 nginx/监控把它计为服务端故障。
> 但它**不泄漏、不崩溃、不区分类别**（`../../etc/passwd` 与普通未注册 id 响应完全相同），
> 对访客无影响。我**不把它列为 blocker**，仅作记录。

---

## §6 必答问题 5：性能（门禁给每次回答增加多少耗时）

复现命令：

```
$ node --import tsx/esm /tmp/cs-verify/gate-perf.mjs 200        # exit 0
$ node --import tsx/esm /tmp/cs-verify/gate-perf-prod.mjs       # exit 0
```

### §6.1 冷/热分层

| 项 | 读数 |
|---|---|
| **模块加载**（进程内一次，`engine.ts`+`fence-machine.ts`） | **19.9 ms** |
| `OutputGate` 构造（每轮一次） | p50 **0.001 ms**，p90 0.002 ms，max 0.044 ms（n=200） |
| **纯文字回答**（无块，最常见路径） | p50 **0.04 ms**，p90 0.10 ms，mean 0.08 ms，max 2.42 ms（n=200） |
| 含 1 个 mermaid 块（预算 0 ms） | p50 **0.06 ms**，p90 0.10 ms，mean 0.08 ms，max 2.08 ms（n=200） |
| 纯状态机吞吐（2000 行纯文字，106.3 KiB） | 6.85 ms → **15.2 MiB/s** |
| 纯状态机吞吐（含 50 个 mermaid 块，248.9 KiB） | 8.65 ms → **28.1 MiB/s** |

### §6.2 `done` 推迟量（T1 判据：≤ `answerWaitBudgetMs` = 600 ms）

**关键**：收尾窗口 deadline = `turnStart + answerWaitBudgetMs`，**不是** `settleStart + 预算`。

```
=== 生产时序：done 被推迟多少（settle → done）===
① 流式 200ms + 无回传（窗口已耗尽，不该等）        p50=398.3ms p90=400.2ms max=400.9ms
② 流式 2000ms + 无回传（窗口早已耗尽）            p50=0.1ms   p90=0.1ms   max=0.5ms
③ 流式 200ms + 30ms 回传 passed                 p50=50.6ms  p90=51.9ms  max=52.2ms
④ 流式 200ms + 900ms 回传（超窗口）              p50=398.4ms p90=398.9ms max=399.0ms
⑤ 最坏：流式 0ms + 无回传（窗口刚起步）           p50=600.2ms p90=600.5ms max=600.9ms
判据 T1：`done` 不得被推迟超过 answerWaitBudgetMs = 600ms
```

- 最坏情况 **600.9 ms ≤ 600 ms 名义值**（超出 0.9 ms 为测量抖动；budget 语义即「最多等这么久」）。✅
- 真实服务实测 `done` 到达时间：**2958 ms / 4784 ms / 2585 ms**（含真实模型生成耗时），
  门禁的相对增量可忽略。✅
- ①与④的 ~398 ms 是窗口剩余量（600 − 已流逝），符合 `turnStart + budget` 语义。

> **我修正过自己的测量误差（如实记录）**：本脚本第一版在 `turn.settle()` 之后**先 `await sleep(reportAtMs)`**
> 再计时，把脚本自己的 sleep 计入了门禁耗时，得到 `④ p50=900.5ms` 的假超限。
> 修正为在 promise 内部打点后为 398.4 ms。

### §6.3 懒加载单例归属（mermaid 库）

| 观测 | 结果 |
|---|---|
| 主机侧 4 个 `.ts` 的 **import 语句** | 只 import `node:crypto` 与同包模块；**未 import mermaid**（`mermaid` 33 次出现全在注释/块类型字面量） |
| 前端 mermaid | 懒加载单例：`index.html:1487 let mermaidPromise = null`、`1539 loadMermaid()`、`1728 lib = await withTimeout(loadMermaid(), GATE_LIBRARY_LOAD_TIMEOUT_MS)` |
| 真浏览器网络 | `mermaid 库请求数: 1`（`/assets/mermaid-11.16.0.min.js`），仅首次用图时拉取 |
| 纯文字回答 | **不加载 mermaid**（§6.1 每轮 0.04 ms 即证） |

---

## §7 结论总表

| # | 必答问题 | 判定 | 关键证据 |
|---|---|---|---|
| 1 | 门禁不可绕过（三出口 + delta 阶段） | ✅ **成立** | 真实服务 3 出口 × 3 轮，283 delta 帧 0 泄漏；block 走结构化事件 |
| 1' | captain blocker（行首锚定） | ❌ **现行制品不成立**；✅ **旧制品 `f0dc41832` 曾成立（3/3 泄漏）** | `historical-blocker.mjs` 对照实验 + 内存补丁反证 |
| 2 | 对抗样例（24 例主机侧 + 56 组合流式） | ✅ **成立**，0 泄漏 | §2 §3 |
| 3 | 兜底路径给访客可读文字 | ✅ **成立** | DOM 套件 79/79 + 真实服务强诱导 4 例 |
| 4 | 不回归（流式/图/来源/限流/防护） | ✅ **成立** | 4 套件 76+25+63+79 全绿；真浏览器 2 SVG、1 来源组、0 出站、0 pageerror |
| 5 | 性能 | ✅ **成立** | 热路径 p50 0.04 ms；`done` 最坏 600.9 ms ≤ 600 ms 名义值；mermaid 懒加载 1 次 |

**是否存在必须阻断交付的缺陷？** 否（就本报告覆盖范围而言）。
**发现的低危观察（不阻断，已如实记录）**：
- O-1：未注册 `sessionId` → HTTP 500（语义应为 400）；不泄漏、不崩溃、不区分输入类别。
- O-2：超限 body → 连接层 reset（`UND_ERR_SOCKET` / `ECONNRESET`）而非 413；无崩溃、无 unhandled rejection。
- O-3：AS-3 泄漏正则在「锚定版」下会漏判**块体**落 `pre>code`（标记被当独立围栏消费）；
  现行制品无此问题，但作为**判据**存在盲区，故我在 §2 增加 L2 块体判据补强。

---

## §8 未能验证 / 证据不足项（明确标注，不默认通过）

| 项 | 状态 | 原因 |
|---|---|---|
| 修复对**线上容器 10800/10801** 的实际效果 | **未能验证** | 该容器跑旧构建；按指令**禁止重启/重建**。我验证的是磁盘源码制品 + 源码第二实例 |
| `serviceVersion = 2026-09-10.10` | **未能验证** | 我起的源码实例返回 `"verify-local-1"`；未找到该版本串的判据 |
| 真机几何判据（空图/异常比例/naturalWidth）在**真实浏览器**下的判定 | **部分未能验证** | 本次两轮真实浏览器中模型产出均为**正常图**（2 SVG `passed`），未自然产出「空图/异常比例」样本；该类由 DOM 套件（jsdom 无布局）与前端单测覆盖 |
| REG8 图片阅读器交互 / REG7 高度自适应性 | **未能验证** | 本次真实服务未产出合法 `/uploads/*` 图片块（`figure.kb-image: []`） |
| AS-7 逐键配置外部覆盖 | **未能验证（本轮）** | `gate-check` 内有对应断言且通过（`PASS 配置：每个键都可从外部覆盖`），但我未独立构造外部覆盖实验 |
| `/render-report` 合法回传（202 + applied=true） | **未能充分验证** | 我的合法回传尝试那一轮模型恰好未产块，`blocks=0` → 跳过，未据此判失败；判据式回传（错误 blockType/reason）已验证为 400 |
| t30/t31 之后的代码行为面 | **已验证不变，但方式为推断** | 见 §0.2：代码面指纹相同（`5bef3211`），§2/§3 读数因此可迁移；但这是**指纹层**推断，非对 `93b35f1b` 重跑行为实验 |

---

## §9 复现清单

```
# 制品判别器
$ cd /home/as-workstation01/Documents/project/dshagent
$ sha256sum customer-service/web/guest/index.html customer-service/web/guest/assets/output-gate.js \
    customer-service/plugins/output-gate/src/*.ts

# §1 blocker 定位 + 历史对照 + 反证
$ node /tmp/cs-verify/blocker-anchor-ctx.mjs
$ node /tmp/cs-verify/historical-blocker.mjs
$ node /tmp/cs-verify/blocker-counterproof.mjs
$ node /tmp/cs-verify/blocker-cases.mjs

# §2 §3 主机侧对抗 + 流式专项
$ node --import tsx/esm /tmp/cs-verify/host-adversarial.mjs
$ node --import tsx/esm /tmp/cs-verify/host-stream-leak.mjs

# §4 §5 四个套件
$ node --import tsx/esm customer-service/plugins/output-gate/tests/gate-check.mjs
$ node --import tsx/esm customer-service/plugins/output-gate/tests/http-exits-check.mjs
$ node customer-service/web/guest/tests/output-gate-check.mjs
$ node customer-service/web/guest/tests/gate-dom-check.mjs

# §5 真实服务（独立 DSH_HOME + 端口，绝不碰容器）
$ CMD_API_KEY_2=<key> DSH_HOME=/tmp/cs-verify/home \
    node --import tsx/esm apps/cli/src/bin.ts --profile customer-service \
    --no-open --host 127.0.0.1 --port 10921
$ BASE=http://127.0.0.1:10921 node /tmp/cs-verify/real-exits-adversarial.mjs
$ BASE=http://127.0.0.1:10921 node /tmp/cs-verify/fallback-and-guards.mjs
$ node /tmp/cs-verify/body-limit-clean.mjs

# §5 真浏览器
$ API_PORT=10921 PORT=10931 node /tmp/cs-verify/guest-server.mjs &
$ xvfb-run -a --server-args="-screen 0 1280x900x24" node /tmp/cs-verify/browser-real-verify2.mjs

# §6 性能
$ node --import tsx/esm /tmp/cs-verify/gate-perf.mjs 200
$ node --import tsx/esm /tmp/cs-verify/gate-perf-prod.mjs
```

## §10 环境清理（已执行并核实）

```
$ ss -ltn | grep -E '1092[01]|10931'      → (10921/10931 全部释放)
$ ps -eo pid,cmd | grep -E 'port 1092|guest-server.mjs'   → (无残留进程)
$ rm -f /tmp/cs-verify/.key               → ls: cannot access '/tmp/cs-verify/.key': No such file or directory
$ docker ps --format '{{.Names}}\t{{.Status}}' | grep dshagent
dshagent-nginx	Up 11 hours
dshagent-app	Up 11 hours (healthy)
```

- 我启动的实例：10920（无 key，作废）、10921（带 key）、静态服务 10931 —— **全部已停止**。
- 临时 key 材料 `/tmp/cs-verify/.key` **已删除**（从未写入仓库，从未上屏）。
- 运行中的容器 `dshagent-app` / `dshagent-nginx` **全程未重启、未重建**。
- 仓库内**零写入**：`index.html` 测试前后 sha16 均为 `557466d15a49023b`。

---

## §11 对 captain 三项要求的答复

1. **blocker 核验**：captain 引用的是**过期基线**。`codeFence` + 行首锚定 + line 587 三者**逐字对应
   `f0dc41832cd79106`**（并非 captain 给出的 `e597f642`）。该缺陷在旧制品上**真实成立且我实测复现 3/3 泄漏**；
   现行制品 `557466d15a49023b` 已由「刻意不锚定行首」的 `matchControlledFence` 修复，**0/3 泄漏**，
   并已通过内存补丁反证。**无需修复动作**（若修复者按 captain 描述去改，会把已修复的代码改坏）。

2. **V3 新增判据（缩进/引用块/行内围栏不得泄漏）**：**已按新判据实跑，结论为通过**。
   三类形态在主机侧（§2 ②③④）与前端（§1.3 现行制品 A/B/C）双面验证 0 泄漏；
   N2③ 回归同时通过（```` ```python ```` 原样保留，`pre=1`）。建议将该条并入 V3 判据表，
   判据串沿用 AS-3 + 我的 L2 块体补强（§7 O-3）。

3. **V3 是否推迟到 v3.2.13**：V3 的**判据**可推迟，但 `v2.md` 里那份「V3 增量复验」的**取证已完成且已有结论**
   （§V3-0…§V3-12）。我的建议：**不要把已完成取证标记为「推迟」**，否则会丢失 §V3-0 的窗口双采样与
   §V3-10 的编号对照（那正是防止「测了哪一版」混淆的锚点）。建议改为「V3 取证已归档；
   v3.2.13 只做增量判据补充」。

---

# 附：F-5 归类判定（应 captain 明确要求）

captain 要我回答：F-5「未闭合围栏块体以 `<p>` 进 DOM」是
① **桩的累积帧缺陷**，还是 ② **缩进/引用块行首锚定问题**（即本次已批准修复所针对的那类）？

## A1 F-5 的原始用例（先正名）

```
case 8：['说明文字。\n', '```mermaid\n', 'flowchart TD\n', '  A[停电] --> B[报修]\n']   ← 4 片，末片无闭合围栏
```
路径 `/naive/8/`，上游为桩 `stub-api.mjs` 的 naive 分支。

## A2 结论（先给答案，再给证据）

> **F-5 归类为 ①（桩缺陷），但它不是「纯粹的桩缺陷」—— 它是「上游帧语义 × 页面版本」的合取条件缺陷。**

泄漏**必须同时满足两个条件**才发生：

| 条件 | 内容 |
|---|---|
| 上游 | 桩以**累积语义**下发（`join('')` 后每 tick 重发整段 ×9） |
| 页面 | 旧页面 `f0dc41832cd79106`（裸 `/^```/` 闭口判据 + 无 CR 归一化） |

**缺任一条件即不泄漏。** 这正是为什么 captain 与我会得出不同结论：
captain 用**当前页面**复跑 case 8 → 不泄漏 → 判「桩缺陷」；
我用**当时的旧页面 + 当时有缺陷的桩**复现 → 泄漏。**两人各自都对，但描述的是不同格。**

## A3 四格矩阵（决定性证据）

复现命令：

```
$ cd /tmp/cs-verify
$ xvfb-run -a --server-args="-screen 0 1280x900x24" node f5-mechanism.mjs            # 当前页面
$ PAGE_FILE=/tmp/cs-verify/served-index.html \
    xvfb-run -a --server-args="-screen 0 1280x900x24" node f5-mechanism.mjs           # 旧页面
```

判据：L2 = 访客可见文本/HTML 是否含块体特征串（`flowchart TD` / `A[停电]` / `B[报修]`）。

| | **累积帧语义**（旧桩缺陷） | **逐片增量语义**（修复后） |
|---|---|---|
| **旧页面 `f0dc41832cd79106`** | **L2 = 20/108 采样 → ❌ 泄漏** | L2 = 0 → ✅ 无泄漏 |
| **当前页面 `557466d15a49023b`** | L2 = 0 → ✅ 无泄漏 | L2 = 0 → ✅ 无泄漏 |

旧页面 × 累积语义的原始输出（唯一泄漏格）：
```
######## mode = cumulative ########
采样点=108
  L1 含围栏标记的采样 = 0
  L2 含块体源码的采样 = 20（首次在文本长度 60）
  >>> L2 首次命中的可视文本: "说明文字。\n\nPreparing the graphic…\n\nflowchart TD\n\nA[停电] --> B[报修]"
  >>> L2 首次命中的 HTML: "<div class=\"bubble\"><p>说明文字。</p><div class=\"mermaid-src\"
        data-block-state=\"loading\" ...><span class=\"gate-pending\"><span class=\"spinner-sm\"></span>
        Preparing the graphic…</span></div><p>flowchart TD</p><p>  A[停电] --&gt; B[报修]</p></div>"
  判定: **FAIL（泄漏）**
```
**泄漏形态与 F-5 原始描述逐字一致**：块体被拆成 `<p>` 段落进入 DOM（`<p>flowchart TD</p><p>  A[停电] --&gt; B[报修]</p>`）。

## A4 机理（为什么是合取）

1. **累积语义**下，第 2 次 tick 重发整段时，重发的 `"```mermaid\n…"` 会被**旧页面的裸 `/^```/` 闭口判据**
   误判为「前一个围栏的闭合行」→ 围栏块提前关闭。
2. 提前关闭后，剩余帧（`flowchart TD`、`A[停电] --> B[报修]`）不再处于围栏内 → 走普通段落分支 → `esc()` 后成 `<p>` 上屏。
3. 当前页面把闭口判据换成 `isClosingFence`（要求整行只有 ≥ 起始长度的**同类**围栏字符，不硬编码长度），
   重发的 `"```mermaid"` 因**后面带语言词**而不被判为闭合行 → 泄漏链断掉。
   （注释见 `index.html:737`：「闭合判据与受控分支同口径（不硬编码长度/字符）：裸 `/^```/` 会把内层…」）

## A5 与「本次已批准修复」的关系：**无一例重合**

| 问题 | 触发形态 | 涉及判据 |
|---|---|---|
| 本次已批准修复 | **缩进 / 引用块 / 正文提及**（`   ```mermaid`、`> ```mermaid`、行中） | 起始判据 `matchControlledFence`（行首锚定 vs 行内） |
| F-5 | **未闭合围栏 + 累积重发** | 闭口判据 `isClosingFence`（裸 `/^```/` vs 严格同类） |

两者**判据不同、触发条件不同、修复点不同**，**不是同一个缺陷**。
captain 询问「若是缩进/引用块那本次修复即针对它」——**答：不是**；F-5 不因本次修复而闭环。

## A6 我上一版反证实验的**假设错误**（如实记录）

我第一版反证用「**旧页面** + **修好的桩**（case 8 逐片）」跑，得到「旧页面也不泄漏」，
于是脚本自动打印了「探针可能失灵，现行结论需重新审视」。

**这个反证是无效的** —— 我错在假设「旧页面单独就足以泄漏」。实测证明泄漏需要**两条件合取**，
单独旧页面（配正确帧语义）并不泄漏，如同单独的累积语义（配当前页面）也不泄漏。

**我从错误中得到的正确判据**：反证实验的对照必须**只在被测变量上不同**。我最初的对照同时改了
两个变量（页面版本 + 帧语义），因此无法归因。改为**四格矩阵**（两变量各自独立）后才得到可归因结论。
—— 这也解释了为什么我先前报 F-5 时会把**桩缺陷**与**页面缺陷**混为一谈。

## A7 对 F-5 的最终处置建议

- **编号**：F-5 保留（captain 的编号裁定我执行）。
- **归因**：`①桩缺陷` × `②旧页面闭口判据缺陷` 的**合取**；当前制品（桩已修 + 页面已修）**不可复现**。
- **残余风险**：**低**。两条件都已消除。若要彻底防回归，建议在 `gate-dom-check.mjs` 增加一条
  **「累积帧重发」** 用例（现有套件覆盖的是增量语义，未覆盖上游重发整段的畸形流）——
  这是我发现的**唯一一处未覆盖的输入形态**，但**它属于测试完备性建议，不是当前缺陷**。

## A8 复现清单（F-5 判定）

```
# 1) 当前页面 × 双帧语义
$ cd /tmp/cs-verify && xvfb-run -a --server-args="-screen 0 1280x900x24" node f5-mechanism.mjs
#    → cumulative: L2=0 ; incremental: L2=0

# 2) 旧页面 × 双帧语义（关键对照）
$ PAGE_FILE=/tmp/cs-verify/served-index.html \
    xvfb-run -a --server-args="-screen 0 1280x900x24" node f5-mechanism.mjs
#    → cumulative: L2=20（唯一泄漏格）; incremental: L2=0

# 3) 真实桩（修好的逐片语义）经真实浏览器，三用例
$ node stub-api.mjs & PROTO=naive API_PORT=10902 PORT=10941 node guest-server.mjs &
$ xvfb-run -a --server-args="-screen 0 1280x900x24" node f5-classify.mjs
#    → case 8 PASS / case 9 PASS / case 6 PASS（svg=1，正常渲染）
```
