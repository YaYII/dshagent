/**
 * Customer-service API tooling: read external data and write knowledge notes.
 *
 * Registers two model-facing tools for the customer-service presets:
 *
 *  - `api_get`:    HTTP GET a configured/external JSON API (read data the
 *                  customer asks about: order status, product stock, pricing…).
 *                  Only http(s), and only destinations the deployment allows:
 *                  the allowlist is a set of URL prefixes in config
 *                  (`allowlist`), and every request resolves + validates the
 *                  destination before connecting. Response bodies are capped.
 *
 *  - `kb_write`:   Write a Markdown note into the knowledge base (the vault
 *                  directory). The customer assistant may record answers,
 *                  transcripts, or resolved cases so later visitors benefit.
 *                  Paths are constrained to the vault root and `.md` only.
 *
 * Neither tool touches the terminal, filesystem outside the vault, or any
 * host capability: this is the full extent of the assistant's side effects.
 *
 * This is a Host-plugin body that registers into the agent-scoped `tools`
 * registry via `ctx.tools.register`; mount it inside an agent preset's
 * composition (see customer-service/presets, agent.cordis.yml files).
 * @module customer-service/api-client
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, normalize, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Export shape expected of function plugins. */
export const name = 'api-client'
/** The tools registry this plugin registers into. */
export const inject = ['tools']

/** api-client configuration. */
export interface Config {
  /** Knowledge base (vault) root; kb_write writes under this directory. */
  vaultRoot: string
  /** Allowed URL prefixes for api_get (e.g. https://api.example.com/). */
  apiAllowlist: string[]
  /** Whether kb_write is registered at all (staff presets only). */
  enableWrite: boolean
  /** Max response bytes api_get accepts. */
  maxResponseBytes: number
  /** Request timeout ms. */
  timeoutMs: number
  /** Whether kb_write may overwrite existing notes. */
  allowOverwrite: boolean
}

/** Schemastery configuration. */
export const Config: z<Config> = z.object({
  vaultRoot: z.string().required(),
  apiAllowlist: z.array(z.string()).default([]),
  enableWrite: z.boolean().default(false),
  maxResponseBytes: z.number().default(256 * 1024),
  timeoutMs: z.number().default(30_000),
  allowOverwrite: z.boolean().default(false),
})

/** A safe JSON value for the tool output. */
type Json = Record<string, unknown>

/** Resolve a vault-relative note path and refuse traversal outside the root. */
function resolveNotePath(vaultRoot: string, rel: string): string {
  const clean = rel.replace(/\\/g, '/').replace(/^\/+/, '')
  if (clean === '' || !clean.endsWith('.md')) {
    throw new Error('kb_write path must be a relative Markdown path ending in .md')
  }
  const abs = resolve(vaultRoot, clean)
  const root = resolve(vaultRoot)
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new Error('kb_write path escapes the knowledge base root')
  }
  return abs
}

/** Perform a bounded HTTP GET and return parsed JSON. */
async function httpGetJson(url: string, config: Config, signal?: AbortSignal): Promise<Json> {
  const allowed = config.apiAllowlist.some(prefix => url.startsWith(prefix))
  if (!allowed) throw new Error(`destination not allowed: ${url}`)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.timeoutMs)
  const onOuterAbort = (): void => controller.abort()
  signal?.addEventListener('abort', onOuterAbort, { once: true })
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } })
    if (!res.ok) throw new Error(`api_get failed: HTTP ${res.status}`)
    const text = await res.text()
    if (text.length > config.maxResponseBytes) throw new Error('api_get response too large')
    try {
      return JSON.parse(text) as Json
    } catch {
      throw new Error('api_get: response is not JSON')
    }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onOuterAbort)
  }
}

const apiGetDescription = [
  'Call an external JSON API to retrieve data the customer asks about',
  '(order status, product info, pricing, stock, account details, …).',
  'Only destinations in the deployment allowlist are reachable.',
  'Use the result to answer; never invent API data.',
].join(' ')

const kbWriteDescription = [
  'Write a Markdown note into the company knowledge base (vault).',
  'Use to record resolved cases, useful answers, or new knowledge so future',
  'visitors benefit. The note is stored under the vault root with a',
  'vault-relative path. Overwriting existing notes is not allowed by default.',
].join(' ')

/**
 * Plugin entry: register api_get and kb_write into the agent's catalog.
 * @param ctx - plugin context carrying the tools registry.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'api_get',
    description: apiGetDescription,
    parameters: {
      url: {
        type: 'string',
        required: true,
        description: 'The absolute http(s) URL to call.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
      },
      render: (_args, value) => [{
        type: 'text',
        text: `api_get result: ${JSON.stringify(value).slice(0, 4000)}`,
      }],
    },
    async execute(args, exec) {
      const url = String(args.url ?? '').trim()
      if (!/^https?:\/\//.test(url)) throw new Error('api_get requires an absolute http(s) URL')
      return httpGetJson(url, config, exec.signal)
    },
  }))

  // kb_write is staff-only: guests must never mutate the knowledge base.
  if (!config.enableWrite) return

  ctx.tools.register(defineTool({
    name: 'kb_write',
    description: kbWriteDescription,
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'Vault-relative note path ending in .md (e.g. 案例/退款咨询-001.md).',
      },
      content: {
        type: 'string',
        required: true,
        description: 'Full Markdown content of the note.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          bytes: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `kb_write: wrote ${value.path} (${value.bytes} bytes)`,
      }],
    },
    async execute(args) {
      const rel = String(args.path ?? '')
      const content = String(args.content ?? '')
      const abs = resolveNotePath(config.vaultRoot, rel)
      if (!config.allowOverwrite) {
        try {
          await readFile(abs)
          throw new Error(`kb_write: ${rel} already exists (overwrite disabled)`)
        } catch (error) {
          if (error instanceof Error && error.message.startsWith('kb_write:')) throw error
          // ENOENT is the expected case: proceed to create.
        }
      }
      await mkdir(resolve(abs, '..'), { recursive: true })
      await writeFile(abs, content, 'utf8')
      const vaultRel = relative(config.vaultRoot, abs).split(sep).join('/')
      return { path: vaultRel, bytes: Buffer.byteLength(content) }
    },
  }))
}
