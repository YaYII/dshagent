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
import { createUserMessage } from '@deepseek-ai/dsh-llm'

/** Export shape expected of function plugins. */
export const name = 'guest-server'
/** Services this plugin registers against. */
export const inject = ['webServer', 'agents', 'sessionQuery', 'agentDefaultModel', 'agentPresets']

/** Guest-server configuration. */
export interface Config {
  /** Agent preset mounted for guest sessions. */
  preset: string
  /** Workspace (cwd) for guest sessions; the persona's {{cwd}} and sandbox anchor. */
  workspace: string
  /** Per-IP rate-limit window in milliseconds. */
  rateLimitWindowMs: number
  /** Max session creates per IP per window. */
  sessionRatePerWindow: number
  /** Max chat requests per IP per window. */
  chatRatePerWindow: number
}

/** Schemastery configuration. */
export const Config: z<Config> = z.object({
  preset: z.string().default('customer-service-guest'),
  workspace: z.string().default('/kb'),
  rateLimitWindowMs: z.number().default(60_000),
  sessionRatePerWindow: z.number().default(5),
  chatRatePerWindow: z.number().default(20),
})

/** Sliding-window per-IP accounting. */
class RateLimiter {
  private readonly hits = new Map<string, number[]>()
  constructor(private readonly windowMs: number, private readonly limit: number) {}

  /** Whether `ip` may make another request now; records the hit when allowed. */
  allow(ip: string, now = Date.now()): boolean {
    const cutoff = now - this.windowMs
    const list = (this.hits.get(ip) ?? []).filter(t => t > cutoff)
    if (list.length >= this.limit) return false
    list.push(now)
    this.hits.set(ip, list)
    return true
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
  const sessions = new RateLimiter(config.rateLimitWindowMs, config.sessionRatePerWindow)
  const chats = new RateLimiter(config.rateLimitWindowMs, config.chatRatePerWindow)
  const guests = new Map<string, GuestSession>()

  /** Drop a guest session (agent + map entry). */
  const dropGuest = async (sessionId: string): Promise<void> => {
    const guest = guests.get(sessionId)
    if (guest === undefined) return
    guests.delete(sessionId)
    await guest.dispose()
  }

  /** Create a fresh guest session, rate-limited. */
  const createGuest = async (ip: string): Promise<{ sessionId: string }> => {
    if (!sessions.allow(ip)) {
      const error = new Error('rate limit exceeded: too many sessions, slow down')
      ;(error as Error & { statusCode?: number }).statusCode = 429
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
      },
      setup: async (agentCtx) => {
        await ctx.agentPresets.mount(agentCtx, resolved)
      },
    })
    guests.set(sessionId, { sessionId, createdAt: Date.now(), dispose: () => handle.dispose() })
    return { sessionId }
  }

  /** Run one chat turn and return the assistant reply plus cited sources. */
  const runChat = async (sessionId: string, text: string): Promise<{ reply: string; sources: string[] }> => {
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
          sendJson(res, 201, await createGuest(ip))
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
          if (!chats.allow(ip)) {
            sendJson(res, 429, { error: 'rate limit exceeded' })
            return
          }
          try {
            const result = await runChat(sessionId, message)
            sendJson(res, 200, result)
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
          if (!chats.allow(ip)) {
            sendJson(res, 429, { error: 'rate limit exceeded' })
            return
          }
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
