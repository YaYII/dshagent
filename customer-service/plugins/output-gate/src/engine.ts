/**
 * 输出前自审门禁 — 主机侧强制点（需求 v2 §3.2 口径 B / §5 / §6 / §9）。
 *
 * 本模块是「不可绕过」的落点：三条访客出口的每个字节都从这里出去，受控图形块
 * （mermaid/chart/image/html）的围栏分隔符与块体源码不再以明文出现在任何载荷里，
 * 未通过结构判定的块**根本不下发源码**。
 *
 * 判定分层（C0 单一事实源）：
 *   - 主机侧只做与真机同构的确定性检查（图片白名单、chart 数据结构、html 非空与
 *     字节上限）和不依赖渲染的结构性检查（空块、超预算、流中止未闭合）；
 *   - 需要渲染才能知道的事实（mermaid 语法与几何、图片自然尺寸）由访客浏览器裁决，
 *     经 `POST /api/guest/render-report` 回传；主机侧据此留痕与预判；
 *   - 主机侧永不做几何校验，也不把服务端结论当作拒绝真机能渲染块的依据（C0/C7）。
 *
 * 输出前替换（REP1–REP5，v3.2）：**不做事后重写**——不调用模型二次生成、不回改已进入
 * 访客 DOM 的内容。未通过的块在**占位态**（尚未上屏）就被替换为可读等价文字，属于
 * 「改完才给用户看」，而不是「先给用户看再去改」。`degraded` 是唯一终态：不重试、不递归、
 * 不影响 `done`（REP4）。
 *
 * @module output-gate/engine
 */

import { createHash } from 'node:crypto'
import { byteLength, FenceMachine, type FenceBlock, type GraphicsType } from './fence-machine.ts'
import {
  GATE_REASONS,
  acceptedReportReasons,
  imageCaption,
  imageSrcPath,
  stripGraphicsFences,
  structuralVerdict,
  UNCLOSED_REASON,
} from './block-rules.ts'

/** 解析后的门禁配置（由插件 Config 提供，默认值见需求 §10）。 */
export interface GateSettings {
  /** 总开关；false 时三个出口行为等同改造前（回滚用）。 */
  enabled: boolean
  /** 单块字节上限，超出直接降级。 */
  maxBlockBytes: number
  /** 闭合后等待真机裁决的上限（`gate.blockTimeoutMs`，默认 1500ms）。 */
  blockTimeoutMs: number
  /**
   * `done` 前结算的收尾窗口（`gate.answerWaitBudgetMs`，默认 600ms）。
   * P7（v3.2）：各块判定**并行**推进，此值不是串行总配额；`done` 时刻仍未结算的块
   * 按降级终态收尾，**不得阻塞 `done`**。
   */
  answerWaitBudgetMs: number
  /** 渲染器（mermaid 库）就绪等待上限；与判定计时分离（`gate.libraryLoadTimeoutMs`）。 */
  libraryLoadTimeoutMs: number
  /** 真机回传端点路径（`gate.reportPath`，随载荷下发访客端）。 */
  reportPath: string
}

/**
 * 下发到访客端的门禁配置（`meta`/`done` 的 `gate` 字段，单点可调）。
 *
 * 访客端只做渲染期裁决，因此它需要的计时口径全部由这里下发：判定上限
 * （`blockTimeoutMs`）、`done` 前收尾窗口（`answerWaitBudgetMs`）、渲染器就绪上限
 * （`libraryLoadTimeoutMs`，与判定计时分离，否则首图必被误降级）、单块字节上限。
 */
export interface GateConfigPayload {
  /** 单块 `validating` 判定超时。 */
  blockTimeoutMs: number
  /** `done` 前结算的收尾窗口。 */
  answerWaitBudgetMs: number
  /** 渲染器（mermaid 库）就绪等待上限；不计入判定计时。 */
  libraryLoadTimeoutMs: number
  /** 单块字节上限。 */
  maxBlockBytes: number
  /** 回传端点路径。 */
  reportPath: string
  /** 回传原因白名单（O2 枚举，访客端据此裁剪 reason）。 */
  reasons: string[]
}

/** 一条留痕记录（O2 七字段）。 */
export interface TraceEntry {
  /** 会话 id（访客会话 `guest-<uuid>`）。 */
  sessionId: string
  /** 块类型。 */
  blockType: GraphicsType
  /** 降级原因（O2 枚举）。 */
  reason: string
  /** 源码摘要（sha256 前 16 位）。 */
  sourceDigest: string
  /** 源码 UTF-8 字节数。 */
  sourceBytes: number
  /** 发生时刻（epoch ms）。 */
  occurredAt: number
  /** 终态（O2 冻结：`passed | degraded`，不含任何回改语义）。 */
  outcome: 'passed' | 'degraded'
}

/** 留痕出口（由插件接到 `ctx.logger`；测试可注入收集器）。 */
export interface Tracer {
  record(entry: TraceEntry): void
}

/** 下发块的形态（口径 B：源码以 base64 承载，明文不进载荷）。 */
export interface BlockPayload {
  /** 块 id（会话内唯一）。 */
  blockId: string
  /** 规范块类型。 */
  blockType: GraphicsType
  /** 块体源码的 base64；仅 `decision: 'render'` 时存在。 */
  sourceB64?: string
  /** 块体源码字节数（供访客端预算判定）。 */
  sourceBytes: number
  /** `render` = 交给真机裁决；`degraded` = 主机侧已确定不可显示。 */
  decision: 'render' | 'degraded'
  /** 降级原因（`degraded` 时给 O2 枚举值）。 */
  reason?: string
  /** 图片块：通过白名单的站点路径（无需源码即可显示）。 */
  imagePath?: string
  /** 图片块：说明文字。 */
  imageCaption?: string
}

/** 三出口共用的规范终态。 */
export interface GatePayload {
  /** 正文（受控块已摘除，不含任何围栏源码）。 */
  text: string
  /** 结构化块，顺序与正文中出现顺序一致。 */
  blocks: BlockPayload[]
  /** 真机裁决结论（块 id → 终态）；尚无回传的块按结构性结论记 `passed`。 */
  blockResults: Record<string, 'passed' | 'degraded'>
  /** 已降级块 id（访客端据此渲染可读替代）。 */
  degradedIds: string[]
  /** 本轮门禁配置。 */
  gate: GateConfigPayload
}

/** 流式事件（SSE 逐条下发）。 */
export type GateStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'block-open'; blockId: string; blockType: GraphicsType }
  | { type: 'block'; block: BlockPayload }

/** 访客回传的渲染结论（O3；字段已在插件层校验）。 */
export interface RenderReport {
  /** 会话 id。 */
  sessionId: string
  /** 块 id。 */
  blockId: string
  /** 块类型。 */
  blockType: GraphicsType
  /** 原因（O2 枚举或访客端同构细分）。 */
  reason: string
  /** 源码摘要。 */
  sourceDigest: string
  /** 源码字节数。 */
  sourceBytes: number
  /** 发生时刻。 */
  occurredAt: number
  /** 真机结论。 */
  outcome: 'passed' | 'degraded'
}

/**
 * 组装下发访客端的门禁配置（单一实现：轮次载荷与 `meta` 事件共用同一份）。
 * @param settings - 已解析配置。
 * @returns `meta`/`done` 的 `gate` 字段。
 */
export function gateConfigPayload(settings: GateSettings): GateConfigPayload {
  return {
    blockTimeoutMs: settings.blockTimeoutMs,
    answerWaitBudgetMs: settings.answerWaitBudgetMs,
    libraryLoadTimeoutMs: settings.libraryLoadTimeoutMs,
    maxBlockBytes: settings.maxBlockBytes,
    reportPath: settings.reportPath,
    reasons: [...acceptedReportReasons()],
  }
}

/** sha256 前 16 位摘要（O2 `sourceDigest`，可复算）。 */
export function shortDigest(source: string): string {
  return createHash('sha256').update(source, 'utf8').digest('hex').slice(0, 16)
}

/** 延迟一小段。 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, Math.max(0, ms)) })
}

/** 一个受控块在本轮的运行时状态。 */
interface BlockState {
  blockId: string
  blockType: GraphicsType
  decision: 'render' | 'degraded'
  reason: string | null
  source: string
  sourceBytes: number
  imagePath?: string
  imageCaption?: string
  /** 真机回传结论；未回传为 undefined。 */
  reported?: { outcome: 'passed' | 'degraded'; reason: string }
}

/** 一轮回答的门禁实例。 */
export class TurnGate {
  private readonly machine: FenceMachine
  private readonly blocks: BlockState[] = []
  private readonly turnStart = Date.now()
  /** 正文累积（受控块已摘除）。 */
  private text = ''
  /** 状态机异常后的应急净化模式：只缓冲，定稿时整段清洗（C8 兜底）。 */
  private readonly rawFallback: string[] = []
  private degradeToFallback = false

  /**
   * @param settings - 已解析的门禁配置。
   * @param sessionId - 访客会话 id（留痕与幂等键）。
   * @param tracer - 留痕出口。
   * @param onEvent - 流式事件回调。
   */
  constructor(
    private readonly settings: GateSettings,
    private readonly sessionId: string,
    private readonly tracer: Tracer,
    private readonly onEvent: (event: GateStreamEvent) => void,
  ) {
    this.machine = new FenceMachine({
      text: chunk => { this.emitText(chunk) },
      open: open => {
        this.onEvent({ type: 'block-open', blockId: this.blockIdFor(open.blockType, open.seq), blockType: open.blockType })
      },
      close: block => { this.closeBlock(block) },
    }, settings.maxBlockBytes)
  }

  /**
   * 送入一个回答增量。文字照常逐字流出，受控图形块被摘出为结构化事件。
   * `enabled=false`（回滚开关）时不摘块、原样透传，行为等同改造前。
   * @param delta - 模型输出的增量文本。
   */
  feed(delta: string): void {
    if (delta === '') return
    if (!this.settings.enabled) {
      this.emitText(delta)
      return
    }
    if (this.degradeToFallback) {
      this.rawFallback.push(delta)
      return
    }
    try {
      this.machine.feed(delta)
    } catch {
      this.enterFallback()
    }
  }

  /** 结束输入：未闭合块不得外发源码，以结构性降级收尾（P6/P8）。 */
  finishInput(): void {
    if (!this.settings.enabled) return
    if (this.degradeToFallback) return
    try {
      this.machine.finish()
    } catch {
      this.enterFallback()
    }
  }

  /**
   * 完成本轮：在收尾窗口内收集真机结论，然后给出规范终态。
   *
   * 结算**不得阻塞 `done`**（P7/T1）：最多等到 `turnStart + answerWaitBudgetMs`，
   * 到点仍未回传的块按当前结构性结论定稿（`render` 交真机继续裁决）。
   * @returns 三出口共用的载荷。
   */
  async settle(): Promise<GatePayload> {
    this.finishInput()
    this.flushFallback()
    await this.awaitReports()
    return this.payload()
  }

  /**
   * 记录一条访客回传（RH4 幂等：同一块的重复回传只累加计数，不触发第二次处理）。
   * @param report - 已通过字段校验的回传。
   * @returns 该回传是否首次处理（false = 重复或被忽略）。
   */
  recordReport(report: RenderReport): boolean {
    const block = this.blocks.find(item => item.blockId === report.blockId)
    if (block === undefined) return false
    if (block.reported !== undefined) return false
    block.reported = { outcome: report.outcome, reason: report.reason }
    if (block.decision === 'render') {
      // 真机结论本身进留痕（O2：outcome ∈ passed|degraded），用途是发现模型反复出错（O4）。
      this.trace(block.blockType, report.reason, report.sourceDigest, report.sourceBytes, report.outcome)
    }
    return true
  }

  /** 是否仍有等待真机裁决的块（已降级块不再等待）。 */
  hasPendingReports(): boolean {
    return this.blocks.some(block => block.decision === 'render' && block.reported === undefined)
  }

  /**
   * 在收尾窗口内等待真机回传（P7：`done` 前结算）。
   *
   * 没有「待裁决」块时**完全不等待**；全部块都已回传立即结束等待；窗口耗尽即定稿——
   * 未回传的块按结构性结论收尾，绝不阻塞 `done`（T1：门禁不得推迟 `done` >600ms）。
   * 各块判定并行推进，本窗口不是串行配额（P7 v3.2）。
   */
  private async awaitReports(): Promise<void> {
    if (!this.blocks.some(block => block.decision === 'render')) return
    const deadline = this.turnStart + Math.max(0, this.settings.answerWaitBudgetMs)
    while (Date.now() < deadline) {
      if (!this.hasPendingReports()) return
      await sleep(Math.min(25, Math.max(1, deadline - Date.now())))
    }
  }

  /** 闭合块：先做主机侧结构判定，再决定是否下发源码。 */
  private closeBlock(block: FenceBlock): void {
    const state: BlockState = {
      blockId: this.blockIdFor(block.blockType, block.seq),
      blockType: block.blockType,
      decision: 'degraded',
      reason: null,
      source: block.source,
      sourceBytes: block.sourceBytes,
    }
    if (!block.closed) {
      // P6/P8：未闭合围栏绝不以任何形式进入载荷，直接进入降级终态。
      state.reason = UNCLOSED_REASON
      state.source = ''
      this.trace(state.blockType, UNCLOSED_REASON, shortDigest(block.source), block.sourceBytes, 'degraded')
      this.blocks.push(state)
      this.onEvent({ type: 'block', block: this.toPayload(state) })
      return
    }
    const verdict = structuralVerdict(block.blockType, block.source, this.settings.maxBlockBytes, block.sourceBytes)
    state.decision = verdict.decision
    state.reason = verdict.reason
    if (verdict.decision === 'degraded') {
      this.trace(state.blockType, verdict.reason ?? GATE_REASONS.renderEmpty, shortDigest(block.source), block.sourceBytes, 'degraded')
      state.source = ''
    } else if (block.blockType === 'image') {
      // IMG3/IMG6：下发的必须是归一化后的站点相对路径（绝对 URL 会被归一化为 /uploads/…）。
      state.imagePath = imageSrcPath(block.source) ?? undefined
      state.imageCaption = imageCaption(block.source)
    }
    this.blocks.push(state)
    this.onEvent({ type: 'block', block: this.toPayload(state) })
  }

  /**
   * 块 id 必须是**内容确定性**的：同一份回答在当轮 SSE、非流式、历史重放三个出口
   * 重放时都要得到同一个 id（E1/E3/E4 三出口终态一致）。**不得使用时间戳做种**——
   * 实测该写法使两次门禁得到 `…-1789095667559-1` 与 `…-1789095668160-1`，直接判
   * 「三出口终态一致」FAIL。
   *
   * 跨轮次（同一会话不同回答）允许出现相同 id：访客端按「id + 内容摘要」复合键登记
   * 块来源，内容不同的块不会互相覆盖，因此无需在 id 里编码轮次。
   * @param blockType - 块类型（围栏语言）。
   * @param seq - 状态机内的块序号（同轮内消解重复块）。
   * @returns 形如 `blk-<14 位摘要>` 的块 id。
   */
  private blockIdFor(blockType: string, seq: number): string {
    const digest = shortDigest(`${this.sessionId}|${blockType}|${seq}`)
    return `blk-${digest}`
  }

  /** 规范化块载荷：降级块不带源码；渲染块源码以 base64 承载（口径 B）。 */
  private toPayload(state: BlockState): BlockPayload {
    const payload: BlockPayload = {
      blockId: state.blockId,
      blockType: state.blockType,
      sourceBytes: state.sourceBytes,
      decision: state.decision,
    }
    if (state.decision === 'render') {
      payload.sourceB64 = Buffer.from(state.source, 'utf8').toString('base64')
      if (state.imagePath !== undefined) payload.imagePath = state.imagePath
      if (state.imageCaption !== undefined) payload.imageCaption = state.imageCaption
    } else {
      payload.reason = state.reason ?? GATE_REASONS.renderEmpty
    }
    return payload
  }

  /**
   * 终态载荷。
   *
   * **`blockResults` 是主机侧发出的块终态**（取值域冻结为 `'passed' | 'degraded'`），
   * 按四分支判定，与 `blocks[].decision` 的取值域**不同**（后者是主机侧的结构性判定，
   * 仍为 `'render' | 'degraded'`）：
   *
   * | 情形 | `blockResults[id]` |
   * |---|---|
   * | 主机侧结构判定即降级（`decision === 'degraded'`） | `'degraded'` |
   * | 真机回传 `degraded` | `'degraded'` |
   * | 真机回传 `passed` | `'passed'` |
   * | 等待窗口内未收到任何回传 | `'passed'` |
   *
   * **`passed` ≠ 真机已验证**：它只表示「对访客保持可见 / 未被判负」。真机验证证据归属留痕
   * （O2 `outcome ∈ passed|degraded`），不放 `blockResults`。
   *
   * **窗口内未回传取 `'passed'` 而非 `'degraded'` 的理由**：该块在访客侧**已经渲染且可读**；
   * 若记 `'degraded'`，`/history` 回放会把一个当时正常显示的块剥离，**与访客实际所见不一致**。
   *
   * `settle()` 的次序是 `finishInput → flushFallback → awaitReports → payload`，即等待窗口
   * 耗尽后**一次性定稿**；因此真机结论**后到**不会改写已送达内容（REP5）。载荷同样**不含任何
   * 未决字段**（E5/T4）：`'passed'` 是定案，不是"等待中"。
   */
  private payload(): GatePayload {
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
    return {
      text: this.text,
      blocks: this.blocks.map(block => this.toPayload(block)),
      blockResults,
      degradedIds,
      gate: gateConfigPayload(this.settings),
    }
  }

  /** 正文外发（唯一出口：累积 + 事件）。 */
  private emitText(chunk: string): void {
    if (chunk === '') return
    this.text += chunk
    this.onEvent({ type: 'text', text: chunk })
  }

  /** 状态机异常：转入应急净化模式，后续内容只在定稿时整段清洗外发（C8 兜底）。 */
  private enterFallback(): void {
    if (this.degradeToFallback) return
    this.degradeToFallback = true
    // 已外发的文字一定是状态机判定为「安全」的片段；这里只把此后未判定的内容
    // 扣留，定稿时用逐行清洗（比状态机更简单，不会因同一处异常再次失败）。
    this.rawFallback.length = 0
  }

  /** 定稿时清洗应急模式下扣留的内容。 */
  private flushFallback(): void {
    if (!this.degradeToFallback || this.rawFallback.length === 0) return
    const raw = this.rawFallback.join('')
    this.rawFallback.length = 0
    const cleaned = stripGraphicsFences(raw)
    if (cleaned !== raw) {
      this.trace('mermaid', GATE_REASONS.renderEmpty, shortDigest(raw), byteLength(raw), 'degraded')
    }
    this.emitText(cleaned)
  }

  /** 写一条留痕（统一出口，字段固定）。 */
  private trace(
    blockType: GraphicsType,
    reason: string,
    sourceDigest: string,
    sourceBytes: number,
    outcome: TraceEntry['outcome'],
  ): void {
    this.tracer.record({
      sessionId: this.sessionId,
      blockType,
      reason,
      sourceDigest,
      sourceBytes,
      occurredAt: Date.now(),
      outcome,
    })
  }
}

/** 一轮门禁的工厂（由插件提供；测试可直接构造）。 */
export class OutputGate {
  /**
   * @param settings - 已解析配置。
   * @param tracer - 留痕出口。
   */
  constructor(
    private readonly settings: GateSettings,
    private readonly tracer: Tracer,
  ) {}

  /**
   * 开始一轮回答的门禁。
   * @param sessionId - 访客会话 id。
   * @param onEvent - 流式事件回调。
   * @returns 本轮 `TurnGate`。
   */
  beginTurn(sessionId: string, onEvent: (event: GateStreamEvent) => void): TurnGate {
    return new TurnGate(this.settings, this.sessionIdFor(sessionId), this.tracer, onEvent)
  }

  /** 本轮门禁配置（下发访客端）。 */
  get configPayload(): GateConfigPayload {
    return gateConfigPayload(this.settings)
  }

  /** 是否启用门禁。 */
  get enabled(): boolean {
    return this.settings.enabled
  }

  /** 留痕用的会话标识（非法/空 id 时回退为匿名标记，绝不写入空串）。 */
  private sessionIdFor(sessionId: string): string {
    return sessionId === '' ? 'anonymous' : sessionId
  }
}

/**
 * 单次（非流式）净化：给一个完整回答，产出三出口共用的载荷。
 * 与流式路径共用同一状态机与判定，因此两条出口终态一致（E1/E3）。
 * @param gate - 门禁工厂。
 * @param sessionId - 会话 id。
 * @param reply - 模型完整回答。
 * @param onEvent - 可选：把内部事件（文字/块）交回调用方。
 * @returns 规范载荷。
 */
export async function gateReply(
  gate: OutputGate,
  sessionId: string,
  reply: string,
  onEvent?: (event: GateStreamEvent) => void,
): Promise<GatePayload> {
  const turn = gate.beginTurn(sessionId, event => { onEvent?.(event) })
  turn.feed(reply)
  return turn.settle()
}
