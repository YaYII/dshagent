# 输出前自审门禁 — 对抗性独立验证报告（V1）

> 角色：verifier（对抗验证者，**只写本报告路径，未修改任何实现代码**）
> 日期：2026-09-10
> 判据基线：`customer-service/docs/output-self-review-requirements.md`
> 报告性质：**正式 V1**（captain 于 2026-09-10 19:0x 放行）

---

## 0. 锁版证据

### 0.1 判据基线版本（实测，非转述）

```
$ head -1 customer-service/docs/output-self-review-requirements.md
# 客服输出前自我审核 — 需求清单与验收标准（v3.2.10）
$ wc -l customer-service/docs/output-self-review-requirements.md
624 customer-service/docs/output-self-review-requirements.md
```

**基线口径说明（必须记录）**：captain 放行指令写的是"判据基线 **v3.2.3**（473 行 / 91 条）"，
但磁盘上的文档实际为 **v3.2.10（624 行）**，比 v3.2.3 晚 7 个修订。文档自身的 **v3.2.9** 已录入
"当前有效基线（两侧）——冻结已达成"，**其值与我的实测逐字相符**（见 §0.2）。两者差异处置如下：

| 条款 | 引入版本 | 本报告处置 |
|---|---|---|
| 配置面冻结为 8 键、删 `gate.jsdomPrecheck` | v3.2.3 | **按 v3.2.3 执行**（与 captain 指令一致），逐键核对见 §8 |
| G-FREEZE 覆盖扩为「前端 + 主机侧」二元组 | v3.2.5 | **已遵守**：两侧文件均取证，见 §0.2 |
| 复验统一走源码实例、不重建镜像 | v3.2.6 | 已遵守 |
| 基线须写者停手 + 双次采样一致 + 另一方复核；放行前末次采样校验 | v3.2.7 / v3.2.8 | 已按 v3.2.9 冻结基线核对，见 §0.2 |
| **G-ANCHOR 四例**：证据须锚定最接近事实的层级（线上制品 > 行为/事件序列 > 制品指纹 > 符号存在 > 措辞 > 陈述） | v3.2.10 | **已遵守**：本报告每项结论标注证据层级；F-2 结论用**行为对照**而非符号检索（§4.3） |
| **G-ANCHOR-2/3/4**：冻结锚点取线上制品；基线不含 `tests/**`；跑测试后须复核指纹 | v3.2.10 | 已执行，见 §0.4 |

**本报告同时满足 v3.2.3 的 8 键配置面与 v3.2.10 的取证规则**，故不因版本口径产生判据缺口。

> **⚠️ 与 captain 本轮指令的两处冲突（以文档为准，如实记录）**：
> 1. 指令给出的"当前有效基线" `index.html = 3ba152739b68c6ae…（124540 B）` /
>    `output-gate.js = 184f8d52612dc375…（32118 B）` —— 该值是文档里的 **v3.2.4 基线，v3.2.7 已明确作废**；
>    文档 v3.2.9 的**当前有效基线**是 `f0dc4183…`（128477 B）/ `cdf2869a…`（34393 B），**与磁盘实测一致**。
> 2. 指令称"10800 服务页面 block-open 命中 = 4" —— 实测为 **6**（§5.1）。

### 0.2 被测制品三重标识

**① 服务端 `serviceVersion`（被测实例）**

```
$ curl -s http://127.0.0.1:10900/api/guest/health
{"ok":true,"version":"verify-local-1"}
```

⚠️ **与 G-FREEZE 期望的 `2026-09-10.10` 不同**，原因是自建实例的 `serviceVersion` 由我显式设为
`verify-local-1` 以标识"这是验证实例而非线上构建"（`deploy/profile/cordis.patch.yml` 将该值固定为
`2026-09-10.10`；我复制 profile 时改写该行以避免与线上构建混淆）。**此差异已如实记录，不作通过判据。**

**② 被测实例自己提供的页面 sha256（取该实例端口，非 10800）**

```
$ curl -s http://127.0.0.1:10901/ -o served-index.html && sha256sum served-index.html | cut -c1-16
f0dc41832cd79106        (128477 字节)
$ curl -s http://127.0.0.1:10901/assets/output-gate.js -o served-gate.js && sha256sum served-gate.js | cut -c1-16
cdf2869a625de891        (34393 字节)
$ grep -c "block-open" served-index.html
6
$ sha256sum customer-service/web/guest/index.html | cut -c1-16
f0dc41832cd79106        ← 与实例响应体逐字节一致
```

**③ 该实例 SSE 含 `block-open`/`block` 事件的证据**

```
$ curl -s -N -X POST -H 'content-type: application/json' \
    -d "{\"sessionId\":\"$SID\",\"message\":\"如何缴交电费？\",\"lang\":\"zh\"}" \
    http://127.0.0.1:10900/api/guest/chat/stream > v1-stream.txt
$ grep -o '^event: [a-z-]*' v1-stream.txt | sort | uniq -c
      3 event: block
      3 event: block-open
    272 event: delta
      1 event: done
      1 event: meta
```

**④ 声明**：**未使用 10800 作为判据**。10800 仅在 §5.1 作为「混合制品」对照出现一次，
且已明确标注"不作判据"。运行中容器 `dshagent-app` / `dshagent-nginx` 全程**未重启、未重建**。

### 0.2b 与文档 v3.2.9 冻结基线的逐字比对（证据层级：制品指纹）

文档 §16.1「✅ 当前有效基线（两侧，v3.2.9）」，采集者 captain、复核者 reviewer（8 文件全量）。

| 侧 | 文件 | 文档 v3.2.9 基线（前 16 位） | 我的实测（前 16 位） | 一致 |
|---|---|---|---|---|
| 前端 | `web/guest/index.html` | `f0dc41832cd79106`（128477 B） | `f0dc41832cd79106`（128477 B） | ✓ |
| 前端 | `web/guest/assets/output-gate.js` | `cdf2869a625de891`（34393 B） | `cdf2869a625de891`（34393 B） | ✓ |
| 前端 | `web/guest/assets/package.json` | `a51bff776fdd5322`（44 B） | `a51bff776fdd5322`（44 B） | ✓ |
| 主机侧 | `plugins/output-gate/src/fence-machine.ts` | `fd6e9cbc227268e2` | `fd6e9cbc227268e2` | ✓ |
| 主机侧 | `plugins/output-gate/src/engine.ts` | `6027b330a385b1b9` | `6027b330a385b1b9` | ✓ |
| 主机侧 | `plugins/output-gate/src/block-rules.ts` | `dafca4575e9be224` | `dafca4575e9be224` | ✓ |
| 主机侧 | `plugins/output-gate/src/index.ts` | `4d39bb58624a0e49` | `4d39bb58624a0e49` | ✓ |
| 主机侧 | `plugins/guest-server/src/index.ts` | `99110840bc1bb7ed` | `99110840bc1bb7ed` | ✓ |

**8/8 逐字相符**；`grep -c "block-open" index.html` = **6**（文档同值）。
→ 被测制品与文档冻结基线**一致**，满足 G-FREEZE「任一缺失或与基线一致时按证据不足处理」的反面（即证据充分）。

### 0.3 G-ANCHOR 合规执行（v3.2.10）

| 条款 | 要求 | 本报告执行 |
|---|---|---|
| G-ANCHOR | 引用证据须声明层级；不得以低层级支撑高层级结论 | 每项结论标注层级（见各节「证据层级」标签） |
| G-ANCHOR-2 | 冻结锚点取**线上制品**（`curl \| sha256sum`），不用本地副本 | §0.2② 的指纹取自 **被测实例响应体**（`curl 10901/`），非工作区文件；两者逐字节一致 |
| G-ANCHOR-3 | 基线**不含 `tests/**`** | 本报告基线为 8 文件，均不在 `tests/` 下（§0.2b 表） |
| G-ANCHOR-4 | 跑测试**前后**各确认一次制品指纹，用 `sha256sum -c` 校验 | **已执行**：全部测试跑完后 `sha256sum -c` **8/8 OK，exit=0**；跑测试前同样 OK。测试未改写制品树 |

> **G-ANCHOR-1 的应用（关键）**：本轮 captain 要求"独立验证 CF-1 的真实效果"与"`scanGates` 是否合格分层"。
> 这两项我**均未用符号检索下结论**：CF-1 用**真机 DOM 状态迁移行为序列**（§4.1），
> `scanGates` 用**真机运行期调用计数**（§4.2）——分别对应判据优先级的"行为/事件序列"层。

### 0.4 基线冻结与写者停手（v3.2.7 要求）

```
T1 19:27:51 index=f0dc41832cd7 gate=cdf2869a625d block-open=6
T2 19:28:01 index=f0dc41832cd7 gate=cdf2869a625d block-open=6
T3 19:28:11 index=f0dc41832cd7 gate=cdf2869a625d block-open=6
```

**主机侧制品（本报告实际使用的修订）**

| 文件 | sha256(16) | mtime |
|---|---|---|
| `plugins/output-gate/src/fence-machine.ts` | `fd6e9cbc227268e2` | 18:57:46 |
| `plugins/output-gate/src/block-rules.ts` | `dafca4575e9be224` | 17:43:50 |
| `plugins/output-gate/src/engine.ts` | `6027b330a385b1b9` | 17:44:08 |
| `plugins/output-gate/src/index.ts` | `4d39bb58624a0e49` | 17:55:16 |
| `plugins/guest-server/src/index.ts` | `99110840bc1bb7ed` | 17:33:33 |
| `web/guest/index.html` | `f0dc41832cd79106` | 19:22:00 |
| `web/guest/assets/output-gate.js` | `cdf2869a625de891` | 18:54:15 |

**⚠️ 放行前的基线漂移记录（必须知悉）**：captain 在放行指令中给出的"核实值"
（`index.html = 3ba152739b68c68ae`、`block-open = 4`）**与磁盘不符**；实测当时即为
`b887772b`/6，并在 19:08:40→19:08:55 的 15 秒窗口内再次变为 `6a75d597`，19:09:41 变为 `f0dc4183`。
**本报告以最终稳定的 `f0dc4183` / `cdf2869a` 为准**（19:27 起三次采样一致）。
`3ba15273`/`4` 与 `b887772b` 两版均已在验证过程中被写者覆盖，**无法作为被测对象**。
（文档 v3.2.7 亦已自行将 `3ba15273` 标注作废。）

---

## 1. 验证环境与清理

### 1.1 被测对象 = 源码第二实例（G-FREEZE 强制）

```
# 隔离 DSH_HOME（profile + 两张 preset 自 deploy/ 与 presets/ 复制，
#   把组合文件里的 /app/customer-service/... 与 /kb 改指本机路径）
DSH_HOME=/tmp/cs-verify/home
  profiles/customer-service/{package.json, cordis.patch.yml, cordis.yml}
  .agent-presets/{customer-service, customer-service-guest}

# 源码方式启动（端口 10900，避开 3080/10800/10801）
set -a; . customer-service/deploy/.env; set +a
cd /home/as-workstation01/Documents/project/dshagent
DSH_HOME=/tmp/cs-verify/home DEEPSEEK_API_KEY="$CMD_API_KEY_2" DSH_TELEMETRY_DISABLED=1 \
  node --import tsx apps/cli/src/bin.ts --profile customer-service \
  --no-open --host 127.0.0.1 --port 10900

# 同源游客端（复刻线上 nginx 语义：静态 + /api/guest 转发 + /uploads 回源 + 30d 图片缓存）
cd /tmp/cs-verify && node guest-server.mjs        # :10901 → 真实实例 10900
```

### 1.2 清理方式（已执行）

```sh
for p in 10900 10901 10902 10903; do
  kill "$(ss -ltnp 2>/dev/null | grep ":$p" | grep -o 'pid=[0-9]*' | cut -d= -f2 | head -1)" 2>/dev/null
done
rm -rf /tmp/cs-verify
```

运行中容器未受影响：

```
$ docker ps --format '{{.Names}}\t{{.Status}}' | grep dshagent
dshagent-nginx  Up 3 hours
dshagent-app    Up 3 hours (healthy)
```

### 1.3 真机浏览器

Playwright（`/home/as-workstation01/Documents/project/Chrome/node_modules/playwright`）
+ **系统 Chrome**（`channel: 'chrome'`），经 `xvfb-run -a --server-args="-screen 0 1280x900x24"` 运行
（headful 渲染路径；本机无可用 X 授权）。

> **对 captain 工具提示的更正**：`chromium-1228` 与当前 Playwright 所需的 `chromium-1234` 不匹配，
> 指定该 `executablePath` 会报 `Executable doesn't exist`；用 `channel: 'chrome'`（系统 google-chrome）可直接工作。
> 另：`/tmp` 下的脚本 `import` 绝对路径**可以**工作（本报告所有脚本均在 `/tmp/cs-verify/` 下运行）。

---

## 2. 验收结论总表

| # | 验收项 | 条款 | 结论 | 证据 |
|---|---|---|---|---|
| A | 源码封堵 6 点（逐点表） | SRC1–SRC5 / AS-12 | **通过（真机）** | §3.1 |
| A′ | SRC5 早时点（≤200ms，覆盖前 2s） | SRC5 | **通过** | §3.1 |
| B | 图片双通道 / IMG1–IMG8 | IMG1–IMG8 | **通过**（IMG7 已实测） | §3.2 |
| C | 三出口一致 + 载荷无源码 | E1 / AS-3 | **通过** | §3.3 |
| D | 多块并行 + `done` ≤600ms | CF-1 / P7 / T1 / AS-14 | **通过** | §3.4 |
| E | 可达性仅留痕（载荷逐字节一致） | C6 | **通过** | §3.5 |
| F | 降级终态 / 组件不可用 | REP/D/C8 | **通过** | §3.6 |
| G | 不回归 | REG1–REG8 | **通过** | §3.7 |
| — | captain 特别复核 ①：CF-1 真实效果 | — | **独立证实** | 行为（DOM 状态迁移） | §4.1 |
| — | captain 特别复核 ②：`scanGates` 兜底分层 | — | **否证**（见 F-1） | 行为（运行期调用计数） | §4.2 |
| — | F-2 修复状态复核 | — | **行为未变，仍可复现**（F-3） | 行为（同脚本 before/after） | §4.3 |

**总判定：`failed`（2 条 medium：F-1 `scanGates` 不可达抽象；F-3 F-2 修复声称与行为不符。另 F-2 本体 low）**

> **判据完整性声明**：A–G 全部通过；两条 captain 特别复核已独立完成（① 证实 ② 否证）；
> 但 **F-3 表明文档 v3.2.9 的冻结依据「F-2 已修复」与实测行为不符**，
> 该项属**流程/记录层面的不一致**，会直接误导 t6/t7，故计入 failed。

---

## 3. 逐项证据

### 3.1 A 项：6 处源码封堵（真机逐点，SRC3 分行表）

对每个封堵点开独立真机页面，100ms 采样 DOM：

| 源码封堵点 | `pre>code` 节点 | 围栏可见 | 源码可见 | 早时点(≤2s)泄漏 | 终态 |
|---|---|---|---|---|---|
| ① mermaid 容器初始内嵌源码（流式期） | 0 | false | false¹ | 0 | passed |
| ② mermaid 渲染失败分支 | 0 | false | false | 0 | degraded |
| ③ `renderImageBlock` 路径非法回退 | 0 | false | false | 0 | degraded |
| ④ `renderChart` 非数组回退 | 0 | false | false | 0 | degraded |
| ⑤ `renderChart` JSON 解析异常回退 | 0 | false | false | 0 | degraded |
| ⑥ `renderMarkdown` 未闭合图形块分支 | 0 | false | false¹ | 0 | degraded |

**SRC3 逐点结论：6 点，失败 0 点。**

> ¹ 首轮自动判据对 ①/⑥ 报"源码可见"，经逐点复核为**我的断言用词过宽**：判据里用了
> `flowchart` 这个裸词，而它会命中 mermaid 产出的 **SVG 类名** `class="flowchart"`。
> 精确判据（只针对裸源码行）实测：
> ```
> 含 class="flowchart"（SVG 类名）: true
> 含裸源码 "flowchart TD":        false
> pre>code 节点:                  0
> ```
> 本表已改用精确判据。**这是我第三次修正自己的断言噪声**（前两次见 §3.6 与旧版报告）。

逻辑层预跑（`probe-src6-table.mjs`），逐字符喂入并逐帧检查正文：

```
$ node --import tsx/esm probe-src6-table.mjs
| ① mermaid 容器初始内嵌源码（流式期） | mermaid | 无 | false | false | render | - |
| ⑥ renderMarkdown 未闭合图形块分支   | mermaid | 无 | false | false | degraded | timeout |
SRC3 逐点结论：6 点，失败 0 点
```

### 3.2 B 项：图片双通道与白名单

**IMG1 主机侧白名单**（22 条样例）：合法误拒 0、非法误放 0。

**IMG3 同源化 / IMG6 归一化**（实测）：

```
IMG3 常规       输入 /uploads/banner_cs_9af26b7f16.png
                → decision=render, imagePath=/uploads/banner_cs_9af26b7f16.png     ✓ 非绝对 URL
IMG6 自家绝对   输入 https://www.cem-macau.com/uploads/image_3f5b3a38a0.png
                → decision=render, imagePath=/uploads/image_3f5b3a38a0.png        ✓ 归一化后通过（不误杀）
外部域名        输入 https://evil.example.com/track.png
                → decision=degraded, reason=image-path-invalid, 不下发 imagePath   ✓
```

**IMG2 零出站请求**（真机台账，自建同源服务 + Playwright request 事件）：
目录穿越 / 外部域名 / `data:` / 协议相对 / `%2e%2e` / 嵌套目录 / 非图片扩展名
→ 均 **0 次 `/uploads/` 请求**、DOM 落可读降级文案。

**IMG7 CSP 真机取证**：

```
$ node probe-img7-csp.mjs
注入的 CSP 指令: img-src 'self' data:
控制台 CSP 相关: ["Loading the image 'https://evil.example.com/track.png' violates the
  following Content Security Policy directive: \"img-src 'self' data:\". The action has been blocked."]
对 evil.example.com 的实际请求数: 0
```

`img-src` 已无 `https:`，外部图被阻断且零出站 ✓

### 3.3 C 项：三出口一致 + 载荷无源码（被测实例）

```
--- /chat/stream 原始报文 ---          --- /chat ---        --- /history ---
  ```mermaid     0                      ```mermaid   0        ```mermaid   0
  ```chart       0                      ```chart     0        ```chart     0
  ```image       0                      ```image     0        ```image     0
  ```html        0                      ```html      0        ```html      0
  ```            0                      ```          0        ```          0
AS-3 正则命中: 0
```

`delta` 帧拼接（272 帧 / 473 字）：含受控围栏 `False`、含裸 `` ``` `` `False`。
本轮 3 个块全部 `decision=render`、`degradedIds=[]`，三出口块指纹一致。

### 3.4 D 项：多块并行与 `done` 时延

**CF-1 多块并行（真机轨迹，桩含 mermaid + chart + image + html 四类块）：**

```
终端状态: ["mermaid-src[passed]","chart[passed]","kb-image[passed]","gate-block[passed]"]
终态 svg/img/pre: 1 / 1 / 0
```

**T1 `done` 时延 A/B（3 次取中位，同实例/同页面/同内容）：**

```
第 1 轮（19:2x）：=== 门禁开（host 协议）===      done 时刻 ms: 3600 / 3596 / 3602 → 中位 3600
              === 门禁关等价（naive 协议）===  done 时刻 ms: 3604 / 3587 / 3604 → 中位 3604
              → 差值 -4 ms
第 2 轮（19:4x）：=== 门禁开（host 协议）===      done 时刻 ms: 3605 / 3587 / 3594 → 中位 3594
              === 门禁关等价（naive 协议）===  done 时刻 ms: 3594 / 3591 / 3588 → 中位 3591
              → 差值 +3 ms

T1 判据：done 时延差 两轮 = -4 ms / +3 ms（要求 ≤600ms）→ PASS（两轮均通过，差值在噪声量级）
```

> 口径说明：A 侧为口径 B（块摘成事件），B 侧为旧后端等价形态（正文携带围栏、无 block 事件），
> 两侧生成侧字节数与帧数一致，故 `done` 时刻之差即门禁造成的推迟。

### 3.5 E 项：可达性仅留痕（C6）

```
$ node --import tsx/esm e-parity-http.mjs
probe=true  载荷 sha256: 29a242b5cb50d7800b6a9e8eb07ffce3
probe=false 载荷 sha256: 29a242b5cb50d7800b6a9e8eb07ffce3
逐字节一致: ✅ PASS
死链图片 decision: ['image:render:/uploads/banner_cs_9af26b7f16.png',
                    'image:render:/uploads/dead-link-404.png']
```

探测开关开/关**载荷逐字节一致**；死链图片在主机侧仍为 `render`（交真机 C4 裁决），未被服务端拦下 ✓

### 3.6 F 项：降级终态与组件不可用

**四处回退的真机终态**（喂"delta 携带围栏"以触发前置渲染路径）：

| 触发条件 | `pre>code` | 源码可见 | 终态文案 |
|---|---|---|---|
| 非法 mermaid | 0 | false | `The diagram is temporarily unavailable; please refer to the text above.` |
| 图片路径非法 | 0 | false | `The image is temporarily unavailable.` + 图注保留 |
| chart 非数组 / 畸形 JSON | 0 | false | `The chart is temporarily unavailable; …` |
| 空 html / 未闭合围栏 | 0 | false | `This part of the content is temporarily unavailable; …` |
| 对照：正常 mermaid / 正常图 | 0 | false | 渲染出 `<svg class="flowchart">` / `<figure class="kb-image">` |

**组件不可用（C8）**：mermaid 资产 404 时，无 `error` 事件、文字与来源照常上屏、
终态无源码/无 `pre`、图形元素全 0 ✓

> **本条含我第二次修正的断言噪声**：早期版本把裸 `` ``` `` 当泄漏判据，导致
> "伪图类型 ` ```mmd ` 失败"的误报。按 **N2③**，非受控语言围栏属于普通代码块，
> **必须原样透传**，保留 `` ``` `` 是合规行为。改用 AS-3 正则 `[`~]{3,}\s*(mermaid|chart|image|img|html)\b`
> 后，对抗矩阵由 50/3 变为 **54/0**。

### 3.7 G 项：不回归

```
REG1 文字逐字流式：文本长度递增的采样点数 = 5 / 332
REG2 正常 mermaid 渲染：svg = 2
REG4 来源引用：.sources span = 3
无源码/围栏：含 ``` = false | 含裸 flowchart TD = false | pre = 0
mermaid 库请求数 = 1
```

**REG5 限流与攻击防护**（隔离实例独立会话）：

```
第1次相同: 200   第2次相同: 200   第3次相同: 200   第4次相同: 429
辱骂 第1次: 200（明显示意）   第2次: 429（blocked，60s）
```

**实现者四套测试（冻结修订上复跑）**：

| 套件 | 结果 | exit |
|---|---|---|
| `gate-check.mjs` | 67/67 | 0 |
| `http-exits-check.mjs` | 20/20 | 0 |
| `output-gate-check.mjs`（前端） | 62/62 | 0 |
| `gate-dom-check.mjs`（jsdom） | 50/50 | 0 |

**独立对抗矩阵**：`54 通过 / 0 失败`（24 条三出口样例 × 分帧 × 鲁棒性）。

---

## 4. captain 指定的两条独立复核

### 4.1 ① CF-1 真实效果 — **独立证实有效**

真机 DOM 轨迹（桩：mermaid + image）：

```
     394ms  SSE:block-open
     811ms  mermaid→loading
    1278ms  mermaid→passed          ← 流式期即已完成，早于 done 2323ms（本轮复测）
    2411ms  image→validating
    2561ms  image→passed
    3601ms  SSE:done

① 流式期并行开判: mermaid 首次离开 pending = 811ms | image 首次 validating = 2411ms | done = 3601ms
   早于 done: true / true
② 两块终态: ["mermaid-src[passed]","chart[passed]","kb-image[passed]","gate-block[passed]"]
③ 终态 svg/img/pre: 1 / 1 / 0
④ done 之后的状态迁移（REP5 应为空）: []
```

**结论**：两块均在流式期完成判定（`done` 之前 2391ms / 1189ms），**两块都 passed**，
`done` 后无任何回改。CF-1 声称的两个修复（P5 计时起点、流式重渲染不销毁在飞块）**在真机上确实生效**，
不是"账面正确"。

### 4.2 ② `scanGates` 兜底是否合格分层 — **否证：它已不是兜底路径**

**静态事实**：`G.scanGates` 在 `index.html` 中**只有一处出现（第 940 行）**，且该处是
**门禁资产缺失时的 NO_GATE 桩**：

```js
// index.html:940
scanGates: () => [],
```

全仓库检索（`grep -rn "scanGates" web/guest/ plugins/`）**没有任何 `G.scanGates(...)` 调用点**。

**真机实证**（给 `G.scanGates` 打计数桩后跑一轮真实回答）：

```
包装成功: true
本轮 G.scanGates 调用次数: 0
→ 口径 B 下 scanGates 是否被使用: 否
```

**真正的兜底路径是别的代码**：`renderMarkdown` 自身的围栏分支（`index.html:588-625`）
+ `gateBlockHtml()`（第 2125 行），**不经过 `scanGates`**。裁决函数是
`output-gate.js:249 chooseBlockSource({sawBlockEvent})` → `'block-events' | 'fence-fallback'`。

**问题（见 F-1）**：`scanGates` 是**导出了、被单测覆盖了、但生产不可达**的抽象；
`gate-dom-check.mjs` 第 818 行的"路径 B（兜底）"用例通过 `boot()` 搭的 jsdom 环境
**测的其实也是 `renderMarkdown` 分支**，并未调用 `scanGates`。

---

## 5. Findings

### F-1（medium）`scanGates` 是不可达抽象，且其所声称的"兜底分层"与实现不符

- **现象**：`output-gate.js:124 scanGates()` 被导出（第 705 行具名导出、第 746 行 CJS）+ 有 5 条单测
  + 被 3 处注释描述为"本地扫描路径/兜底"，但**生产代码零调用**（§4.2 双重取证：静态 grep + 真机计数桩）。
- **违约条款**：**Q5**「不留未使用抽象：每个新增配置项/函数必须被至少一条验收用例引用」——
  此处更严重：它有验收用例，**却没有生产调用点**，属于"测试守护了一个不存在的路径"。
  captain 特别关注"是否会演变成第二事实源"——答案是**不会**（它从不执行），
  但代价是**误导性**：读者会以为存在 `scanGates` 兜底，实际兜底是 `renderMarkdown` 分支。
- **影响**：不影响访客可见行为（未执行 = 无风险）；影响**可维护性与取证可信度**。
- **建议修复**（三选一，需 captain 裁定）：
  1. **删除** `scanGates` 及其 5 条单测，并把注释里的"兜底路径"改指 `renderMarkdown` 围栏分支；
  2. 若确需保留旧后端兼容语义，**让真正的兜底路径调用它**，使抽象可达；
  3. 保留但**显式标注为 dead/预留**，并在 t6 报告中说明为何不满足 Q5。
- **复现命令**：
  ```sh
  grep -rn "scanGates" customer-service/web/guest/ customer-service/plugins/
  # 唯一非注释/非导出点：index.html:940  scanGates: () => []   （NO_GATE 桩）
  node /tmp/cs-verify/scan-gates-probe.mjs http://127.0.0.1:10901 "如何缴交电费？"
  # → 本轮 G.scanGates 调用次数: 0
  ```

### F-3（medium）F-2 的修复声称与行为不符：同一脚本复跑仍 28 个泄漏采样点

> **证据层级：行为/事件序列**（G-ANCHOR-1 要求；**未使用**符号检索）

文档 §16.1 v3.2.9 的冻结依据写明「**F-2 已修复**，写者正式回报『已停手，未提交修复意图：无』」。
我用**同一脚本**（`c8-evidence.mjs`，与提出 F-2 时完全一致）在当前冻结修订上复跑：

```
$ xvfb-run -a node /tmp/cs-verify/c8-evidence.mjs
=== ⑥ 未闭合围栏：流式期块体源码进入访客 DOM ===
采样点: 89 | 命中块体源码的采样点: 28
首次命中时刻: 903 ms
命中时 innerText: "说明文字。\n\nPreparing the graphic…\n\nflowchart TD\n\nA[停电] --> B[报修]"
命中时 HTML: <div class="mermaid-src" data-block-state="loading" …></div><p>flowchart TD</p><p>  A[停电] --&gt; B[报修]</p>
末次命中时刻: 3608 ms
终态 innerText: "说明文字。\n\nThe diagram is temporarily unavailable; please refer to the text above.\n📄 page.md"
```

**结果与提出 F-2 时完全相同（28 / 89，首次命中 903ms，末次 3608ms）** —— 时间戳几乎逐毫秒一致，
说明行为未发生任何变化。故：

- **F-2 在行为层面仍可复现**，"已修复"的结论**不成立**（或修复未覆盖 `fence-fallback` 子路径）；
- 该缺陷**不影响口径 B 主路径**（真实主机协议实测 0 泄漏，§5.1 对照），故严重度仍为 low；
- 但 **v3.2.9 的冻结依据（"F-2 已修复"）与实际行为不符**，建议 captain 修订该依据，
  否则 t6/t7 会据此认为 F-2 已闭环。

> **G-ANCHOR-4 附证**：跑完本项（及全部其它测试）后复核制品指纹，8/8 `OK`、exit=0（§0.4），
> 确认上述行为来自冻结制品而非测试改写。

### F-2（low，仅部署形态相关）未闭合围栏在「旧后端 + 新前端」混用形态下会把块体当段落贴出

- **现象**：当后端**不下发 `block` 事件**时，前端走 `fence-fallback`；此时"未闭合围栏"的块体
  会以普通段落 `<p>` 进入 DOM。真机实测（桩模拟旧后端，delta 携带未闭合围栏）：
  ```
  首次命中时刻: 903 ms
  命中时 innerText: "说明文字。\n\nPreparing the graphic…\n\nflowchart TD\n\nA[停电] --> B[报修]"
  命中时 HTML: <div class="mermaid-src" data-block-state="loading" …>…</div><p>flowchart TD</p><p>  A[停电] --&gt; B[报修]</p>
  命中块体源码的采样点: 28 / 90
  ```
- **与真实协议对照（同一语义）**：
  ```
  真实主机协议（block 事件，degraded 块）: 块体/围栏进 DOM 的采样点 = 0
  旧后端兜底（delta 携带未闭合围栏）:      块体/围栏进 DOM 的采样点 = 28
  ```
- **定位**：`index.html:606-611` 的未闭合分支对受控类型只 `continue`（`fence-fallback` 时插入占位），
  但**块体行随后被外层循环当普通段落渲染**。属 `SRC2⑥` 在 `fence-fallback` 子路径上的未封堵。
- **严重度评估（low 的理由）**：
  1. **口径 B 下不可达**（主机侧摘块，正文无围栏）——实测 0 泄漏；
  2. **线上混合制品实测也未复现**：我对运行中的 10800（新前端 + 旧后端 `2026-09-10.8`）
     跑了同一问题（448 采样点），`innerText` 命中围栏/图形关键字的仅 5 点，
     原因是 `Preparing the graphic…` 占位文案，**未出现块体源码**；
  3. 需要"后端不下发 block 事件 **且** 流尾恰好停在未闭合受控围栏内"两条件同时成立。- **建议**：修复者按 `fence-fallback` 子路径补一处封堵（把未闭合分支的后续块体行一并消费掉），
  并补一条针对该子路径的单测。
- **复现命令**：
  ```sh
  node /tmp/cs-verify/c10-real.mjs      # 对照：真实协议 0 泄漏 / 兜底 28 泄漏
  node /tmp/cs-verify/c8-evidence.mjs   # 完整采样与 DOM 片段
  ```

---

## 5.1 10800 混合制品的对照复核（**不作判据**）

captain 本轮以 10800 为例强调"禁止跨制品混用"。我对该实例做了**只读对照复核**，如实记录：

```
① 10800 服务页面 block-open 命中数（指令称 4）:
   实测: 6
② 10800 后端 health（指令称 2026-09-10.8）:
   实测: {"ok":true,"version":"2026-09-10.8"}                ← 与指令一致
③ 10800 SSE 事件类型（指令称无 block 事件）:
   实测: 563 event: delta / 1 event: done / 1 event: meta    ← 无 block，与指令一致
```

**结论**：10800 确为混合制品 —— **前端是 bind-mount 的工作区新代码（`block-open`=6，与冻结基线同值）**，
**后端是镜像烘焙的旧构建（`2026-09-10.8`，SSE 无 `block` 事件）**。
captain 的担忧成立：**只看前端指纹会把 10800 误判为合格制品**（因它恰好等于当前基线），
但其后端根本不下发 `block` 事件，前端会走 `fence-fallback`。

**本报告的处置**：10800 的所有观测**仅作对照，未进入任何判据**；
A–G 与两条特别复核的证据全部取自自建源码实例（10900 / 10901 / 10903）。

> **一处数值更正**：captain 称"10800 服务页面 block-open 命中 = 4"，实测为 **6**
> （原因是 bind-mount 的工作区已更新到 `f0dc4183`，其 `block-open` 计数即 6）。
> 该差异不影响"混合制品"的定性结论。

---

## 6. 未能验证项（不默认通过）

| # | 条目 | 原因 |
|---|---|---|
| 1 | 留痕七字段实测（O2/AS-6，`docker logs … \| grep guest.output-gate`） | 运行中容器为旧构建、无门禁；自建实例日志未逐字段核对 |
| 2 | 配置逐键覆盖（AS-7 的"生效"验证） | 仅做默认值静态核对（§8）；未逐键改配置重启验证 |
| 3 | 断流自愈（REG6）与断流期块降级（P9） | 未模拟中途 kill 连接 |
| 4 | 图片阅读器交互（REG8 点击放大） | 仅核对 DOM 与代码存在，未做点击交互 |
| 5 | HTML 预览高度自适应（REG7 的高度部分） | 未测 iframe 高度随内容变化 |
| 6 | `serviceVersion` 期望值 `2026-09-10.10` | 被测实例为自建（`verify-local-1`），见 §0.2① |
| 7 | 真实模型的图形块产出率 | 被测实例用真实模型跑通（非流式与流式均返回含块回答），但块类型分布由模型决定，非受控 |

---

## 7. 与 captain 指令的差异（如实记录，均以实测为准）

| # | 指令内容 | 实测 | 处置 |
|---|---|---|---|
| 1 | 判据基线 **v3.2.3**（473 行） | 磁盘为 **v3.2.10（624 行）** | 8 键配置面按 v3.2.3（与指令一致）；其余按 v3.2.10（更严），见 §0.1 |
| 2 | 有效基线 `index.html = 3ba15273…`(124540 B) / `output-gate.js = 184f8d52…`(32118 B) | `f0dc4183…`(128477 B) / `cdf2869a…`(34393 B) | `3ba15273` 是 **v3.2.4 基线，文档 v3.2.7 已明确作废**；v3.2.9 冻结基线与我的实测 **8/8 逐字相符**（§0.2b），按 v3.2.9 执行 |
| 3 | `block-open` **= 0**（不放行理由） | **6**（19:27 起三次采样一致；10800 上亦为 6） | 接线确已闭合，指令该判据已过期 |
| 4 | 10800 服务页面 `block-open` **= 4** | **6** | 不影响"混合制品"定性（§5.1） |

**差异均不改变实质结论**：接线确已闭合（`block-open ≥ 1` 且实例 SSE 有 `block-open`/`block` 事件，§0.2③）。

## 8. 配置面 8 键逐键核对（v3.2.3 冻结）

| 键 | 文档冻结值 | 实现默认值 | 一致 |
|---|---|---|---|
| `gate.enabled` | `true` | `true` | ✓ |
| `gate.blockTimeoutMs` | `1500` | `1500` | ✓ |
| `gate.answerWaitBudgetMs` | `600` | `600` | ✓ |
| `gate.libraryLoadTimeoutMs` | `8000` | `8000` | ✓ |
| `gate.maxBlockBytes` | `32768` | `32768` | ✓ |
| `gate.serverImageProbe` | `true` | `true` | ✓ |
| `gate.serverImageProbeTimeoutMs` | `2000` | `2000` | ✓ |
| `gate.reportPath` | `/api/guest/render-report` | `/api/guest/render-report` | ✓ |

`gate.jsdomPrecheck` **未实现**（按 v3.2.3 裁决），**未测** ✓

---

## 9. 交互链路见证（同轮真实实例，非桩）

```
$ grep -o '^event: [a-z-]*' v1-stream.txt | sort | uniq -c
      3 event: block
      3 event: block-open
    272 event: delta
      1 event: done
      1 event: meta
```

页面侧同一轮（`same-turn.mjs` 已具备同轮抓取实例 health + SSE 原始帧 + DOM 快照的能力）。

---

## 10. 复核建议（供 t6）

1. **F-1** 需 captain 在三种处置间裁定（§5），它直接影响 Q5 的判定口径。
2. **F-2** 建议修复者在 `fence-fallback` 子路径补封堵，并补单测。
3. 本报告 §6 的 7 项未能验证内容，若要纳入 t6 判据，需另派取证。
