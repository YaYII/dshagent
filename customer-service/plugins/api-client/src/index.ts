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

import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises'
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
  /** Knowledge base (vault) root; kb_write/kb_append write under this directory. */
  vaultRoot: string
  /** Allowed URL prefixes for api_get (e.g. https://api.example.com/). */
  apiAllowlist: string[]
  /** Whether kb_write is registered at all (staff presets only). */
  enableWrite: boolean
  /**
   * Writable directory for kb_append (unanswered-questions collection).
   * The vault root itself stays read-only; this lives on the DSH_HOME volume
   * so the team can review and fold entries into the knowledge base.
   */
  appendDir: string
  /**
   * File names (relative to appendDir) kb_append may append to (guest
   * "unanswered questions" collection). Empty disables kb_append.
   */
  appendPaths: string[]
  /**
   * Extra request headers api_get sends on every call (e.g. a vendor gateway
   * that requires a named header). Values may use `${ENV_NAME}` to inject a
   * secret from the container environment, so no credential is written into
   * the composition file or the repository.
   */
  apiHeaders: Record<string, string>
  /**
   * URL **path** prefixes (after the allowlisted host) api_get may reach, e.g.
   * `/api/contract/all/`. Empty means "any path on an allowlisted host".
   * Narrowing to the documented endpoints keeps a prompt-injected agent from
   * probing unrelated routes on a partner host.
   */
  apiPathAllowlist: string[]
  /** Max response bytes api_get accepts. */
  maxResponseBytes: number
  /** Request timeout ms. */
  timeoutMs: number
  /** Whether kb_write may overwrite existing notes. */
  allowOverwrite: boolean
  /**
   * Response fields the assistant may read from {@link Config.apiLookup}
   * responses. An allowlist, never a denylist: a field absent here is stripped
   * before the model sees it, so a widened upstream payload cannot leak a new
   * data category (customer name, address, identity, account flags) without a
   * deliberate edit here. Enforced on the parsed JSON, before truncation.
   */
  apiLookupFields: Record<string, string[]>
  /**
   * Lookup endpoints that answer "is this the customer's own contract?" rather
   * than listing what the customer holds. Each entry declares a path template
   * (`{placeholder}` segments) plus a regular expression every placeholder value
   * must match, so a malformed contract number never reaches the partner API.
   *
   * The raw response is reduced to `{ found, record?: <apiLookupFields> }` and
   * never handed to the model as a list: the deployment decides what "found"
   * means per endpoint (`keyedBy` + `listPath`/`recordPath`), and the model can
   * only ever confirm a value the customer already gave.
   *
   * This exists because a list endpoint used as "what do I have?" is an
   * enumeration oracle: 10086 does not read your number back to you, it asks
   * for it and confirms. A demo deployment may still expose more by adding the
   * endpoint's fields here, but the default posture is confirmation-only.
   */
  apiLookup: ApiLookupEndpoint[]
}

/** One confirmation-only lookup endpoint (see {@link Config.apiLookup}). */
export interface ApiLookupEndpoint {
  /** Stable tool-facing label, e.g. `contract` (registered as `lookup_contract`). */
  name: string
  /** Path template with `{placeholder}` segments, e.g. `/api/contract/all/ai/{lang}`. */
  pathTemplate: string
  /** Query parameters appended verbatim, e.g. `{ level: '1' }`. */
  fixedQuery: Record<string, string>
  /** Placeholder name whose value the tool argument must supply and {@link valuePattern} must accept. */
  keyedBy: string
  /** Regular expression (anchored by the tool) every supplied key value must match. */
  valuePattern: string
  /** Human-readable form of {@link valuePattern}, quoted in the rejection message. */
  valueHint: string
  /** Dot path to the array of records, e.g. `data.caInfo`. */
  listPath: string
  /** Field inside each record compared against the supplied key value. */
  matchField: string
  /** Dot path to a single record, used when {@link listPath} is absent. */
  recordPath?: string
  /** Model-visible description of what a match means. */
  description: string
}

/** Schemastery configuration. */
export const Config: z<Config> = z.object({
  vaultRoot: z.string().required(),
  apiAllowlist: z.array(z.string()).default([]),
  enableWrite: z.boolean().default(false),
  appendDir: z.string().default('/dsh-home/unanswered'),
  appendPaths: z.array(z.string()).default([]),
  apiHeaders: z.dict(z.string()).default({}),
  apiPathAllowlist: z.array(z.string()).default([]),
  maxResponseBytes: z.number().default(256 * 1024),
  timeoutMs: z.number().default(30_000),
  allowOverwrite: z.boolean().default(false),
  apiLookupFields: z.dict(z.array(z.string())).default({}),
  apiLookup: z.array(z.object({
    name: z.string().required(),
    pathTemplate: z.string().required(),
    fixedQuery: z.dict(z.string()).default({}),
    keyedBy: z.string().required(),
    valuePattern: z.string().required(),
    valueHint: z.string().required(),
    listPath: z.string().required(),
    matchField: z.string().required(),
    recordPath: z.string(),
    description: z.string().required(),
  })).default([]),
})

/** A safe JSON value for the tool output. */
type Json = Record<string, unknown>

/** Resolve a root-relative note path and refuse traversal outside the root. */
function resolveNotePath(root: string, rel: string): string {
  const clean = rel.replace(/\\/g, '/').replace(/^\/+/, '')
  if (clean === '' || !clean.endsWith('.md')) {
    throw new Error('note path must be a relative Markdown path ending in .md')
  }
  const abs = resolve(root, clean)
  const resolvedRoot = resolve(root)
  if (abs !== resolvedRoot && !abs.startsWith(resolvedRoot + sep)) {
    throw new Error('note path escapes its root directory')
  }
  return abs
}

/**
 * Resolve configured header values, expanding `${ENV_NAME}` from the process
 * environment. Keeping the secret in the environment (docker-compose `env_file`)
 * means the composition file and this repository carry no credential.
 * @param config - validated plugin configuration.
 * @returns Headers to merge into every api_get request.
 */
function resolveHeaders(config: Config): Record<string, string> {
  const out: Record<string, string> = { accept: 'application/json' }
  for (const [name, raw] of Object.entries(config.apiHeaders)) {
    const value = String(raw).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, key: string) => process.env[key] ?? '')
    if (value !== '') out[name] = value
  }
  return out
}

/**
 * Perform a bounded HTTP GET and return parsed JSON.
 *
 * `pathAllowlist` guards the caller-composed URL. `api_get` passes
 * {@link Config.apiPathAllowlist} because the model chooses that path itself;
 * the lookup tools pass their own template path, which the model cannot
 * influence — their key value is pattern-validated and URL-encoded upstream of
 * this call — so a path the deployment deliberately keeps out of `api_get`
 * (the customer-list endpoint) stays reachable for confirmation only.
 *
 * @param url - absolute URL to request.
 * @param config - validated plugin configuration.
 * @param pathAllowlist - prefixes the URL path must match; empty allows every path.
 * @param signal - optional cancellation.
 * @returns the parsed JSON body.
 */
async function httpGetJson(url: string, config: Config, pathAllowlist: readonly string[], signal?: AbortSignal): Promise<Json> {
  const allowed = config.apiAllowlist.some(prefix => url.startsWith(prefix))
  if (!allowed) throw new Error(`destination not allowed: ${url}`)
  // 路径白名单：只放行部署文档里列出的端点，避免被提示注入后去探伙伴主机的其他路由
  if (pathAllowlist.length > 0) {
    const path = new URL(url).pathname
    if (!pathAllowlist.some(prefix => path.startsWith(prefix))) {
      throw new Error(`api_get path not allowed: ${path}`)
    }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.timeoutMs)
  const onOuterAbort = (): void => controller.abort()
  signal?.addEventListener('abort', onOuterAbort, { once: true })
  try {
    const res = await fetch(url, { signal: controller.signal, headers: resolveHeaders(config) })
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
  'Do not use this to enumerate records the customer did not themselves',
  'identify: confirm a value the customer supplied with the matching lookup_*',
  'tool instead.',
].join(' ')

/** Read a dot path (`data.caInfo`) out of parsed JSON; undefined at any gap. */
function readPath(root: unknown, path: string): unknown {
  let current: unknown = root
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

/**
 * Redact one record to the fields the deployment allows, looked up by
 * `endpointName`. An endpoint with no entry yields an empty record: a
 * misconfigured endpoint shows the customer nothing rather than everything.
 */
function projectRecord(record: unknown, endpointName: string, config: Config): Json {
  const allowedFields = config.apiLookupFields[endpointName] ?? []
  if (record === null || typeof record !== 'object') return {}
  const source = record as Record<string, unknown>
  const out: Json = {}
  for (const field of allowedFields) {
    const value = source[field]
    if (value !== undefined) out[field] = value
  }
  return out
}

/**
 * Answer "is this the customer's own record?" without revealing the collection.
 *
 * The partner list endpoint returns every record the account holds; this
 * function reduces it to one verdict about the single key the customer
 * supplied. Neither the other records nor a count of them reaches the model,
 * so the assistant can confirm a contract number but can never enumerate them
 * — the 10086 property: ask for the number, confirm it, do not read it back
 * from a database the caller has no right to see.
 *
 * @param url - fully composed request URL, already built from the configured template.
 * @param endpoint - the matched {@link ApiLookupEndpoint}.
 * @param keyValue - the customer-supplied key, already pattern-validated.
 * @param config - validated plugin configuration.
 * @param signal - optional cancellation.
 * @returns `{ found: false }` when nothing matches, else `{ found: true, record }` with allowlisted fields only.
 */
async function httpLookupRecord(
  url: string,
  endpoint: ApiLookupEndpoint,
  keyValue: string,
  config: Config,
  signal?: AbortSignal,
): Promise<{ found: boolean; record?: Json }> {
  const payload = await httpGetJson(url, config, [endpoint.pathTemplate.split('{')[0]], signal)
  const direct = endpoint.recordPath === undefined ? undefined : readPath(payload, endpoint.recordPath)
  if (direct !== undefined) {
    const record = projectRecord(direct, endpoint.name, config)
    // A direct record whose key does not match is still not the customer's.
    const matchValue = record[endpoint.matchField]
    const matches = matchValue === undefined || String(matchValue) === keyValue
    return matches ? { found: true, record } : { found: false }
  }
  const list = readPath(payload, endpoint.listPath)
  if (!Array.isArray(list)) return { found: false }
  for (const entry of list) {
    if (entry === null || typeof entry !== 'object') continue
    if (String((entry as Record<string, unknown>)[endpoint.matchField]) !== keyValue) continue
    return { found: true, record: projectRecord(entry, endpoint.name, config) }
  }
  return { found: false }
}

/**
 * Compose the request URL for one lookup call from its template, refusing any
 * key value that fails the endpoint's pattern before a request is attempted.
 *
 * The key value is the one placeholder the model supplies directly, so its
 * pattern is a security control, not input hygiene: without it a caller could
 * walk the path (an embedded `/` or `..`) or land on an unintended host. Only
 * `lang` is accepted as a non-key placeholder, and only from a fixed set.
 *
 * @param endpoint - the matched {@link ApiLookupEndpoint}.
 * @param args - the model-supplied tool arguments keyed by placeholder name.
 * @param config - validated plugin configuration.
 * @returns the absolute URL to request, plus the validated key value.
 */
function composeLookupUrl(endpoint: ApiLookupEndpoint, args: Record<string, unknown>, config: Config): { url: string; keyValue: string } {
  const keyValue = String(args[endpoint.keyedBy] ?? '').trim()
  const anchored = new RegExp(`^(?:${endpoint.valuePattern})$`)
  if (!anchored.test(keyValue)) {
    throw new Error(`${endpoint.name}: ${endpoint.keyedBy} must be ${endpoint.valueHint}`)
  }
  const base = config.apiAllowlist[0]
  if (base === undefined) throw new Error('api-client: no API host configured')
  const path = endpoint.pathTemplate.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (_match, placeholder: string) => {
    if (placeholder === endpoint.keyedBy) return encodeURIComponent(keyValue)
    // The only other placeholder is the answer language, which the endpoint
    // feeds to the partner's own localization. Restrict it to the documented
    // codes so it cannot become a second path-injection vector.
    if (placeholder === 'lang') {
      const lang = String(args.lang ?? 'zh').trim().toLowerCase()
      if (!LANG_CODES.has(lang)) throw new Error(`api-client: lang must be one of ${[...LANG_CODES].join(' | ')}`)
      return lang
    }
    throw new Error(`api-client: unsupported placeholder {${placeholder}} in ${endpoint.pathTemplate}`)
  })
  const url = new URL(path.replace(/^\/+/, ''), base)
  for (const [key, value] of Object.entries(endpoint.fixedQuery)) url.searchParams.set(key, value)
  return { url: url.toString(), keyValue }
}

/** Answer languages the partner API documents (`/ai/{lang}`). */
const LANG_CODES = new Set(['zh', 'en', 'pt'])

const kbWriteDescription = [
  'Write a Markdown note into the company knowledge base (vault).',
  'Use to record resolved cases, useful answers, or new knowledge so future',
  'visitors benefit. The note is stored under the vault root with a',
  'vault-relative path. Overwriting existing notes is not allowed by default.',
].join(' ')

/**
 * Plugin entry: register api_get, one lookup tool per configured endpoint, and
 * kb_write/kb_append into the agent's catalog.
 * @param ctx - plugin context carrying the tools registry.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  for (const endpoint of config.apiLookup) {
    ctx.tools.register(defineTool({
      name: `lookup_${endpoint.name}`,
      description: [
        endpoint.description,
        'Answers whether the value the customer gave belongs to them, and returns',
        'only that record. It cannot list or count the other records on the',
        'account: ask the customer for the value first, then call this to confirm.',
      ].join(' '),
      parameters: {
        [endpoint.keyedBy]: {
          type: 'string',
          required: true,
          description: `The ${endpoint.keyedBy} the customer supplied (${endpoint.valueHint}).`,
        },
        lang: {
          type: 'string',
          required: true,
          description: 'Answer language for the upstream data: zh | en | pt.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            found: { type: 'boolean', required: true },
            record: { type: 'object', additionalProperties: true },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.found === true
            ? `${endpoint.name} confirmed: ${JSON.stringify(value.record).slice(0, 4000)}`
            : `${endpoint.name} not found for the supplied value.`,
        }],
      },
      async execute(args, exec) {
        const { url, keyValue } = composeLookupUrl(endpoint, args as Record<string, unknown>, config)
        return httpLookupRecord(url, endpoint, keyValue, config, exec.signal)
      },
    }))
  }

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
      return httpGetJson(url, config, config.apiPathAllowlist, exec.signal)
    },
  }))

  // kb_append: line-append to allow-listed collection files only. This is the
  // guest-safe "record what I could not answer" channel: guests may never
  // create/overwrite arbitrary notes, only append one line to files the
  // deployment explicitly allows (e.g. 待补充问题.md).
  if (config.appendPaths.length === 0) return

  ctx.tools.register(defineTool({
    name: 'kb_append',
    description: [
      'Append one line to a knowledge-base collection file (used to record',
      'questions you could not answer so the team can enrich the knowledge base).',
      'Only pre-allowed files can be appended; provide the exact vault-relative',
      'path and one line of text. Never invent an answer after appending.',
    ].join(' '),
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'Vault-relative path from the allowed list (e.g. 待补充问题.md).',
      },
      line: {
        type: 'string',
        required: true,
        description: 'One line to append (the unanswerable question).',
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
        text: `kb_append: recorded in ${value.path} (${value.bytes} bytes)`,
      }],
    },
    async execute(args) {
      const rel = String(args.path ?? '')
      const line = String(args.line ?? '').trim()
      const allowed = config.appendPaths.includes(rel)
      if (!allowed) throw new Error(`kb_append: ${rel} is not an allowed collection file`)
      if (line === '') throw new Error('kb_append: line must not be empty')
      // The collection lives in the writable appendDir (DSH_HOME volume),
      // never inside the read-only vault.
      const abs = resolveNotePath(config.appendDir, rel)
      await mkdir(resolve(abs, '..'), { recursive: true })
      const stamp = new Date().toISOString().slice(0, 10)
      const entry = `- ${line}（${stamp}）\n`
      await appendFile(abs, entry, 'utf8')
      const relPath = relative(config.appendDir, abs).split(sep).join('/')
      return { path: relPath, bytes: Buffer.byteLength(entry) }
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
