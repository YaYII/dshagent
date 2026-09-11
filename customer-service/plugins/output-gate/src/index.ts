/**
 * 「输出前自审」门禁插件 — 主机侧不可绕过点（需求 v2 §3.2 / §6 / §9 / §10）。
 *
 * 本插件把围栏状态机、结构性判定与定向重写组装成主机侧服务 `outputGate`，由访客
 * HTTP 桥（`guest-server`）在**三条出口**（`/api/guest/chat`、`/api/guest/chat/stream`、
 * `/api/guest/history`）上强制调用：正文经状态机摘除受控图形块后外发，块以结构化
 * 载荷下发（源码以 base64 承载），未通过结构判定的块不带源码。因此「绝不把原始围栏
 * 源码交给访客」由主机侧保证，不依赖提示词，也不依赖访客端自觉（E2）。
 *
 * 分工（C0/C7 强制）：能否显示的裁决权归访客浏览器里的真机渲染器；本插件不做几何
 * 校验、不做 mermaid 语法复算（jsdom 下 `render()` 必然抛 `getBBox is not a function`，
 * 用它当判据只会误拒真机能显示的块）。主机侧只做与真机同构的确定性检查（图片白名单、
 * chart 数据结构、html 非空与字节上限）和不依赖渲染的结构性检查（空块、超预算、
 * 流中止未闭合）。真机结论经 `POST /api/guest/render-report` 回传，用于留痕与定向重写。
 *
 * **不做事后重写（REP1）**：本插件不调用模型二次生成、不回改已上屏内容；因此没有
 * 任何「事后重写」类配置，也不存在第二次模型调用。
 *
 * 留痕（O1/O2/O4）：统一前缀 `guest.output-gate`，七个字段
 * `sessionId/blockType/reason/sourceDigest/sourceBytes/occurredAt/outcome`（outcome ∈
 * `passed|degraded`，不含任何回改语义），同时按 `sessionId|blockType|reason` 计数，
 * 用途限定为「发现模型反复出错」（O4）。
 *
 * @module customer-service/output-gate
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  type GateConfigPayload,
  type GatePayload,
  type GateSettings,
  type GateStreamEvent,
  type RenderReport,
  OutputGate,
  gateReply as runGateReply,
  shortDigest,
  type TraceEntry,
  type TurnGate,
} from './engine.ts'
import { acceptedReportReasons, checkImagePath } from './block-rules.ts'
import type { GraphicsType } from './fence-machine.ts'

/** Export shape expected of function plugins. */
export const name = 'output-gate'

/**
 * Services this plugin registers against. It owns no hard dependency: the LLM route
 * and default-model selection are read lazily with `ctx.get()`, so a missing route
 * 不得改变任何判定（REP1：事后重写已在 v3.2 整条取消）。
 */
export const inject: string[] = []

/** 留痕前缀（O1 冻结）。 */
const TRACE_PREFIX = 'guest.output-gate'

/**
 * 门禁插件配置（需求 v3.2 §13 冻结键；默认值即该表值，禁止硬编码）。
 *
 * **没有任何事后重写开关**：REP1 冻结「不做事后重写」——不调用模型二次生成、
 * 不回改已上屏内容。未通过的块在占位态直接替换为可读文字（REP2）。
 */
export interface Config {
  /** 门禁本体配置。 */
  gate: {
    /** 总开关；false 时三个出口行为等同改造前（回滚用）。 */
    enabled: boolean
    /** 单块 `validating` 判定超时（默认 1500ms）。 */
    blockTimeoutMs: number
    /** `done` 前结算的收尾窗口（默认 600ms；P7 并行语义，非串行总配额）。 */
    answerWaitBudgetMs: number
    /** 渲染器（mermaid 库）就绪等待上限；与判定计时分离（默认 8000ms）。 */
    libraryLoadTimeoutMs: number
    /** 单块字节上限，超出直接降级。 */
    maxBlockBytes: number
    /** 服务端图片可达性探测开关；结论**仅留痕**（C6，v3.2）。 */
    serverImageProbe: boolean
    /** 探测超时；超时不拒绝。 */
    serverImageProbeTimeoutMs: number
    /** 真机回传端点路径（下发访客端）。 */
    reportPath: string
  }
}

/** Schemastery configuration. */
export const Config: z<Config> = z.object({
  gate: z.object({
    enabled: z.boolean().default(true),
    blockTimeoutMs: z.number().default(1500),
    answerWaitBudgetMs: z.number().default(600),
    libraryLoadTimeoutMs: z.number().default(8000),
    maxBlockBytes: z.number().default(32768),
    serverImageProbe: z.boolean().default(true),
    serverImageProbeTimeoutMs: z.number().default(2000),
    reportPath: z.string().default('/api/guest/render-report'),
  }).required(),
})

/**
 * 开始一轮回答时的可选上下文（由 HTTP 桥提供）。
 *
 * 只有 `origin`：图片可达性探测需要同源地址（C6，结论仅留痕）。v3.2 删除事后重写后，
 * 门禁不再有任何模型调用，因此不再需要访客语言。
 */
export interface TurnOptions {
  /** 访客请求的源站（图片可达性探测用；缺省则跳过探测）。 */
  origin?: string
}

/** 门禁服务对外的形态（`guest-server` 消费）。 */
export interface OutputGateService {
  /** 门禁是否启用。 */
  readonly enabled: boolean
  /** 下发访客端的门禁配置（`meta`/`done` 的 `gate` 字段）。 */
  readonly configPayload: GateConfigPayload
  /** 开始一轮门禁（流式路径逐帧 `feed`）。 */
  beginTurn(sessionId: string, onEvent: (event: GateStreamEvent) => void, options?: TurnOptions): TurnGate
  /** 单次净化（非流式路径与历史重放共用同一判定，保证三出口终态一致）。 */
  gateReply(
    sessionId: string,
    reply: string,
    onEvent?: (event: GateStreamEvent) => void,
    options?: TurnOptions,
  ): Promise<GatePayload>
  /**
   * 记录一条真机回传（O3/RH4）。
   * @returns 该回传是否被本轮首次处理（轮次已结束或重复时为 false）。
   */
  recordReport(report: RenderReport): boolean
  /** 回传原因白名单（`guest-server` 校验请求体用）。 */
  acceptedReasons(): ReadonlySet<string>
  /** 留痕计数（`sessionId|blockType|reason` → 次数），供聚合与验收取证（O4）。 */
  stats(): Record<string, number>
}

/** 插件入口：把门禁服务注册到主机上下文。 */
export function apply(ctx: Context, config: Config): void {
  const settings: GateSettings = {
    enabled: config.gate.enabled,
    maxBlockBytes: config.gate.maxBlockBytes,
    blockTimeoutMs: config.gate.blockTimeoutMs,
    answerWaitBudgetMs: config.gate.answerWaitBudgetMs,
    libraryLoadTimeoutMs: config.gate.libraryLoadTimeoutMs,
    reportPath: config.gate.reportPath,
  }
  /** 留痕计数（O4 可聚合）。 */
  const counters = new Map<string, number>()
  /** 活跃轮次：真机回传按会话路由到对应轮次。 */
  const liveTurns = new Map<string, TurnGate>()
  /** 轮次上下文（图片可达性探测需要访客源站）。 */
  const turnOptions = new Map<string, TurnOptions>()
  /** 异常情况下的会话泄漏护栏（正常轮次结束时移除）。 */
  const LIVE_TURNS_MAX = 500

  /** 写一条主机侧留痕（O1/O2）。 */
  const trace = (entry: TraceEntry): void => {
    const key = `${entry.sessionId}|${entry.blockType}|${entry.reason}`
    counters.set(key, (counters.get(key) ?? 0) + 1)
    ctx.logger.warn(
      `${TRACE_PREFIX} sessionId=${entry.sessionId} blockType=${entry.blockType} reason=${entry.reason}`
      + ` sourceDigest=${entry.sourceDigest} sourceBytes=${entry.sourceBytes}`
      + ` occurredAt=${entry.occurredAt} outcome=${entry.outcome}`,
    )
  }

  const gate = new OutputGate(settings, { record: trace })

  /**
   * 服务端图片可达性探测：**只告警**（C6/C8）。
   * 结论只写留痕，绝不参与放行；开关关闭、缺源站、网络不通或超时都只是跳过该项。
   */
  const probeImage = (block: { sourceBytes: number; imagePath?: string }, options: TurnOptions): void => {
    if (!config.gate.serverImageProbe) return
    const path = block.imagePath
    if (path === undefined || options.origin === undefined || options.origin === '') return
    if (!checkImagePath(path).ok) return
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Math.max(1, config.gate.serverImageProbeTimeoutMs))
    void fetch(`${options.origin}${path}`, { method: 'HEAD', signal: controller.signal, redirect: 'manual' })
      .then(response => {
        if (response.ok) return
        trace({
          sessionId: 'image-probe',
          blockType: 'image',
          reason: 'image-unreachable',
          sourceDigest: shortDigest(path),
          sourceBytes: block.sourceBytes,
          occurredAt: Date.now(),
          outcome: 'degraded',
        })
      })
      .catch(() => { /* 探测不可用：跳过该项，不阻断回答（C8） */ })
      .finally(() => { clearTimeout(timer) })
  }

  /**
   * 把块事件接到调用方的下游回调，并在**其后**触发可达性探测。
   *
   * 顺序是刻意的（E5/T4 裁决）：块事件先同步下发，探测只是事后旁路——因此即使探测
   * 本身抛错或阻塞，也**不会**推迟 block 下发或 `delta` 帧间隔。可达性结论只进留痕
   * （C6），不进载荷、不参与放行。
   */
  const forward = (options: TurnOptions, onEvent: (event: GateStreamEvent) => void) =>
    (event: GateStreamEvent): void => {
      onEvent(event)
      if (event.type === 'block') probeImage(event.block, options)
    }

  const service: OutputGateService = {
    get enabled(): boolean {
      return settings.enabled
    },
    get configPayload(): GateConfigPayload {
      return gate.configPayload
    },
    beginTurn(sessionId, onEvent, options = {}): TurnGate {
      turnOptions.set(sessionId, options)
      const turn = gate.beginTurn(sessionId, forward(options, onEvent))
      liveTurns.set(sessionId, turn)
      if (liveTurns.size > LIVE_TURNS_MAX) {
        const oldest = liveTurns.keys().next().value
        if (oldest !== undefined && oldest !== sessionId) {
          liveTurns.delete(oldest)
          turnOptions.delete(oldest)
        }
      }
      return turn
    },
    async gateReply(sessionId, reply, onEvent, options = {}): Promise<GatePayload> {
      turnOptions.set(sessionId, options)
      return runGateReply(gate, sessionId, reply, forward(options, onEvent ?? (() => { /* 非流式调用方不需要逐帧事件 */ })))
    },
    recordReport(report: RenderReport): boolean {
      const turn = liveTurns.get(report.sessionId)
      if (turn !== undefined) return turn.recordReport(report)
      // 轮次已结束（回传晚到）：只留痕聚合，不再触发重写（RH1：不上屏的内容不回改）。
      trace({
        sessionId: report.sessionId,
        blockType: report.blockType,
        reason: report.reason,
        sourceDigest: report.sourceDigest,
        sourceBytes: report.sourceBytes,
        occurredAt: report.occurredAt,
        outcome: report.outcome,
      })
      return false
    },
    acceptedReasons(): ReadonlySet<string> {
      return acceptedReportReasons()
    },
    stats(): Record<string, number> {
      return Object.fromEntries(counters)
    },
  }

  // 注册即副作用：`ctx.provide` 返回的 disposer 随本插件的 fiber 卸载自动执行（Q1 可回滚）。
  const disposeService = ctx.provide('outputGate', service)
  ctx.effect(() => () => {
    disposeService()
    liveTurns.clear()
    turnOptions.clear()
  }, 'output-gate.service')
}
