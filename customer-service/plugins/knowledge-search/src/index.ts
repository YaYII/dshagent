/**
 * Knowledge-base search for the customer-service deployment.
 *
 * Reads a read-only mounted knowledge base (an Obsidian vault directory) and
 * registers a model-facing `knowledge_search` tool. The tool scans Markdown
 * files under the vault root, ranks them against the query with a lightweight
 * scoring function (title matches, heading matches, and body term frequency —
 * case-insensitive, CJK-aware tokenization on 1- and 2-gram substrings), and
 * returns ranked excerpts with their source paths so the assistant can answer
 * grounded in the vault and cite sources.
 *
 * The implementation is deliberately dependency-free (Node built-ins only):
 * the vault is a plain directory of Markdown, no external search service or
 * embedding model is required. Content changes are picked up per query (with
 * a small TTL cache for directory listing), so editing the vault updates the
 * assistant's knowledge without a restart.
 *
 * This is a Host plugin. It registers into the agent-scoped `tools` registry
 * via `ctx.tools.register`, so it must be mounted inside an agent preset's
 * composition (see customer-service/presets/customer-service/agent.cordis.yml).
 * @module customer-service/knowledge-search
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Export shape expected of function plugins. */
export const name = 'knowledge-search'
/** The tools registry this plugin registers into. */
export const inject = ['tools']

/** Knowledge-search plugin configuration. */
export interface Config {
  /** Absolute path of the read-only knowledge base (vault) root. */
  vaultRoot: string
  /** Maximum number of ranked results returned to the model. */
  maxResults: number
  /** Maximum characters of excerpt text per result. */
  excerptChars: number
  /** Directory-listing TTL in milliseconds; 0 disables caching. */
  listTtlMs: number
}

/** Schemastery configuration. */
export const Config: z<Config> = z.object({
  vaultRoot: z.string().required(),
  maxResults: z.number().default(8),
  excerptChars: z.number().default(1200),
  listTtlMs: z.number().default(5000),
})

/** One Markdown file discovered under the vault root. */
interface VaultFile {
  /** Path relative to the vault root, using forward slashes. */
  rel: string
  /** Absolute path. */
  abs: string
  /** Size in bytes (used to skip binary/oversized files cheaply). */
  size: number
}

/** A ranked search hit. */
interface Hit {
  /** Vault-relative path of the source file. */
  path: string
  /** Score from the ranking function. */
  score: number
  /** Excerpt of the matched content around the best match. */
  excerpt: string
}

/** Normalize and split a query or text into comparable tokens. */
/** CJK stop characters: common function words that carry no search signal. */
const CJK_STOP = new Set('的了么吗呢吧啊呀在是有没与我你他她它这那之也都就很而及被把让对从向为于和或一个不将着过中上'.split(''))

/** Normalize and split a query or text into comparable tokens. */
function tokens(text: string): string[] {
  const lower = text.toLowerCase()
  // CJK-aware: 2-grams plus non-stop single characters; plus ASCII words.
  const cjk = lower.match(/[\u4e00-\u9fff]/g) ?? []
  const grams: string[] = []
  for (let i = 0; i < cjk.length; i++) {
    const isStop = CJK_STOP.has(cjk[i]!)
    if (!isStop) grams.push(cjk[i]!)
    if (i + 1 < cjk.length && !isStop && !CJK_STOP.has(cjk[i + 1]!)) {
      grams.push(`${cjk[i]}${cjk[i + 1]}`)
    }
  }
  const latin = lower.match(/[a-z0-9][a-z0-9-]*/g) ?? []
  return [...grams, ...latin]
}

/** Term frequency of tokens within text. */
function termFreq(text: string, terms: Set<string>): number {
  let score = 0
  for (const token of tokens(text)) {
    if (terms.has(token)) score += token.length >= 2 ? 2 : 0.5
  }
  return score
}

/** Best contiguous excerpt around the first token hit. */
function excerpt(text: string, terms: Set<string>, maxChars: number): string {
  const lower = text.toLowerCase()
  let idx = -1
  for (const term of terms) {
    const at = lower.indexOf(term)
    if (at >= 0 && (idx === -1 || at < idx)) idx = at
  }
  if (idx < 0) idx = 0
  const start = Math.max(0, idx - Math.floor(maxChars / 2))
  const end = Math.min(text.length, start + maxChars)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < text.length ? '…' : ''
  return `${prefix}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${suffix}`
}

/** A knowledge-base scanner over one vault root. */
export class VaultScanner {
  /** Cached file list generation. */
  private files: VaultFile[] | undefined
  private listedAt = 0

  constructor(private readonly root: string, private readonly listTtlMs: number) {}

  /** Recursively list Markdown files under the root. */
  private async listFiles(): Promise<VaultFile[]> {
    const now = Date.now()
    if (this.files !== undefined && this.listTtlMs > 0 && now - this.listedAt < this.listTtlMs) {
      return this.files
    }
    const out: VaultFile[] = []
    const walk = async (dir: string): Promise<void> => {
      let entries: string[]
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return // A missing/unreadable subtree is skipped (e.g. .obsidian config).
      }
      for (const entry of entries) {
        const abs = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name === '.obsidian' || entry.name.startsWith('.')) continue
          await walk(abs)
          continue
        }
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue
        try {
          const info = await stat(abs)
          out.push({ rel: relative(this.root, abs).split('\\').join('/'), abs, size: info.size })
        } catch {
          // Vanished between listing and stat; skip.
        }
      }
    }
    await walk(this.root)
    this.files = out
    this.listedAt = now
    return out
  }

  /**
   * Search the vault for the query.
   * @param query - the user's question / search keywords.
   * @param maxResults - number of ranked hits to return.
   * @param excerptChars - max excerpt width per hit.
   * @returns ranked hits with excerpts, and the vault-relative paths read.
   */
  async search(query: string, maxResults: number, excerptChars: number): Promise<Hit[]> {
    const files = await this.listFiles()
    const terms = new Set(tokens(query))
    const scored: Array<Hit & { read: string }> = []
    for (const file of files) {
      if (file.size > 2 * 1024 * 1024) continue
      let content: string
      try {
        content = await readFile(file.abs, 'utf8')
      } catch {
        continue
      }
      const titleMatch = file.rel.toLowerCase()
      const heading = /^#\s+([^\n]+)/m.exec(content)?.[1] ?? ''
      let score = 0
      for (const term of terms) {
        if (titleMatch.includes(term)) score += 8
        if (heading.toLowerCase().includes(term)) score += 5
      }
      score += termFreq(content, terms)
      // A single stray 0.5-weight character hit is noise, not a match.
      if (score < 2) continue
      scored.push({
        path: file.rel,
        score,
        excerpt: excerpt(content, terms, excerptChars),
        read: content,
      })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, maxResults).map(({ read: _read, ...hit }) => hit)
  }
}

/** The model-facing tool description. */
const DESCRIPTION = [
  'Search the company knowledge base (an Obsidian vault of Markdown documents)',
  'for the customer-service assistant. Use it BEFORE answering any question about',
  'company facts, products, policies, pricing, procedures, or troubleshooting.',
  'Returns ranked excerpts with source file paths; cite the source path in your answer.',
].join(' ')

/**
 * Plugin entry: register the knowledge_search tool into the agent's catalog.
 * @param ctx - plugin context carrying the tools registry.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  const scanner = new VaultScanner(config.vaultRoot, config.listTtlMs)
  ctx.tools.register(defineTool({
    name: 'knowledge_search',
    description: DESCRIPTION,
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'The search query (a question or keywords).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', required: true },
          hits: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                score: { type: 'number', required: true },
                excerpt: { type: 'string', required: true },
              },
            },
          },
          total: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => {
        const total = value.total
        const lines = total === 0
          ? ['No knowledge-base matches.']
          : value.hits.map((hit, i) => `[${i + 1}] ${hit.path} (score ${hit.score})\n${hit.excerpt}`)
        return [{ type: 'text', text: `Knowledge base (${total} hit${total === 1 ? '' : 's'}):\n${lines.join('\n\n')}` }]
      },
    },
    async execute(args) {
      const query = String(args.query ?? '').trim()
      if (query === '') return { query, hits: [], total: 0 }
      const hits = await scanner.search(query, config.maxResults, config.excerptChars)
      return { query, hits, total: hits.length }
    },
  }))
}
