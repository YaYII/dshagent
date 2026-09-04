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
  /** Hard cap of searches per agent turn (re-search loops are the main latency driver). */
  maxSearchesPerTurn: number
}

/** Schemastery configuration. */
export const Config: z<Config> = z.object({
  vaultRoot: z.string().required(),
  maxResults: z.number().default(8),
  excerptChars: z.number().default(1200),
  listTtlMs: z.number().default(5000),
  maxSearchesPerTurn: z.number().default(3),
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

/**
 * Section-level excerpt: split a Markdown file into `##`-headed sections and
 * return the sections with the most query-term density, joined. This gives
 * the model the COMPLETE relevant passages (FAQ items, news items…) instead
 * of a fixed-width window, so it can answer from one search instead of
 * re-searching for the rest of the section.
 * @param content - full file text.
 * @param terms - query terms.
 * @param maxChars - total excerpt budget across the chosen sections.
 * @returns up to ~maxChars of the most relevant complete sections.
 */
function sectionExcerpt(content: string, terms: Set<string>, maxChars: number): string {
  const lines = content.split('\n')
  const sections: Array<{ title: string; body: string[]; score: number }> = []
  let current: { title: string; body: string[]; score: number } | undefined
  const flush = (): void => {
    if (current !== undefined && current.score > 0) sections.push(current)
  }
  for (const line of lines) {
    const heading = /^##\s+(.*)$/.exec(line)
    if (heading !== null) {
      flush()
      const title = heading[1]!.toLowerCase()
      let score = 0
      for (const term of terms) if (title.includes(term)) score += 4
      current = { title: heading[1]!, body: [line], score }
      continue
    }
    if (current === undefined) continue // ignore preamble before the first ##
    current.body.push(line)
    const lower = line.toLowerCase()
    for (const term of terms) {
      let at = 0
      while ((at = lower.indexOf(term, at)) !== -1) {
        current.score += term.length >= 2 ? 1 : 0.25
        at += term.length
      }
    }
  }
  flush()
  if (sections.length === 0) return excerpt(content, terms, maxChars) // unstructured file
  sections.sort((a, b) => b.score - a.score)
  const chosen: string[] = []
  let total = 0
  for (const section of sections) {
    const text = section.body.join('\n').trim()
    if (total + text.length > maxChars && chosen.length > 0) break
    chosen.push(text)
    total += text.length
    if (total >= maxChars) break
  }
  return chosen.join('\n\n').slice(0, maxChars)
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
        // Navigation/readme files are not knowledge content: exclude them so
        // they never rank above real answers.
        if (entry.name.toUpperCase() === 'README.MD') continue
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
        if (titleMatch.includes(term)) score += 40
        if (heading.toLowerCase().includes(term)) score += 20
      }
      // Body relevance = term density, not raw frequency: a dedicated FAQ
      // file that mentions the terms densely must outrank a huge press
      // archive that mentions them once per unrelated article.
      const density = termFreq(content, terms) / Math.sqrt(Math.max(file.size, 1))
      score += density * 60
      // A single stray 0.5-weight character hit is noise, not a match.
      if (score < 2) continue
      scored.push({
        path: file.rel,
        score,
        excerpt: sectionExcerpt(content, terms, excerptChars),
        read: content,
      })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, maxResults).map(({ read: _read, ...hit }) => hit)
  }
}

/** The model-facing tool description. */
const DESCRIPTION = [
  'Search the company knowledge base (Markdown documents) for customer-service answers.',
  'STRATEGY: search at most 2 times per question. Craft ONE precise query covering the',
  'whole question (include synonyms). After the first result, if the excerpts already',
  'answer the question, STOP searching and answer immediately using them. Only search a',
  'second time when the first result clearly lacks the answer. Never repeat a query you',
  'already tried. Cite source file paths in your answer.',
].join(' ')

/**
 * Plugin entry: register the knowledge_search tool into the agent's catalog.
 * @param ctx - plugin context carrying the tools registry.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  const scanner = new VaultScanner(config.vaultRoot, config.listTtlMs)
  /** Per-agent search counts within one turn (never cleared mid-turn; agents are per-session). */
  const budget = new Map<string, number>()
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
          note: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const total = value.total
        const lines = total === 0
          ? ['No knowledge-base matches.']
          : value.hits.map((hit, i) => `[${i + 1}] ${hit.path} (score ${hit.score})\n${hit.excerpt}`)
        const note = value.note === undefined || value.note === ''
          ? ''
          : `\nNOTE: ${value.note}`
        return [{ type: 'text', text: `Knowledge base (${total} hit${total === 1 ? '' : 's'}):\n${lines.join('\n\n')}${note}` }]
      },
    },
    async execute(args, exec) {
      const query = String(args.query ?? '').trim()
      if (query === '') return { query, hits: [], total: 0 }
      // Per-turn search budget: repeated searches are the main latency driver
      // (the model re-queries with synonyms when excerpts are thin). Enforce a
      // hard cap keyed by the owning agent so one question cannot trigger a
      // dozen scans; beyond the cap the model must answer from what it has.
      const owner = (exec as { agent?: { id?: unknown } }).agent
      if (owner !== undefined) {
        const key = String(owner.id)
        const used = budget.get(key) ?? 0
        if (used >= config.maxSearchesPerTurn) {
          return {
            query,
            hits: [],
            total: -1,
            note: `search budget exhausted (${config.maxSearchesPerTurn}); answer from the excerpts already returned`,
          }
        }
        budget.set(key, used + 1)
      }
      const hits = await scanner.search(query, config.maxResults, config.excerptChars)
      return { query, hits, total: hits.length }
    },
  }))
}
