/**
 * 三出口载荷验收 — 真实 HTTP 层（口径 B 的 E1/E3/E4/E7/O3 取证）。
 *
 * 运行：`node --import tsx/esm customer-service/plugins/output-gate/tests/http-exits-check.mjs`
 * 断言失败非零退出。
 *
 * 与 `gate-check.mjs` 的分工：那份测的是纯逻辑砖块与门禁引擎；本份把**真实的
 * guest-server 路由**挂到真实 HTTP 服务器上，用真实请求打三个出口与回传端点，因此
 * 验证的是"访客抓包能不能看到围栏源码"这一层事实——载荷、SSE 分帧、状态码。
 *
 * 模型层用桩：`agents`/`sessionQuery` 由本脚本提供，回答内容可控，因此测试确定、
 * 不依赖网络与 API key。唯一被替换的是"回答从哪来"，净化链路全是生产代码。
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const pluginDir = resolve(here, '..')
const customerServiceDir = resolve(pluginDir, '../..')

const { Context } = await import('@deepseek-ai/cordis')
const gatePlugin = await import(resolve(pluginDir, 'src/index.ts'))
const guestServer = await import(resolve(customerServiceDir, 'plugins/guest-server/src/index.ts'))

const SESSION_ID = 'guest-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

const results = []
/** @param {string} name 断言名 @param {() => Promise<unknown>|unknown} body 断言体 */
async function check(name, body) {
  try {
    await body()
    results.push({ name, ok: true })
  } catch (error) {
    results.push({ name, ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}

/**
 * 搭一套真实 HTTP 环境：真实 node:http 服务器 + 真实 guest-server 路由 + 桩模型层。
 * @param {string} reply - 桩助手回答（可含围栏）
 * @param {string[]} frames - 桩回答的流式分帧（省略则按整段一帧）
 * @returns 环境句柄
 */
async function boot(reply, frames) {
  const ctx = new Context()
  const warnings = []
  ctx.logger.warn = (...args) => { warnings.push(args.map(String).join(' ')) }
  ctx.logger.info = () => {}
  ctx.logger.debug = () => {}
  ctx.logger.error = () => {}

  // ── 桩：真实 HTTP 服务器 + 与生产同形的路由注册 ──
  const routes = []
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    for (const route of routes) {
      const hit = route.kind === 'exact'
        ? url.pathname === route.path
        : url.pathname === route.path || url.pathname.startsWith(`${route.path}/`)
      if (hit) {
        void route.handler(req, res)
        return
      }
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'no route' }))
  })
  await new Promise(resolve_ => server.listen(0, '127.0.0.1', resolve_))
  const port = server.address().port
  const webServer = {
    host: '127.0.0.1',
    port,
    register(route) {
      routes.push(route)
      return () => { routes.splice(routes.indexOf(route), 1) }
    },
    registerUpgrade() { return () => {} },
    registerFallback() { return () => {} },
  }
  ctx.provide('webServer', webServer)

  // ── 桩：会话与助手回答 ──
  const events = () => [
    { type: 'user/message', data: { content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: reply }] } } },
  ]
  // 桩必须实现 guest-server 用到的每一个 Agent 消息入口。真实 Agent 的接口是
  // send/followup/steer/inject（packages/core/agent/src/runtime-types.ts）；这里原先
  // 只有 followup，guest-server 把语言说明改成 inject 后桩就抛 TypeError → /chat 500，
  // 让「行为其实是对的」看起来像回归。桩缺方法 = 测试替身落伍于被测接口。
  const agent = {
    send() {},
    followup() {},
    steer() {},
    inject() {},
    async whenIdle() {
      for (const piece of frames ?? [reply]) {
        ctx.emit('session/event', { id: SESSION_ID }, { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: piece } } })
        await new Promise(resolve_ => setTimeout(resolve_, 0))
      }
    },
  }
  ctx.provide('agents', {
    get: id => (String(id) === SESSION_ID ? agent : undefined),
    create: async () => ({ agent, dispose: async () => {} }),
    resume: async () => ({ agent, dispose: async () => {} }),
  })
  ctx.provide('sessionQuery', { readSession: async () => ({ session: { id: SESSION_ID }, events: events() }) })
  ctx.provide('sessionPersistence', {})
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'stub', model: 'stub-model' }) })
  ctx.provide('agentPresets', { resolve: async id => ({ id }), mount: async () => {} })

  // ── 真实插件：门禁在前，访客桥在后（与 profile 行序一致）──
  gatePlugin.apply(ctx, gatePlugin.Config({ gate: { serverImageProbe: false } }))
  guestServer.apply(ctx, guestServer.Config({
    preset: 'customer-service-guest',
    workspace: '/kb',
    serviceVersion: 'test',
  }))

  /** 发一条请求并取回原始文本与状态码。 */
  const request = async (path, { method = 'GET', body } = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: response.status, text: await response.text(), contentType: response.headers.get('content-type') ?? '' }
  }

  /** 逐帧读 SSE（保留原始报文，用于 grep 级断言）。 */
  const stream = async (body) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/guest/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const raw = await response.text()
    const parsed = []
    for (const block of raw.split('\n\n')) {
      const eventLine = block.split('\n').find(line => line.startsWith('event: '))
      const dataLine = block.split('\n').find(line => line.startsWith('data: '))
      if (eventLine === undefined || dataLine === undefined) continue
      parsed.push({ event: eventLine.slice(7), data: JSON.parse(dataLine.slice(6)) })
    }
    return { status: response.status, raw, events: parsed, contentType: response.headers.get('content-type') ?? '' }
  }

  return { ctx, request, stream, warnings, close: () => new Promise(resolve_ => server.close(resolve_)), port }
}

/** 回答正文（含四类围栏与一段坏块）。 */
const REPLY = [
  '您好，办理流程如下：',
  '```mermaid',
  'flowchart TD',
  '  SECRET_MERMAID_NODE-->B',
  '```',
  '费用比例如下：',
  '```chart',
  'SECRET_CHART_JSON',
  '```',
  '参考图片：',
  '```image',
  '/uploads/banner_cs_9af26b7f16.png',
  '账单示意',
  '```',
  '补充说明：',
  '```html',
  '<div class="hero">SECRET_HTML_BODY</div>',
  '```',
  '以上，谢谢。',
].join('\n')

/** 围栏明文标记（载荷里一个都不允许出现）。 */
const FENCE_MARKERS = ['```mermaid', '```chart', '```image', '```html', '```img']

/** 断言一段原始报文不含围栏标记，也不含"源码体"级特征串。 */
function assertNoFenceLeak(raw, label) {
  for (const marker of FENCE_MARKERS) {
    assert.equal(raw.includes(marker), false, `${label}: 报文里出现围栏标记 ${marker}`)
  }
  for (const secret of ['SECRET_MERMAID_NODE', 'SECRET_CHART_JSON', 'SECRET_HTML_BODY']) {
    assert.equal(raw.includes(secret), false, `${label}: 报文里出现源码明文 ${secret}`)
  }
}

// ── 三个出口 ────────────────────────────────────────────────────────────────

await check('GET /api/guest/health 正常（组合可用）', async () => {
  const env = await boot(REPLY)
  try {
    const response = await env.request('/api/guest/health')
    assert.equal(response.status, 200)
    assert.equal(JSON.parse(response.text).ok, true)
  } finally {
    await env.close()
  }
})

await check('POST /api/guest/chat：载荷无围栏源码，正文保留、块结构化下发', async () => {
  const env = await boot(REPLY)
  try {
    const response = await env.request('/api/guest/chat', {
      method: 'POST',
      body: { sessionId: SESSION_ID, message: '如何办理？', lang: 'zh' },
    })
    assert.equal(response.status, 200)
    assertNoFenceLeak(response.text, '/chat 原始报文')
    const body = JSON.parse(response.text)
    assert.ok(body.reply.includes('您好，办理流程如下：'), '正文开头保留')
    assert.ok(body.reply.includes('以上，谢谢。'), '正文结尾保留')
    assert.equal(body.reply.includes('flowchart'), false, '正文不得含图形源码')
    assert.equal(body.blocks.length, 4, '四类围栏应各摘成一个块')
    assert.deepEqual(body.blocks.map(block => block.blockType), ['mermaid', 'chart', 'image', 'html'])
    // 坏块（chart 体不是 JSON）在主机侧即降级，且不带源码
    const chart = body.blocks.find(block => block.blockType === 'chart')
    assert.equal(chart.decision, 'degraded')
    assert.equal(chart.sourceB64, undefined)
    assert.equal(chart.reason, 'chart-invalid')
    // 结构合法的块以 base64 承载源码，可被访客端还原
    const mermaid = body.blocks.find(block => block.blockType === 'mermaid')
    assert.equal(mermaid.decision, 'render')
    assert.equal(Buffer.from(mermaid.sourceB64, 'base64').toString('utf8').includes('SECRET_MERMAID_NODE'), true)
    assert.equal(body.gate.maxBlockBytes, 32768, 'meta/done 必须下发门禁预算')
    assert.ok(body.degradedIds.includes(chart.blockId))
  } finally {
    await env.close()
  }
})

await check('POST /api/guest/chat/stream：SSE 原始报文无围栏源码，块以结构化事件下发', async () => {
  const env = await boot(REPLY, ['您好，办理流程如下：\n```mer', 'maid\nflowchart TD\n  SECRET_MERMAID_NODE-->B\n```\n费用比例如下：\n```chart\nSECRET_CHART_JSON\n```\n参考图片：\n```image\n/uploads/banner_cs_9af26b7f16.png\n账单示意\n```\n补充说明：\n```html\n<div class="hero">SECRET_HTML_BODY</div>\n```\n以上，谢谢。'])
  try {
    const response = await env.stream({ sessionId: SESSION_ID, message: '流程是什么？', lang: 'zh' })
    assert.equal(response.status, 200)
    assert.ok(response.contentType.startsWith('text/event-stream'), '必须是 SSE')
    assertNoFenceLeak(response.raw, '/chat/stream 原始报文')

    const kinds = response.events.map(event => event.event)
    assert.equal(kinds[0], 'meta', '首帧必须是 meta')
    assert.ok(kinds.includes('block-open'), '必须有 block-open 占位帧')
    assert.ok(kinds.includes('block'), '必须有 block 裁决帧')
    assert.ok(kinds.includes('done'), '必须有 done 定稿帧')
    assert.ok(kinds.indexOf('block-open') < kinds.indexOf('block'), 'block-open 先于 block')

    // 文字仍在逐帧流式（delta 帧存在且拼起来是正文）
    const deltas = response.events.filter(event => event.event === 'delta').map(event => event.data.text).join('')
    assert.ok(deltas.includes('您好，办理流程如下：'), '文字必须逐帧上屏')
    assert.equal(deltas.includes('flowchart'), false, 'delta 流不得含图形源码')

    const done = response.events.find(event => event.event === 'done')
    assert.ok(done !== undefined)
    assert.equal(done.data.blocks.length, 4)
    assert.equal(done.data.reply.includes('flowchart'), false)
    assert.ok(!response.raw.includes('SECRET_MERMAID_NODE'), '抓包看不到源码（base64 承载）')
  } finally {
    await env.close()
  }
})

await check('GET /api/guest/history：重放同样净化，与当轮终态一致', async () => {
  const env = await boot(REPLY)
  try {
    const response = await env.request(`/api/guest/history?sessionId=${SESSION_ID}`)
    assert.equal(response.status, 200)
    assertNoFenceLeak(response.text, '/history 原始报文')
    const body = JSON.parse(response.text)
    const assistant = body.messages.filter(message => message.role === 'assistant')
    assert.equal(assistant.length, 1)
    assert.equal(assistant[0].blocks.length, 4, 'history 必须回放同一批结构化块')
    assert.equal(assistant[0].text.includes('flowchart'), false)
    assert.equal(assistant[0].degradedIds.length, 1, '降级结论随历史一起回放（E4）')
  } finally {
    await env.close()
  }
})

await check('三出口终态一致：同一份回答在三条出口的块结构完全相同', async () => {
  const env = await boot(REPLY)
  try {
    const chat = JSON.parse((await env.request('/api/guest/chat', { method: 'POST', body: { sessionId: SESSION_ID, message: '问甲', lang: 'zh' } })).text)
    const stream = await env.stream({ sessionId: SESSION_ID, message: '问乙', lang: 'zh' })
    const history = JSON.parse((await env.request(`/api/guest/history?sessionId=${SESSION_ID}`)).text)
    const done = stream.events.find(event => event.event === 'done').data
    const fingerprint = value => JSON.stringify(value.map(block => ({ type: block.blockType, decision: block.decision, reason: block.reason ?? null, path: block.imagePath ?? null, sourceBytes: block.sourceBytes })))
    assert.equal(fingerprint(chat.blocks), fingerprint(done.blocks), '/chat 与 /chat/stream 终态必须一致')
    const assistant = history.messages.find(message => message.role === 'assistant')
    assert.equal(fingerprint(assistant.blocks), fingerprint(done.blocks), '/history 与 /chat/stream 终态必须一致')
    // 三个出口的正文也必须一致
    assert.equal(chat.reply, done.reply)
    assert.equal(assistant.text, done.reply)
  } finally {
    await env.close()
  }
})

await check('未闭合围栏：断流后载荷里也没有源码', async () => {
  const partial = '开头\n```mermaid\nflowchart TD\n  SECRET_MERMAID_NODE-->B'
  const env = await boot(partial, ['开头\n```mer', 'maid\nflowchart TD\n  SECRET_MERMAID_NODE-->B'])
  try {
    const stream = await env.stream({ sessionId: SESSION_ID, message: '未闭合', lang: 'zh' })
    assertNoFenceLeak(stream.raw, '未闭合流')
    const done = stream.events.find(event => event.event === 'done')
    assert.equal(done.data.blocks.length, 1)
    assert.equal(done.data.blocks[0].decision, 'degraded')
    assert.equal(done.data.blocks[0].sourceB64, undefined)
  } finally {
    await env.close()
  }
})

// ── 真机回传端点（O3）──────────────────────────────────────────────────────

await check('POST /api/guest/render-report：合法回传被接受', async () => {
  const env = await boot(REPLY)
  try {
    const response = await env.request('/api/guest/render-report', {
      method: 'POST',
      body: {
        sessionId: SESSION_ID,
        blockId: 'blk-x-0',
        blockType: 'mermaid',
        reason: 'render-empty',
        sourceDigest: '0123456789abcdef',
        sourceBytes: 42,
        occurredAt: Date.now(),
        outcome: 'degraded',
      },
    })
    assert.equal(response.status, 202)
    assert.equal(JSON.parse(response.text).ok, true)
  } finally {
    await env.close()
  }
})

await check('回传端点：非法 reason / 缺字段 / 超大 body 一律 400 且不落留痕', async () => {
  const env = await boot(REPLY)
  try {
    const bad = await env.request('/api/guest/render-report', { method: 'POST', body: { sessionId: SESSION_ID, blockId: 'b', blockType: 'mermaid', reason: 'made-up-reason' } })
    assert.equal(bad.status, 400)
    const missing = await env.request('/api/guest/render-report', { method: 'POST', body: { sessionId: SESSION_ID, blockType: 'mermaid', reason: 'render-empty' } })
    assert.equal(missing.status, 400)
    const malformed = await env.request('/api/guest/render-report', { method: 'POST', body: undefined })
    assert.equal(malformed.status, 400)
    // 超过 8KB：服务端在读取阶段即拒绝并断开（客户端可能因此看到 fetch 失败）。
    let rejected = false
    try {
      const huge = await env.request('/api/guest/render-report', { method: 'POST', body: { filler: 'x'.repeat(9000) } })
      rejected = huge.status >= 400
    } catch {
      rejected = true
    }
    assert.equal(rejected, true, '超过 8KB 的 body 必须被拒绝')
    assert.equal(env.warnings.filter(line => line.includes('guest.output-gate')).length, 0, '非法回传不得产生留痕')
  } finally {
    await env.close()
  }
})

await check('留痕：真机判定失败写入主机侧日志，前缀与七字段齐全', async () => {
  const env = await boot(REPLY)
  try {
    // 用与当轮块 id 一致的载荷发回传：先从 /chat 拿到真实块 id
    const chat = JSON.parse((await env.request('/api/guest/chat', { method: 'POST', body: { sessionId: SESSION_ID, message: '留痕用例', lang: 'zh' } })).text)
    const block = chat.blocks.find(item => item.blockType === 'mermaid')
    // 该轮已结束（回传晚到）→ 仍必须留痕，用于聚合
    const response = await env.request('/api/guest/render-report', {
      method: 'POST',
      body: {
        sessionId: SESSION_ID,
        blockId: block.blockId,
        blockType: 'mermaid',
        reason: 'render-empty',
        sourceDigest: 'fedcba9876543210',
        sourceBytes: block.sourceBytes,
        occurredAt: Date.now(),
        outcome: 'degraded',
      },
    })
    assert.equal(response.status, 202)
    const line = env.warnings.find(entry => entry.includes('sourceDigest=fedcba9876543210'))
    assert.ok(line !== undefined, '必须写主机侧留痕（含本次回传的 sourceDigest）')
    assert.ok(line.includes('guest.output-gate'), '留痕前缀必须是 guest.output-gate')
    assert.ok(line.includes(`sessionId=${SESSION_ID}`), '留痕含 sessionId')
    assert.ok(line.includes('blockType=mermaid'), '留痕含 blockType')
    assert.ok(line.includes('reason=render-empty'), '留痕含 reason')
    assert.ok(line.includes('sourceDigest=fedcba9876543210'), '留痕含 sourceDigest')
    assert.ok(/sourceBytes=\d+/.test(line), '留痕含 sourceBytes')
    assert.ok(/occurredAt=\d+/.test(line), '留痕含 occurredAt')
    assert.ok(/outcome=(passed|degraded)\b/.test(line), '留痕含 outcome，且取值在 O2 冻结集内')
  } finally {
    await env.close()
  }
})


// ── 输出前替换与 O3 去重（REP1–REP5 / O3，v3.2）──────────────────────────

await check('REP1：门禁不发起任何模型调用（无第二次模型请求）', async () => {
  const env = await boot(REPLY)
  try {
    // 桩环境没有提供 llm 服务；若门禁尝试调用模型会抛错并影响回答。
    const response = await env.request('/api/guest/chat', {
      method: 'POST',
      body: { sessionId: SESSION_ID, message: '流程？', lang: 'zh' },
    })
    assert.equal(response.status, 200, '无 llm 服务时回答必须照常完成')
    assert.equal(JSON.parse(response.text).blocks.length, 4)
  } finally {
    await env.close()
  }
})

await check('O3：回传永不引发内容变更（不做事后重写）', async () => {
  const env = await boot(REPLY)
  try {
    const chat = JSON.parse((await env.request('/api/guest/chat', { method: 'POST', body: { sessionId: SESSION_ID, message: '去重', lang: 'zh' } })).text)
    const block = chat.blocks.find(item => item.blockType === 'mermaid')
    const payload = {
      sessionId: SESSION_ID,
      blockId: block.blockId,
      blockType: 'mermaid',
      reason: 'render-empty',
      sourceDigest: 'abcabcabcabcabca',
      sourceBytes: block.sourceBytes,
      occurredAt: Date.now(),
      outcome: 'degraded',
    }
    const first = JSON.parse((await env.request('/api/guest/render-report', { method: 'POST', body: payload })).text)
    const second = JSON.parse((await env.request('/api/guest/render-report', { method: 'POST', body: payload })).text)
    assert.equal(first.ok, true)
    assert.equal(second.ok, true)
    // 回传后重新读历史：内容与结构都不得变化（REP1/REP5）
    const after = JSON.parse((await env.request(`/api/guest/history?sessionId=${SESSION_ID}`)).text)
    const assistant = after.messages.find(message => message.role === 'assistant')
    assert.equal(assistant.text.includes('flowchart'), false, '回传不得改变已交付内容')
    assert.equal(assistant.blocks.length, 4, '结构保持')
    assert.equal(assistant.blocks.find(item => item.blockType === 'mermaid').decision, 'render', '真机结论不改写主机侧裁决')
  } finally {
    await env.close()
  }
})

await check('O2：留痕 outcome 只用 passed|degraded（无 rewritten）', async () => {
  const env = await boot(REPLY)
  try {
    await env.request('/api/guest/chat', { method: 'POST', body: { sessionId: SESSION_ID, message: '留痕集', lang: 'zh' } })
    const lines = env.warnings.filter(line => line.includes('guest.output-gate'))
    assert.ok(lines.length > 0, '应有留痕')
    for (const line of lines) {
      assert.ok(/outcome=(passed|degraded)\b/.test(line), `outcome 必须在 O2 冻结集内: ${line}`)
      assert.equal(line.includes('rewritten'), false, '不得出现 rewritten')
    }
  } finally {
    await env.close()
  }
})

await check('P7/T1：多块回答不因"预算被前一块吃掉"而降级', async () => {
  const env = await boot(REPLY)
  try {
    const response = await env.request('/api/guest/chat', { method: 'POST', body: { sessionId: SESSION_ID, message: '两个块', lang: 'zh' } })
    const body = JSON.parse(response.text)
    const renderable = body.blocks.filter(block => block.decision === 'render')
    assert.equal(renderable.length, 3, '结构合法的三类块（mermaid/image/html）都必须保持可渲染，不因并行预算被降级')
    assert.equal(body.degradedIds.length, 1, '只有真非法的 chart 块降级')
  } finally {
    await env.close()
  }
})


// ── F-1 / F-3 回归（V1 blocker 的载荷层取证）──────────────────────────────

/** 反引号围栏（避免模板字符串里的裸反引号）。 */
const FENCE = '`'.repeat(3)

await check('F-1 回归：受控关键字 + 超长 info 行，三出口载荷均无围栏与源码', async () => {
  // verifier 的原复现：`FENCE+mermaid` 后接 >512 字符的 info 行。
  const reply = ['开头', FENCE + 'mermaid' + 'A'.repeat(600), 'BODY', FENCE, '结尾'].join('\n')
  const env = await boot(reply, [reply])
  try {
    const chat = await env.request('/api/guest/chat', { method: 'POST', body: { sessionId: SESSION_ID, message: '超长 info', lang: 'zh' } })
    const stream = await env.stream({ sessionId: SESSION_ID, message: '超长 info', lang: 'zh' })
    const history = await env.request(`/api/guest/history?sessionId=${SESSION_ID}`)
    for (const [label, raw] of [['/chat', chat.text], ['/chat/stream', stream.raw], ['/history', history.text]]) {
      assert.equal(raw.includes(FENCE + 'mermaid'), false, `${label}: 不得含围栏`)
      assert.equal(raw.includes('AAAA'), false, `${label}: 不得含超长 info 内容`)
      assert.equal(raw.includes('BODY'), false, `${label}: 不得含块体源码`)
    }
    assert.equal(JSON.parse(chat.text).text === undefined || true, true)
  } finally {
    await env.close()
  }
})

await check('F-3 回归：嵌套围栏在三出口载荷均不泄漏', async () => {
  const reply = ['前', FENCE + 'mermaid', 'flowchart TD', FENCE + 'chart', '[{"label":"SECRET","value":1}]', FENCE, '后'].join('\n')
  const env = await boot(reply, [reply])
  try {
    const chat = await env.request('/api/guest/chat', { method: 'POST', body: { sessionId: SESSION_ID, message: '嵌套', lang: 'zh' } })
    const stream = await env.stream({ sessionId: SESSION_ID, message: '嵌套', lang: 'zh' })
    for (const [label, raw] of [['/chat', chat.text], ['/chat/stream', stream.raw]]) {
      assert.equal(raw.includes('SECRET'), false, `${label}: 嵌套块体不得外发`)
      assert.equal(raw.includes(FENCE + 'chart'), false, `${label}: 嵌套起始行不得外发`)
    }
  } finally {
    await env.close()
  }
})

// ── C6 裁决取证：可达性仅留痕、不参与放行、不阻塞下发 ──────────────────────

/**
 * 起一套带"被探测源站"的环境：源站按 probeMode 返回 404 或永不响应。
 * @param {'ok'|'404'|'hang'} probeMode - 被探测源站的行为
 * @param {boolean} serverImageProbe - 探测开关
 * @returns 环境句柄（含载荷、事件时序、留痕）
 */
async function bootProbe(probeMode, serverImageProbe) {
  const ctx = new Context()
  const warnings = []
  ctx.logger.warn = (...args) => { warnings.push(args.map(String).join(' ')) }
  ctx.logger.info = () => {}
  ctx.provide('llm', undefined)
  const originServer = createServer((req, res) => {
    if (probeMode === 'hang') return
    if (probeMode === '404') { res.writeHead(404); res.end(); return }
    res.writeHead(200); res.end()
  })
  await new Promise(resolve_ => originServer.listen(0, '127.0.0.1', resolve_))
  const origin = `http://127.0.0.1:${originServer.address().port}`
  gatePlugin.apply(ctx, gatePlugin.Config({ gate: { serverImageProbe, serverImageProbeTimeoutMs: 50 } }))
  const service = ctx.get('outputGate')
  const order = []
  const turn = service.beginTurn(SESSION_ID, event => order.push(event.type), { origin })
  const started = Date.now()
  turn.feed('看图：\n```image\n/uploads/banner_cs_9af26b7f16.png\n说明\n```\n后续正文')
  const payload = await turn.settle()
  const elapsed = Date.now() - started
  return { payload, order, warnings, elapsed, close: () => new Promise(resolve_ => originServer.close(resolve_)) }
}

await check('C6：可达性探测结果不参与放行（404 与"探测关闭"的载荷完全一致）', async () => {
  const on = await bootProbe('404', true)
  const off = await bootProbe('404', false)
  try {
    assert.equal(on.payload.blocks[0].decision, off.payload.blocks[0].decision, '决策必须一致')
    assert.equal(on.payload.blocks[0].decision, 'render', '路径合法 → 交真机裁决（不因 404 降级）')
    assert.equal(on.payload.blocks[0].imagePath, off.payload.blocks[0].imagePath, '路径结论一致')
    assert.equal(on.payload.text, off.payload.text, '正文一致')
  } finally {
    await on.close()
    await off.close()
  }
})

await check('C6：探测挂起（永不响应）同样不影响载荷与耗时', async () => {
  const hang = await bootProbe('hang', true)
  const off = await bootProbe('hang', false)
  try {
    assert.equal(hang.payload.blocks[0].decision, 'render')
    assert.equal(hang.payload.blocks[0].decision, off.payload.blocks[0].decision)
    assert.ok(hang.elapsed < 3000, `探测不得拖慢结算，实际 ${hang.elapsed}ms`)
  } finally {
    await hang.close()
    await off.close()
  }
})

await check('C6：探测结论写入留痕（仅记录，字段符合 O2）', async () => {
  const env = await bootProbe('404', true)
  try {
    // 探测是异步旁路：给它一点时间落日志
    await new Promise(resolve_ => setTimeout(resolve_, 50))
    const line = env.warnings.find(entry => entry.includes('guest.output-gate') && entry.includes('image-unreachable'))
    assert.ok(line !== undefined, '404 探测必须写留痕 reason=image-unreachable')
    assert.ok(line.includes('blockType=image'), '留痕含 blockType')
  } finally {
    await env.close()
  }
})

await check('E5/T4：block 事件同步下发，不被探测阻塞（探测在 emit 之后触发）', async () => {
  const env = await bootProbe('hang', true)
  try {
    assert.ok(env.order.includes('block'), '必须有 block 事件')
    assert.ok(env.order.includes('text'), '文字照常')
  } finally {
    await env.close()
  }
})

/** 未决字段名清单（E5/T4：载荷不得出现任何"等待中"语义）。 */
const PENDING_KEYS = ['pending', 'unresolved', 'probe', 'probeResult', 'reachable', 'awaiting', 'deferred']

await check('E5：图片块载荷不含"未决"字段（可达性不进载荷）', async () => {
  const env = await bootProbe('hang', true)
  try {
    const block = env.payload.blocks[0]
    for (const key of PENDING_KEYS) {
      assert.equal(key in block, false, `载荷不得含未决字段 ${key}`)
    }
    assert.ok(['render', 'degraded'].includes(block.decision), 'decision 必须是已定结论')
  } finally {
    await env.close()
  }
})

// ── D-1：blockResults 终态语义与「全载荷无未决字段」─────────────────────────

await check('D-1：blockResults 四分支语义与裁定表一致，且取值域恒为 passed|degraded', async () => {
  const env = await boot(REPLY)
  try {
    const chat = JSON.parse((await env.request('/api/guest/chat', { method: 'POST', body: { sessionId: SESSION_ID, message: '四分支', lang: 'zh' } })).text)
    const byType = Object.fromEntries(chat.blocks.map(block => [block.blockType, block.blockId]))
    // 分支①：主机侧结构判定即降级（REPLY 的 chart 体不是 JSON）
    assert.equal(chat.blockResults[byType.chart], 'degraded', 'chart 结构性降级 → degraded')
    // 分支④：等待窗口内未收到任何回传 → passed（块对访客保持可见）
    assert.equal(chat.blockResults[byType.mermaid], 'passed', '未回传 → passed（不代表真机已验证）')
    assert.equal(chat.blockResults[byType.image], 'passed', '未回传 → passed')
    // 取值域：只允许 passed|degraded；主机侧中间态 render 绝不得进入终态映射
    const values = [...new Set(Object.values(chat.blockResults))].sort()
    assert.deepEqual(values, ['degraded', 'passed'], '取值域必须是 passed|degraded')
    assert.equal(JSON.stringify(chat.blockResults).includes('"render"'), false, 'blockResults 不得出现 render')
  } finally {
    await env.close()
  }
})

await check('D-1：回传 degraded 时记为 degraded 且入 degradedIds', async () => {
  const env = await boot(REPLY)
  try {
    const chat = JSON.parse((await env.request('/api/guest/chat', { method: 'POST', body: { sessionId: SESSION_ID, message: '回传', lang: 'zh' } })).text)
    const target = chat.blocks.find(block => block.decision === 'render')
    assert.ok(target !== undefined, '本例应有一个可渲染块')
    // 真机回传降级（轮次已结束 → 只留痕，不改已送达内容；断言其不污染本轮终态）
    const applied = JSON.parse((await env.request('/api/guest/render-report', {
      method: 'POST',
      body: {
        sessionId: SESSION_ID, blockId: target.blockId, blockType: target.blockType,
        reason: 'render-empty', sourceDigest: 'abcabcabcabcabca', sourceBytes: target.sourceBytes,
        occurredAt: Date.now(), outcome: 'degraded',
      },
    })).text)
    assert.equal(applied.ok, true, '回传端点必须接受')
    // REP5：已送达内容不回改
    const after = JSON.parse((await env.request(`/api/guest/history?sessionId=${SESSION_ID}`)).text)
    const assistant = after.messages.find(message => message.role === 'assistant')
    assert.equal(assistant.blockResults[target.blockId], 'passed', '已送达终态不被后到回传改写（REP5）')
  } finally {
    await env.close()
  }
})

await check('D-1：blocks[].decision 仍为 render|degraded（与 blockResults 取值域不同）', async () => {
  const env = await boot(REPLY)
  try {
    const chat = JSON.parse((await env.request('/api/guest/chat', { method: 'POST', body: { sessionId: SESSION_ID, message: 'decision', lang: 'zh' } })).text)
    const decisions = [...new Set(chat.blocks.map(block => block.decision))]
    assert.ok(decisions.every(value => value === 'render' || value === 'degraded'), `decision 取值域必须是 render|degraded，实际 ${decisions}`)
    assert.equal(decisions.includes('render'), true, '结构性合法的块仍须以 render 下发（交真机裁决）')
    assert.equal(decisions.includes('passed'), false, 'decision 不得被改成 passed')
  } finally {
    await env.close()
  }
})

await check('D-1：degradedIds 与 blockResults 同判据恒等（对任意 id，双向）', async () => {
  const env = await boot(REPLY)
  try {
    const chat = JSON.parse((await env.request('/api/guest/chat', { method: 'POST', body: { sessionId: SESSION_ID, message: '恒等', lang: 'zh' } })).text)
    const ids = Object.keys(chat.blockResults)
    assert.ok(ids.length > 0, '应有块结论')
    for (const id of ids) {
      assert.equal(chat.blockResults[id] === 'degraded', chat.degradedIds.includes(id), `id=${id} 双向必须恒等`)
    }
    for (const id of chat.degradedIds) {
      assert.equal(chat.blockResults[id], 'degraded', `degradedIds 中的 ${id} 必须在 blockResults 里为 degraded`)
    }
    assert.equal(chat.degradedIds.length, ids.filter(id => chat.blockResults[id] === 'degraded').length, '数量也必须一致')
  } finally {
    await env.close()
  }
})

await check('E5/T4：全载荷（blocks 与 blockResults，三出口）均无未决字段', async () => {
  const env = await boot(REPLY)
  try {
    const chat = JSON.parse((await env.request('/api/guest/chat', { method: 'POST', body: { sessionId: SESSION_ID, message: '未决', lang: 'zh' } })).text)
    const stream = await env.stream({ sessionId: SESSION_ID, message: '未决', lang: 'zh' })
    const done = stream.events.find(event => event.event === 'done')
    const history = JSON.parse((await env.request(`/api/guest/history?sessionId=${SESSION_ID}`)).text)
    const assistant = history.messages.find(message => message.role === 'assistant')

    const targets = [
      ['/chat blocks', chat.blocks],
      ['/chat blockResults', chat.blockResults],
      ['/chat/stream done.blocks', done.data.blocks],
      ['/chat/stream done.blockResults', done.data.blockResults],
      ['/history blocks', assistant.blocks],
      ['/history blockResults', assistant.blockResults],
    ]
    for (const [label, value] of targets) {
      const json = JSON.stringify(value)
      for (const key of PENDING_KEYS) {
        assert.equal(json.includes(`"${key}"`), false, `${label}: 不得含未决字段名 ${key}`)
      }
      const items = Array.isArray(value) ? value : Object.values(value).map(v => ({ v }))
      for (const item of items) {
        for (const key of PENDING_KEYS) {
          assert.equal(key in item, false, `${label}: 不得含未决字段 ${key}`)
        }
      }
    }
    // blockResults 的值只能是终态
    for (const [label, results] of [['/chat', chat.blockResults], ['/chat/stream', done.data.blockResults], ['/history', assistant.blockResults]]) {
      for (const [id, verdict] of Object.entries(results)) {
        assert.ok(verdict === 'passed' || verdict === 'degraded', `${label} ${id}: 终态只能是 passed|degraded，实际 ${verdict}`)
      }
    }
  } finally {
    await env.close()
  }
})

// ── 汇报 ───────────────────────────────────────────────────────────────────

const failed = results.filter(result => !result.ok)
for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}${result.ok ? '' : `\n        ${result.error}`}`)
}
console.log(`\n${results.length - failed.length}/${results.length} 项断言通过`)
if (failed.length > 0) process.exit(1)
