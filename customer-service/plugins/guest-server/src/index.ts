/**
 * Guest (visitor) HTTP API for the customer-service deployment.
 *
 * A Host plugin that registers `/api/guest/*` JSON routes on the official
 * webserver (the same listener that serves the Admin Web GUI). Visitors do
 * not authenticate: the guest surface is anonymous, and the only capability
 * it grants is a conversation with the `customer-service-guest` agent preset,
 * which is read-only (knowledge_search over the vault).
 *
 * Route contract (all JSON, UTF-8):
 *   POST /api/guest/session   -> 201 { sessionId }       (new visitor session)
 *   POST /api/guest/chat      -> 200 { reply, sources }  (send one message, await reply)
 *   GET  /api/guest/health    -> 200 { ok: true }
 *
 * Per-IP rate limiting is enforced in memory on the chat route: each client
 * may send at most `rateLimitPerWindow` chats per `rateLimitWindowMs`. The
 * bucket is per process — adequate for a single-container deployment. The
 * session route is also rate-limited so an attacker cannot open unbounded
 * sessions.
 *
 * Sessions are plain dsh sessions created with the `customer-service-guest`
 * agent preset. One chat request runs one turn: it appends a user message,
 * awaits agent quiescence, then reads the committed assistant message from
 * the session log through the official `ctx.sessionQuery` service and returns
 * its text plus any cited knowledge-base source paths.
 *
 * This plugin mounts on the HOST plane; its row belongs in the
 * customer-service profile composition (see customer-service/deploy/profile),
 * not in an agent preset.
 * @module customer-service/guest-server
 */

import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'

/** Export shape expected of function plugins. */
export const name = 'guest-server'
/** Services this plugin registers against. */
export const inject = ['webServer', 'agents', 'sessionQuery', 'sessionPersistence', 'agentDefaultModel', 'agentPresets']

/** Guest-server configuration. */
export interface Config {
  /** Agent preset mounted for guest sessions. */
  preset: string
  /** Workspace (cwd) for guest sessions; the persona's {{cwd}} and sandbox anchor. */
  workspace: string
  /** Process-wide ceiling of live guest sessions (memory guard). */
  maxSessions: number
  /** Window (ms) in which repeated identical messages count as spam. */
  spamWindowMs: number
  /** Identical messages within spamWindowMs that trigger a block. */
  spamRepeat: number
  /** Block duration in ms after an attack is detected (cool-down). */
  blockMs: number
  /**
   * Reasoning effort pinned for guest turns. Customer-service Q&A is
   * retrieval-grounded and rarely benefits from deep deliberation; leaving
   * the model at its default (high) effort lets a single uncertain turn
   * burn 15-20s emitting a long reasoning chain before the first answer
   * token. Pin low/off so first tokens arrive fast (mobile visitors leave
   * otherwise). Omit to keep the deployment default.
   */
  reasoningEffort?: string
}

/** Schemastery configuration. */
export const Config: z<Config> = z.object({
  preset: z.string().default('customer-service-guest'),
  workspace: z.string().default('/kb'),
  maxSessions: z.number().default(500),
  spamWindowMs: z.number().default(30_000),
  spamRepeat: z.number().default(3),
  blockMs: z.number().default(60_000),
  reasoningEffort: z.string(),
})

/**
 * Abuse guard: two-stage, human-style moderation per conversation.
 *   Stage 1 (WARN): a first abusive/repeated-spam message is NOT blocked —
 *   the user is politely reminded and the reply still goes through.
 *   Stage 2 (BLOCK): if the same kind of misbehaviour continues (a second
 *   abusive message, or spam repeats past the threshold), the conversation is
 *   blocked for `blockMs` (60s) with a calm-down notice.
 * Judgement keys on the conversation (session), never on the IP.
 */
class AttackGuard {
  private readonly recent = new Map<string, Array<{ text: string; at: number }>>()
  private readonly warned = new Map<string, Set<string>>()
  private readonly blockedUntil = new Map<string, number>()
  constructor(
    private readonly spamWindowMs: number,
    private readonly spamRepeat: number,
    private readonly blockMs: number,
  ) {}

  /** Roughly normalise a message for duplicate detection (lowercase, collapse spaces). */
  private static norm(text: string): string {
    return text.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 200)
  }

  /** Whether the text is abusive/attack content (profanity/insults in zh/en). */
  private static isAbusive(text: string): boolean {
    const lower = text.toLowerCase()
    const abusive = [
      'fuck', 'shit', 'bitch', 'asshole', 'stupid', 'idiot', '笨蛋', '白痴', '傻逼', '你妈', '去死',
      '垃圾客服', '废物', '操你', '妈的', '混蛋', '王八蛋', '贱人', '神经病',
    ]
    if (abusive.some(w => lower.includes(w))) {
      const len = text.length
      const hits = abusive.filter(w => lower.includes(w)).length
      return len <= 60 || hits >= 2
    }
    return false
  }

  /**
   * Decide admission for one chat message of a conversation.
   * @returns
   *   - `{ kind: 'ok' }` — proceed normally.
   *   - `{ kind: 'warn', reason }` — proceed, but attach a friendly reminder
   *     (first offence is tolerated with a nudge; no blocking yet).
   *   - `{ kind: 'block', reason, remainingMs }` — conversation blocked for
   *     the cool-down because the user continued after the warning.
   */
  check(key: string, message: string, now = Date.now()): { kind: 'ok' } | { kind: 'warn'; reason: string } | { kind: 'block'; reason: string; remainingMs: number } {
    const blocked = this.blockedUntil.get(key)
    if (blocked !== undefined) {
      const remainingMs = blocked - now
      if (remainingMs > 0) return { kind: 'block', reason: 'blocked', remainingMs }
      this.blockedUntil.delete(key)
    }

    const kind = (): 'abusive' | 'spam' | undefined => {
      if (AttackGuard.isAbusive(message)) return 'abusive'
      // Repeated identical messages in the window.
      const cutoff = now - this.spamWindowMs
      const list = (this.recent.get(key) ?? []).filter(e => e.at > cutoff)
      const norm = AttackGuard.norm(message)
      if (norm === '') return undefined
      const same = list.filter(e => AttackGuard.norm(e.text) === norm).length
      list.push({ text: message, at: now })
      this.recent.set(key, list)
      if (same + 1 >= this.spamRepeat) return 'spam'
      return undefined
    }

    const reason = kind()
    if (reason === undefined) {
      // Well-behaved message clears any prior warning state.
      this.warned.delete(key)
      return { kind: 'ok' }
    }

    // Already warned for this kind of behaviour? Block now.
    const offences = this.warned.get(key)
    if (offences !== undefined && offences.has(reason)) {
      this.blockedUntil.set(key, now + this.blockMs)
      this.warned.delete(key)
      this.recent.delete(key)
      return { kind: 'block', reason, remainingMs: this.blockMs }
    }
    // First offence: record the warning and let the message through.
    const next = offences ?? new Set<string>()
    next.add(reason)
    this.warned.set(key, next)
    return { kind: 'warn', reason }
  }
}

/** Live guest session ownership. */
interface GuestSession {
  sessionId: string
  createdAt: number
  dispose: () => Promise<void>
}

/** Write a JSON response with the correct content-type and length. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

/** Read the whole request body as UTF-8 text, bounded. */
function readBody(req: IncomingMessage, maxBytes = 64 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > maxBytes) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** Client IP: the nginx reverse proxy's X-Forwarded-For, else the socket. */
function clientIp(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for']
  if (typeof forwarded === 'string' && forwarded.length > 0) return forwarded.split(',')[0]!.trim()
  return req.socket.remoteAddress ?? 'unknown'
}

/**
 * Plugin entry: register guest routes and manage guest agent sessions.
 * @param ctx - plugin context carrying webserver, agent registry, session query.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  const guard = new AttackGuard(config.spamWindowMs, config.spamRepeat, config.blockMs)

  /**
   * Two-stage, attack-aware admission for one chat request, keyed by the
   * SESSION (one person's conversation), never the IP.
   * @returns `{ kind: 'block', status, body }` — refuse with a calm-down
   * notice (second offence); `{ kind: 'warn', notice }` — allow the request
   * but surface a friendly reminder (first offence); `null` — proceed freely.
   */
  const chatAdmission = (sessionId: string, message: string):
    | { kind: 'block'; status: number; body: unknown }
    | { kind: 'warn'; notice: string }
    | null => {
    const verdict = guard.check(sessionId, message)
    if (verdict.kind === 'block') {
      const seconds = Math.max(1, Math.ceil(verdict.remainingMs / 1000))
      const text = verdict.reason === 'abusive'
        ? '很抱歉，为保障交流环境，请文明用语。系统将在约 1 分钟后为您恢复服务，请稍后再试，谢谢配合。'
        : '很抱歉，我们检测到您短时间内重复发送相同内容。为保障服务质量，请先冷静一下，约 1 分钟后再继续咨询，谢谢理解。'
      return {
        kind: 'block',
        status: 429,
        body: {
          error: 'request blocked',
          blocked: true,
          retryAfterSec: seconds,
          message: text,
        },
      }
    }
    if (verdict.kind === 'warn') {
      const notice = verdict.reason === 'abusive'
        ? '温馨提示：请文明用语，我们很乐意帮您解决问题 😊'
        : '温馨提示：您刚才发送了重复的内容，若继续重复发送将需要稍作休息哦 😊'
      return { kind: 'warn', notice }
    }
    // No fixed per-window chat quota: normal users may ask as many varied
    // questions as they like; only repeated abuse blocks.
    return null
  }
  const guests = new Map<string, GuestSession>()

  /** Drop a guest session (agent + map entry). */
  const dropGuest = async (sessionId: string): Promise<void> => {
    const guest = guests.get(sessionId)
    if (guest === undefined) return
    guests.delete(sessionId)
    await guest.dispose()
  }

  /** Create a fresh guest session. */
  const createGuest = async (): Promise<{ sessionId: string }> => {
    // No per-IP limits: a session is one person's conversation and an IP
    // must not be used to judge people. A process-wide ceiling still guards
    // memory (each session owns an agent) without singling anyone out.
    if (guests.size >= config.maxSessions) {
      const error = new Error('service busy: too many concurrent conversations, please try later')
      ;(error as Error & { statusCode?: number }).statusCode = 503
      throw error
    }
    const sessionId = `guest-${randomUUID()}`
    // Provide the deployment default model route so the persona's {{model}}
    // resolves and the turn can run (Admin Sessions get this from the UI's
    // model-selection flow; programmatic creation must set it explicitly).
    const selection = ctx.agentDefaultModel.currentSelection()
    // Mount the guest preset exactly like the official session controller:
    // resolve the preset id, then install model selection and mount the
    // preset's composition (persona, tools) inside the agent setup scope.
    const resolved = (await ctx.agentPresets.resolve(config.preset)).id
    const handle = await ctx.agents.create({
      sessionId: sessionId as never,
      // cwd satisfies the persona's {{cwd}} and anchors any sandboxed work;
      // guest agents only read the knowledge base, so the workspace root is a
      // read-only-safe neutral directory.
      meta: {
        agentPreset: resolved,
        cwd: config.workspace,
      },
      agentOptions: {
        provider: selection.provider,
        model: selection.model,
        ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
        ...(config.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: ReasoningEffortId(config.reasoningEffort) }),
      },
      setup: async (agentCtx) => {
        await ctx.agentPresets.mount(agentCtx, resolved)
      },
    })
    guests.set(sessionId, { sessionId, createdAt: Date.now(), dispose: () => handle.dispose() })
    return { sessionId }
  }

  /** Whether a caller-supplied id names a guest-owned session (defence against arbitrary session reads). */
  const isGuestSessionId = (sessionId: string): boolean => /^guest-[0-9a-f-]{36}$/.test(sessionId)

  /**
   * Ensure a guest agent is live for `sessionId`, creating it on first sight
   * or resuming it from persistence after a process restart (visitors keep
   * their conversation across refreshes and server restarts).
   */
  const ensureGuest = async (sessionId: string): Promise<void> => {
    if (guests.has(sessionId)) return
    if (!isGuestSessionId(sessionId)) throw new Error('unknown session')
    const selection = ctx.agentDefaultModel.currentSelection()
    const resolved = (await ctx.agentPresets.resolve(config.preset)).id
    let handle: { agent: unknown; dispose(): Promise<void> }
    try {
      // Live in this process already? Adopt it.
      const live = ctx.agents.get(sessionId as never)
      if (live !== undefined) {
        handle = {
          agent: live,
          dispose: async () => { /* adopted: the original owner disposes */ },
        }
      } else {
        handle = await ctx.agents.resume({
          resumeSessionId: sessionId as never,
          agentOptions: {
            provider: selection.provider,
            model: selection.model,
            ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
            ...(config.reasoningEffort === undefined
              ? {}
              : { reasoningEffort: ReasoningEffortId(config.reasoningEffort) }),
          },
          setup: async (agentCtx) => {
            await ctx.agentPresets.mount(agentCtx, resolved)
          },
        })
      }
    } catch {
      throw new Error('unknown session')
    }
    guests.set(sessionId, { sessionId, createdAt: Date.now(), dispose: () => handle.dispose() })
  }

  /** Run one chat turn and return the assistant reply plus cited sources. */
  const runChat = async (sessionId: string, text: string): Promise<{ reply: string; sources: string[] }> => {
    await ensureGuest(sessionId)
    const guest = guests.get(sessionId)
    if (guest === undefined) throw new Error('unknown session')
    const agent = ctx.agents.get(sessionId as never)
    if (agent === undefined) throw new Error('session agent is not live')
    const message = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    })
    agent.followup(message)
    await agent.whenIdle()
    const reply = await readLatestAssistantText(sessionId as never)
    return { reply, sources: extractSources(reply) }
  }

  /**
   * Live SSE stream subscriptions, keyed by session id. While a
   * chat/stream request awaits its turn, the global session/event listener
   * below forwards assistant text deltas to the matching subscriber.
   */
  const streamers = new Map<string, (event: string, data: unknown) => void>()

  /**
   * Run one streamed turn: send the user message, wait for quiescence while
   * text deltas are pushed to `onDelta`, then return the final reply.
   */
  const runChatStream = async (
    sessionId: string,
    text: string,
    onDelta: (delta: string) => void,
  ): Promise<{ reply: string; sources: string[] }> => {
    await ensureGuest(sessionId)
    const guest = guests.get(sessionId)
    if (guest === undefined) throw new Error('unknown session')
    const agent = ctx.agents.get(sessionId as never)
    if (agent === undefined) throw new Error('session agent is not live')
    streamers.set(sessionId, (_event, data) => {
      onDelta(String((data as { text?: string }).text ?? ''))
    })
    try {
      const message = createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      })
      agent.followup(message)
      await agent.whenIdle()
      const reply = await readLatestAssistantText(sessionId as never)
      return { reply, sources: extractSources(reply) }
    } finally {
      streamers.delete(sessionId)
    }
  }

  // Forward assistant text deltas of live turns to the matching stream
  // subscriber. `session/event` fires for every committed event of every
  // session; only sessions with an active streamer are forwarded. The chunk
  // stream carries text-delta pieces; reasoning and tool deltas are ignored
  // (guests see the answer text only).
  ctx.on('session/event', (session, event) => {
    const push = streamers.get(String(session.id))
    if (push === undefined) return
    if (event.type !== 'assistant/chunk') return
    const chunk = (event.data as { chunk?: { type?: string; text?: string } }).chunk
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
      push('delta', { text: chunk.text })
    }
  })

  /** Read the most recent assistant text via the official session-query service. */
  const readLatestAssistantText = async (sessionId: never): Promise<string> => {
    const snapshot = await ctx.sessionQuery.readSession(sessionId)
    // SessionLogSnapshot carries { session, events }; each event is a
    // session-log record. An assistant/message event carries the message
    // under data.message with content blocks in data.message.content. Walk
    // backwards for the newest assistant message and join its text blocks.
    const rawEvents = (snapshot as unknown as { events: Array<Record<string, unknown>> }).events ?? []
    for (let i = rawEvents.length - 1; i >= 0; i--) {
      const ev = rawEvents[i]!
      if (ev.type !== 'assistant/message') continue
      const data = ev.data as { message?: { content?: Array<{ type?: string; text?: string }> } } | undefined
      const content = data?.message?.content
      if (!Array.isArray(content)) continue
      const text = content
        .filter(b => b.type === 'text' && typeof b.text === 'string')
        .map(b => b.text as string)
        .join('')
      if (text.length > 0) return text
    }
    return ''
  }

  /** Extract vault source paths cited in a reply like `产品/价格.md`. */
  function extractSources(reply: string): string[] {
    const out: string[] = []
    const re = /[\u4e00-\u9fffA-Za-z0-9_./-]+\.md/g
    let m: RegExpExecArray | null
    while ((m = re.exec(reply)) !== null) {
      if (!out.includes(m[0]!)) out.push(m[0]!)
    }
    return out
  }

  /**
   * Read the guest conversation as a message list for refresh recovery:
   * user messages and their assistant replies, in order, from the durable
   * session log.
   * @returns `[{ role: 'user'|'assistant', text }]` in chronological order.
   */
  const readHistory = async (sessionId: string): Promise<Array<{ role: string; text: string }>> => {
    if (!isGuestSessionId(sessionId)) throw new Error('unknown session')
    const snapshot = await ctx.sessionQuery.readSession(sessionId as never)
    const events = (snapshot as unknown as { events: Array<Record<string, unknown>> }).events ?? []
    const messages: Array<{ role: string; text: string }> = []
    for (const ev of events) {
      if (ev.type === 'user/message') {
        const data = ev.data as { content?: Array<{ type?: string; text?: string }>; source?: { kind?: string } } | undefined
        const isRuntime = data?.source?.kind === 'plugin' || data?.source?.kind === 'system'
        if (isRuntime) continue // skip runtime-context injections
        const text = (data?.content ?? [])
          .filter(b => b.type === 'text' && typeof b.text === 'string')
          .map(b => b.text as string)
          .join('')
        if (text.length > 0) messages.push({ role: 'user', text })
      } else if (ev.type === 'assistant/message') {
        const data = ev.data as { message?: { content?: Array<{ type?: string; text?: string }> } } | undefined
        const text = (data?.message?.content ?? [])
          .filter(b => b.type === 'text' && typeof b.text === 'string')
          .map(b => b.text as string)
          .join('')
        if (text.length > 0) messages.push({ role: 'assistant', text })
      }
    }
    return messages
  }

  ctx.webServer.register({
    kind: 'prefix',
    path: '/api/guest',
    handler: async (req, res) => {
      const ip = clientIp(req)
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const path = url.pathname.replace(/\/+$/, '')
        if (req.method === 'GET' && path === '/api/guest/health') {
          sendJson(res, 200, { ok: true })
          return
        }
        if (req.method === 'POST' && path === '/api/guest/session') {
          sendJson(res, 201, await createGuest())
          return
        }
        if (req.method === 'GET' && path === '/api/guest/history') {
          const sessionId = url.searchParams.get('sessionId') ?? ''
          if (!isGuestSessionId(sessionId)) {
            sendJson(res, 400, { error: 'invalid sessionId' })
            return
          }
          try {
            const messages = await readHistory(sessionId)
            sendJson(res, 200, { sessionId, messages })
          } catch {
            sendJson(res, 404, { error: 'session not found' })
          }
          return
        }
        if (req.method === 'POST' && path === '/api/guest/chat') {
          const raw = await readBody(req)
          let parsed: unknown
          try {
            parsed = JSON.parse(raw)
          } catch {
            sendJson(res, 400, { error: 'invalid JSON body' })
            return
          }
          const { sessionId, message } = (parsed ?? {}) as { sessionId?: string; message?: string }
          if (typeof sessionId !== 'string' || typeof message !== 'string' || message.trim() === '') {
            sendJson(res, 400, { error: 'sessionId and message (non-empty string) are required' })
            return
          }
          const admission = chatAdmission(sessionId, message)
          if (admission !== null && admission.kind === 'block') {
            sendJson(res, admission.status, admission.body)
            return
          }
          try {
            const result = await runChat(sessionId, message)
            if (admission !== null && admission.kind === 'warn') {
              sendJson(res, 200, { ...result, notice: admission.notice })
            } else {
              sendJson(res, 200, result)
            }
          } catch (error) {
            sendJson(res, 500, { error: error instanceof Error ? error.message : 'turn failed' })
          }
          return
        }
        if (req.method === 'POST' && path === '/api/guest/chat/stream') {
          // Server-Sent Events: text deltas stream as they are produced so
          // the visitor sees the answer appear instead of waiting for the
          // full turn (large knowledge-base turns can take a minute+).
          const raw = await readBody(req)
          let parsed: unknown
          try {
            parsed = JSON.parse(raw)
          } catch {
            sendJson(res, 400, { error: 'invalid JSON body' })
            return
          }
          const { sessionId, message } = (parsed ?? {}) as { sessionId?: string; message?: string }
          if (typeof sessionId !== 'string' || typeof message !== 'string' || message.trim() === '') {
            sendJson(res, 400, { error: 'sessionId and message (non-empty string) are required' })
            return
          }
          const admission = chatAdmission(sessionId, message)
          if (admission !== null && admission.kind === 'block') {
            sendJson(res, admission.status, admission.body)
            return
          }
          const warnNotice = admission !== null && admission.kind === 'warn' ? admission.notice : null
          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-store',
            'connection': 'keep-alive',
            'x-accel-buffering': 'no',
          })
          const sendEvent = (event: string, data: unknown): void => {
            res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
          }
          sendEvent('meta', { sessionId })
          if (warnNotice !== null) sendEvent('notice', { text: warnNotice })
          try {
            const result = await runChatStream(sessionId, message, (delta) => {
              sendEvent('delta', { text: delta })
            })
            sendEvent('done', { reply: result.reply, sources: result.sources })
          } catch (error) {
            sendEvent('error', { error: error instanceof Error ? error.message : 'turn failed' })
          } finally {
            res.end()
          }
          return
        }
        sendJson(res, 404, { error: `no guest route for ${req.method} ${path}` })
      } catch (error) {
        const status = (error as Error & { statusCode?: number }).statusCode ?? 500
        sendJson(res, status, { error: error instanceof Error ? error.message : 'guest error' })
      }
    },
  })

  // Dispose every guest agent when this plugin stops.
  ctx.on('dispose', () => {
    for (const guest of guests.values()) void guest.dispose()
    guests.clear()
  })
}
