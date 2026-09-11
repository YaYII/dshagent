/**
 * 主机侧围栏状态机 — 口径 B 的砖块层（需求 v2 §3.2 / §4）。
 *
 * 职责：把受控图形围栏（` ```mermaid `/` ```chart `/` ```image `/` ```img `/` ```html `）
 * 从流式回答中**摘出来**，使围栏分隔符与块体源码在送达访客之前就离开文字流。
 * 本模块是纯函数砖块：不碰 DOM、不读配置、不做网络 IO，只把字符流切成
 * 「文字 / 受控块」两种事件，因此流式与非流式、浏览器与 Node 复用同一份判定。
 *
 * 分帧安全（P1/P2 的核心难点）：SSE 的 `delta` 可能把围栏拆成 `"``"` + `` "`mermaid" ``，
 * 也可能把闭合围栏拆开。状态机因此在读出整行之前**扣留**可能成为围栏的字符序列，
 * 受控块体自打开起整段扣留，绝不以任何形式进入文字流。
 *
 * 识别口径（比 CommonMark 更保守，出于安全目的）：只要出现「≥3 个同类围栏字符
 * + 首个词是受控关键字」就按受控块处理，**不要求行首**。理由：围栏源码一旦漏进
 * 文字流，访客的抓包与 `curl` 就能看到它，而"行首才算是围栏"的宽松口径正好会给
 * 这种漏出留门。代价是极少数把 ` ```mermaid ` 当字面量提到的句子会被当成块摘出并
 * 降级——按 D2「宁可放弃图形内容、绝不回退为源码展示」处理。
 *
 * 非受控语言围栏（如 ` ```python `）保持现状：整块原文照旧透传（N2③），仅在
 * 「行首单独一行的同类围栏字符」处结束，因此普通代码块内部的图形围栏仍会被摘出
 * （否则 `curl` 载荷里会出现 ` ```mermaid `，与 E7 冲突）。
 *
 * 流尾未闭合的受控块以 `closed: false` 交回调用方：其源码不得外发（P6/P8）。
 *
 * @module output-gate/fence-machine
 */

/** 受控图形块类型（P1；`img` 与 `image` 同义，规范化后只有四类）。 */
export type GraphicsType = 'mermaid' | 'chart' | 'image' | 'html'

/** 围栏语言词 → 规范块类型；不在表中的语言是普通代码块。 */
export const GRAPHICS_KEYWORDS: Readonly<Record<string, GraphicsType>> = Object.freeze({
  mermaid: 'mermaid',
  chart: 'chart',
  image: 'image',
  img: 'image',
  html: 'html',
})

/** 受控语言词全表（用于流尾半截 info 行的前缀推断）。 */
export const GRAPHICS_WORDS: readonly string[] = Object.freeze(Object.keys(GRAPHICS_KEYWORDS))

/** 起始围栏被观测到时发出的块头（此刻尚无块体）。 */
export interface FenceOpen {
  /** 本文档内第几个受控块，从 0 开始（块 id 的序号部分）。 */
  seq: number
  /** 规范块类型。 */
  blockType: GraphicsType
  /** 围栏语言词之后的剩余 info（如 `mermaid mindmap` 的 `mindmap`）。 */
  info: string
}

/** 一个受控块的完整描述（闭合或流中止时给出）。 */
export interface FenceBlock extends FenceOpen {
  /** 块体源码（不含围栏行）；流尾未闭合时是已收到的部分内容。 */
  source: string
  /** 块体 UTF-8 字节数。 */
  sourceBytes: number
  /** 是否看到闭合围栏。false = 流中止时仍未闭合。 */
  closed: boolean
}

/** 状态机的外发出口（调用顺序即最终载荷顺序）。 */
export interface FenceHooks {
  /** 可安全外发的文字片段（不含任何受控围栏内容）。 */
  text(chunk: string): void
  /** 受控块的起始围栏已确认（P4：此刻起访客端可渲染占位）。 */
  open(open: FenceOpen): void
  /** 受控块结束（闭合，或流中止未闭合）。 */
  close(block: FenceBlock): void
}

/** info 行长度上限：超过即认定不是围栏（避免异常输入导致无界扣留）。 */
const INFO_LIMIT_CHARS = 512

/** UTF-8 字节数（块预算与留痕字段共用同一口径）。 */
export function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/** 去掉行尾的 `\r`（CRLF 输入的归一化，只影响判定用的行副本）。 */
function stripCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

/**
 * 一行是否为受控块的闭合围栏。
 *
 * 本函数自身的判据：整行仅**同类**围栏字符（`` ` `` 或 `~`）、可带**前置空白**与**尾随
 * 制表/空格**、长度 ≥ 起始围栏，且字符种类**与起始围栏相同**（`run[0] === char`）。
 *
 * **与前端 `isClosingFence`（`web/guest/index.html` 的 `renderMarkdown` 内）同口径**：
 * 前端同为「整行仅同类围栏字符 + 长度 ≥ 起始 + 允许前后空白」，且同样按起始围栏字符
 * 与长度校验，不只看行首三反引号；行尾 `\r` 的归一化两侧也都做了（本函数经 `stripCr()`
 * 归一化，`isClosingFence`、`decideInfo`、`overflowInfo` 三处调用点均先剥 `\r`；前端在其
 * 两个判据入口各自 `stripCr`，故 `tableCell()` 那条路径同样覆盖）。
 * 两侧各自服务的目的不同——主机侧要在**送达前**判定块边界，故取保守口径（宁可多认一个
 * 闭合点，也不把块体留在文字流里）；前端那条是**流式渲染的兜底路径**（本轮已有 block
 * 事件时根本不走它）。
 *
 * **已知的唯一残留差异**是前置空白字符类：本函数用 `\s`（含 NBSP/VT/FF/BOM 等 Unicode
 * 与控制空白），前端用 `[ \t]`（仅空格与制表）。仅当行首出现非常规空白字符时显现——
 * 实测 NBSP/VT/FF 前置时本函数判闭合、前端不判。该差异在前端侧有意保留：对齐它会把
 * 「NBSP 缩进的围栏」从正文改为受控块并降级，属**改变既有行为**，故未随 CRLF 修复一并处理。
 *
 * **改动任一侧都必须重新核对另一侧**：闭合口径不一对齐会导致围栏源码泄漏——CRLF 那次
 * 即是实例（一侧剥 `\r`、一侧未剥，前端受控围栏落入普通代码块并外发源码），已由两侧
 * 同时补 `stripCr` 消除。
 */
function isClosingFence(line: string, char: string, minLen: number): boolean {
  const match = /^\s*([`~]+)[ \t]*$/.exec(stripCr(line))
  if (match === null) return false
  const run = match[1]!
  return run[0] === char && run.length >= minLen
}

/**
 * 受控关键字判定：**前缀匹配**（保守口径）。
 *
 * 用前缀而非整词匹配，是因为 AS-3/E7 禁止载荷出现 ` ```mermaid ` 这类序列——而
 * `mermaidAAAA` 这种 info 在整词口径下"不是 mermaid"，会被当正文透传，载荷里却真真切切
 * 出现了 ` ```mermaid `。因此只要 info 以受控关键字开头就按受控块处理（最坏情况是把
 * 少数畸形围栏当块降级，代价远小于源码泄漏）。
 * @param info - 起始围栏行去掉围栏字符后的 info 文本（原始，可含前导空白）
 * @returns 规范块类型；不属于受控围栏时返回 null
 */
function controlledTypeOf(info: string): GraphicsType | null {
  const text = info.trim().toLowerCase()
  for (const word of GRAPHICS_WORDS) {
    if (text.startsWith(word)) return GRAPHICS_KEYWORDS[word]!
  }
  return null
}

/** 受控块类型判定（`img` 归一化为 `image`）。 */
function graphicsTypeOf(keyword: string): GraphicsType | null {
  return GRAPHICS_KEYWORDS[keyword] ?? null
}

/**
 * 流尾 info 行是否可能是受控围栏（`finish()` 的收尾判定专用）。
 *
 * 两个方向都要认，否则同一内容会因"流是否恰好在此刻结束"得到相反的安全结论：
 *   - **已写完关键字**（可能带尾随内容，如 `mermaidAAA`）：走 `controlledTypeOf` 前缀判定；
 *   - **正在打关键字**（如 `mer`）：尚不构成关键字，但任一受控词以它开头，也必须扣留。
 * 空 info（只写了围栏字符）同理按受控处理——围栏字符之后可能正好接 `mermaid`。
 * @param info - 已扣留的 info 文本（原始，可含空白）
 * @returns 推断出的块类型；不可能是受控围栏时返回 null
 */
function inferControlledType(info: string): GraphicsType | null {
  const text = info.trim().toLowerCase()
  if (text === '') return 'mermaid'
  const completed = controlledTypeOf(text)
  if (completed !== null) return completed
  const typing = GRAPHICS_WORDS.find(word => word.startsWith(text))
  return typing === undefined ? null : GRAPHICS_KEYWORDS[typing]!
}

/**
 * 状态机位置。
 *   text     —— 正文；同时累积可能成为围栏的连续围栏字符
 *   info     —— 已读到 ≥3 围栏字符，正在读 info 行（类型未定，内容全部扣留）
 *   graphics —— 受控块块体中（整段扣留，只等闭合围栏）
 */
type State = 'text' | 'info' | 'graphics'

/**
 * 增量围栏状态机。逐字符推进，跨 `delta` 分帧安全。
 *
 * ```ts
 * const machine = new FenceMachine(hooks, maxBlockBytes)
 * for (const delta of deltas) machine.feed(delta)
 * machine.finish()
 * ```
 */
export class FenceMachine {
  private state: State = 'text'
  /** 正文里正在累积的同类围栏字符（1-2 个时随时可能只是普通反引号）。 */
  private run = ''
  /** 已确认 ≥3 的起始围栏字符（进入 info 后用于还原与闭合判定）。 */
  private openRun = ''
  /** info 行内容（不含换行）。 */
  private held = ''
  /** 受控块块体（已闭合的完整行）。 */
  private body = ''
  /** 块体内当前行（闭合判定需要整行）。 */
  private bodyLine = ''
  /** 块体内已扣留的字节数。 */
  private bodyBytes = 0
  /** 正文外发缓冲：块边界处先冲刷，保证顺序。 */
  private out = ''
  /** 下一个块的序号。 */
  private seq = 0
  /** 当前受控块的类型与 info（`open` 时确定）。 */
  private openType: GraphicsType = 'mermaid'
  private openInfo = ''
  /** 块体是否已超出保留上限（超出后只记字节数，不再累积内容）。 */
  private oversizedBody = false
  private finished = false

  /**
   * @param hooks - 外发出口。
   * @param maxBlockBytes - 单块保留上限（`gate.maxBlockBytes`）：超出后停止累积源码，
   *   只继续计数并识别闭合行，避免异常输入占用无界内存。
   */
  constructor(
    private readonly hooks: FenceHooks,
    private readonly maxBlockBytes: number,
  ) {}

  /** 送入一段增量文本。 */
  feed(delta: string): void {
    if (this.finished) throw new Error('fence machine already finished')
    for (const ch of delta) this.step(ch)
    this.flushText()
  }

  /**
   * 结束输入。未闭合的受控块以 `closed: false` 交回调用方，其源码不得外发（P6/P8）。
   */
  finish(): void {
    if (this.finished) return
    this.finished = true
    switch (this.state) {
      case 'text': {
        // 结尾残留的 1-2 个围栏字符不构成围栏，按正文外发。
        this.out += this.run
        this.run = ''
        break
      }
      case 'info': {
        // 流尾半截 info：可能是受控围栏（`"```mer"`），一律按未闭合块处理并不外发。
        const inferred = inferControlledType(this.held)
        if (inferred === null) {
          this.out += this.openRun + this.held
        } else {
          this.flushText()
          this.hooks.close({
            seq: this.seq++,
            blockType: inferred,
            info: this.held.trim(),
            source: '',
            sourceBytes: 0,
            closed: false,
          })
        }
        break
      }
      case 'graphics': {
        // 流可能正好停在闭合围栏那一行（无尾随换行）：先按闭合行判一次。
        if (isClosingFence(this.bodyLine, this.openRun[0]!, this.openRun.length)) {
          this.bodyLine = ''
          this.flushText()
          this.emitClose(true)
          break
        }
        this.flushText()
        this.emitClose(false)
        break
      }
    }
    this.flushText()
  }

  /** 推进一个字符。 */
  private step(ch: string): void {
    switch (this.state) {
      case 'text': {
        if (ch === '`' || ch === '~') {
          if (this.run !== '' && this.run[0] !== ch) {
            // 围栏字符换了种类：前一段只是普通反引号/波浪号，照常外发。
            this.out += this.run
            this.run = ch
            return
          }
          this.run += ch
          if (this.run.length >= 3) {
            this.openRun = this.run
            this.run = ''
            this.held = ''
            this.state = 'info'
          }
          return
        }
        if (this.run !== '') {
          this.out += this.run
          this.run = ''
        }
        this.out += ch
        return
      }
      case 'info': {
        if (ch === '\n') {
          this.decideInfo()
          return
        }
        // 同类围栏字符继续延长起始围栏（````mermaid 这种更长围栏同样成立）。
        if (ch === this.openRun[0] && this.held === '') {
          this.openRun += ch
          return
        }
        this.held += ch
        // 异常长的 info 行：先看首词是不是受控关键字，再决定透传还是扣留。
        // 不能无条件透传——否则 ```mermaid 后跟 >512 字符的内容会把整行（含围栏与
        // 块体源码）当正文外发，而同样内容只要换行早一点就会被 decideInfo 摘成块，
        // 同一内容因行长得到两种相反的安全结论（E7/SRC1 违约）。
        if (this.held.length > INFO_LIMIT_CHARS) this.overflowInfo()
        return
      }
      case 'graphics': {
        if (ch !== '\n') {
          // 形如 `` ```后 `` 的行：闭合围栏出现在行内，块到此结束，余下文字回到正文。
          // 但 ```` ```chart ```` 这类嵌套起始行不能被误判成闭合（见 closesInline）。
          if (this.closesInline(ch)) {
            this.bodyLine = ''
            this.flushText()
            this.emitClose(true)
            this.step(ch)
            return
          }
          this.bodyLine += ch
          return
        }
        if (isClosingFence(this.bodyLine, this.openRun[0]!, this.openRun.length)) {
          this.bodyLine = ''
          this.flushText()
          this.emitClose(true)
          return
        }
        this.appendBody(`${this.bodyLine}\n`)
        this.bodyLine = ''
        return
      }
    }
  }

  /** info 行结束：判定受控图形块还是普通代码块。 */
  private decideInfo(): void {
    const line = stripCr(this.held)
    this.held = ''
    // 起始围栏字符已在进入 info 时消费进 `openRun`，这里只需看首个词。
    const info = line.trim()
    // 前缀判定：`mermaid mindmap` 与 `mermaidAAAA` 都算受控围栏（见 controlledTypeOf）。
    const type = controlledTypeOf(info)
    if (type === null) {
      // 非受控语言围栏（或异常行）：整行原文透传，保持现状（N2③）。
      this.flushText()
      this.out += this.openRun + line + '\n'
      this.openRun = ''
      this.state = 'text'
      return
    }
    this.flushText()
    this.openType = type
    this.openInfo = info
    this.body = ''
    this.bodyLine = ''
    this.bodyBytes = 0
    this.oversizedBody = false
    this.state = 'graphics'
    this.hooks.open({ seq: this.seq, blockType: type, info })
  }

  /**
   * 异常长的 info 行（超过 {@link INFO_LIMIT_CHARS}）的处置。
   *
   * 与 {@link decideInfo} 用**同一套前缀判定**，只是不看闭合换行：
   *   - 首词是受控关键字 → 转入 `graphics` 块体态：把已扣留的超长 info 当作块体开头，
   *     此后继续按正常闭合围栏规则识别，**该行余下字符与后续块体一律不外发**；
   *   - 否则 → 非受控语言（`python` 等）或普通正文，按现状透传（N2③）。
   *
   * 必须与 `decideInfo` 结论一致：否则同一内容会因"info 行是否超长"得到相反的安全
   * 结论——超限就整行（含围栏与块体源码）漏进载荷（E7/SRC1 违约）。
   */
  private overflowInfo(): void {
    const info = stripCr(this.held)
    const type = controlledTypeOf(info)
    if (type === null) {
      // 非受控语言：整行原文透传，保持现状（N2③）。
      this.out += this.openRun + this.held
      this.held = ''
      this.openRun = ''
      this.state = 'text'
      return
    }
    // 受控关键字：转入块体态，已扣留的 info 文本成为块体开头（后续同样扣留到闭合围栏）。
    const held = this.held
    this.held = ''
    this.flushText()
    this.openType = type
    this.openInfo = info.slice(0, INFO_LIMIT_CHARS)
    this.body = ''
    this.bodyLine = held
    this.bodyBytes = 0
    this.oversizedBody = false
    this.state = 'graphics'
    this.hooks.open({ seq: this.seq, blockType: type, info: this.openInfo })
  }

  /**
   * 块体内**行内**闭合围栏的判定：当前行已是一段纯围栏字符、且刚到的字符不会把它
   * 变成嵌套围栏的起始行时，才算闭合。
   *
   * 关键点：` ```chart ` 这种嵌套起始行在读到第三个反引号时，行内容恰好等于 ` ``` `；
   * 若此时就判闭合，外层块会提前结束，嵌套块的 `chart` 与块体源码随即漏进正文（SRC1 违约，
   * F-3）。因此遇到可能开启受控关键字的字母（c/m/i/h）就先不判，等整行读到换行再说。
   * @param ch - 刚读到的字符
   * @returns 应当就地闭合时为 true
   */
  private closesInline(ch: string): boolean {
    if (!isClosingFence(this.bodyLine, this.openRun[0]!, this.openRun.length)) return false
    // 刚到的字母是否可能是某个受控关键字的前缀（c→chart、m→mermaid、i→image/img、h→html）？
    // 是就先不判闭合，等整行读到换行——否则 ```` ```chart ```` 这种嵌套起始行会把外层块
    // 提前结束，嵌套块的源码随即漏进正文（F-3/SRC1）。
    const prefix = ch.toLowerCase()
    if (/^[a-z]$/.test(prefix) && GRAPHICS_WORDS.some(word => word.startsWith(prefix))) return false
    return true
  }

  /** 累积块体并统计字节数；超出保留上限后只计数。 */
  private appendBody(chunk: string): void {
    if (this.oversizedBody) {
      this.bodyBytes += byteLength(chunk)
      return
    }
    this.body += chunk
    this.bodyBytes += byteLength(chunk)
    if (this.bodyBytes > this.maxBlockBytes) this.oversizedBody = true
  }

  /** 闭合（或流中止）时给出块描述。 */
  private emitClose(closed: boolean): void {
    const source = closed ? this.body : this.body + this.bodyLine
    const bytes = closed ? this.bodyBytes : this.bodyBytes + byteLength(this.bodyLine)
    const block: FenceBlock = {
      seq: this.seq++,
      blockType: this.openType,
      info: this.openInfo,
      source,
      sourceBytes: bytes,
      closed,
    }
    this.body = ''
    this.bodyLine = ''
    this.bodyBytes = 0
    this.oversizedBody = false
    this.openRun = ''
    this.state = 'text'
    this.hooks.close(block)
  }

  /** 把缓冲文字交给调用方。 */
  private flushText(): void {
    if (this.out === '') return
    const chunk = this.out
    this.out = ''
    this.hooks.text(chunk)
  }
}
