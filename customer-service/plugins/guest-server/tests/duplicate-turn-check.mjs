/**
 * 会话重复生成验收脚本 —— 「一轮对话只能产生一条回答」。
 *
 * 背景（实测回归）：guest-server 用 agent.followup() 注入语言说明，而
 * followup = send(…, 'next-turn', wakeup=true)——**每次调用都唤醒一个新 turn**。
 * 于是同一轮里「用户消息」与「语言说明」各生成一条回答，落盘两条 assistant 消息，
 * 刷新后历史里并排出现两条回答（实测：同一句"你好"得到中文、英文两条不同回答）。
 *
 * 判据：
 *   A. 一次 /chat/stream 只产生 **1 条** assistant 消息（不是 2 条）；
 *   B. SSE 只出现 1 个 done 帧；
 *   C. 历史里 assistant 数量 == 用户轮数；
 *   D. 语言说明仍生效（回答语言跟随界面语言，说明改成 inject 没有把它漏掉）；
 *   E. 源码层：语言注入必须用 agent.inject 而非 agent.followup。
 *
 * 需要容器在跑（默认 http://127.0.0.1:10800）：
 *   node customer-service/plugins/guest-server/tests/duplicate-turn-check.mjs
 * 断言失败必须非零退出。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const BASE = process.env.GUEST_URL ?? 'http://127.0.0.1:10800'
const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', 'src', 'index.ts')

let passed = 0
let failed = 0
const ok = (label, cond, detail = '') => {
  if (cond) { passed += 1; console.log(`  PASS  ${label}`) }
  else { failed += 1; console.log(`  FAIL  ${label}${detail === '' ? '' : ` — ${detail}`}`) }
}

console.log('\nE. 源码层：语言注入必须用 inject（不另起 turn）')
const src = readFileSync(SRC, 'utf8')
// 判据要盯住「哪个消息被送进 inject/followup」，而不是文本距离：语言说明的
// createUserMessage 里带 plugin: 'guest-server'，用户消息带 source: { kind: 'user' }。
// 旧实现的错误形态是 langNote 块里调 followup，因此按块内调用名精确判断。
const langBlocks = [...src.matchAll(/const langNote = languageContext\(lang\)([\s\S]{0,420}?)\n {6}\}/g)]
  .map(match => match[1])
ok('找到了语言注入代码块', langBlocks.length >= 1, `匹配到 ${langBlocks.length} 处`)
ok('每一处语言注入都用 agent.inject（不另起 turn）',
  langBlocks.length > 0 && langBlocks.every(block => /agent\.inject\(/.test(block) && !/agent\.followup\(/.test(block)),
  langBlocks.map(b => (b.match(/agent\.\w+\(/) ?? ['?'])[0]).join(' , '))
ok('语言说明仍带 plugin 来源（历史读取会过滤，不污染对话）',
  langBlocks.some(block => /plugin: 'guest-server'/.test(block)))
ok('用户消息仍走 followup（它是真正唤醒本轮的那一条）',
  /const message = createUserMessage\(\{[\s\S]{0,200}?kind: 'user'[\s\S]{0,80}?\}\)\s*\n\s*agent\.followup\(message\)/.test(src))

console.log('\nA/B/C/D. 真实一轮对话（需要容器在跑）')
let sessionId = ''
try {
  const created = await (await fetch(`${BASE}/api/guest/session`, { method: 'POST' })).json()
  sessionId = created.sessionId
} catch (error) {
  console.log(`  SKIP  容器不可达（${BASE}）：${String(error).slice(0, 80)}`)
  console.log(`\n${passed}/${passed + failed} 项断言通过（联网部分已跳过）`)
  process.exit(failed > 0 ? 1 : 0)
}
ok('创建会话成功', typeof sessionId === 'string' && sessionId.startsWith('guest-'))

const chatRes = await fetch(`${BASE}/api/guest/chat/stream`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ sessionId, message: '你好', lang: 'zh' }),
})
const sse = await chatRes.text()
const doneFrames = (sse.match(/^event: done$/gm) ?? []).length

const historyRes = await fetch(`${BASE}/api/guest/history?sessionId=${encodeURIComponent(sessionId)}`)
const history = (await historyRes.json()).messages ?? []
const assistants = history.filter(m => m.role === 'assistant')
const users = history.filter(m => m.role === 'user')

ok('SSE 只有 1 个 done 帧', doneFrames === 1, `实际 ${doneFrames} 个`)
ok('历史里有 1 条用户消息', users.length === 1, `实际 ${users.length} 条`)
ok('历史里只有 1 条 assistant 消息（不是 2 条）', assistants.length === 1,
  `实际 ${assistants.length} 条: ${assistants.map(a => JSON.stringify(String(a.text ?? '').slice(0, 32))).join(' | ')}`)
ok('assistant 数量 == 用户轮数', assistants.length === users.length,
  `assistant ${assistants.length} vs user ${users.length}`)

const reply = String(assistants[0]?.text ?? '')
ok('回答非空', reply.length > 0)
// D：语言跟随。zh 界面不应回一整段英文——中文字符占比是最直接的判据。
const cjk = (reply.match(/[\u4e00-\u9fff]/g) ?? []).length
ok('zh 界面回答以中文为主（inject 生效，语言说明没被漏掉）',
  cjk >= 10 && cjk / Math.max(1, reply.length) > 0.2,
  `中文字符 ${cjk} / 总长 ${reply.length}：${reply.slice(0, 60)}`)

// 清理本次验证会话（精确 id；服务端回收 agent 内存）
await fetch(`${BASE}/api/guest/session?sessionId=${encodeURIComponent(sessionId)}`, { method: 'DELETE' })

console.log(`\n${passed}/${passed + failed} 项断言通过`)
if (failed > 0) { console.log(`${failed} 项失败`); process.exit(1) }
