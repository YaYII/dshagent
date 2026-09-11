# 客服输出前自我审核 — 需求清单与验收标准（v3.2.12）

> 版本：v3.2.12｜日期：2026-09-10｜目标目录：`customer-service/`
> 依据：V3 的 D-2（判据内嵌过期指纹）→ 新增 **G-ANCHOR-5 判据不得内嵌易变事实** 并完成一致性清扫；§16.3 补记第 6 条失责（预告与放行未分离）。
> 依据：F-4/F-4b 死代码清理完成 → 新基线录入 + reviewer 对 Q5 判定做独立核验（§16.4，含 1 条 low finding）。
> 依据：captain 要求纳入方法论条目（engineer-frontend 提炼 + captain 补第四例）与本轮流程缺陷/改进 → 新增 §16.2 G-ANCHOR、§16.3 流程缺陷与改进。
> 依据：F-2 已修复（写者回报停手）→ captain 按改进流程采集末次基线 → reviewer 8 文件全量复核并校验线上页面一致。
> 依据：captain 冻结信号（5 次采样一致）→ reviewer 依 v3.2.7 规则**录入两侧基线并通过全量复核**；主机侧门槛解除。
> 依据：captain 硬冻结协议 + reviewer 自查发现 **v3.2.4 录入的基线已过期**（文件仍在变动时录入）→ 本文撤销该基线并写入防重演教训。
> 依据：captain 澄清（2026-09-10）→ 本节写明「取证统一走源码实例、不重建镜像」及其成立前提与失效条件。
> 依据：captain 要求基线并入主机侧指纹（F-1/F-2/F-3 均为主机侧修复）→ reviewer 补强 G-FREEZE：**被测制品 = 前端 + 主机侧二元组**。
> 依据：captain 通知接线闭合 → reviewer **重录 G-FREEZE 基线**（§16.1）；旧基线标注已作废。
> 依据：captain 裁决（2026-09-10）：**配置面收敛为 8 键**，删除 `gate.jsdomPrecheck`（与 G1/Q5 冲突；C7 最强合规形态 = 不引入 jsdom 依赖）。
> 依据：captain 决策（2026-09-10）：V1 证据有效性升级为**放行前置条件（G-FREEZE）**；并补「构建标识须可机器校验」的可核验锚点（sha256 指纹 + `block-open` grep）。
> 依据：captain 裁决（2026-09-10，v3.2）：① **CF-1** P7 改**并行语义**（多块互不串行占预算；`answerWaitBudgetMs` 重新定义为「`done` 前结算的收尾窗口」），T1 措辞改为「**门禁不得推迟 `done` 超过 600ms**」；② **CF-2** C6 可达性**降为仅留痕**、不参与放行（**IMG1 路径白名单仍为硬门禁**）；③ **CF-3** 图片块随流下发、只带路径判定结果，可达性不进载荷。裁决原文语义未走样。
> 依据：captain 拍板（2026-09-10）：①「不通过必须由模型重写」**不是**产品硬要求，**取消模型重写**；② 采纳「单一裁决者 + 块级缓冲 + 服务端只补真机拿不到的信号」；③ 预算冻结 1500ms / ≤600ms；④ 图片地址白名单纳入需求；⑤ 可见性以 DOM 快照为可执行验收项；⑥ 留痕主机侧、不用于回改内容。
> 依据：captain 补充事实（2026-09-10）：**「原始围栏源码裸露」不止 mermaid 一处，四类围栏全部存在**；图片放行规则过度宽松（`data:` + 任意 `https?:`），要求写成明确条款与验收项；并要求显式区分四类围栏各自的可见性通道。
> 上游评审：`customer-service/docs/output-self-review-review-r1.md`（R1，9 条 finding，处置见 §17）
> 证据基线：运行实例 `dshagent-app`（`GET /api/guest/health` → `{"ok":true,"version":"2026-09-10.8"}`），源码 git `0e6f0cc`

## 0.1 v2 → v3 / v3.1 变更摘要（背离项）

| # | v2 条款 | v3/v3.1 处置 | 原因 |
|---|---|---|---|
| 1 | RH 系列「定向重写」（每轮 ≤1 次、20s 超时、20k 等待预算） | **删除**。改为 §8 REP 系列「输出前替换」 | captain 撤回模型重写：924×delta 流式下重写必然回改已上屏内容或等待过长 |
| 2 | 送达口径 A/B 二选一（E6 默认 B） | **冻结为口径 B**，删除 A 选项 | captain 采纳取向 B |
| 3 | 服务端图片可达性「仅告警、不参与放行」（C6） | v3 曾**改判为硬门禁**；**v3.2 已回退为「仅留痕、不参与放行」**（§8 IMG1–IMG8 的**路径白名单**仍为硬门禁） | v3.2 裁决：可达性受 `deploy/nginx.conf:53` `proxy_cache_valid 404 10m` 影响，会「缓存状态决定内容」；细化见 §7 C6 与 §8 说明 |
| 4 | 预算：200ms 校验 / 3s 访客等待 / 20s 重写 | **冻结 1500ms 单块判定 / ≤600ms 整条回答增量**，新增 `libraryLoadTimeoutMs=8000` | captain 冻结值；新增键用于把「库加载」与「判定计时」分开，否则首图必被误降级 |
| 5 | 无生成侧条款 | **新增 §4 GEN 系列（生成侧前移）** | captain 第 1 节：把「不通过需要修改」的一半落在提示词契约上 |
| 6 | 图片地址仅要求「来自知识库」（C2） | **新增 §8 IMG 白名单**（禁 `..`、查询串、绝对 URL、其它协议、`data:`） | 实测 `/uploads/../api/guest/health` 返回 200 的 guest API JSON |
| 7 | 无三要素强度判定 | **新增 §0.2 判定** | captain 第 7 节要求；不默默淡化 U2 |
| 8 | 源码裸露条款只覆盖 mermaid（F3/F5 的缺口） | **新增 §6 SRC 系列 + §2.1 通道表**：四类围栏、**6 个代码点**逐点封堵 | captain 补充事实（4 处）+ 本轮实测复核（发现第 5 通道与第 6 代码点，见 §2.1） |
| 9 | 图片放行规则未明确处置 `data:` 与外部 `https?:` | **IMG1 明确一并拒绝**（含协议相对 `//`），并给出 KB 绝对 URL 的归一化边界（IMG6） | captain 建议 + 实测：现有两条通道均放行任意外部域名；KB 自带 4 条 `https://www.cem-macau.com/uploads/…` 绝对引用 |

---

## 0.2 用户诉求 → 条款 → 验收（含强度判定，不淡化）

| # | 用户原话语义 | 覆盖条款 | 验收脚本 | 满足强度 | 判定与理由（必读） |
|---|---|---|---|---|---|
| U1 | **先内部校验才能输出**：图没通过就不能出现 | C0、C1–C4、P3–P6、V1–V3 | AS-2、AS-4、AS-10 | **完整满足** | 块级缓冲把「校验」放在送达之前：未判定合格的块不进 DOM（V1），口径 B 下连载荷都不出现源码（E7）。 |
| U2 | **不通过需要修改** | §4 GEN、§8 REP1–RE4、D1–D3 | AS-6、AS-7、AS-11 | **部分满足 → 经重新定义后满足（须 captain 确认）** | 新取向**不调用模型修正图形本身**，「修改」只发生在**送达前的内容替换**（未通过块 → 可读文字）。因此：若产品真意是「必须让那张图正确地显示出来」，本取向**不满足**，须回头讨论（代价：重写与 924×delta 流式互斥，见 R1-F2）；若真意是「不能把不对的内容给用户看，要给出可用的替代」——即「改完才给用户看」——则**满足**。本文件按后者冻结。 |
| U3 | **错误内容不得被用户看到** | P6、**IMG1–IMG8（路径硬门禁）**、**C4（真机判据）**、**C6（仅留痕）**、V1–V5、E1–E7、D2、C8 | AS-1～AS-5、AS-13、AS-14 | **完整满足（口径 B 下更强）** | 三出口终态一致；对抗样例矩阵下 DOM 无源码、无坏图、无非法 src；非法路径零出站请求；死链由真机 C4（`decode()` + `naturalWidth`）裁决后降级；组件不可用时降级而非裸露。 |
| U4 | 不破坏体验（隐含） | T1–T5、REG1–REG8 | AS-8、AS-9 | **完整满足（可测）** | 文字打字机不受影响；门禁带来的整条回答等待增量 ≤600ms（T1）。 |

---

## 1. 范围、覆盖与非目标

| 编号 | 条款 | 可执行验收方式 |
|---|---|---|
| N1 | **覆盖范围（两条链路 + 三条出口）**：<br>① **访客链路（硬门禁）**：`customer-service-guest` preset 会话的全部输出出口——`POST /api/guest/chat`、`POST /api/guest/chat/stream`、`GET /api/guest/history`（第三条出口实测存在，刷新即重放）。<br>② **Admin 链路（生成侧）**：`customer-service` preset 的提示词契约适用（GEN 系列）；官方 Web GUI 不渲染 mermaid/chart/image/html 围栏（已核 `packages/client/`、`apps/web/` 无 mermaid 渲染代码），故图形门禁（P/C/V）在 Admin 链路不适用——它没有"坏图"，只有工具性文本。<br>③ 若 Manager/Admin 的回答将来经任何通道转发给访客，必须在**出口处**过门禁（门禁挂在出口，不挂在渲染器）。 | 通读 `plugins/output-gate`、`plugins/guest-server/src/index.ts`、`web/guest/index.html`、两张 preset、profile patch；核对三出口均接入。 |
| N2 | **非目标（明确不做）**：<br>① **不做事后重写**：不调用模型二次生成、不重新提问、不回改已进入访客 DOM 的内容；<br>② **不做服务端图形语义复算**：服务端不解析 mermaid 语义、不做 chart JSON 语义校验、不做 html 检查、不做几何校验；<br>③ 不改变普通代码块（`python`/`bash` 等）与无语言围栏的展示；<br>④ 不新增第三方依赖；<br>⑤ 不调整知识库内容与检索算法；<br>⑥ 门禁结果**不用于回改内容**，只用于输出前替换与留痕。 | 逐条对照实现 diff；出现任一条即判不合规。 |
| N3 | **不得破坏的既有能力**：文字逐字流式（打字机）、来源引用、限流与攻击防护、断流自愈、图片阅读器、HTML 预览高度自适应、mermaid 懒加载（无图不下载）。 | 回归清单 REG1–REG8（§13）。 |

---

## 2. 术语与事实源

| 术语 | 定义 |
|---|---|
| 图形块 | 受控围栏块：` ```mermaid ` / ` ```chart ` / ` ```image `（含 ` ```img `）/ ` ```html `。 |
| 唯一裁决者 | 判定图形块"能否显示"的组件。**即访客浏览器内的真机渲染器**（只有它能出图并给出几何结论）。 |
| 真机信号 | 只有渲染环境能观测到的事实：`naturalWidth`、SVG 子节点与几何、解码失败、CSP 违规。 |
| 占位 | 块被判定期（`pending`/`loading`/`validating`）在正文位置的临时元素，文案来自 i18n。 |
| 输出前替换 | 未通过的块**在送达访客之前**被替换为可读等价文字（不是事后重写、不是重问模型）。 |
| 终态 | 块进入 `passed`（显示图形）或 `degraded`（显示可读文字）后不再变化。 |
| 源码裸露 | 原始围栏内容（含分隔符）以 `<pre><code>` 或任何文本形式出现在访客 DOM/载荷中。 |

| 编号 | 条款 | 可执行验收方式 |
|---|---|---|
| C0 | **单一事实源（强制）**：图形块"能否显示"的裁决权归**真机渲染器**。服务端不得否决真机能正常渲染的图形内容。服务端只允许做**一类**不依赖渲染的判定：**图片路径合法性（确定性正则，§8 IMG1）**。图片**可达性探测降为仅留痕**（C6，v3.2 裁决），不得参与放行；其余一切结论只能用于留痕。 | 代码审查：服务端无 `mermaid.parse(`/`mermaid.render(`/chart 解析调用；不存在"服务端语法判定 → 拒绝"分支；图片判定只走 §7 规则。 |

### 2.1 四类围栏的展示通道与源码裸露点（本轮实测复核，冻结）

可见性通道**因块类型而异**——这是"iframe 已沙箱化"不能作为整体安全论据的原因：

| 块类型 | 渲染通道 | 是否经 DOM 沙箱 | 源码裸露点（**以函数/代码片段为锚点**；行号随实现变动已弃用） |
|---|---|---|---|
| `mermaid` | 容器 `div.mermaid-src` → 真机 `render` 写入 `<svg>` | ❌ 否（SVG 直插页面 DOM） | ① 初始容器内含 `<pre><code>${esc(src)}</code></pre>`（`renderMermaidBlock` 内 `<pre><code>${esc(src)}</code></pre>`，**流式期即已在屏**）；② 渲染失败分支只 `console.warn`，容器保留源码（`renderMermaidNodes` 的 `catch` 分支，只 `console.warn`） |
| `image` / `img` | 直接在页面插入 `<figure><img src=…>` | ❌ 否（**页面级 `<img>`**，不受 iframe 沙箱约束） | ③ 路径不像图片时 `return <pre><code>${esc(body)}</code></pre>`（`renderMermaidNodes` 的 `catch`） |
| `chart` | 页面内 `div.chart` + 条形行 | ❌ 否 | ④ `JSON.parse` 成功但非数组 → 源码回退（`renderImageBlock` 的 `if (!looksLikeImage)` 分支）；⑤ `JSON.parse` 抛错 → 源码回退（`renderChart` 的 `if (!Array.isArray(data))` 分支） |
| `html` | `iframe[sandbox="allow-scripts"]` + srcdoc + CSP nonce | ✅ 是（唯一沙箱通道） | 无源码回退路径（`renderHtmlBlock` 全函数无条件产出 iframe）；但 iframe 内 `img-src` 允许 `https:`（见 IMG7） |

**另发现的第 5 条图片通道（captain 清单未含）**：行内 Markdown 图片 `![alt](url)` 走 `inlineMd`（`inlineMd` 的 `![alt](url)` 替换回调），放行规则与 `renderImageBlock` 不同但**同样宽松**：`/^(https?:|data:image\/|\/)/` 命中即产出页面 `<img>`。实测两条通道对 `data:`、外部 `https://`、协议相对 `//` **一律放行**（证据见 §2.2 与本轮 probe 输出）。→ 条款 IMG2 必须覆盖**两条通道**，不能只改 `renderImageBlock`。

### 2.2 本轮实测证据（通道放行矩阵）

以页面自身解析函数逐字回放（未改写）得到：

| 输入地址形态 | 通道 A：` ```image ` 围栏 | 通道 B：行内 `![alt](url)` | `imageSrcOf` 归一化结果 |
|---|---|---|---|
| `data:image/svg+xml;base64,…` | **放行** `<img src="data:…">` | **放行** | 原样 |
| `https://evil.example.com/track.png` | **放行** 外部域名 | **放行** | 原样（外部域名） |
| `//evil.example.com/x.png` | **放行** 协议相对 | **放行** | 原样 |
| `https://www.cem-macau.com/uploads/a.png` | 放行 → 归一为 `/uploads/a.png` | 放行 → 归一 | `/uploads/a.png` |
| `/uploads/banner_cs_9af26b7f16.png` | 放行（正确形态） | 放行 | 不变 |

**KB 侧事实**：`deploy/kb/` 内实测存在 **4 条** `![](https://www.cem-macau.com/uploads/image_3f5b3a38a0.png)` 形态的绝对 URL 引用（`car-model.md:4724`、`car-model.md:4979`、`ev-tip.md:917`、`ev-tip.md:931`）；`data:image` 引用 **0 条**；图片扩展名在用集合为 `jpg/JPG/png/jpeg/svg`（`pdf/zip/docx` 也在 KB 但非图片）。→ 这就是 IMG1 必须同时**拒绝任意外部主机**、又**接受自家源站绝对 URL 并归一化**的原因（见 IMG6）。

---

## 3. 出口、不可绕过与送达口径（E 系列）

实测出口（本机）：

| 出口 | 实测行为 | 角色 |
|---|---|---|
| `POST /api/guest/chat` | 返回 `{reply, sources}` | 载荷出口 |
| `POST /api/guest/chat/stream` | SSE：`meta` → N×`delta`（实测单轮 924 帧）→ `done` | 载荷出口（**主要暴露路径**） |
| `GET /api/guest/history` | 刷新重放全部历史；实测返回文本含 ` ```mermaid ` 原文 | 载荷出口（**刷新即重放**） |

| 编号 | 条款 | 可执行验收方式 |
|---|---|---|
| E1 | 门禁覆盖三条出口，同一坏内容在三条出口的**终态一致**。 | AS-4：同一对抗样例分别打三出口，比对终态。 |
| E2 | **主机侧不可绕过**：不得只靠提示词；不得把唯一把关放前端（访客可自行 `fetch` API）。主机侧必须承担：出口收口、围栏识别与结构化摘块、图片路径判定、留痕。 | 代码审查 + `curl` 三出口取证；绕过前端后主机侧仍有留痕与结构化摘块。 |
| E3 | 两条聊天出口必须共用同一收口函数；任何新增出口必须复用，禁止旁路。 | 代码审查。 |
| E4 | `history` 重放与当轮送达同一判定：刷新不得暴露当轮已替换为文字的源码。 | AS-4：坏块轮 → 记录终态 → 刷新 → DOM 快照一致。 |
| E5 | **送达口径冻结为「口径 B：主机侧结构化块」**：主机侧在 delta 流上做**跨分帧**围栏识别，把图形块摘成结构化 `block` 事件（含 `blockId`/`type`/源码/判定结果），围栏源码**不以明文出现在任何载荷**（三出口一致）。<br>**下发时机（v3.2 裁决，解 CF-3）**：图片块**随流下发**，其 `block` 事件只携带**路径判定结果**（IMG1 的确定性结论）；**可达性结论不进载荷**（只进留痕，见 C6）。因此 block 事件**不含任何「未决」字段**，也**不得为等探测而阻塞 `delta` 帧间隔**。 | 代码审查（无「等探测」分支、block 事件无未决字段）+ AS-3 报文断言 + AS-14 帧间隔采样。 |
| E6 | **跨分帧（强制）**：围栏标记可能被任意切分（如 `"``"` + `"`mermaid"`、跨多帧的闭合标记）。状态机必须逐字符累积判定，不得假设 ` ```mermaid ` 落在单个 delta 内。 | AS-11：注入分帧样例（含 1 字符/帧的最坏情况）后，识别结果与整块输入一致。 |
| E7 | 口径 B 下，` ```mermaid `/` ```chart `/` ```image `/` ```html ` 与块体源码不得出现在任何访客载荷的原始报文中。 | AS-3：`curl` 三出口 + `grep` 断言无命中。 |

---

## 4. 生成侧前移（GEN 系列，提示词契约）

定位：这是「不通过需要修改」的**前半段**——让模型尽量一次产出合法块。它是**软措施**，不得作为唯一防线（E2 的硬门禁必须独立成立）。

| 编号 | 条款 | 可执行验收方式 |
|---|---|---|
| GEN1 | 两张 preset（`customer-service/agent.cordis.yml`、`customer-service-guest/agent.cordis.yml`）的提示词必须包含**围栏块契约**：① 严格使用 mermaid 官方语法（`flowchart TD` / `sequenceDiagram` / `mindmap` / `pie`），≤15 个短节点；② 块内不得嵌套围栏，块内不得出现 ` ``` ` 序列；③ `chart` 块内容必须是 JSON 数组，元素形如 `{"label":"A","value":3}`，值必须为有限数值。 | 代码审查：两份 preset 提示词均含三段契约；`grep` 可核。 |
| GEN2 | 图片契约：`image` 块首行必须严格是 `/uploads/<文件名>`（站点相对路径），不得使用绝对 URL、其它协议、`data:`、查询串或 `..`（与 §7 同一常量正则）；图片路径必须来自知识库原文，回答中不得编造。 | 提示词审查；并用 AS-1 对抗样例验证"即使模型违反，硬门禁仍拦住"。 |
| GEN3 | 生成侧契约的效果必须**可观测**：被拦块按类型/原因聚合后，团队能看出模型是否反复违规（§12 O4）。 | 留痕聚合计数（AS-6）。 |
| GEN4 | 提示词契约不得替代硬门禁：删掉提示词约束后，对抗样例仍必须全部被拦。 | AS-1 在临时移除提示词契约后复跑一遍（记录结果，不修改仓库）。 |

---

## 5. 围栏块协议与块级缓冲（P 系列，冻结）

| 编号 | 条款 | 可执行验收方式 |
|---|---|---|
| P1 | **识别范围**：`mermaid`、`chart`、`image`、`img`、`html` 五类（`info` 带关键字同样识别，如 ` ```mermaid mindmap`）。普通代码块不纳入。 | 单测：五类 + `mermaid mindmap` + `python` + 无语言围栏。 |
| P2 | **判定单位**：一个完整围栏块（起始围栏行 → 闭合围栏行之间全部内容）。 | 单测：单块/多块/相邻块/块内含 ` ``` ` 的边界。 |
| P3 | **状态机（冻结）**：`absent → pending → loading → validating → passed`；任一阶段失败 → `degraded`（终态）。不允许回退。 | 单测覆盖全部转移；导出状态枚举供断言。 |
| P4 | **占位规则**：起始围栏行一出现（含未闭合）即进入 `pending`，正文位置渲染占位元素（`data-block-state="pending"`），文案取自 i18n（D3）。**`pending`/`loading`/`validating` 期间块内容（含源码）不得进入访客 DOM。** | DOM 快照：四时点比对（AS-2）。 |
| P5 | **计时起点（冻结）**：<br>① 块闭合 → `loading`（等待渲染器就绪；此阶段**不计入** `gate.blockTimeoutMs`）；<br>② 渲染器就绪 → `validating`，此时开始计时 `gate.blockTimeoutMs`（默认 1500ms），并在同一帧完成校验与渲染；<br>③ 通过 → `passed`，以渲染结果整体替换占位。 | 单测（假计时器）+ 真机计时。 |
| P6 | **超时与失败**：`validating` 超过 `gate.blockTimeoutMs`、`loading` 超过 `gate.libraryLoadTimeoutMs`、任一判据抛异常、流中断 → 全部走 §8 输出前替换（`degraded`）。**任何状态、任何路径都不得出现原始围栏源码。** | AS-1/AS-2/AS-5。 |
| P7 | **预算语义（v3.2 裁决：并行，非串行总配额）**：<br>① **各块判定并行推进，互不串行占用预算**；多块回答**不得**因「预算被前一块吃掉」而降级；<br>② `gate.blockTimeoutMs`（1500ms）仍是**单块判定上限**，计时起点按 P5 不变（闭合 → `loading` → 渲染器就绪才起算）；<br>③ `gate.answerWaitBudgetMs`（600ms）**重新定义为「收尾窗口」**：门禁必须在 `done` 下发前完成结算；`done` 时刻仍未结算完的块 → 按降级终态（可读文案），**不得阻塞 `done`**。<br>**依据（v3 原串行写法是功能性杀手）**：实测 5 个真实问题的单轮图形块数分布 = `1, 1, 1, 0, 2` → 2 块回答真实存在；串行语义下 mermaid 块吃掉 ~400ms 后，image 块仅剩 ~200ms，而其判据（`decode()` + `naturalWidth`）跨网络几乎必然超时被降级。且实测块闭合后仍有 ~6.6s 生成窗口（首帧 11.03s / done 19.14s → 8.1s 窗口），**门禁真实增量被生成时间掩盖**，串行配额换不来任何体验收益，只换来「图被换成文字」。 | 真机计时 + 单测（假计时器，须覆盖「多块并行、任一未结算不影响其余」）+ AS-14。 |
| P8 | **幂等缓存**：同一源码（sha256）在同一会话内复用判定结论；重复块不重复加载库、不重复渲染。 | 单测：同源码两次 → 渲染调用一次。 |
| P9 | **流中止（四情形枚举）**：以下**四种**情形下，`pending\|loading\|validating` 的块按 P6 降级；已 `passed` 的块保持显示：<br>① **SSE 断流**（有 delta、连接异常中断）；<br>② **`AbortController`**（用户主动中止）；<br>③ **硬截止**（现状 45s）；<br>④ **干净 EOF**（有 delta、**无 `done`**、连接**正常关闭**）—— 该情形此前无条款、无断言，导致「占位永久转圈」缺陷逃过验收。<br>**其余未列举情形**：一律按 P6 处理（降级，不得静默透传）。 | 四情形**各自**模拟后取 DOM 快照：断言**无 `pending` 残留**、块为可读降级态、无源码泄漏。④ 的断言须含「存在块节点 + 无 pending 态 + 无 pending 文案残留」三条件（防空断言）。 |

## 6. 源码裸露全面封堵（SRC 系列，冻结）

适用范围：**四类围栏全部**（不再只针对 mermaid）。依据：§2.1 通道表 + captain 补充事实 + 本轮实测复核。

| 编号 | 条款 | 可执行验收方式 |
|---|---|---|
| SRC1 | **统一不变量**：任何围栏块在任何状态下，其原始内容（含 ` ``` ` 分隔符、块体源码）**不得以任何文本形式进入访客 DOM**。唯一例外是**非图形块**（`python`/`bash`/无语言等普通代码块），其展示行为保持不变（N2③）。 | 代码审查 + DOM 快照（AS-2）。 |
| SRC2 | **六个代码点逐点封堵（清单冻结）**，实现方须逐点消除 `<pre><code>${esc(...)}</code></pre>` 形式的图形块回退：<br>① `renderMermaidBlock` 初始容器内嵌源码（`renderMermaidBlock` 内的 `<pre><code>${esc(src)}</code></pre>`）→ 改为占位元素；<br>② `renderMermaidNodes` 渲染失败分支保留源码（`renderMermaidNodes` 的 `catch` 分支，只 `console.warn`）→ 改为降级文案（并按 O2 留痕）；<br>③ `renderImageBlock` 路径非法回退（`renderMermaidNodes` 的 `catch`）→ 降级文案；<br>④ `renderChart` 非数组回退（`renderImageBlock` 的 `if (!looksLikeImage)` 分支）→ 降级文案；<br>⑤ `renderChart` JSON 解析异常回退（`renderChart` 的 `if (!Array.isArray(data))` 分支）→ 降级文案；<br>⑥ `renderMarkdown` 的未闭合围栏分支（`renderMarkdown` 的 `if (needsClose && !closed)` 分支）→ 仅对**普通代码块**保留代码呈现；图形块必须走占位（P4）。 | AS-SRC：逐点构造触发条件，断言访客 DOM 内**无**源码文本、**无** `<pre><code>` 含块体。 |
| SRC3 | **每个渲染器一条独立验收**（不合并）：mermaid 语法错误、image 路径非法、chart 非法 JSON、chart 非数组、html 空块 —— 五个场景各自必须在 DOM 快照中证明"未产出 `<pre><code>` 源码"。 | AS-SRC 输出按渲染器分行的通过/失败表，任一行失败即不通过。 |
| SRC4 | **保底断言（可自动化，判据须限定为「受控图形块」）**：<br>① **正向提取断言（首选）**：**受控图形关键字**（` ```mermaid ` / ` ```chart ` / ` ```image ` / ` ```html `）与**块体特征串**不得出现在访客载荷/DOM 中；<br>② 对图形块集合，承载图形块内容的 `pre > code` 节点不存在。<br>**⚠️ 判据范围限定（重要）**：**不得**写成「字面任何 ` ``` ` 序列都不得出现」——**合法的普通代码块**（如 ` ```python `）**本就**以围栏形式呈现（N2③ 明确保留），其载荷为 `"```python\nprint(1)\n```\n"`（**实测**），按字面判据会**恒假失败**。<br>**残留说明**：主机侧对「块体行本身即受控围栏」的嵌套输入会在 `payload.text` 外发裸围栏序列（N1 实例 `text="```\n"`）；经逐级追踪，该序列经前端渲染为 `<pre><code></code></pre>`、**访客可见文本为空**（**非可见泄漏**）。故按上列判据（限定范围）判**通过**；若仍要求消除该裸序列残差，须在 `fence-machine` 补嵌套跟踪并加用例，**但须先修正判据范围**，否则合法普通代码块恒假失败。 | 真机 DOM 断言脚本（可并入 AS-2）+ 载荷层断言（对 `payload.text`，**因 DOM 层已被证明会漏**，见 F-1）。 |
| SRC5 | mermaid 初始容器改为占位后，**流式期不得再出现源码**——这条同时消除 R1-E2 实测的"第 38 个 delta 起源码在屏"现象。 | AS-2 早时点采样（≤200ms 间隔，覆盖前 2 秒）。 |

---

## 7. 校验判据与职责分工（C 系列）

| 编号 | 归属 | 条款 | 可执行验收方式 |
|---|---|---|---|
| C1 | **真机** | **mermaid**：`parse` 通过 **且** `render` 产出有效 `<svg>`（至少一个几何子节点；`viewBox` 或 `width/height` 至少一项有效）。失败 → `degraded`，reason=`parse-error` / `render-empty`。 | 真机对抗样例：非法括号 flowchart、非图文本、空块、超长（>15 节点）。 |
| C2 | **真机** | **chart**：`JSON.parse` 成功且为非空数组，每项 `label|name` 为非空字符串、`value|count` 为 `Number.isFinite` 且 ≥0（拒绝 `NaN`/`Infinity`/负值）。失败 → `degraded`，reason=`chart-invalid`。 | 真机对抗样例：对象、畸形 JSON、`NaN`、负值、空数组、1000 项。 |
| C3 | **真机** | **html**：非空白、字节数 ≤ `gate.maxBlockBytes`、渲染后回传高度 >0；沙箱属性必须保持 `sandbox="allow-scripts"` + CSP `nonce`（不得放宽）。失败 → `degraded`，reason=`html-invalid`。 | 真机对抗样例：空块、触发脚本块、超高块、超长块。 |
| C4 | **真机** | **图片最终判据**：`await img.decode()` 成功且 `naturalWidth>0 && naturalHeight>0`。**不得用布局尺寸**（现状硬编码 `width="1000" height="560"`，布局尺寸恒有效，不可用）。失败 → `degraded`，reason=`image-decode-failed`。 | 真机对抗样例：死链、非图片扩展名、非法路径、真实 SVG（KB 实测 `_6a4f894bad.svg` 自带 `width/height`→应通过）。 |
| C5 | **服务端** | **图片路径合法性（硬门禁）**：按 §8 IMG1 常量正则判定；非法 → 直接降级（`reason=image-path-invalid`），不得下发给前端。 | 单测 + AS-1。 |
| C6 | **服务端** | **图片可达性：仅留痕，不参与放行（v3.2 裁决，撤回 v3 的硬门禁升级）**：同源 `HEAD` 探测结果（含 404/410）**只写留痕**（O2 `reason=image-unreachable`），**不得**用于降级或拒绝；是否显示一律交真机 C4（`decode()` + `naturalWidth`）裁决。开关 `gate.serverImageProbe`（默认 true）仅控制是否探测与留痕。<br>**依据（captain 复核为真，本机实证）**：`deploy/nginx.conf:53` 有 `proxy_cache_valid 404 10m` → 源站瞬时 404 被缓存 **10 分钟**，期间所有引用该图的回答都会被降级 ＝ **缓存状态决定内容**，超出「确定性否证」的范围；且与 C0/C7 单一事实源一致——可达性只有真机能裁决。<br>**与 IMG1 的区别（必须写清，两类判定不可混为一谈）**：IMG1 路径白名单是**确定性、无网络依赖**的判定（**硬门禁**）；C6 可达性依赖网络与缓存状态（**仅留痕**）。 | 代码审查：探测结果变量不出现在任何降级/拒绝分支；AS-1：死链图片**仍然进入真机 C4 裁决**（而非被服务端拦下）。 |
| C7 | **服务端** | **不做几何校验**：不得使用 jsdom 的 `render`/`getBBox` 结论（实测 jsdom 下必然抛 `d.getBBox is not a function`）；不得据 jsdom `parse` 结论拒绝。jsdom 若使用，只允许标记"可疑"并**照样下发给真机裁决**（可选，默认关闭）。 | 代码审查：无 `mermaid.render(`；无可选预检的拒绝分支。 |
| C8 | **降级顺序（冻结）**：门禁组件不可用时按「**可读替代 > 丢弃该块（保留前后文字） > 整条回答失败**」取舍；**「把未校验的块直接渲染」在任何分支下都不是选项**。具体：渲染器加载失败 → 该类型块降级且不再重试加载（避免反复拉 3.4MB）；服务端探测不可用 → 跳过该项；任何判据异常 → 捕获并降级；**不得因门禁使 `done` 事件或整轮回答失败**。 | AS-5：`mv assets/mermaid-11.16.0.min.js{,.bak}` 后跑一轮 → 文字正常、块降级、无 `error` 事件、无 500。 |

---

## 8. 图片路径白名单（IMG 系列，硬门禁）

背景（实测缺陷）：`/uploads/../api/guest/health` 经 `curl --path-as-is` 返回 **200 的 guest health JSON**——图片地址可回落访客 API 出口，属"错误内容直达访客"同类问题。

| 编号 | 条款 | 可执行验收方式 |
|---|---|---|
| IMG1 | **常量正则（冻结，安全不变量，不进 Config）**：`^/uploads/[A-Za-z0-9_.-]+\.(png|jpe?g|gif|webp|avif|svg|bmp)$`（大小写不敏感）。**禁止**：`..`、嵌套目录、查询串（`?`/`#`）、`http(s)://` 绝对 URL（除 IMG6 归一化后的自家源站地址）、**协议相对 `//host/...`**、其它协议、`data:`（见 IMG8）、行内空白与换行、URL 编码形式的绕过（含 `%2e`/`%2f`）。 | 单测逐条样例（合法：`/uploads/banner_cs_9af26b7f16.png`、`/uploads/Cover_2023_ccb9475205.jpg`、`/uploads/_6a4f894bad.svg`；非法：`/uploads/../api/guest/health`、`/uploads/%2e%2e/x.png`、`/uploads/a.png?x=1`、`//evil.example.com/x.png`、`https://evil.example.com/track.png`、`data:image/png;base64,…`、`/uploads/sub/a.png`、`/uploads/a.txt`）。 |
| IMG2 | **两条通道全封（captain 清单之外的第 5 条通道已纳入）**：必须同时改造 ① `renderImageBlock`（` ```image ` 围栏）与 ② `inlineMd` 的行内 Markdown 图片 `![alt](url)`（`inlineMd` 的 `![alt](url)` 替换回调）。两者都必须调用**同一个**白名单判定函数（单一实现，禁止两处各写一份正则）；**非法路径不得发起任何请求**（现状两条通道都会发出 `GET`）。 | AS-IMG：两条通道 × 全部非法样例，真机 Network 面板**零出站请求**；代码审查确认共用同一函数。 |
| IMG3 | **同源化**：通过校验后下发/渲染的 `src` 一律为站点相对路径（`${API_BASE}/uploads/<文件名>`），不得指向外部主机。 | 代码审查 + DOM 快照断言（`img.src` 同源）。 |
| IMG4 | **提示词一致**：GEN2 与 IMG1 使用同一常量与语义。 | 两份 preset 提示词审查。 |
| IMG5 | 扩展名白名单来源：KB 实测图片扩展名为 `jpg/JPG/png/jpeg/svg`；`pdf/zip/docx` 出现在 KB 但不是图片，**不得**进入白名单。 | 单测含 `.pdf`/`.zip`/`.docx` 拒绝样例。 |
| IMG6 | **自家源站绝对 URL 的归一化边界（从 KB 实测得出）**：KB 内实测存在 4 条 `https://www.cem-macau.com/uploads/<file>` 形态引用（`car-model.md:4724`、`car-model.md:4979`、`ev-tip.md:917`、`ev-tip.md:931`）。这类地址**允许**，但必须**先归一化为 `/uploads/<file>` 再走 IMG1 校验**（即：`imageSrcOf` 的归一化在判定之前执行，判定对象是归一化后的路径）。归一化仅接受**精确主机 `www.cem-macau.com` 或 `cem-macau.com`** 且路径为 `/uploads/<文件名>`；其余任何主机一律拒绝。 | 单测：自家绝对 URL → 归一为相对路径并通过；`https://evil.example.com/uploads/a.png` → 拒绝（不因"长得像自家"而放行）。 |
| IMG7 | **html 围栏内的图片通道（沙箱不阻断网络）**：`renderHtmlBlock` 的 CSP 为 `img-src 'self' data: https:`（`renderHtmlBlock` 的 srcdoc CSP），意味着沙箱内可加载外部图片，同样会把访客 IP/UA 送给第三方。要求：把 `img-src` 收紧为 `'self' data:` 且**禁止外部主机**（`https:` 移除）；若产品确需在 html 块内展示外部图，须作为单独议题提出并给出风险接受记录。 | 代码审查（CSP 字符串断言）+ 真机：构造 html 块内含外部 `<img>` → 断言请求被 CSP 阻止（`securitypolicyviolation`）。 |
| IMG8 | **`data:` 的处理决定：一并拒绝**（与客服 preset"图片必须来自知识库"对齐）。理由与风险：① KB 实测 `data:image` 引用 **0 条**，拒绝不影响现有内容；② 现状两条通道均放行 `data:`，且 `.svg` 也在允许扩展名内 → `data:image/svg+xml` 可携带脚本/SMIL，进入**页面级** `<img>`（非沙箱）会扩大攻击面；③ 拒绝后无需在需求层引入新的解码/消毒逻辑（避免新增未使用抽象）。**风险**：若未来确有内联图需求，需重新评估并登记；本版按拒绝冻结。 | 单测：`data:image/svg+xml;base64,…`、`data:image/png;base64,…` 均走降级文案，且真机零请求。 |

---

## 9. 输出前替换与终态（REP 系列，冻结）

| 编号 | 条款 | 可执行验收方式 |
|---|---|---|
| REP1 | **不做事后重写（冻结）**：不调用模型二次生成、不重新提问、不回改已进入访客 DOM 的内容。 | 代码审查（无第二次模型调用/无 `followup` 重发）+ 留痕中无 `rewritten` 状态。 |
| REP2 | **替换时机**：未通过的块**尚未上屏**（处于占位态），直接替换为可读等价文字后才输出。即"改完才给用户看"，而非"先给用户看再去改"。 | DOM 快照：源码从未出现；占位 → 文案的一次替换。 |
| REP3 | **替换内容**：① 有语义等价正文时保留正文，仅去掉图形；② 无等价正文时按类型给出 i18n 降级文案（D3）；③ 连降级文案都无法写出（极端）→ 丢弃该块、保留前后文字，整条回答仍可用。 | AS-1/AS-2。 |
| REP4 | **终态唯一性**：`degraded` 为终态，不重试、不递归、不影响 `done`。 | 单测 + 真机。 |
| REP5 | **已上屏内容永不回改**：任何块进入 `passed`/`degraded` 后，其 DOM 不再被门禁改写。 | DOM 快照序列比对（AS-2）。 |

---

## 10. 降级文案与 i18n（D 系列）

| 编号 | 条款 | 可执行验收方式 |
|---|---|---|
| D1 | **可读性**：降级文案不得出现 `mermaid`、`栅栏`、`语法`、`校验`、`代码块` 等技术词，不得出现英文错误信息。 | 文案审查 + 四语言快照。 |
| D2 | **内容完整性**：降级**放弃原图形内容**，不得以任何形式回退为源码展示；不得保留未通过校验的 `<img src>`。 | DOM 快照断言。 |
| D3 | **文案进 i18n 字典**（`web/guest/index.html` 的 `I18N`，zh/zhHant/en/pt 四语言齐备），禁止硬编码。 | 断言四语言字典均含全部键且非空。 |

**i18n 键清单（冻结）**

| 键 | zh（参考值） | en（参考值） | 用途 |
|---|---|---|---|
| `gatePreparing` | 图形正在准备… | Preparing the graphic… | P4 占位 |
| `gateDiagramUnavailable` | 示意图暂时无法显示，您可以先看上面的文字说明。 | The diagram is temporarily unavailable; please refer to the text above. | mermaid 降级（C1/C8） |
| `gateChartUnavailable` | 图表暂时无法显示，您可以先看上面的文字说明。 | The chart is temporarily unavailable; please refer to the text above. | chart 降级（C2） |
| `gateImageUnavailable` | 图片暂时无法显示（源站可能已移除该图）。 | The image is temporarily unavailable. | 图片降级（C4/C5/C6）；可与既有 `imageUnavailable` 复用同值 |
| `gateRichContentUnavailable` | 这部分内容暂时无法显示，您可以先看上面的文字说明。 | This part of the content is temporarily unavailable; please refer to the text above. | html 降级（C3） |

| 编号 | 条款 | 可执行验收方式 |
|---|---|---|
| D4 | **文案与 SRC 的关系**：SRC2 的六个代码点全部使用上表键；每个代码点必须映射到唯一键，不得回退为源码或空白。 | 逐点核对映射；AS-SRC 输出映射表。 |

---

## 11. 可见性与证据形式（V 系列）

| 编号 | 条款 | 可执行验收方式 |
|---|---|---|
| V1 | **判定合格前，图形块内容（含原始围栏分隔符与源码）不得出现在访客 DOM 中。**"进入 DOM" = `.bubble` 子树内出现该块源码文本，或出现承载源码的 `pre > code` 节点。 | 真浏览器 DOM 快照序列（AS-2），覆盖 `pending/loading/validating/passed/degraded` 五时点。 |
| V2 | 判定期唯一允许的呈现是占位元素（`data-block-state`），文本必须来自 i18n 占位键，不含源码任何片段。 | DOM 快照 + 文本包含断言。 |
| V3 | `degraded` 终态不得出现：源码文本、` ``` ` 分隔符、未通过校验的 `<img src>`。 | DOM 快照 + 断言。 |
| V4 | **证据形式（冻结）**：以真浏览器 **DOM 快照**为可对抗验证凭据——按时间片（≤200ms）或按 `delta` 序号采样 `.bubble` 的 `outerHTML`，存为文件，验收报告列出采样点与命中/未命中结论；`curl` 原始报文作为载荷层证据（E7）。 | 验收报告附采样文件路径与结论。 |
| V5 | 现场证据：非法图片路径时真机 Network 面板**无出站请求**（对应 IMG2）。 | 抓包截图/日志。 |

---

## 12. 留痕与几何回传（O 系列）

| 编号 | 条款 | 可执行验收方式 |
|---|---|---|
| O1 | **落点为主机侧**：`guest-server`（或 output-gate 插件）通过 `ctx.logger` 输出，统一前缀 `guest.output-gate`；不得只写访客控制台（现状 `console.warn` 团队不可见）。 | 代码审查 + `docker logs dshagent-app \| grep guest.output-gate`。 |
| O2 | **最小字段（冻结）**：`sessionId`、`blockType`（`mermaid\|chart\|image\|html`）、`reason`（枚举：`parse-error\|render-empty\|image-path-invalid\|image-unreachable\|image-decode-failed\|chart-invalid\|html-invalid\|timeout\|library-unavailable`）、`sourceDigest`（sha256 前 16 位）、`sourceBytes`、`occurredAt`、`outcome`（`passed\|degraded`）。**不含**任何回改语义（无 `rewritten`）。 | 日志样本逐字段核对；`sourceDigest` 可复算。 |
| O3 | **几何回传端点**：`POST /api/guest/render-report`——同域、复用既有限流、请求体 ≤8KB、只接受 O2 的 `reason` 枚举与幂等键 `(sessionId, blockId, sourceDigest)`；服务端**只记录统计，不做任何内容决策**；重复回传按幂等键去重计数（防日志噪音），不触发任何重新生成。回传失败必须静默（fire-and-forget），不得影响访客所见。 | 端点契约测试（合法/非法 reason、超大 body、限流、重复回传）+ 断网时回答仍完整。 |
| O4 | **可聚合（用途：发现模型反复出错）**：同一 `sessionId` 内同 `reason` 重复时，日志可按 `sessionId`+`blockType`+`reason` 聚合统计；聚合结果**不用于回改内容**。 | 同一坏块跑 3 轮 → 统计计数为 3。 |

---

## 13. 配置（G 系列）

全部取值走插件 Schemastery `Config`（可从 cordis.yml / profile patch 调整），禁止硬编码；**安全不变量（IMG1 正则、沙箱属性）固定，不进 Config**。

| 键 | 默认值（冻结） | 说明 |
|---|---|---|
| `gate.enabled` | `true` | 总开关；`false` 时行为等同现状（回滚用） |
| `gate.blockTimeoutMs` | `1500` | 单块 `validating` 判定超时（captain 冻结） |
| `gate.answerWaitBudgetMs` | `600` | 整条回答的访客可感知等待增量上限（captain 冻结） |
| `gate.libraryLoadTimeoutMs` | `8000` | 渲染器就绪等待上限（与判定计时分离） |
| `gate.maxBlockBytes` | `32768` | 单块字节上限，超出直接降级 |
| `gate.serverImageProbe` | `true` | 图片可达性探测；**按 v3.2 裁决仅写留痕，不参与放行**（C6）——探测结果（含 404/410）不得用于降级或拒绝 |
| `gate.serverImageProbeTimeoutMs` | `2000` | 探测超时；超时不拒绝 |
| `gate.reportPath` | `/api/guest/render-report` | 几何回传端点路径 |

| 编号 | 条款 | 可执行验收方式 |
|---|---|---|
| G1 | 上表全部键必须由 Config 提供并可覆盖；未在验收用例中被使用的键不得保留（避免未使用抽象）。 | 代码审查 + 逐键覆盖测试（AS-7）。 |
| G1a | **配置面冻结为 8 键（v3.2.3 收敛）**：`gate.enabled`、`blockTimeoutMs`、`answerWaitBudgetMs`、`libraryLoadTimeoutMs`、`maxBlockBytes`、`serverImageProbe`、`serverImageProbeTimeoutMs`、`reportPath`。曾列入的 `gate.jsdomPrecheck` 已删除：它与 G1/Q5「未在验收用例中被使用的键不得保留」冲突（AS-7 不含它），且 **C7 的最强合规形态是完全不引入 jsdom 依赖**——服务端没有 jsdom，就不存在"用错判据"的可能。若将来部署方确有需求，再补 AS-7 覆盖项后加回。 | 逐键核对 §13 表与 AS-7 清单为同一 8 键集合；全文 `jsdomPrecheck` 不得出现在现状配置语境 |

| G2 | 默认值变更必须同时更新本表（唯一事实源）。 | 文档与代码一致性核对。 |

---

## 14. 性能预算与回归（T / REG 系列）

| 编号 | 条款 | 预算 / 判据 | 可执行验收方式 |
|---|---|---|---|
| T1 | **门禁不得推迟 `done` 超过 600ms（v3.2 裁决的措辞修正）**：由 v3 的「整条回答访客可感知等待增量 ≤600ms」改为「**`done` 的下发不得被门禁推迟超过 600ms**」。访客感知增量 ≈0（门禁增量被生成窗口掩盖）。 | 实测时序：首帧 `delta` ≈11.03s / `done` ≈19.14s → 窗口 ≈8.1s（另一次实测：首帧 11.42s / 块闭合 11.64s / done 18.24s，块闭合后 6.60s 窗口，门禁 1.5s 仅占 23%）；单轮 924–1069 帧 | 真机计时：`done` 时刻 − 无门禁基线 `done` 时刻 ≤600ms，各 3 次取中位 |
| T2 | 单块判定：`validating` P95 ≤ `gate.blockTimeoutMs`(1500ms)；库已就绪时 P95 ≤ 600ms | — | 真机计时（10 块样本） |
| T3 | mermaid 懒加载：无图回答**不得**请求 `/assets/mermaid-11.16.0.min.js`；加载成本基线 ≈35ms（jsdom 冷启动，3.40MB 资产） | 库加载不占用 `blockTimeoutMs`（P5） | 真机 Network + 计时 |
| T4 | **服务端探测不得进入送达路径（v3.2 措辞修正）**：图片块随流下发（E5），可达性结论**只进留痕**（C6）；探测必须异步/并发，**不得**为等探测而阻塞 `delta` 帧间隔或 block 下发 | — | 开关前后 `delta` 帧间隔时间序列对比 + AS-14 |
| T5 | 无新增依赖 | — | `git diff`：`package.json` / `pnpm-lock.yaml` 无新增 |
| T6 | 文字打字机不受影响 | 只有图形块进入缓冲 | DOM 采样：文字按 delta 增量出现（REG1） |

**回归清单（N3 的可执行形式）**

| # | 回归项 | 验收方式 |
|---|---|---|
| REG1 | 文字逐字流式（打字机） | 真机 DOM 采样：文字按 delta 增量出现 |
| REG2 | 正常 mermaid 图可渲染 | 问「如何缴交电费？」→ `passed` 且 `<svg>` 有几何 |
| REG3 | 正常图片可显示 | KB 真实图片（`/uploads/banner_cs_9af26b7f16.png` 实测 200）→ `<img>` 正常 |
| REG4 | 来源引用正常 | `sources` 区块仍显示 |
| REG5 | 限流与攻击防护未破坏 | 重复消息/辱骂触发既有 warn/block |
| REG6 | 断流自愈未破坏 | 中途 kill 连接 → `recovering` → 恢复出答案 |
| REG7 | HTML 预览沙箱与高度自适应未破坏 | iframe 属性 + 高度随内容 |
| REG8 | 图片阅读器未破坏 | 点击图片/图表可放大 |

---

## 15. 工程质量（Q 系列）

| 编号 | 条款 | 验收方式 |
|---|---|---|
| Q1 | 主机侧改动遵循仓库约定：函数插件导出 `name/inject/Config/apply`（**无 default export**）、依赖 `ctx.get()`、注册即副作用（可回滚）、配置走 Config。 | 对照 `AGENTS.md` / `packages/AGENTS.md`。 |
| Q2 | **分层**：纯决策逻辑抽为可测砖块（前端 `web/guest/assets/output-gate.js`，浏览器可 `<script>` 加载且 Node 可直接 import、不碰 DOM；主机侧围栏状态机同样抽纯函数模块）；DOM 组合留在 `index.html`。 | 模块被两侧复用；含 `web/guest/tests/output-gate-check.mjs`（`node:assert`，失败非零退出）。 |
| Q3 | 不得引入新依赖；服务端**不使用 jsdom**（配置面已收敛，v3.2.3）：可用材料为 `assets/mermaid-11.16.0.min.js`（真机渲染器）与原生 `fetch`/`HEAD`（图片探测）。根 devDependency `jsdom@29.1.1` 存在但**本机制不依赖它**，也不得为它引入任何调用路径（与 C7「不做几何校验」一致）。 | T5 + 代码审查（服务端无 jsdom 调用）。 |
| Q4 | 新增出口必须复用 E3 收口函数。 | 代码审查。 |
| Q5 | 不留未使用抽象：每个新增配置项/函数必须被至少一条验收用例引用。 | 逐个核对 §13 与 §16。 |
| Q6 | 跨分帧状态机必须有独立单测（含 1 字符/帧、多块同帧、跨块截断）。 | 单测运行记录。 |

---

## 16. 验收脚本清单（供 verifier 取证）

| 编号 | 用途 | 命令 / 检查点 |
|---|---|---|
| AS-1 | 对抗样例矩阵 | 逐条构造：非法括号 flowchart、非图文本、空 mermaid、超长 mermaid、死链图片、`/uploads/../api/guest/health`、`/uploads/%2e%2e/x.png`、`/uploads/a.png?x=1`、**协议相对 `//evil.example.com/x.png`**、**外部域名 `https://evil.example.com/track.png`**、**外部 `https://…/x.svg`**、`https://www.cem-macau.com/uploads/a.png`（应归一化后通过，见 IMG6）、`data:image/png;base64,…`、`data:image/svg+xml;base64,…`、`/uploads/sub/a.png`、`/uploads/a.pdf`、`/uploads/a.zip`、`/uploads/a.docx`、真实 SVG（`_6a4f894bad.svg`）、chart 对象/畸形 JSON/`NaN`/负值/空数组、空 html、触发脚本 html、**html 内含外部 `<img src="https://evil.example.com/x.png">`**、未闭合围栏、流中断围栏 |
| AS-2 | 可见性（V1–V4） | 真浏览器 DOM 采样脚本 → 输出五时点快照文件 |
| AS-3 | 载荷口径（E7） | `curl -s -N` 三出口 → 断言**受控图形关键字**无命中：`grep -E '```(mermaid\|chart\|image\|img\|html)'` 必须无命中；**并保留正向提取断言**（受控关键字与块体特征串不得出现）。<br>**⚠️ 不得**把判据放宽成「任何 ` ``` ` 序列」，也**不得**收紧成「字面所有裸序列」——合法普通代码块（` ```python `）本就承载围栏（N2③），见 SRC4 的范围限定说明。 |
| AS-4 | 出口一致性（E1/E4） | 同一坏内容打三出口 + 刷新重放，终态一致 |
| AS-5 | 降级顺序（C8） | `mv web/guest/assets/mermaid-11.16.0.min.js{,.bak}` 后跑一轮：文字正常、块降级、无 `error`/500 |
| AS-6 | 留痕（O1/O2/O4） | `docker logs dshagent-app \| grep guest.output-gate` + 字段核对 + 聚合计数 |
| AS-7 | 配置（G1/G1a） | **逐键覆盖全部 8 键**（与 §13 表严格同集合）：`enabled=false`（总开关，行为应回退为现状）、`blockTimeoutMs=1`（超时即降级）、`answerWaitBudgetMs=0`（预算耗尽立即降级）、`libraryLoadTimeoutMs=1`（库就绪超时→降级）、`maxBlockBytes=1`（块超限→降级）、`serverImageProbe=false`（探测关闭，行为不变，仅无留痕）、`serverImageProbeTimeoutMs=1`（探测超时不拒绝）、`reportPath` 改自定义路径（回传送往新路径） |
| AS-8 | 性能（T1–T4） | 首帧与整条回答 A/B 计时、库加载时机、单块耗时、探测并发性 |
| AS-9 | 回归（REG1–REG8） | §14 回归清单逐项 |
| AS-10 | 纯逻辑砖块单测 | 主机侧 `node --import tsx/esm plugins/output-gate/tests/gate-check.mjs`；前端 `node web/guest/tests/output-gate-check.mjs`（失败必须非零退出） |
| AS-11 | 跨分帧（E6/Q6） | 分帧注入器：把含 mermaid/image/chart/html 块的回答按 1 字符/帧、随机切片两种方式重放，断言识别与整块输入一致、源码不入载荷 |
| AS-12 | **六点源码封堵（SRC2/SRC3/D4）** | 逐点触发：① mermaid 初始容器；② mermaid 渲染失败；③ image 路径非法；④ chart 非数组；⑤ chart 非法 JSON；⑥ 图形块未闭合 —— 每点产出真机 DOM 快照，断言 `.bubble` 内无 ` ``` ` 序列、无承载图形块内容的 `pre > code`，且显示的是对应 i18n 键。输出按渲染器分行的通过/失败表 |
| AS-13 | **图片双通道（IMG2/IMG6/IMG7/IMG8）** | 两条通道（` ```image ` 围栏 + 行内 `![alt](url)`）× 全部非法样例：真机 Network 零出站请求、DOM 显示降级文案；自家绝对 URL 归一化后正常加载；html 块内外部 `<img>` 触发 `securitypolicyviolation` |
| AS-14 | **并行预算与帧间隔（P7/T1/T4，v3.2 裁决）** | ① **多块并行**：构造一轮含 2 个图形块（`mermaid` + `image`，与实测构型一致）的回答，断言**两块都达到 `passed`**（不得出现"第二块因前一块耗掉预算而降级"）；② **不推迟 `done`**：`done` 时刻 − 无门禁基线 `done` 时刻 ≤600ms（各 3 次取中位）；③ **帧间隔不受探测影响**：`serverImageProbe` 开/关两种状态下，`delta` 帧间隔序列无显著差异；④ `done` 到达时仍未结算的块显示可读文案（不得阻塞 `done`、不得出现源码） |

---

## 16.1 对抗验证启动条件（G-FREEZE，流程条款）

| 编号 | 条款 | 可执行验收方式 |
|---|---|---|
| G-FREEZE | **对抗验证（V1/AS 系列）不得在接线闭合前启动**：必须在「主机侧下发 `block` 事件」与「访客端消费 `block` 事件」**两端接线闭合后**才启动；且 V1 报告必须记录**被测构建**的三重标识——① 服务端 `serviceVersion`（取自被测实例 health）；② **前端与主机侧两侧文件的 `sha256` 指纹**；③ 前端确实消费 block 事件的 grep 证据。任一缺失或与基线一致时，其结论**按「证据不足」处理**，不得进入 t6 判据。<br>**被测制品是「前端 + 主机侧」二元组，两侧都须取证**（v3.2.5 补强）：仅核前端指针对**主机侧修复无效**——F-1/F-2/F-3 均为主机侧改动，若只录前端指纹，主机侧回归（如 `gateReply` 净化分支被改坏）不会被发现。因此基线与报告均须覆盖下方**两侧文件集**。 | `sha256sum` 覆盖：**前端** `web/guest/index.html`、`web/guest/assets/output-gate.js`；**主机侧** `plugins/output-gate/src/{index,engine,fence-machine,block-rules}.ts`、`plugins/guest-server/src/index.ts`；`grep -c "block-open" customer-service/web/guest/index.html`（须 ≥1）；`curl -s <被测实例>/api/guest/health` |

**基线（仅接线闭合后有效；此前一切指纹不作判据）**

**两侧制品文件集（基线须覆盖，缺一即为证据不足）**

| 侧 | 文件 | 说明 |
|---|---|---|
| 前端 | `web/guest/index.html`、`web/guest/assets/output-gate.js` | **bind-mount** 进 nginx，工作区一改立即生效 |
| 主机侧 | `plugins/output-gate/src/{index,engine,fence-machine,block-rules}.ts`、`plugins/guest-server/src/index.ts` | **烘焙进镜像**（`COPY customer-service /app/customer-service`），运行中容器跑的是镜像内副本 |

> **两侧生效方式不同 → 必须分别取证**：前端改动实时反映在 10800；主机侧改动**不会**反映在运行中容器（其 health 仍返回镜像构建号），因此主机侧只能用**源码实例**被测，且其指纹须取自**该实例实际加载的文件**。

**⚠️ 已失效基线（时点 `2026-09-10T20:21:40+08:00`，v3.2.11）—— 请勿在失效后继续引用**

> **❌ 本节所述基线已于 `2026-09-10` 深夜起失效**（F4B-1、t18/t19/t22/t25/t29、t38 等多项制品改动陆续落地）。
> **✅ 现采表见：`docs/output-self-review-delivery.md` §2（判别器 + 规格式，含采集时点与归属任务）。**
> 本节保留为**作废对照**，用途仅是甄别「测了旧构建」；**不得**作为现役判据。

**原基线（已失效，仅作对照）**

| 文件 | 原 sha256（已失效） | 原尺寸 |
|---|---|---|
| `web/guest/index.html` | `e597f642b8c3337c…` | 128426 B |
| `web/guest/assets/output-gate.js` | `11ebac8964857f0a…` | 31718 B |
| `web/guest/assets/package.json` | `a51bff776fdd5322…` | 44 B |
| `plugins/output-gate/src/fence-machine.ts` | `fd6e9cbc227268e2…` | — |
| `plugins/output-gate/src/engine.ts` | `6027b330a385b1b9…` | — |
| `plugins/output-gate/src/block-rules.ts` | `dafca4575e9be224…` | — |
| `plugins/output-gate/src/index.ts` | `4d39bb58624a0e49…` | — |
| `plugins/guest-server/src/index.ts` | `99110840bc1bb7ed…` | — |

**失效条件（已触发）**：任何一次制品写入都会使命中值作废；本轮触发者为 F4B-1 注释修正（`fence-machine.ts`）、
t12（`engine.ts`）、t18/t19/t22/t25/t29/t38（前端）等。原表头的「**当前有效基线 —— 冻结已达成**」字样已删除。

> **注**：主机侧 `block-rules.ts`、`output-gate/src/index.ts`、`guest-server/src/index.ts` 三项在本轮**确实未变**
> （见 `delivery.md` §2 现采表），但**不得**由此推出「全表仍有效」——失效是**整表**语义，须整表现采。

**现采值来源**：`docs/output-self-review-delivery.md` §2（**采集时点 `2026-09-11T05:06:43`**，采集者 engineer-core /
t41；记录性引用仍需由 requirements 作者落笔并注明时点，本处已注明）。第三方复核可直接跑 `delivery.md` §3 的判别器命令。

**⚠️ 本轮删除的制品级符号（取证时必须不再出现）**：`scanGates`、`matchFenceOpen`、`matchFenceClose`、`FENCE_LANGS` 已全域删除（见 §16.4 F-4/F-4b）。取证脚本若仍引用它们，说明用错了制品。

### 基线有效性规则（v3.2.7 立，本轮首次依此执行）

基线只能在**全部写者停手**、且**连续两次采样一致**后录制；录制后**由另一方复核一次**（本轮：captain 采集 → reviewer 全量复核）。
在文件仍被编辑时录制，会让条款携带**看起来权威、实则过期**的数字——与"行号引用"同类缺陷（把易变事实写成判据）。

**基线不是永久有效**：任何一次写入都会使命中值作废，须重新走「停手 → 连续两次一致 → 另一方复核」三步。

接线闭合的内容锚点（供复核，勿用行号）：SSE 分支 `event === 'block-open'` 与 `event === 'block'`（`index.html`）；解码砖块 `decodeBlockPayload`（`index.html` 与 `output-gate.js` 各一处定义/调用）。

**主机侧基线已随上表一并录入** —— v3.2.5 所立门槛「主机侧基线录入前任何 V1/复验结论不得判合格」**现已解除**（前提：报告指纹命中上表值）。

**已作废基线（保留作废对照，供甄别"测了旧构建"）**

| 被核对象 | 已作废指纹（sha256 前 16 位） | 作废原因 |
|---|---|---|
| `web/guest/index.html` | `67802984703f4ab3`（接线前）→ `d0a25f911fa5e302` → `f1960e9fc1d30833` → `3ba152739b68c6ae` → `57507a0d814b7daf` → `b887772b77023319` → **`f0dc41832cd79106`**（v3.2.9 基线，因 F-4/F-4b 清理失效） | 均在文件仍被编辑时录制；v3.2.9 那条为**放行前已录、放行后因已批准的改动再度失真** |
| `web/guest/assets/output-gate.js` | `101ec5ac141e508f`（接线前）→ `184f8d52612dc375` → **`cdf2869a625de891`**（v3.2.9 基线，因 F-4/F-4b 清理失效） | 同上 |

**判据**：V1/复验报告的指纹若命中上表任一**已作废**值，或 `block-open < 6` → **判「证据不足」**（被测即接线前/半接线/变动中构建），不接受其结论。
**注意**：`index.html` 曾在接线未完成时连续抖动三次指纹（见上表），**故指纹变化不得作为"接线已闭合"的判据**；接线闭合的唯一判据是 `block-open ≥ 1` 且 SSE 分支存在。

### 取证方式：**统一走「源码实例」，不重建镜像**（v3.2.6 澄清，本机核实）

| 事实 | 本机实测 | 后果 |
|---|---|---|
| nginx 的 `/srv/guest` 是 **bind-mount** | `dshagent-nginx` 内 `/srv/guest/assets/output-gate.js` 的 sha256 **等于**工作区同名文件（`cdf2869a625de891…`） | **前端改动实时生效**，无需任何构建动作 |
| agent 容器内**没有**插件源码 | `dshagent-app` 内 `/app/customer-service/plugins/*` → `No such file or directory` | 运行中容器是**早于 output-gate 插件的旧镜像**，其后端只发 `meta`/`delta`/`done` |

→ **结论（冻结）**：确认性复验与对抗验证**统一以「源码实例」为被测对象**——`node --import tsx apps/cli/src/bin.ts`（配独立 `DSH_HOME` + 空闲端口，避开 3080/10800/10801）直接加载工作区 TS，**主机侧与前端两侧都是最新工作区代码，天然自洽**。

**不重建 docker 镜像**，理由有二：① 运行中容器是用户正在使用的服务，重建会影响线上；② 在当前架构下重建**既不必要也不充分**——前端由 nginx bind-mount 提供（重建镜像并不会改变访客拿到的前端），主机侧虽烘焙但源码实例已覆盖同一份工作区代码。

> **条款有效期提示（强制）**：本节成立的前提是「前端 bind-mount + 主机侧烘焙」这一部署形态。**若将来部署方式变化**（例如前端也改为烘焙进镜像、或插件改为挂载），**本节必须相应更新**；届时"源码实例"与"容器制品"将不再等价，需重新定义被测制品的取证方式。

---

**必须区分「源码构建」与「被测制品」，并禁止跨制品混用（本机实证的陷阱）**

**判定方式（相对表述，不内嵌易变值 —— v3.2.12 / D-2 修正）**

下表**故意不写入具体指纹、计数与行号**：那些值每轮制品变更后即失效，写进判据会**制造假失败**（D-2 的成因）。
判据改为**相对表述**，执行时现场取值：

| 标识 | 取值来源（现场取） | 判定规则（相对） |
|---|---|---|
| 源码 `serviceVersion` | `deploy/profile/cordis.patch.yml` | 参考值，非判据 |
| **被测实例 `serviceVersion`** | `curl <被测实例>/api/guest/health` | **取自被测实例**，不得取自源码文件 |
| **前端制品指纹** | `curl <被测实例>/ \| sha256sum` | **须与"本提交工作区制品"逐字节一致** |
| 主机侧制品指纹 | 被测实例实际加载的文件 | **须与"本提交工作区制品"逐字节一致** |
| `block-open` 计数 | `grep -c "block-open" <被测实例工作区制品>` | **≥1**（不写死具体数字） |
| 后端构建是否含门禁 | `curl <被测实例>/api/guest/health` + SSE 事件类型 | 是否出现 `block-open`/`block` 事件 |

→ 实测结论（**定性，不含易变值**）：**运行中的 10800 是「新前端 + 旧后端」的混合制品**——其页面前端由 nginx bind-mount 实时取自工作区，而后端是**早于 output-gate 的旧镜像**（容器内既无该插件源码，SSE 也只发 `meta`/`delta`/`done`，**不发任何 block 事件**）。

**因此两条强制结论**：
1. **源码指纹不能证明被测制品是接线后的构建**。V1 必须对**实际被测制品**取证——`serviceVersion` 取自**被测实例的 health 端点**（而非源码文件）；前端指纹与 `block-open` 计数取自**被测实例实际服务的页面资产**（而非工作区文件）。
2. **禁止跨制品混用**：前端来源与后端来源必须属于**同一被测实例**。凡出现「前端来自 A、后端来自 B」的证据组合（如"用 10800 的页面 + 源码实例的 API"），一律按**证据不足**处理。

**若 V1 直接打 10800，其结论必定不合格**——前端虽已接线，后端仍是旧构建、不发 block 事件，测到的将是"前端无 block 事件可消费"的假象（既非假失败也非真通过，而是**测了旧版本却以为测了新版本**）。

---
## 16.2 证据锚定方法论（G-ANCHOR，冻结）

> 来源：engineer-frontend 提炼（本轮三次「顶回 captain」的共性根因），captain 核实认可并补充第四例。
> 定位：这不是"待人接物的态度问题"，而是**可执行的取证纪律**——每一条都对应一次真实误判。

### 四例共性：**用间接证据代替直接证据**

| # | 误判实例 | 间接证据（被误用） | 直接证据（应锚定） |
|---|---|---|---|
| 1 | 基线 `block-open` 计数 | **旧副本 / 本地工作区** | **线上制品的 `curl` 结果**（`curl <url>/ \| sha256sum`） |
| 2 | 每帧解析是否符合契约 | **契约措辞** | **真实分帧事件序列**（抓 SSE 帧序） |
| 3 | F-2 是否已修 | **符号存在**（grep 到 `mermaidPromise`） | **行为存在**（同一脚本 before/after 对照） |
| 4 | 写者是否已停手 | **事后陈述**（"我已经不改了"） | **事前声明 + 指纹复核**（"我将要改 X，请暂缓录基线"） |

**解法同为一条：锚定到最接近事实的那一层。** 判据优先级：
`线上制品 > 行为/事件序列 > 制品指纹 > 符号存在 > 措辞 > 主观陈述`。

| 编号 | 条款 | 可执行验收方式 |
|---|---|---|
| G-ANCHOR | **引用证据时必须声明其层级**：凡在报告/结论中引用某项证据，须同时标明它属于上表哪一层；**不得以低层级证据支撑高层级结论**（例如用"符号存在"证明"缺陷已修"、用"措辞"证明"行为正确"、用"本地副本"证明"线上状态"）。 | 报告逐条标注证据层级；t6 抽查可复算性 |

### 冻结锚点：用**线上制品**，不用容器内同名副本

| 编号 | 条款 | 可执行验收形式 |
|---|---|---|
| G-ANCHOR-2 | **冻结锚点取线上制品**：`curl` 取页面并算 sha256，避免"容器内同名旧副本"陷阱（本机实证：`dshagent-nginx` 的 `/srv/guest` 为 bind-mount；`dshagent-app` 内**无**插件源码）。 | `curl -s <url>/ \| sha256sum`；与仓库指纹比对 |
| G-ANCHOR-3 | **基线只含制品，不含 `tests/**`**：`web/guest/tests/gate-dom-snapshots.json` 由测试运行时 `writeFileSync` 重写（本机实证），把它纳入基线会**自造漂移**。 | 基线文件清单**不含** `tests/**`（本基线 8 文件均不在 tests 下，已核） |
| G-ANCHOR-5 | **判据不得内嵌易变事实（冻结）**：任何**判据/验收标准**中**不得**写入具体 sha256 指纹、`block-open` 计数、行号、断言条数等随制品变更而变化的值。一律改为**相对表述**（"与本提交制品逐字节一致"、"以脚本实际输出为准"、"计数 ≥1"）。<br>**原因**：硬编码易变值会在每轮制品变更后自动失效，**制造假失败**——与"行号引用""硬编码断言计数"同类，本质是**把易变事实写进判据**（D-2 的成因）。<br>**例外**：**记录性表格**（如 §16.1 基线表、作废对照表、§22 修订记录）**可以**记载具体值，因为它们声明的是"某一时点的实测事实"而非"长期判据"；但须同时标注时点与失效条件。 | 全文检索判据行：`grep -nE '\b[0-9a-f]{16,}\b|\.(ts|mjs|html):[0-9]+' <文档>` 在**条款/验收/判据行**内应为 0 命中（记录性表格除外） |
| G-ANCHOR-6 | **枚举式条款必须声明「其余情形如何处置」（强制项）**：凡以枚举方式列举情形/分支的条款（如 P9 的流中止、SRC2 的代码点清单、AS 矩阵），**必须同时显式声明**：① 枚举是否**穷尽**；② 若未穷尽，**未列举情形**按哪一条处理。<br>**原因**：枚举式条款天然产生「**枚举外的盲区**」——本轮该类缺陷**已两次逃过条款与验收**（P9-1 干净 EOF 不在任何枚举项内；F-1 表格路径同样不在任何枚举项内），且每次都是「**缺陷存在但条款与用例都覆盖不到**」。写条款时若不声明边界，读者会默认「列举即全部」。 | 评审时对每条枚举式条款逐条提问：**「未列举的情形按哪条处理？」** 答不上即为不合格。 |
| G-ANCHOR-4 | **跑测试后须重新确认制品指纹**：测试可能改写制品树内文件。 | 跑测试**前后**各做一次 `sha256sum` 比对；并用清单校验：`sha256sum <files> > /tmp/base.sum && sha256sum -c /tmp/base.sum`（不匹配即以非 0 退出。**本机已验证**：改动制品后 `-c` 正确报 `FAILED` 且 exit=1，还原后复 OK） |

---

## 16.3 流程缺陷与改进（本轮，冻结）

**责任定性（最终，不再变更）**
- **代码 / 文档 / 验证工作：三位成员均正确执行，无归责项。**
- **基线漂移：属流程失责，责任在冻结发起方（captain）。**
- engineer-frontend 两次主动认领"是我造成的" → captain 已明确纠正：**它在执行 captain 的指令（正确），captain 在指令在途时录基线（失责）**。

**captain 本轮四条失责（已确认）**

| # | 失责 | 后果 |
|---|---|---|
| 1 | 缺陷未关闭即冻结（F-2 尚待修完就录基线） | 基线失效 |
| 2 | 缺放行前末次采样校验 | v3.2.8 基线在发信号后才发现失效 |
| 3 | 用符号检索代替行为验证 | 误判 F-2"未修" |
| 4 | 状态不明时替成员裁决（把 F-2 裁为"不修"） | 裁决与事实相反（它已修完），裁决已作废 |

**第 5 条失责（第三批制品漂移后补记）**

| # | 失责 | 后果 |
|---|---|---|
| 5 | **批准制品改动时未广播给取证方**（三次制品漂移 F-2 / F-4 / F-4b 都只通知了改动人，漏了 verifier） | verifier **三次中断取证** |

> **流程修复（已生效）**：**凡批准任何影响制品的改动，必须在批准的同时广播给 verifier** —— 写明改什么、谁改、预期完成时间、请暂停取证。

**第 6 条失责（第 5 条的延伸，V3 期间暴露）**

| # | 失责 | 后果 |
|---|---|---|
| 6 | **预告与放行未分离**：在广播"F4B-1 即将落地"的**同一条消息里**就放行了执行，没有留出"停手 → 复核 → 才开工"的间隔 | `fence-machine.ts` 于取证窗口内变更（20:29:14），verifier 将窗口前的门禁证据**全部判失效并重采** |

> **流程修复（已生效）**：**"预告"与"放行"必须分成两条消息**；**放行须附「已复核稳定」的指纹**（即"我已确认制品在 N 分钟内未变"），否则取证方无从判断窗口是否干净。

**改进规则（现已生效）**
1. **写者事前声明意图**（"我将要改 X，请暂缓录基线"）→ captain 只在收到「已停手 + 指纹」后录基线；
2. **冻结锚点用线上制品**（见 G-ANCHOR-2）；
3. **基线只含制品，不含 `tests/**`**（见 G-ANCHOR-3）；
4. **跑测试后须重新确认制品指纹**（见 G-ANCHOR-4）；
5. **放行前末次采样校验**（缺陷先关闭 → 写者明确停手+无待改 → 两次采样一致 → 采集 → 复核 → 放行前末次采样）。

---

## 16.4 F-4 / F-4b 死代码清理的独立核验（reviewer，Q5 裁定）

> captain 明确邀请独立复核 F-4b「是否确为 Q5 未使用抽象」。以下是**独立取证结果**（内容锚点，非行号）。

### F-4b：`matchFenceOpen` / `matchFenceClose` / `FENCE_LANGS`

| 核验项 | 实测 | 判定 |
|---|---|---|
| 生产调用点 | 全仓（排除 `node_modules`）命中：`matchFenceOpen` **0**、`FENCE_LANGS` **0**、`matchFenceClose` **1（仅注释）** | ✅ 无生产调用点 |
| 与生产语义是否一致 | **不一致**：生产前端用 `renderMarkdown` 内的 `/^```\s*([\w-]*)\s*(.*)$/` 判开、`/^```/` 判闭（**行首**锚定）；已删的 `matchFenceClose` 为 `/^\s*(`{3,}|~{3,})\s*$/`（**允许前置空白、允许 `~~~`、要求整行仅围栏字符、且不要求与原开标记同字符**） | ✅ 确为两套口径 |

**裁定：F-4b 属 Q5「未使用抽象」，删除正确。** 补充理由（与 captain 一致）：**一份与生产不一致的"语法基准"比没有更危险**——后人会以为生产遵循它。

### F-4：`scanGates` 同型死代码

`scanGates` 全仓命中 **0**（含测试）；`output-gate.js` 现存导出为 `chooseBlockSource`/`planBlocks`/`checkRendered`/`checkImagePath`/`decodeBlockPayload`（**无** `scanGates`）。裁定：删除正确。

### 兜底路径仍然存在且是**活路径**（删除范围的边界正确）

`scanGates` 被删**不等于**兜底能力被删。实测存活链路：

```
chooseBlockSource({ sawBlockEvent }) → sawBlockEvent === true ? 'block-events' : 'fence-fallback'   // output-gate.js（单一裁决点，单向不可逆）
renderMarkdown 内：if (blockSourcePolicy() === 'block-events') continue                            // index.html（两处：未闭合块 + 已闭合块）
```

→ `fence-fallback` 下，前端的 `renderMarkdown` 仍**自行**按围栏产出占位/终态元素（分别覆盖未闭合与已闭合两分支）。这正是 v3.2.3 §9.7 所说"旧后端兼容路径"的**实现本体**，**未被** F-4 破坏。
另核：`web/guest/tests/gate-dom-check.mjs` 的「路径 B」标签改为「renderMarkdown 围栏兜底」、**测试体保留**，测的正是这条活路径 → 删除范围未误伤。

### 本次核验发现的一条 finding（low）

| id | 严重度 | problem | requiredFix |
|---|---|---|---|
| F4B-1 | **low** | `plugins/output-gate/src/fence-machine.ts` 的 `isClosingFence` 注释仍写「与访客端 `matchFenceClose` 同一口径」——该符号**已被 F-4b 删除**，注释指向不存在的对照物，且**真实口径本就不同**（见上表），会将后人误导为"两侧口径一致"。 | 改写该注释：删除对 `matchFenceClose` 的指称，直接写明本函数自身的闭合判据（整行仅同类围栏字符、长度 ≥ 起始、允许前后空白），**并明确标注与访客端 `renderMarkdown` 的判据差异**；或若产品要求两侧严格同构，则改为真正的单一实现（本次不要求，仅要求注释不再指向已删符号）。 |

> 该 finding 为 **low**（注释级、不影响行为）；但按 G-ANCHOR 纪律，"注释声称一致"属**措辞层**证据，而**行为层**证据显示不一致——正属方法论四例中的第 2 例，故如实记录而非略过。

### F4B-1 处置（captain 裁决）

| 项 | 裁决 |
|---|---|
| 修复时机 | **单独修复，不走 t7** —— t7 的 inScope 明确排除插件代码（把插件注释改动塞进 t7 会越界）；且该文件属**主机侧**，改动会使其指纹变化，**必须走完整冻结流程**（否则又成"制品漂移未广播"）。成本极低（一行注释），现在修完可让后续验证共用同一冻结基线。 |
| 修复要求 | 注释**不得再指向已删符号**（`matchFenceClose`）；并须**写明与前端 `renderMarkdown` 判据的实际差异**。 |
| 修复后动作 | **必须重录基线**（`fence-machine.ts` 指纹将变化）；且在开始修复前**广播 verifier**（依 §16.3 第 5 条的修复规则，避免再次中断取证）。 |
| t6 判据 | 新增：**F4B-1 是否已修复**（注释不再指向已删符号 + 明示差异）。 |

---

## 17. 需求 → 验收映射表（一页速查）

| 需求主题 | 条款 | 验收脚本 | 通过判据 |
|---|---|---|---|
| 先校验才能输出 | P3–P6、V1–V3、C1–C4 | AS-2、AS-10 | 合格前 DOM 无内容；合格后有 `<svg>`/`<img>`/`<iframe>` |
| 主机侧不可绕过 | E2、E3、E5、E6 | AS-3、AS-4、AS-11 | 三出口一致；载荷无源码；跨分帧识别正确 |
| 单一事实源 | C0、C7 | 代码审查 | 服务端无图形语义复算与拒绝分支 |
| 图片不得直达 API / 坏图 | **IMG1–IMG8（路径硬门禁）、C5、C4、C6（仅留痕）** | AS-1、AS-13 | 非法路径零请求（IMG1 硬门禁）；**可达性只留痕、死链交由真机 C4 裁决**（v3.2）；缓存状态不得决定内容 |
| **源码裸露全面封堵（四类围栏）** | **SRC1–SRC5、D4** | **AS-12** | **6 个代码点全部消除 `<pre><code>` 源码回退；四类围栏各有独立通过记录** |
| 图片白名单与外链防泄漏 | IMG1–IMG8、C5、C6、C4 | AS-1、AS-13 | 外部主机/`data:`/协议相对一律拒绝且零请求；自家绝对 URL 归一化通过；沙箱内外部图被 CSP 阻断 |
| 不通过 → 输出前替换 | REP1–RE5、D1–D3 | AS-1、AS-2 | 源码从不出现；占位→文案一次替换 |
| 生成侧前移 | GEN1–GEN4 | 提示词审查 + AS-1 | 契约存在；硬门禁独立成立 |
| 可见性证据 | V1–V5 | AS-2、AS-5 | DOM 快照文件与结论 |
| 留痕 | O1–O4 | AS-6 | 主机侧日志 7 字段 + 可聚合 |
| 预算 | T1–T6 | AS-8、**AS-14** | **`done` 不被推迟 >600ms；各块判定并行、多块回答不因预算降级**（v3.2）；文字不受影响 |
| 配置化 | G1、G2 | AS-7 | 逐键生效；默认值与本表一致 |
| 工程质量 | Q1–Q6 | AS-10 | 单测非零退出语义正确；无新增依赖 |
| **对抗验证证据有效性（流程）** | **G-FREEZE** | 见 §16.1 命令 | V1 须在接线闭合后启动；报告含 `serviceVersion` + 两文件 sha256 + `block-open`≥1；**须对被测制品取证（非源码）**；指纹等于基线 → 证据不足 |

---

## 18. R1 findings 处置（逐条：已吸收 / 已改判 / 拒绝）

| finding | 处置 | 落点与理由 |
|---|---|---|
| F1 blocker 两套事实源 | **已吸收** | C0/C7；服务端**只做一类**非渲染判定：**IMG1 图片路径白名单**（确定性、无网络依赖、硬门禁）+ 留痕。**可达性探测按 v3.2 裁决降为仅留痕、不参与放行**（C6）：依据 `deploy/nginx.conf:53` `proxy_cache_valid 404 10m`，源站瞬时 404 被缓存 10 分钟会使**缓存状态决定内容**；可达性只有真机 C4（`decode()` + `naturalWidth`）能裁决，这也彻底消除了原"服务端探测失败 → 误杀真机能加载的图"的误拒面。 |
| F2 blocker 重写作用域 | **已改判** | captain 撤回模型重写 → REP1 明确不做事后重写；原"作用域/时序竞争"问题随之消解；N2① 写入非目标。 |
| F3 high 缺块级缓冲协议 | **已吸收** | P3–P6；**新增** `loading` 阶段与 `libraryLoadTimeoutMs`（P5/G）把"库加载"与"判定计时"分离，否则首图必然被 1500ms 误降级。 |
| F4 medium 回传预算 | **已改判** | 回传不再触发重写 → 预算条款（原 RH3/RH7）删除；改为 O3 幂等去重 + O4 聚合；等待预算改由 T1/P7 定义（600ms）。 |
| F5 high 可见性门禁 | **已吸收** | V1–V5（可执行验收项 + DOM 快照证据形式）。 |
| F6 medium 降级顺序 / 服务端不做几何 | **已吸收** | C7、C8。 |
| F7 medium 留痕落主机侧 | **已吸收** | O1–O4；用途限定"发现模型反复出错"，不用于回改内容。 |
| F8 low i18n 键清单 | **已吸收** | D3（5 键 × 4 语言，禁硬编码）。 |
| F9 low 配置化 | **已吸收** | §12 + G1/G2（按 captain 冻结值 1500ms/600ms；新增 libraryLoadTimeoutMs；**移除** rewrite.* 键）。 |
| （captain 补充）四处源码裸露 | **已吸收并扩大** | §6 SRC1–SRC5 + §2.1 通道表。captain 列出 **4 处**；本轮实测复核为 **6 个代码点**（新增 `renderMermaidBlock` 初始容器——**流式期即在屏**，以及 `renderMarkdown` 未闭合分支），并发现**第 5 条图片通道**（`inlineMd` 行内 `![alt](url)`）同样宽松放行。 |
| （captain 补充）图片放行过宽 | **已决断：一并拒绝** | IMG1（含协议相对 `//`）、IMG8（`data:` 拒绝，理由与风险已写明；KB 实测 `data:image` 引用 0 条）、IMG6（自家源站绝对 URL 归一化边界，KB 实测 4 条此类引用）、IMG7（html 围栏 CSP `img-src` 收紧，堵住沙箱内外部图）。 |
| （新增）图片地址可回落 API 出口 | **已吸收（本轮新增条款）** | IMG1–IMG5；实测 `/uploads/../api/guest/health` → 200 guest JSON。 |
| （新增）跨分帧围栏识别 | **已吸收（本轮新增条款）** | E6 + Q6 + AS-11；口径 B 的硬前提。 |
| CF-1 blocker（P7 串行预算自溃） | **已裁决采纳推荐项：P7 改并行语义** | captain 2026-09-10 裁决。P7 重写为「各块并行、互不串行占预算；`answerWaitBudgetMs` 改为 `done` 前结算的收尾窗口」；T1 措辞改为「`done` 不得被推迟 >600ms」；AS-14 提供取证。已在实现中观察到串行版本（`gateTurnSpent` 累加 + `remainingGateBudget()` + `budget<=0` 即降级），裁决已同步下达 engineer-frontend。 |
| CF-2 high（C6 与 IMG6 冲突 / 缓存决定内容） | **已裁决采纳推荐项：C6 降为仅留痕** | captain 2026-09-10 裁决。依据 `deploy/nginx.conf:53` `proxy_cache_valid 404 10m`（源站瞬时 404 被缓存 10 分钟 → 期间所有引用该图的回答被降级）＋ C0/C7 单一事实源。**IMG1 路径白名单仍为硬门禁**，文档已明确区分两类判定。裁决已同步下达 engineer-core。 |
| CF-3 medium（E5 与 T4 冲突） | **已裁决：随 CF-2 消解，并写清下发时机** | captain 2026-09-10 裁决。E5 明确图片块随流下发、只携带 IMG1 路径判定结果，可达性结论不进载荷（只进留痕），block 事件无「未决」字段且不得为等探测阻塞 `delta`；T4 措辞相应修正为「探测不得进入送达路径」；AS-14 第 ③ 项取证。 |

---

## 19. v2 → v3 条款迁移表（供实现方对齐）

| v2 | v3 | 说明 |
|---|---|---|
| C0 | C0 | 不变（口径 B 下仍是唯一裁决者） |
| C1–C5（真机判据） | C1–C4 | 图片判据合并为 C4，新增服务端 C5/C6 |
| C6（探测仅告警） | **C6（确定性 404 即拦截）** 〔v3 状态；**已被 v3.2 取代**，见下行〕 | 口径变化，见 §7 |
| C7 | C7 | 不变 |
| C8 | C8 | 不变 |
| E6（口径 A/B 可选） | **E5（冻结 B）** | A 选项删除 |
| RH1–RH7（定向重写） | **REP1–REP5（输出前替换）** | 重写取消 |
| D1–D3 | D1–D3 | 不变 |
| V1–V5 | V1–V5 | 不变（V5 改为非法路径零请求证据） |
| O1–O4 | O1–O4 | O3 语义从"触发重写"改为"去重统计" |
| §10 配置（含 rewrite.*） | §12 | 删除 rewrite.*；新增 blockTimeoutMs/answerWaitBudgetMs/libraryLoadTimeoutMs/jsdomPrecheck〔**jsdomPrecheck 已于 v3.2.3 撤回、未实现**；配置面冻结 8 键，见 G1a〕 |
| — | GEN1–GEN4、T6、Q6、AS-11 | v3 新增 |
| — | **SRC1–SRC5、IMG6–IMG8、AS-12、AS-13、§2.1 通道表** | **v3.1 新增**（captain 补充事实 + 本轮实测复核） |
| C6（硬门禁，404/410 拦截） | **C6（仅留痕，不参与放行）** | **v3.2 裁决**：撤回硬门禁升级；路径白名单（IMG1）仍是硬门禁 |
| P7（串行总配额） | **P7（并行 + 收尾窗口）** | **v3.2 裁决**：各块并行；600ms 改为 `done` 前结算窗口 |
| T1（整条回答增量 ≤600ms） | **T1（`done` 不得被推迟 >600ms）** | **v3.2 裁决**：措辞修正，访客感知增量 ≈0 |
| T4（探测异步） | **T4（探测不得进入送达路径）** | **v3.2 裁决** + CF-3 |
| E5（block 含判定结果） | **E5 + 下发时机** | **v3.2 裁决**：图片块只带路径判定，可达性不进载荷 |
| — | **AS-14** | **v3.2 新增**：并行预算 / `done` 时延 / 帧间隔 取证 |
| IMG1–IMG5 | IMG1–IMG8 | 白名单扩大：新增协议相对/外部域名拒绝、第 5 通道覆盖、同源化、自家绝对 URL 归一化、html 围栏 CSP 收紧、`data:` 拒绝 |

---

## 20. 需 captain 复核的 3 点（不阻塞实现）

| # | 事项 | 本文件冻结值 | 为什么需要你确认 |
|---|---|---|---|
| 1 | **U2 的语义**（§0.2） | 「不通过需要修改」= 修正**送达内容**（降级替代），不修正**图形本身** | 若产品真意是"必须让图正确显示"，则需重新讨论（与流式互斥，见 R1-F2）。这是本轮唯一可能影响结论方向的判定。 |
| 2 | **Admin 链路覆盖口径**（N1②） | Admin 只适用生成侧契约（GEN），不设图形门禁（官方 GUI 不渲染围栏） | 你要求"两条链路"覆盖；这是把 Admin 纳入的最强合理形式，若你要求 Admin 也走门禁需另定渲染面。 |
| 3 | **可实现性风险提示**（T3/AS-5） | 首次 mermaid 库加载（3.4MB）不计入门禁 600ms 增量 | 慢网下首图占位可能持续数秒（显示占位文案，不显示源码）；若要求占位时长也纳入预算，需调整 P5/T3。 |

---

## 21. 实现契约同步提示（供 captain 更新 t3 / t4）

现行 t3/t4 契约按 v2 生成，与 v3 冻结取向存在以下冲突，需更新后执行（详见 `output-self-review-review-r1.md` 同目录报告与会话汇报）：

| 任务 | 冲突条款 | v3 要求 |
|---|---|---|
| t3 | acceptance「提供留痕与受预算约束的定向重写」「定向重写仅作用于仍未上屏的缓冲块，每轮 ≤1 次、不递归、超时即降级为终态不重试」 | **删除定向重写**；改为 REP2「未通过块在占位态替换为可读文字」 |
| t3 | acceptance「服务端图片可达性探测仅作告警与预判，不参与放行」 | 改为 C5 的 **IMG1 路径白名单硬门禁**（确定性、无网络依赖）；**可达性探测按 v3.2 裁决仅留痕、不参与放行**（C6），不得据 404/410 降级或拒绝——是否显示交真机 C4 裁决 |
| t3 | acceptance 未含分帧要求 | 新增 E6/Q6（跨分帧识别 + 1 字符/帧单测） |
| t3 | 交付物未含提示词契约 | 新增 GEN1/GEN2（两份 preset 提示词契约；已在 inScope 内） |
| t3 | 配置未给冻结值 | 按 §12：`blockTimeoutMs=1500`、`answerWaitBudgetMs=600`、`libraryLoadTimeoutMs=8000`，无 `rewrite.*` |
| t4 | acceptance「几何类失败按契约回传服务端（幂等三元组）」 | 保留回传，但语义改为 **O3 去重统计**（不触发重写）；幂等键仍为 `(sessionId, blockId, sourceDigest)` |
| t4 | 未含图片路径白名单 | 新增 IMG1/IMG2/IMG3（前端防御性校验 + 非法路径零请求 + 同源化） |
| t4 | 未含 `loading` 阶段 | 新增 P5（`pending→loading→validating`）与 `libraryLoadTimeoutMs` |
| t3+t4 | 交付物未含 AS-11 分帧注入 | 单测须覆盖 1 字符/帧与随机切片 |
| t4 | acceptance 只提到 mermaid 失败路径的源码回退（未覆盖四类围栏） | **改为 §6 SRC2 的 6 个代码点清单**（含 `renderMermaidBlock` 初始容器 `renderMermaidBlock` 初始容器 与未闭合图形块分支 `renderMarkdown` 未闭合分支），并按 SRC3 逐渲染器独立验收 |
| t4 | 图片白名单只针对 ` ```image ` 围栏 | **扩到两条通道**（IMG2：`renderImageBlock` + `inlineMd` 行内 `![alt](url)`），且共用同一判定函数、非法路径零请求 |
| t4 | 未含 `data:` / 外部 URL / 协议相对的处置 | 按 IMG1/IMG8：**一并拒绝**；IMG6 自家源站绝对 URL 先归一化再校验；IMG7 收紧 html 围栏 CSP `img-src` 为 `'self' data:` |
| t3 | 未含服务端图片路径合法性判定 | 按 C5/IMG1：服务端硬门禁路径正则（与前端同一常量与语义） |

---

## 22. 修订记录

| 版本 | 日期 | 变更 | 依据 |
|---|---|---|---|
| v1 | 2026-09-10 | 初版取向（服务端复算 + 前端按裁决 + 回传重写） | 用户诉求 + 原方案取向 |
| v2 | 2026-09-10 | 吸收 R1 评审 9 条意见：单一事实源、重写作用域、块级缓冲协议、可见性门禁、回传预算与终态、降级顺序、主机侧留痕、i18n 键清单、配置化；新增送达口径 A/B 与 history 出口 | `output-self-review-review-r1.md` |
| v3.2.12 | 2026-09-10 | **D-2 修正 + 一致性清扫**：新增 **G-ANCHOR-5**（判据不得内嵌 sha/计数/行号，须用相对表述；记录性表格除外但须标时点与失效条件）；把"混合制品"节的实测值表改为**相对表述**（现场取值 + 判定规则）；§16.3 补记**第 6 条失责**（预告与放行未分离 → 取证窗口被污染） | V3 报告 D-2 + captain 裁决 |
| v3.2.11 | 2026-09-10 | **录入新基线**（`index.html`=`e597f642b8c3337c…` 128426 B、`output-gate.js`=`11ebac8964857f0a…` 31718 B；主机侧 5 文件未变）；旧基线 `f0dc41832`/`cdf2869a` 并入作废对照表；**新增 §16.4 F-4/F-4b 独立核验**（Q5 裁定 + 兜底路径存活性取证 + 1 条 low finding F4B-1：`fence-machine.ts` 注释仍指已删的 `matchFenceClose` 且两侧口径本不同；**F4B-1 处置裁决：单独修复、不走 t7、修复后重录基线**）；§16.3 补记**第 5 条失责**（批准改动未广播取证方 → verifier 三次中断）与其修复规则 | captain 要求 + reviewer 独立取证 |
| v3.2.10 | 2026-09-10 | 新增 **§16.2 证据锚定方法论（G-ANCHOR / -2 / -3 / -4）**：四例"间接证据代替直接证据"（旧副本→线上制品、措辞→行为、符号→行为、事后陈述→事前声明）+ 判据优先级；新增 **§16.3 流程缺陷与改进**：captain 四条失责与五条改进规则、责任定性（成员无归责、责任在冻结发起方）；**G-ANCHOR-4 已本机验证**（`sha256sum -c` 双向：改动制品 → `FAILED` exit=1，还原 → OK） | captain 要求 + engineer-frontend 提炼 + reviewer 实证 |
| v3.2.9 | 2026-09-10 | **重录基线（F-2 修复后）**：新增 `web/guest/assets/package.json` 入基线（8 文件）；`index.html` = `f0dc41832cd79106…`（128477 B）、`output-gate.js` 尺寸更新为 34393 B；校验**线上 10800 页面指纹 = 仓库指纹**；`block-open`=6；**记录 v3.2.8 失效根因与流程改进**（缺陷未关闭即冻结 + 缺放行前末次采样；责任在冻结发起方） | captain 末次采样 + reviewer 全量复核 |
| v3.2.8 | 2026-09-10 | **录入两侧有效基线**（v3.2.7 三步规则首次执行）：前端 2 文件 + 主机侧 5 文件完整 sha256、`block-open`=6、基准时间戳 `19:05:49`；采集者 captain、复核者 reviewer（**7 文件全量**、两次独立采样与 captain 表值逐字相符）；已作废对照表并入全部历史指纹；**主机侧门槛解除** | captain 冻结信号 + reviewer 全量复核 |
| v3.2.7 | 2026-09-10 | **撤销过期基线 + 立防重演教训**：v3.2.4 录入的前端基线（`3ba15273…`/`block-open`=4）在数分钟内即与磁盘不符（现 `b887772b…`/`block-open`=6），**已作废**；写入硬规则——**基线只能在全部写者停手且连续两次采样一致后录制，并须由另一方复核一次**；同批明确「新机制的生产验证尚未发生」（10800 为无门禁旧后端，「298 采样点 0 泄漏」仅支持兜底路径可用，不支持门禁机制有效性） | captain 硬冻结协议 + reviewer 自查 |
| v3.2.6 | 2026-09-10 | **取证方式澄清**：确认性复验/对抗验证**统一走「源码实例」、不重建 docker 镜像**——本机实测 nginx `/srv/guest` 为 bind-mount（与工作区 sha256 相同）、agent 容器内无插件源码（旧镜像）；并加**条款有效期提示**：本节前提是"前端 bind-mount + 主机侧烘焙"，部署形态变化时必须更新本节 | captain 澄清 + reviewer 本机核实 |
| v3.2.5 | 2026-09-10 | **G-FREEZE 覆盖主机侧**：被测制品由「前端」扩为「**前端 + 主机侧**二元组」——新增两侧制品文件集表（前端 bind-mount / 主机侧烘焙进镜像，生效方式不同故须分别取证）；明确「仅核前端指针对主机侧修复无效」（F-1/F-2/F-3 皆主机侧改动）；主机侧基线待修复停手后录入，**录入前任何结论不得判合格** | captain 通知（主机侧已改多处）→ reviewer 补强 |
| v3.2.4 | 2026-09-10 | **重录 G-FREEZE 基线（接线闭合后）**：`index.html` = `3ba152739b68c6ae…`（124540 B，`block-open`=4）、`output-gate.js` = `184f8d52612dc375…`（32118 B）；旧基线三条（`67802984703f4ab3`/`d0a25f911fa5e302`/`f1960e9fc1d30833`）标注**已作废（接线前）**；**并据重测更新「混合制品」表**：10800 现为「新前端（`block-open`=4）+ 旧后端（`2026-09-10.8`）」，新增**禁止跨制品混用**条款（前端与后端须来自同一被测实例）；记明「接线闭合的唯一判据是 `block-open ≥ 1` 且 SSE 分支存在，**指纹变化不得作判据**」（实测：接线未完成时指纹曾抖动三次） | captain 通知接线闭合 + reviewer 本机实测录入 |
| v3.2.3 | 2026-09-10 | **配置面收敛**：删除 §13 `gate.jsdomPrecheck` —— 与 G1/Q5「未使用键不得保留」冲突（AS-7 不含它），且 C7 的最强合规形态是完全不引入 jsdom 依赖；新增 **G1a** 声明配置面冻结为 **8 键**；**同时补齐 AS-7 逐键清单**（原只列 4 键，漏 `enabled`/`maxBlockBytes`/`serverImageProbeTimeoutMs`/`reportPath`，经实测四者均在主机侧有真实调用点 12/15/3/7 处，故保留并补入覆盖清单，使 §13 表与 AS-7 严格同集合）；§19 迁移表该行标注〔jsdomPrecheck 已撤回、未实现〕保留历史；Q3 同步改为"服务端不使用 jsdom"。90 条编号未重排 | captain 裁决（2026-09-10，engineer-core 实现时发现的第三处条款冲突）+ 本机实测复核 |
| v3.2.2 | 2026-09-10 | 新增 **§16.1 G-FREEZE 流程条款**：V1 必须在两端接线闭合后启动，报告须记录被测构建的三重标识（`serviceVersion` + 两文件 `sha256` + `block-open` grep）；收录接线前基线（`index.html=67802984703f4ab3`、`output-gate.js=101ec5ac141e508f`、`block-open`=0）与"指纹未变即证据不足"判据；**并新增「源码构建 vs 被测制品」区分表**（本机实证：源码 `serviceVersion=2026-09-10.10`，而运行中容器 health 仍返回 `2026-09-10.8`、其服务页面 `block-open=0`），据此规定 V1 须对**实际被测制品**取证 | captain 决策（2026-09-10）｜ 报告：reviewer 前瞻提醒 + 本机实测复核 |
| v3.2.1 | 2026-09-10 | **文档内部一致性修正**：§17（F1 行）与 §21（t3 行）的 C6 旧措辞对齐 §7/§18/§19 的 v3.2 裁决；并自查修正 §13 配置表 `gate.serverImageProbe` 描述（原"确定性 404/410 即拦截"→"仅写留痕、不参与放行"）与 §19 v2→v3 行标注"已被 v3.2 取代"。89 条编号未重排 | captain 复核（engineer-core 实现时发现并拒绝执行冲突指令；captain 已肯定其做法并撤回旧措辞） |
| v3.2 | 2026-09-10 | 按 captain 裁决落盘 3 条：**CF-1** P7 改并行语义（删串行配额）+ T1 改为「`done` 不得被推迟 >600ms」；**CF-2** C6 降为仅留痕（依据 `deploy/nginx.conf:53` `proxy_cache_valid 404 10m`），IMG1 仍为硬门禁并写清两类判定区别；**CF-3** E5 写清图片块下发时机、T4 改为「探测不得进入送达路径」；新增 AS-14 与 §17/§19 相应行。89 条编号未重排（仅追加 AS-14） | captain 裁决（2026-09-10）｜ 报告：reviewer v3 自相矛盾审查（CF-1/2/3） |
| v3.1 | 2026-09-10 | 并入 captain 补充事实：**源码裸露扩到四类围栏 / 6 个代码点**（§2.1 + §6 SRC1–SRC5 + AS-12）；图片白名单扩到 IMG1–IMG8（外部域名与协议相对拒绝、`data:` 拒绝并写明理由与风险、自家绝对 URL 归一化、html 围栏 CSP `img-src` 收紧、**第 5 条通道 inlineMd 纳入**）；新增 AS-13 与四类围栏通道表 | captain 补充事实（2026-09-10）+ 本轮实测 |
| v3 | 2026-09-10 | 按 captain 拍板：**取消模型重写**（RH→REP）、**冻结口径 B**、**图片路径白名单**（IMG，硬门禁）+ 可达性确定性拦截（C6）、**冻结预算 1500ms/≤600ms**、新增 `libraryLoadTimeoutMs`、新增生成侧前移（GEN）、跨分帧识别（E6/Q6/AS-11）、U2 强度判定（§0.2）、实现契约同步提示（§20） | captain 拍板（2026-09-10 消息） |
