# F-1（主机侧）独立复核 —— 表格行内闭合围栏不被识别，致块体吞掉整条回答余下正文

- 复核者：`verifier`（**只读**；本报告为唯一写入物）
- 复核性质：**对 captain「放行 t13/t14」信号的响应中发现的阻断级问题**
- 证据层级：**行为序列**（真实 `OutputGate` / `FenceMachine` 驱动）＋ **制品指纹**
- 判据纪律：不内嵌易变值（基线用相对表述「与本提交制品逐字节一致」）

---

## §0 判别器（判定基线）

```
index.html            6b4bc36bd549c020   141804 B
engine.ts             2da07bdce590e6ad
fence-machine.ts      93b35f1b0eb9e127
block-rules.ts         dafca4575e9be224
index.ts              4d39bb58624a0e49
gate-check.mjs        444e6816ac7abb4e
http-exits-check.mjs  fc6c8ca4af75e907
output-gate.js        11ebac8964857f0a
```

**与 captain 的 v3.2.14 基线对比（4 项不符）**：

| 制品 | captain 声称 | 磁盘实际 | |
|---|---|---|---|
| `engine.ts` | `2da07bdc` | `2da07bdc` | ✅ 一致 |
| `http-exits-check.mjs` | `fc6c8ca4` | `fc6c8ca4` | ✅ 一致 |
| `fence-machine.ts` | `25948540` | **`93b35f1b`** | ❌ |
| `gate-check.mjs` | **`5b55d310`**（+6 断言） | **`444e6816`** | ❌ |
| `index.html` | **`07a073ce`** | **`6b4bc36b`** | ❌ |
| `block-rules.ts` / `index.ts` / `output-gate.js` | 见上 | 同 | ✅ |

**窗口内稳定性**：5 采样 × 4 s，`index.html` / `engine.ts` / `fence-machine.ts` 三个指纹 **5/5 不变**。
注：上一轮（t38 仍在写入时）曾观测到 `index.html` 连续变动 `945332a3 → e28e6e3c → 6525bf9d → 6b4bc36b`。
**当前已稳定，但 `t38` 在任务板仍为 `in_progress`**，故本报告结论标注为**「对 `6b4bc36b` 有效；t38 终态后需复采样确认」**。

---

## §1 阻断发现：F-1 主机侧 —— 表格行内闭合围栏不被识别

### §1.1 现象（真实 `OutputGate` 驱动）

输入：

```
开头正文必须保留

| 项目 | 内容 |
|---|---|
| 流程 | ```mermaid ZZQ_SECRET_BODY |

结束后文必须保留
```

输出：

```
输入字节=121  输出字节=67  丢弃=54 B
开头保留=true  结尾保留=false
payload.text = "开头正文必须保留\n\n| 项目 | 内容 |\n|---|---|\n| 流程 | "
blocks = ["mermaid:degraded"]
```

→ **`payload.text` 截断在单元格中间，其后整段正文（`结束后文必须保留`）全部丢失。**

### §1.2 表格四形态全部命中（4/4）

| 形态 | 裸标记 | 块体哨兵进 text | 后续正文保留 | 判定 |
|---|---|---|---|---|
| F-1a 标记+块体**同格** | 0 | false | **false** | **FAIL（截断）** |
| F-1b 标记在格、块体在**后续数据行** | 0 | false | **false** | **FAIL（截断）** |
| F-1c 同格 + 同行闭合符 | 0 | false | **false** | **FAIL（截断）** |
| F-1d 表头行含标记 | 0 | false | **false** | **FAIL（截断）** |

**对照项（均 PASS，证明未误伤）**：
- 普通代码块 ```` ```python ```` → 原样透传，尾部保留 ✅
- 无围栏的普通表格 → 完整保留 ✅

```
>>> 主机侧 F-1 形态失败数：4 / 4（不含 2 个对照项）   EXIT=1
```

### §1.3 **精确归因**（关键：不是「表格解析错」，而是**闭合判据漏识别**）

用真实 `FenceMachine` 直接驱动（不经 `OutputGate`），穷举闭合符的 5 种位置：

| # | 闭合符位置 | `block.closed` | 后续正文保留 | 判定 |
|---|---|---|---|---|
| ① | 无闭合 | `false` | false | 块消费到 EOF（**设计如此**） |
| ② | **同行、同格内**（`| x | ```mermaid SENT ``` |`） | **`false`** | **false** | **❌ 未识别闭合** |
| ③ | 块体在下一行、**闭合符不在** | `false` | false | 块消费到 EOF |
| ④ | 闭合符在**独立数据行**（`| ``` | z |`） | **`false`** | **false** | **❌ 未识别闭合** |
| ⑤ | **表外**独立行闭合 | `true` | **true** ✅ | 正确 |
| ⑥ | 非表格·无闭合（对照） | `false` | false | 正确（N2③ 同口径） |
| ⑦ | 非表格·有闭合（对照） | `true` | **true** ✅ | 正确 |

**结论**：

> **当受控围栏出现在表格数据行内时，只有「表外独立行的闭合符」被识别（⑤）。
> 同行同格闭合（②）与独立数据行闭合（④）均不被识别 → `closed:false` →
> 按「未闭合块消费到输入末尾」语义吞掉整条回答的余下全部正文。**

### §1.4 严重度评估

| 维度 | 评估 |
|---|---|
| 触发条件 | 模型在**表格单元格内**输出受控围栏（真实场景：`| 流程 | ```mermaid ... |`） |
| 后果 | **静默数据丢失**——块之后的所有正文（含答案结论）对访客不可见 |
| 与既有语义的关系 | 「未闭合块消费到 EOF」对**非表格**是**正确设计**（防源码上屏）；但表格内**闭合被漏识别**时，该语义**从安全特性变成数据丢失** |
| 是否泄漏 | **否**——块体源码**未进 text**（口径 B 仍成立） |
| 定级 | **blocker**（静默丢正文；且 t39 修复任务已 `cancelled`） |

---

## §2 对 captain 两问的答复

### §2.1 「D-1 修复的 tsc 判据」——**复算通过**

```
$ npx tsc --noEmit --strict --target es2022 --module nodenext --moduleResolution nodenext \
    --skipLibCheck --ignoreConfig customer-service/plugins/output-gate/src/engine.ts
customer-service/plugins/output-gate/src/engine.ts(23,28): error TS2591: Cannot find name 'node:crypto'. …
customer-service/plugins/output-gate/src/engine.ts(24,78): error TS5097: An import path can only end with a '.ts' extension when 'allowImportingTsExtensions' is enabled.
customer-service/plugins/output-gate/src/engine.ts(33,8): error TS5097: …
customer-service/plugins/output-gate/src/engine.ts(365,27): error TS2591: Cannot find name 'Buffer'. …
customer-service/plugins/output-gate/src/fence-machine.ts(78,10): error TS2591: Cannot find name 'Buffer'. …

--- TS2322 计数 --- 0
--- 总行数 --- 5
```
→ **TS2322 = 0 ✅**，残余 5 行 = 3×TS2591 + 2×TS5097，**与 captain 读数逐条一致**，且与 D-1 无关。

### §2.2 「两套件项数」——**与 captain 声称不符**

| 套件 | captain 声称 | 实测 |
|---|---|---|
| `gate-check.mjs` | 73/73（并称该文件 `5b55d310`，+6 断言） | **76/76，exit=0** |
| `http-exits-check.mjs` | 25/25 | **25/25，exit=0** ✅ |

磁盘 `gate-check.mjs = 444e6816ac7abb4e`（**不是** captain 引的 `5b55d310`），断言数 **76**（**不是** 73）。
→ 属**基线引用不符**；两套件本身**均通过**。

### §2.3 t13 / t14 任务状态

```
t13 | completed | V4 复验 D-1：三出口实测 blockResults 取值域 + 同判据恒等 + 行为无回归
t14 | completed | V5 契约↔实现一致性独立核验：§2 四来源表 vs payload() 实际分支
```
两个任务**均已是终态**，其成果已在 `output-self-review-verification-v3.md` 与 V9 报告中。
captain 的「放行 t13/t14」信号与任务板状态不符（**第 N 次基线/状态引用过期**）。

---

## §3 结论

| 项 | 判定 |
|---|---|
| D-1（`blockResults` 取值域）修复 | ✅ 成立（tsc TS2322=0，复算一致；引擎层四分支与线上报文已于前轮实测 exit=0） |
| **F-1 主机侧（表格行内闭合不识别 → 吞正文）** | ❌ **成立，blocker** |
| t13 / t14 | 均已完成（无需重开） |
| 本轮是否阻断交付 | **是** —— 表格内围栏会静默丢弃块之后的全部正文 |

**建议**：
1. **重开 t39**（主机侧 F-1 修复；该任务当前为 `cancelled`），或新建等价修复任务；
2. 修复目标**不是**「改表格解析」，而是**让表格数据行内的闭合围栏被识别**（②④两形态），
   使其与「未闭合块消费到 EOF」的安全语义**不再混淆**；
3. 保持 `closed:false` 的安全语义不变（⑤⑦ 正确，不可回退）；
4. 反证应覆盖 **①–⑦ 七形态矩阵**，要求修复后仅 ①③⑥ 保留「消费到 EOF」行为。

---

## §4 复现清单

```
$ cd /home/as-workstation01/Documents/project/dshagent
$ node --import tsx/esm /tmp/cs-verify/f1-host.mjs            # 4/4 FAIL，EXIT=1
$ node --import tsx/esm /tmp/cs-verify/f1-host-qualify.mjs    # 丢失范围 + 定位
$ npx tsc --noEmit --strict --target es2022 --module nodenext --moduleResolution nodenext \
    --skipLibCheck --ignoreConfig customer-service/plugins/output-gate/src/engine.ts   # TS2322=0
$ node --import tsx/esm customer-service/plugins/output-gate/tests/gate-check.mjs       # 76/76
$ node --import tsx/esm customer-service/plugins/output-gate/tests/http-exits-check.mjs # 25/25
```

## §5 未能验证项（明确标注）

| 项 | 状态 | 原因 |
|---|---|---|
| t38 终态后的制品指纹 | **未能验证** | t38 任务板仍 `in_progress`；本报告结论对 `6b4bc36b` 有效，需其终态后复采样 |
| 真实模型是否会在表格单元格内输出受控围栏 | **未能验证** | 本轮为确定性合成输入；真实模型的触发概率未测（相同机理此前在真实服务上触发过 1/7 左右） |
| 前端表格分支对②④形态的表现 | **未能验证** | 本轮只做主机侧；前端 `tableCell(cell, run)` 的另一套判据未在本报告范围内 |
| 线上 10800 的实际表现 | **未能验证** | captain 已声明该实例为混合制品；且禁令禁止重启，本报告不以其为被测对象 |
