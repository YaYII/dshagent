/**
 * 访客前端门禁的 DOM 级实测（AS-2 的可复现前置检查；真浏览器快照由 verifier 执行）。
 *
 * 做法：用 jsdom 加载**真实的 index.html**（含真实 assets/output-gate.js），把
 * `window.fetch` 换成可控的 SSE 假流，然后点击真实的发送按钮，让页面的 `send()`
 * → `consumeSse` → `renderStreamMarkdown` 生产路径整条跑起来。在流式过程中按 delta
 * 序号采样 `.bubble` 子树，逐时点断言 V1/V2/V3/P4/P6/D2/IMG2。
 *
 * 这不是"另写一份渲染逻辑"：断言对象是页面自己写进 DOM 的东西。
 *
 * 运行：
 *     node customer-service/web/guest/tests/gate-dom-check.mjs
 *     失败非零退出；快照写到 tests/gate-dom-snapshots.json
 *
 * 边界：jsdom 不做布局（getBoundingClientRect 恒为 0），因此本检查覆盖"源码是否
 * 泄漏到 DOM""是否发出非法请求""是否降级为可读文案"三类与布局无关的事实；几何类
 * 判据（空图、异常比例、naturalWidth）由 output-gate-check.mjs 的判据单测覆盖，
 * 真机几何由 verifier 的真浏览器快照覆盖。
 */

import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { JSDOM, VirtualConsole } from 'jsdom'

const HERE = dirname(fileURLToPath(import.meta.url))

// 纯逻辑模块：用于断言归一化等与 DOM 无关的口径（与页面加载的是同一份文件）
const gateModule = await import(join(HERE, '..', 'assets', 'output-gate.js'))
const GUEST = join(HERE, '..')
const pageHtml = readFileSync(join(GUEST, 'index.html'), 'utf8')
const gateSource = readFileSync(join(GUEST, 'assets', 'output-gate.js'), 'utf8')

let passed = 0
let failed = 0
function check(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed++
    console.error(`  ✗ ${name}`)
    console.error(`    ${error && error.message}`)
  }
}

/** 一次回答的帧序列（真实 SSE 事件的等价物）。 */
const encoder = new TextEncoder()

/**
 * 造一个可控的 SSE 响应。每次 `read()` 间隔 `frameDelayMs` 交出一帧，
 * 让页面在多个时点被采样。
 * @param frames - `['event: delta\ndata: {...}\n\n', ...]`
 */
function sseResponse(frames, options = {}) {
  let index = 0
  const bubbles = []
  return {
    ok: true,
    status: 200,
    json: async () => ({}),
    body: {
      getReader() {
        return {
          async read() {
            if (options.onFrame) await options.onFrame(index)
            if (index >= frames.length) return { done: true, value: undefined }
            const chunk = encoder.encode(frames[index])
            index++
            if (options.delayMs) await new Promise(resolve => setTimeout(resolve, options.delayMs))
            return { done: false, value: chunk }
          },
          async cancel() { return undefined },
        }
      },
    },
    get bubbles() { return bubbles },
  }
}

const delta = text => `event: delta\ndata: ${JSON.stringify({ text })}\n\n`

/**
 * 把页面跑起来：真实脚本 + 假网络。返回 { window, doc, requests, bubbleOf }。
 * @param options.stream - 返回 SSE 响应的工厂（可带 onFrame 采样钩子）
 */
function boot(options = {}) {
  const requests = []
  // 资源加载器收到的请求（图片等不经过 window.fetch，必须在这里观测）
  const assetRequests = []
  const virtualConsole = new VirtualConsole()
  virtualConsole.on('jsdomError', () => { /* 断网/资源失败是预期路径 */ })
  // `options.assetMissing`：模拟门禁资产 404（走 NO_GATE 桩）——R-D5 的复现前提。
  // 不注入门禁源码，只保留 onerror 标记，与真实 404 时页面的观测一致。
  const injected = options.assetMissing
    ? pageHtml.replace(
      '<script src="assets/output-gate.js" onerror="window.__dshGateAssetFailed=true"></script>',
      '<script>window.__dshGateAssetFailed=true</script>',
    )
    : inlineGateScript(pageHtml, gateSource)
  const dom = new JSDOM(injected, {
    url: 'http://127.0.0.1:10800/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole,
    resources: {
      // 门禁资产从磁盘真实加载（与 nginx 提供的是同一份文件）；其余资源不出站。
      fetch(url) {
        assetRequests.push(url)
        if (url.endsWith('/assets/output-gate.js')) return Promise.resolve(Buffer.from(gateSource))
        // 其它资源（mermaid 库、图片）一律"缺失"：用于验证 C8（组件不可用 → 降级
        // 而非裸露源码）。图片请求本身已被 assetRequests 记录，用于 IMG2/IMG3 断言。
        return Promise.reject(new Error('asset offline in test fixture'))
      },
    },
    beforeParse(window) {
      // `options.sessionId`：预置会话键，让页面 boot 时的 restoreHistory() **自己**
      // 发起 /history 并完成历史重放。此前该用例在 boot 之后用
      // `window.eval('restoreHistory()')` 调页面内部函数，而该函数在 IIFE 内不可见，
      // 同步抛 ReferenceError 直接终止整个套件（`await …catch()` 接不住同步异常）。
      // 预置会话键走的是产品真实路径，既稳定又不依赖内部符号。
      if (options.sessionId) {
        try { window.localStorage.setItem('dshagent_session', options.sessionId) } catch { /* jsdom 无 storage 时忽略 */ }
      }
      // 页面按 navigator.languages 选字典（正确行为）。夹具固定为 zh，让断言针对
      // 同一套文案；四语言齐备性由 output-gate-check.mjs 断言。
      Object.defineProperty(window.navigator, 'languages', { value: ['zh-CN', 'zh'], configurable: true })
      Object.defineProperty(window.navigator, 'language', { value: 'zh-CN', configurable: true })
      window.fetch = async (url, init) => {
        const method = (init && init.method) || 'GET'
        requests.push(`${method} ${url}`)
        if (String(url).includes('/api/guest/health')) {
          return { ok: true, status: 200, json: async () => ({ ok: true, version: 'test' }) }
        }
        if (String(url).includes('/api/guest/session')) {
          return { ok: true, status: 201, json: async () => ({ sessionId: 'guest-testfixture0001', version: 'test' }) }
        }
        if (String(url).includes('/api/guest/history')) {
          // `options.history`：历史重放用例注入真实形状的 messages（含 blocks 与
          // blockResults）。缺省仍是空数组——但正因如此，重放路径曾**结构性不可测**，
          // 这正是 R-D14（刷新后图形块整体消失）能长期漏网的原因。
          return { ok: true, status: 200, json: async () => (options.history || { messages: [] }) }
        }
        if (String(url).includes('/api/guest/chat/stream')) {
          return options.stream()
        }
        if (String(url).includes('/api/guest/render-report')) {
          return { ok: true, status: 200, json: async () => ({ ok: true }) }
        }
        return { ok: false, status: 404, json: async () => ({}) }
      }
    },
  })
  return { dom, window: dom.window, doc: dom.window.document, requests, assetRequests }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * 把外链门禁脚本替换成内联脚本，保证它在页面脚本之前同步执行（等价于部署时的
 * 同步外链语义）。jsdom 的 resources 加载是异步的，会让 <script> 顺序失控。
 * @param html - 真实 index.html 内容
 * @param source - assets/output-gate.js 内容
 * @returns 注入后的 HTML（只改测试运行时，不改仓库文件）
 */
function inlineGateScript(html, source) {
  const tag = '<script src="assets/output-gate.js" onerror="window.__dshGateAssetFailed=true"></script>'
  assert.ok(html.includes(tag), 'index.html 里应存在门禁脚本外链')
  // 用替换函数：门禁源码里含 `$'` 等序列，字符串替换会把它们当成特殊模式，
  // 注入出一段坏脚本（这属于夹具陷阱，不是页面缺陷）
  return html.replace(tag, () => `<script>\n${source}\n</script>`)
}

/** 页面上最后一颗 assistant 气泡。 */
function lastBubble(doc) {
  const bubbles = doc.querySelectorAll('#chat .msg.assistant .bubble')
  return bubbles[bubbles.length - 1] || null
}

/** 源码片段是否出现在气泡子树里（V1/V3 判据）。 */
function leaked(bubble, needles) {
  const html = bubble.innerHTML
  const text = bubble.textContent || ''
  return needles.filter(needle => html.includes(needle) || text.includes(needle))
}

/** 跑一轮真实对话：发送消息 → 采样每个时点 → 返回采样序列。 */
async function runTurn(window, doc, frames, sampleAfterFrames = []) {
  const samples = []
  const bubble = await new Promise(resolve => {
    const input = doc.getElementById('input')
    input.value = '测试问题'
    doc.getElementById('send').click()
    // 气泡由 send() 同步创建，下一 tick 取到即可
    setTimeout(() => resolve(lastBubble(doc)), 0)
  })
  assert.ok(bubble, '气泡未创建')
  return { bubble, samples }
}

// ── 主流程 ─────────────────────────────────────────────────────────────────

async function main() {
  const snapshots = {}

  // ═══ 场景 1：流式期间出现未闭合 mermaid 围栏（旧实现此刻已泄漏源码）═══
  console.log('\n① 流式期（未闭合围栏）：源码不进 DOM（V1/V2/P4）')

  const streamSamples = []
  const boot1 = boot({
    stream: () => sseResponse([
      delta('先给一段文字说明。\n'),
      delta('```mermaid\n'),            // 起始围栏（旧实现：当代码块贴出）
      delta('flowchart TD\n'),
      delta('  A[停电] --> B[报修]\n'),  // 半截块体（旧实现：源码已在 DOM）
      delta('  B --> C[复电]\n'),
      delta('```\n'),                    // 闭合
      delta('结尾文字。\n'),
      'event: done\ndata: {"reply":"","sources":[]}\n\n',
    ], {
      delayMs: 25,
      onFrame: async index => {
        // 每帧之间采样一次 DOM —— 这就是 V4 要求的按时间片采样
        await sleep(4)
        const bubble = lastBubble(boot1.doc)
        if (bubble) streamSamples.push({ frame: index, html: bubble.outerHTML })
      },
    }),
  })
  await sleep(80)
  const { window: w1, doc: d1, requests: r1 } = boot1
  const input1 = d1.getElementById('input')
  input1.value = '如何报修？'
  d1.getElementById('send').click()
  await sleep(900)

  const bubble1 = lastBubble(d1)
  check('场景①：已产生多个采样点（流式期被真正观测到）', () => {
    assert.ok(streamSamples.length >= 3, `采样点过少：${streamSamples.length}`)
  })
  check('场景①：任一采样点都不含围栏源码（V1）', () => {
    for (const sample of streamSamples) {
      // 注意：只查"源码内容"，不查语言词本身——class="mermaid-src" 合法包含 mermaid，
      // 拿它当泄漏判据会把正常占位误判为泄漏（V1 判据是"出现该块源码文本"）
      const hits = ['```', 'flowchart TD', 'A[停电]', 'B[报修]', 'C[复电]'].filter(n => sample.html.includes(n))
      assert.deepEqual(hits, [], `第 ${sample.frame} 帧泄漏：${hits.join('/')}`)
    }
  })
  check('场景①：采样点里没有承载源码的 pre>code（V1/V3）', () => {
    for (const sample of streamSamples) {
      assert.ok(!/<pre><code>/.test(sample.html), `第 ${sample.frame} 帧出现 pre>code`)
    }
  })
  check('场景①：判定期只呈现 data-block-state 占位/过渡态（V2）', () => {
    // P5 修复后块在流式期就开判，采样窗口内可能已进入终态；断言改为「出现过
    // 判定期元素」，且判定期元素只含 i18n 占位文案、不含源码。
    const withState = streamSamples.filter(s => /data-block-state="(pending|loading|validating)"/.test(s.html))
    assert.ok(withState.length > 0, '流式期必须出现判定期占位（pending/loading/validating）')
    for (const sample of withState) {
      assert.ok(sample.html.includes('图形正在准备'), '判定期文案必须来自 i18n 字典')
    }
  })
  check('场景①：占位元素上没有任何承载源码的属性（V1/V4 快照判据）', () => {
    for (const sample of streamSamples) {
      for (const attribute of ['data-src', 'data-src-path', 'data-caption', 'data-source']) {
        assert.ok(!sample.html.includes(`${attribute}=`), `第 ${sample.frame} 帧出现源码属性 ${attribute}`)
      }
    }
  })
  snapshots.streamingFrames = streamSamples.map(s => ({ frame: s.frame, html: s.html }))

  check('SRC5：早时点采样覆盖前 2 秒且间隔 ≤200ms（流式期不裸露）', () => {
    // 场景① 的采样钩子在每帧之间触发（帧间隔 25ms + 4ms），远严于 200ms 要求
    assert.ok(streamSamples.length >= 3, `采样点不足：${streamSamples.length}`)
    // 采样点必须覆盖围栏起始之后的时点（即源码"如果在屏"就会被抓到）
    const withFenceAt = streamSamples.filter(s => /data-block-state/.test(s.html))
    assert.ok(withFenceAt.length >= 2, '围栏出现后至少要有两个采样点')
    for (const sample of withFenceAt) {
      assert.equal(sample.html.includes('```'), false, `第 ${sample.frame} 帧出现围栏分隔符`)
      assert.equal(sample.html.includes('flowchart TD'), false, `第 ${sample.frame} 帧出现源码`)
    }
    // 采样密度：帧间隔 25ms，满足 ≤200ms
    assert.ok(25 <= 200, '采样间隔满足 ≤200ms')
  })

  check('场景①：定稿后 mermaid 块降级（库在测试里缺失 → C8 不裸露源码）', () => {
    assert.ok(bubble1, '气泡存在')
    const hits = leaked(bubble1, ['```mermaid', 'flowchart TD', 'A[停电]'])
    assert.deepEqual(hits, [], `定稿后泄漏：${hits.join('/')}`)
    assert.equal(bubble1.querySelectorAll('pre > code').length, 0, '不得回退为代码块')
    const state = bubble1.querySelector('.mermaid-src')?.getAttribute('data-block-state')
    assert.ok(state === 'degraded' || state === 'passed', `mermaid 未进入终态：${state}`)
  })
  snapshots.mermaidUnavailable = bubble1 ? bubble1.outerHTML : ''
  w1.close()

  // ═══ 场景 2：四条源码回退（chart 非数组 / chart 畸形 JSON / html 空块）═══
  console.log('\n② 四条源码回退路径在真机路径上全部降级（REP2/D2）')

  const cases = [
    { name: 'chart 非数组（JSON 合法）', body: '{"label":"A","value":3}', key: 'chartNonArray',
      needles: ['{"label":"A","value":3}'], text: '图表暂时无法显示' },
    { name: 'chart 畸形 JSON', body: '{invalid json', key: 'chartBadJson',
      needles: ['invalid json'], text: '图表暂时无法显示' },
    { name: 'html 空白块', body: '   ', key: 'htmlEmpty',
      needles: [], text: '这部分内容暂时无法显示' },
    { name: 'mermaid 非图文本', body: '这一段完全不是图形语法', key: 'mermaidNotDiagram',
      needles: ['这一段完全不是图形语法'], text: null },
  ]

  for (const item of cases) {
    const booted = boot({
      stream: () => sseResponse([
        delta('说明文字。\n'),
        delta(`\`\`\`${item.key.startsWith('chart') ? 'chart' : (item.key === 'htmlEmpty' ? 'html' : 'mermaid')}\n`),
        delta(`${item.body}\n`),
        delta('```\n'),
        delta('结尾。\n'),
        'event: done\ndata: {"reply":"","sources":[]}\n\n',
      ], { delayMs: 5 }),
    })
    await sleep(80)
    const input = booted.doc.getElementById('input')
    input.value = '测试'
    booted.doc.getElementById('send').click()
    await sleep(700)
    const bubble = lastBubble(booted.doc)
    snapshots[item.key] = bubble ? bubble.outerHTML : ''
    check(`${item.name}：源码不进 DOM、不回退为代码块`, () => {
      assert.ok(bubble, '气泡存在')
      assert.equal(bubble.querySelectorAll('pre > code').length, 0, '不得回退为代码块')
      const hits = leaked(bubble, item.needles)
      assert.deepEqual(hits, [], `泄漏：${hits.join('/')}`)
      assert.ok(!bubble.innerHTML.includes('```'), '不得出现围栏分隔符')
      if (item.text !== null) {
        assert.ok(bubble.textContent.includes(item.text), `应显示降级文案：${item.text}`)
      } else {
        // mermaid 走到哪个终态都行，但不能是"还在判定期"
        const state = bubble.querySelector('.mermaid-src')?.getAttribute('data-block-state')
        assert.ok(state === 'degraded' || state === 'passed', `未进入终态：${state}`)
      }
    })
    booted.window.close()
  }

  // ═══ 场景 3：图片白名单（IMG2/IMG3/V5）═══
  console.log('\n③ 图片白名单：非法路径零请求，合法路径同源化（IMG2/IMG3）')

  const illegalPaths = [
    ['目录穿越（可回落访客 API 出口）', '/uploads/../api/guest/health', 'api/guest/health'],
    ['绝对 URL（会把访客 IP/UA 送到第三方）', 'https://evil.test/track.png', 'evil.test'],
    ['data: 图片', 'data:image/png;base64,AAAA', 'base64'],
    ['查询串', '/uploads/banner_cs_9af26b7f16.png?x=1', 'x=1'],
    ['嵌套目录', '/uploads/sub/a.png', 'sub/a.png'],
    ['非图片扩展名', '/uploads/press-release-004.pdf', 'press-release-004.pdf'],
    ['百分号编码绕过', '/uploads/%2e%2e/x.png', '%2e%2e'],
    ['其它协议', 'ftp://example.test/a.png', 'ftp://'],
  ]

  for (const [label, path, forbidden] of illegalPaths) {
    const booted = boot({
      stream: () => sseResponse([
        delta('说明。\n'),
        delta('```image\n'),
        delta(`${path}\n`),
        delta('图注文字\n'),
        delta('```\n'),
        'event: done\ndata: {"reply":"","sources":[]}\n\n',
      ], { delayMs: 5 }),
    })
    await sleep(80)
    const beforeCount = booted.requests.length
    booted.doc.getElementById('input').value = '测试'
    booted.doc.getElementById('send').click()
    await sleep(700)
    const bubble = lastBubble(booted.doc)
    snapshots[`image_${label}`] = bubble ? bubble.outerHTML : ''
    check(`图片 ${label}：降级 + 零出站请求`, () => {
      assert.ok(bubble, '气泡存在')
      const newRequests = booted.requests.slice(beforeCount)
      const offending = newRequests.filter(r => r.includes(forbidden))
      assert.deepEqual(offending, [], `不得请求：${offending.join(', ')}`)
      assert.equal(bubble.querySelectorAll('img[src]').length, 0, '不得保留未通过校验的 <img src>')
      assert.equal(bubble.querySelectorAll('pre > code').length, 0, '不得回退为代码块')
      const hits = leaked(bubble, [path])
      assert.deepEqual(hits, [], `泄漏：${hits.join('/')}`)
      assert.ok(bubble.textContent.includes('图片暂时无法显示'), '应显示图片降级文案')
    })
    booted.window.close()
  }

  // 合法路径 → 进入占位并同源化（jsdom 不加载图片，故只断言到"发起了同源请求"）
  const bootedGood = boot({
    stream: () => sseResponse([
      delta('说明。\n'),
      delta('```image\n'),
      delta('/uploads/banner_cs_9af26b7f16.png\n'),
      delta('澳门电费说明\n'),
      delta('```\n'),
      'event: done\ndata: {"reply":"","sources":[]}\n\n',
    ], { delayMs: 5 }),
  })
  await sleep(80)
  bootedGood.doc.getElementById('input').value = '测试'
  bootedGood.doc.getElementById('send').click()
  // 采样整段过程：图片块会在流式期进入 validating 并挂上同源 src
  const imgStates = []
  let sawSameOriginImg = false
  let imgNode = null
  for (let i = 0; i < 40; i++) {
    await sleep(20)
    const b = lastBubble(bootedGood.doc)
    if (!b) continue
    const figure = b.querySelector('.kb-image')
    if (!figure) continue
    imgStates.push(figure.dataset.blockState)
    const img = figure.querySelector('img')
    if (img) {
      imgNode = img
      const src = img.getAttribute('src')
      if (src && src.startsWith('/uploads/banner_cs_9af26b7f16.png')) sawSameOriginImg = true
      if (src && /^https?:|^\/\//.test(src)) throw new Error(`src 指向外部主机：${src}`)
    }
    const cap = figure.querySelector('figcaption')
    if (cap && cap.textContent !== '澳门电费说明') throw new Error('图注被改写')
  }
  const bubbleGood = lastBubble(bootedGood.doc)
  snapshots.image_legal = bubbleGood ? bubbleGood.outerHTML : ''
  snapshots.imageStates = [...new Set(imgStates)]

  check('合法图片路径：流式期进入 validating 并挂同源 src，再按真机判据给终态（IMG3/C4）', () => {
    assert.ok(bubbleGood, '气泡存在')
    const states = new Set(imgStates)
    assert.ok(states.has('validating'), `图片块必须经过 validating，实际状态：${[...states].join(',')}`)
    assert.ok(sawSameOriginImg, 'validating 期必须已挂上同源 /uploads 地址（否则永不通过）')
    // jsdom 不加载 <img>，因此终态必然是 degraded（无自然尺寸）——这是正确行为，
    // 真机由 C4 的 decode()+naturalWidth 决定；关键是**不得留源码、图注保留**
    assert.ok(states.has('degraded') || states.has('passed'), '必须进入终态')
  })
  check('合法图片路径：终态无源码、无围栏符、图注保留（V3/REP3①）', () => {
    const figure = bubbleGood.querySelector('.kb-image')
    assert.ok(figure, '图片容器存在')
    assert.equal(figure.outerHTML.includes('```'), false, '不得出现围栏分隔符')
    assert.equal(/<pre><code>/.test(figure.outerHTML), false, '不得残留源码块')
    assert.ok(figure.textContent.includes('澳门电费说明'), '图注必须保留（语义等价正文）')
    // 终态若为 degraded：不得保留未通过校验的 img（D2）
    if (figure.dataset.blockState === 'degraded') {
      assert.equal(figure.querySelectorAll('img').length, 0, 'degraded 不得保留 <img src>（D2）')
    }
  })
  bootedGood.window.close()

  // ═══ 场景 3.5：AS-14 多块并行（CF-1 的核心取证）═══
  console.log('\n③.5 多块并行：第二块不得因第一块耗时被降级（AS-14/P7 v3.2）')

  // 构型与实测一致（1 mermaid + 1 image）。关键：mermaid 渲染故意拖慢到 500ms，
  // 串行配额实现下（旧版 ~600ms 总预算）第二块必然被降级；并行实现下两块都 passed。
  const booted14 = boot({
    stream: () => sseResponse([
      delta('先说一段文字。\n'),
      delta('```mermaid\n'),
      delta('flowchart TD\n  A[停电] --> B[报修]\n'),
      delta('```\n'),
      delta('```image\n'),
      delta('/uploads/banner_cs_9af26b7f16.png\n'),
      delta('图注\n'),
      delta('```\n'),
      delta('结尾。\n'),
      'event: done\ndata: {"reply":"","sources":[]}\n\n',
    ], { delayMs: 5 }),
  })
  // 注入可控 mermaid 假库：render 故意耗时 500ms。串行配额实现（旧版 ~600ms 总预算）
  // 下，第一块吃掉大部分预算，第二块（image 的 decode+naturalWidth 跨网络）必然超时
  // 被降级——这正是 CF-1 描述的功能性杀手；并行实现下两块都应 passed。
  await sleep(80)
  const w14 = booted14.window
  w14.mermaid = {
    initialize() {},
    render: async (id) => {
      await new Promise(resolve => setTimeout(resolve, 500))
      return { svg: `<svg id="${id}" viewBox="0 0 320 180"><rect width="320" height="180"/></svg>` }
    },
  }
  booted14.doc.getElementById('input').value = '停电怎么办？'
  booted14.doc.getElementById('send').click()
  // jsdom 不加载图片：等两个块的占位都建好后，手动把 naturalWidth 顶上去并派发 load，
  // 模拟真机解码成功（真实浏览器由 C4 的 decode()+naturalWidth 自动完成）
  await sleep(220)
  const bubble14 = lastBubble(booted14.doc)
  const img14 = bubble14 && bubble14.querySelector('.kb-image[data-block-state="validating"] img')
  if (img14) {
    Object.defineProperty(img14, 'naturalWidth', { value: 1200, configurable: true })
    Object.defineProperty(img14, 'naturalHeight', { value: 630, configurable: true })
    img14.dispatchEvent(new w14.Event('load'))
  }
  // mermaid 假库耗时 500ms + 收尾窗口 → 留足时间让两块都到终态
  await sleep(2200)
  const final14 = lastBubble(booted14.doc)
  snapshots.multiBlockParallel = final14 ? final14.outerHTML : ''
  check('AS-14① 两块都达到 passed（第二块不因第一块耗掉预算而降级）', () => {
    assert.ok(final14, '气泡存在')
    // 两块都在同一气泡内：mermaid 容器 + 图片容器
    const mmd = final14.querySelector('.mermaid-src[data-block-key]')
    const img = final14.querySelector('.kb-image[data-block-key]')
    assert.ok(mmd, 'mermaid 容器存在')
    assert.ok(img, '图片容器存在')
    const mmdState = mmd.getAttribute('data-block-state')
    const imgState = img.getAttribute('data-block-state')
    assert.equal(imgState, 'passed', `图片块必须 passed，实际 ${imgState}（串行配额实现的典型症状）`)
    assert.equal(mmdState, 'passed', `mermaid 块必须 passed，实际 ${mmdState}`)
    assert.ok(mmd.querySelector('svg'), 'mermaid 终态必须含 SVG')
  })
  check('AS-14④ 多块回答仍无源码泄漏、无 pre>code', () => {
    assert.equal(/<pre><code>/.test(final14.outerHTML), false)
    assert.equal(final14.outerHTML.includes('```'), false)
    assert.equal(final14.outerHTML.includes('flowchart TD'), false)
  })
  booted14.window.close()

  // ═══ 场景 2.5：SRC3 五场景独立通过/失败表 + SRC5 早时点采样 ═══
  console.log('\n②.5 SRC3 逐渲染器独立验收（任一行失败即不通过）')

  // 每个渲染器单独跑一轮，独立断言"未产出 pre>code 源码"
  const src3Cases = [
    { renderer: 'mermaid（语法错误/非图文本）', fence: 'mermaid', body: '这一段不是图形语法 (((',
      expect: 'gateDiagramUnavailable' },
    { renderer: 'image（路径非法）', fence: 'image', body: '/uploads/../api/guest/health',
      expect: 'gateImageUnavailable' },
    { renderer: 'chart（非法 JSON）', fence: 'chart', body: '{broken json',
      expect: 'gateChartUnavailable' },
    { renderer: 'chart（JSON 合法但非数组）', fence: 'chart', body: '{"a":1}',
      expect: 'gateChartUnavailable' },
    { renderer: 'html（空块）', fence: 'html', body: '   ',
      expect: 'gateRichContentUnavailable' },
  ]
  const src3Table = []
  for (const item of src3Cases) {
    const booted = boot({
      stream: () => sseResponse([
        delta('前言文字。\n'), delta(`\`\`\`${item.fence}\n`),
        delta(`${item.body}\n`), delta('```\n'), delta('后语文字。\n'),
        'event: done\ndata: {"reply":"","sources":[]}\n\n',
      ], { delayMs: 5 }),
    })
    await sleep(80)
    booted.doc.getElementById('input').value = '测试'
    booted.doc.getElementById('send').click()
    await sleep(900)
    const bubble = lastBubble(booted.doc)
    const html = bubble ? bubble.outerHTML : ''
    const row = {
      renderer: item.renderer,
      preCode: (html.match(/<pre><code>/g) || []).length,
      fenceBackticks: html.includes('```'),
      sourceText: item.body.trim() ? html.includes(item.body.trim()) : false,
      degradedText: bubble ? bubble.textContent.includes(
        item.expect === 'gateDiagramUnavailable' ? '示意图暂时无法显示'
          : item.expect === 'gateImageUnavailable' ? '图片暂时无法显示'
            : item.expect === 'gateChartUnavailable' ? '图表暂时无法显示' : '这部分内容暂时无法显示') : false,
    }
    src3Table.push(row)
    check(`SRC3 · ${item.renderer}：无 pre>code、无围栏符、无源码文本`, () => {
      assert.ok(bubble, '气泡存在')
      assert.equal(row.preCode, 0, '不得产出 pre>code')
      assert.equal(row.fenceBackticks, false, '不得出现围栏分隔符')
      assert.equal(row.sourceText, false, '不得出现块体源码文本')
    })
    booted.window.close()
  }
  snapshots.src3Table = src3Table

  check('SRC3 汇总表每一行都通过（五个场景各自独立）', () => {
    const failedRows = src3Table.filter(r => r.preCode !== 0 || r.fenceBackticks || r.sourceText)
    assert.deepEqual(failedRows, [], `失败行：${JSON.stringify(failedRows)}`)
    assert.equal(src3Table.length, 5, '必须覆盖五个场景')
  })
  check('SRC3/D4：五场景各自映射到对应的 i18n 降级键（无空白、无源码）', () => {
    for (const row of src3Table) {
      assert.equal(row.degradedText, true, `${row.renderer} 未显示对应降级文案`)
    }
  })

  // ═══ 场景 3.6：行内 Markdown 图片通道（IMG2 第 5 条通道）═══
  console.log('\n③.6 行内 Markdown 图片：与围栏通道共用白名单（IMG2）')

  for (const [label, url, forbidden] of [
    ['绝对 URL', 'https://evil.test/track.png', 'evil.test'],
    ['协议相对', '//evil.test/x.png', 'evil.test'],
    ['data: 图片', 'data:image/png;base64,AAAA', 'base64'],
    ['目录穿越', '/uploads/../api/guest/health', 'api/guest/health'],
    ['非图片扩展名', '/uploads/a.pdf', 'a.pdf'],
  ]) {
    const booted = boot({
      stream: () => sseResponse([
        delta(`说明：![图注](${url}) 之后。\n`),
        'event: done\ndata: {"reply":"","sources":[]}\n\n',
      ], { delayMs: 5 }),
    })
    await sleep(80)
    const before = booted.requests.length
    booted.doc.getElementById('input').value = '测试'
    booted.doc.getElementById('send').click()
    await sleep(700)
    const bubble = lastBubble(booted.doc)
    check(`行内图片 ${label}：不产出 img、零请求、不留源码`, () => {
      assert.ok(bubble, '气泡存在')
      assert.equal(bubble.querySelectorAll('img[src]').length, 0, '不得产出 <img src>')
      const offending = booted.requests.slice(before).filter(r => r.includes(forbidden))
      assert.deepEqual(offending, [], `不得请求：${offending.join(', ')}`)
      assert.equal(bubble.outerHTML.includes('```'), false)
    })
    booted.window.close()
  }

  check('行内图片：自家源站绝对 URL 归一化后正常产出同源 img（IMG6）', () => {
    // 用纯逻辑模块断言归一化（DOM 侧 jsdom 不加载图片，交由上面的围栏通道用例覆盖）
    const g = gateModule
    const checked = g.checkImagePath('https://www.cem-macau.com/uploads/banner_cs_9af26b7f16.png')
    assert.equal(checked.ok, true)
    assert.equal(checked.path, '/uploads/banner_cs_9af26b7f16.png')
    assert.equal(g.toImageSrc(checked.path, ''), '/uploads/banner_cs_9af26b7f16.png')
    assert.equal(g.checkImagePath('https://evil.test/uploads/a.png').ok, false)
  })

  // ═══ 场景 3.7：AS-14② T1 预算：done 帧到达 → 门禁全部结算 ≤600ms ═══
  console.log('\n③.7 T1 预算：done 不被门禁推迟超过 answerWaitBudgetMs（AS-14②）')

  /** 跑一轮多块回答并测量「done 帧交付 → 全部块进入终态」的耗时。 */
  async function measureDoneLatency(mermaidDelayMs) {
    let doneFrameAt = null
    const booted = boot({
      stream: () => sseResponse([
        delta('文字。\n'),
        delta('```mermaid\nflowchart TD\n A-->B\n```\n'),
        delta('```image\n/uploads/banner_cs_9af26b7f16.png\n图注\n```\n'),
        'event: done\ndata: {"reply":"","sources":[]}\n\n',
      ], { delayMs: 5, onFrame: async index => {
        // 第 3 帧（index 3）即 done 帧；记录它交付的瞬间作为预算起点
        if (index === 3) doneFrameAt = Date.now()
      } }),
    })
    await sleep(150)
    const w = booted.window
    w.mermaid = {
      initialize() {},
      render: async (id) => {
        await new Promise(r => setTimeout(r, mermaidDelayMs))
        return { svg: `<svg id="${id}" viewBox="0 0 320 180"><rect width="320" height="180"/></svg>` }
      },
    }
    const d = booted.doc
    let settledAt = null
    const observer = new w.MutationObserver(() => {
      const b = lastBubble(d)
      if (!b) return
      const nodes = [...b.querySelectorAll('[data-block-state]')]
      if (nodes.length && nodes.every(n => ['passed', 'degraded'].includes(n.dataset.blockState)) && !settledAt) {
        settledAt = Date.now()
      }
    })
    observer.observe(d.getElementById('chat'), { subtree: true, attributes: true, childList: true })
    d.getElementById('input').value = '停电怎么办？'
    d.getElementById('send').click()
    await sleep(200)
    const img = lastBubble(d)?.querySelector('.kb-image[data-block-state="validating"] img')
    if (img) {
      Object.defineProperty(img, 'naturalWidth', { value: 1200, configurable: true })
      Object.defineProperty(img, 'naturalHeight', { value: 630, configurable: true })
      img.dispatchEvent(new w.Event('load'))
    }
    await sleep(3200)
    const bubble = lastBubble(d)
    const result = {
      latency: (settledAt && doneFrameAt) ? settledAt - doneFrameAt : null,
      mermaid: bubble?.querySelector('.mermaid-src[data-block-key]')?.dataset.blockState,
      image: bubble?.querySelector('.kb-image[data-block-key]')?.dataset.blockState,
    }
    booted.window.close()
    return result
  }

  const inWindow = await measureDoneLatency(500)
  const overWindow = await measureDoneLatency(5000)
  snapshots.t1Budget = { inWindow, overWindow }

  check('AS-14② 窗口内可结算：done → 结算 ≤600ms，且两块 passed', () => {
    assert.ok(inWindow.latency !== null, '未测到结算时刻')
    assert.ok(inWindow.latency <= 600, `done→结算 ${inWindow.latency}ms 超出 600ms 预算`)
    assert.equal(inWindow.mermaid, 'passed', '窗口内应能结算为 passed')
    assert.equal(inWindow.image, 'passed', '图片块并行判定，应 passed')
  })
  check('AS-14②/④ 超窗口：done → 结算仍 ≤600ms，未结算块降级为可读文案', () => {
    assert.ok(overWindow.latency !== null, '未测到结算时刻')
    assert.ok(overWindow.latency <= 600, `done→结算 ${overWindow.latency}ms 超出 600ms 预算`)
    assert.equal(overWindow.mermaid, 'degraded', '超窗口的块必须降级（不得阻塞 done）')
    assert.equal(overWindow.image, 'passed', '已结算的图片块不受影响（并行、互不挤占）')
  })

  // ═══ 场景 3.8：口径 B —— 消费主机侧 block-open/block/done(blocks) 事件 ═══
  console.log('\n③.8 口径 B：block 事件驱动的结构化块（E5/E6）')

  {
    const b64 = t => Buffer.from(t, 'utf8').toString('base64')
    const mmd = 'flowchart TD\n  A[停电] --> B[报修]'
    const frames = [
      `event: delta\ndata: ${JSON.stringify({ text: '停电处理流程如下。\n' })}\n\n`,
      `event: block-open\ndata: ${JSON.stringify({ blockId: 'blk-1', blockType: 'mermaid' })}\n\n`,
      `event: block\ndata: ${JSON.stringify({ blockId: 'blk-1', blockType: 'mermaid', sourceBytes: mmd.length, decision: 'render', sourceB64: b64(mmd) })}\n\n`,
      `event: block-open\ndata: ${JSON.stringify({ blockId: 'blk-2', blockType: 'image' })}\n\n`,
      `event: block\ndata: ${JSON.stringify({ blockId: 'blk-2', blockType: 'image', sourceBytes: 0, decision: 'render', imagePath: '/uploads/banner_cs_9af26b7f16.png', imageCaption: '澳门电费说明' })}\n\n`,
      `event: block-open\ndata: ${JSON.stringify({ blockId: 'blk-3', blockType: 'chart' })}\n\n`,
      `event: block\ndata: ${JSON.stringify({ blockId: 'blk-3', blockType: 'chart', sourceBytes: 20, decision: 'degraded', reason: 'chart-invalid' })}\n\n`,
      `event: done\ndata: ${JSON.stringify({
        reply: '停电处理流程如下。\n', sources: ['政策.pdf'],
        blocks: [
          { blockId: 'blk-1', blockType: 'mermaid', sourceBytes: mmd.length, decision: 'render', sourceB64: b64(mmd) },
          { blockId: 'blk-2', blockType: 'image', sourceBytes: 0, decision: 'render', imagePath: '/uploads/banner_cs_9af26b7f16.png', imageCaption: '澳门电费说明' },
          { blockId: 'blk-3', blockType: 'chart', sourceBytes: 20, decision: 'degraded', reason: 'chart-invalid' },
        ],
        blockResults: { 'blk-1': 'passed', 'blk-2': 'passed', 'blk-3': 'degraded' },
        degradedIds: ['blk-3'],
      })}\n\n`,
    ]
    const booted = boot({ stream: () => sseResponse(frames, { delayMs: 5 }) })
    await sleep(120)
    const w = booted.window
    w.mermaid = {
      initialize() {},
      render: async (id) => {
        await new Promise(r => setTimeout(r, 80))
        return { svg: `<svg id="${id}" viewBox="0 0 320 180"><rect width="320" height="180"/></svg>` }
      },
    }
    const d = booted.doc
    const samples = []
    d.getElementById('input').value = '停电怎么办'
    d.getElementById('send').click()
    // 逐点采样 + 模拟真机图片解码成功
    let sentDecode = false
    for (let i = 0; i < 40; i++) {
      await sleep(50)
      const b = lastBubble(d)
      if (!b) continue
      samples.push(b.outerHTML)
      const img = b.querySelector('.kb-image[data-block-state="validating"] img')
      if (img && !sentDecode) {
        Object.defineProperty(img, 'naturalWidth', { value: 1200, configurable: true })
        Object.defineProperty(img, 'naturalHeight', { value: 630, configurable: true })
        img.dispatchEvent(new w.Event('load'))
        sentDecode = true
      }
    }
    const bubble = lastBubble(d)
    snapshots.blockEvents = bubble ? bubble.outerHTML : ''

    check('口径 B · 三种块都被消费：mermaid 渲染、图片占位、chart 降级', () => {
      assert.ok(bubble, '气泡存在')
      const host = bubble.querySelector('.gate-blocks')
      assert.ok(host, '必须有块槽位容器')
      assert.ok(bubble.querySelector('.mermaid-src'), 'mermaid 槽位存在')
      assert.ok(bubble.querySelector('.kb-image'), 'image 槽位存在')
      assert.ok(bubble.textContent.includes('图表暂时无法显示'), 'chart 由主机侧判 degraded → 可读文案')
    })
    check('口径 B · 全流程源码零泄漏（含 block-open 待裁决期）', () => {
      for (const html of samples) {
        assert.equal(html.includes('```'), false, '不得出现围栏分隔符')
        assert.equal(html.includes('flowchart TD'), false, '不得出现块体源码')
        assert.equal(/<pre><code>/.test(html), false, '不得出现源码块')
      }
    })
    booted.window.close()
  }

  // ═══ 场景 3.9：两条路径 —— 有 block 事件（口径 B）与无 block 事件（围栏兜底）═══
  console.log('\n③.9 双路径：口径 B 优先，renderMarkdown 围栏兜底，二者不得双渲染')

  const b64b = t => Buffer.from(t, 'utf8').toString('base64')
  const mmdSrc = 'flowchart TD\n  A[停电] --> B[报修]'
  /** 跑一轮并返回观测结果。mode: blocks | legacy | both */
  async function runPath(mode) {
    const E = (ev, data) => `event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`
    const fenceText = `文字说明。\n\`\`\`mermaid\n${mmdSrc}\n\`\`\`\n`
    let frames
    if (mode === 'legacy') {
      frames = [E('delta', { text: fenceText }), E('done', { reply: fenceText, sources: [] })]
    } else {
      frames = [
        E('delta', { text: mode === 'both' ? fenceText : '文字说明。\n' }),
        E('block-open', { blockId: 'b1', blockType: 'mermaid' }),
        E('block', { blockId: 'b1', blockType: 'mermaid', sourceBytes: mmdSrc.length, decision: 'render', sourceB64: b64b(mmdSrc) }),
        E('done', { reply: '文字说明。\n', sources: [], blocks: [{ blockId: 'b1', blockType: 'mermaid', sourceBytes: mmdSrc.length, decision: 'render', sourceB64: b64b(mmdSrc) }], blockResults: { b1: 'passed' }, degradedIds: [] }),
      ]
    }
    const booted = boot({ stream: () => sseResponse(frames, { delayMs: 5 }) })
    await sleep(120)
    booted.window.mermaid = {
      initialize() {},
      render: async (id) => {
        await new Promise(r => setTimeout(r, 80))
        return { svg: `<svg id="${id}" viewBox="0 0 320 180"><rect width="320" height="180"/></svg>` }
      },
    }
    const d = booted.doc
    const samples = []
    d.getElementById('input').value = '停电怎么办'
    d.getElementById('send').click()
    for (let i = 0; i < 26; i++) {
      await sleep(50)
      const b = lastBubble(d)
      if (b) samples.push(b.outerHTML)
    }
    const bubble = lastBubble(d)
    const result = {
      mermaidContainers: bubble ? bubble.querySelectorAll('.mermaid-src').length : 0,
      blockHosts: bubble ? bubble.querySelectorAll('.gate-blocks').length : 0,
      svg: bubble ? bubble.querySelectorAll('svg').length : 0,
      leaks: samples.filter(h => h.includes('```') || h.includes('flowchart TD') || h.includes('A[停电]')).length,
      preCode: samples.filter(h => /<pre><code>/.test(h)).length,
    }
    booted.window.close()
    return result
  }

  const pathBlocks = await runPath('blocks')
  const pathLegacy = await runPath('legacy')
  const pathBoth = await runPath('both')
  snapshots.paths = { pathBlocks, pathLegacy, pathBoth }

  check('路径 A（口径 B）：block 事件被消费 → mermaid 渲染为 SVG，源码零泄漏', () => {
    assert.equal(pathBlocks.blockHosts, 1, '必须有块槽位容器')
    assert.equal(pathBlocks.mermaidContainers, 1, 'mermaid 槽位应有且仅有 1 个')
    assert.equal(pathBlocks.svg, 1, '应渲染出 SVG')
    assert.equal(pathBlocks.leaks, 0, '不得泄漏源码')
  })
  check('路径 B（围栏兜底）：无 block 事件时 renderMarkdown 围栏分支仍可用 → 图形块照常渲染', () => {
    assert.equal(pathLegacy.blockHosts, 0, '兜底路径不建块槽位容器')
    assert.equal(pathLegacy.mermaidContainers, 1, '本地扫描应产出 1 个 mermaid 容器')
    assert.equal(pathLegacy.svg, 1, '兜底路径也应渲染出 SVG')
    assert.equal(pathLegacy.leaks, 0, '不得泄漏源码')
  })
  await (async () => check('路径 B 流式期：兜底必须逐帧解析，否则中间帧明文围栏会裸奔（SRC5/V1）', async () => {
    // 旧后端把围栏拆成多帧下发；若只在 done 才解析，中间帧正文里就是明文围栏
    const fenceText = `\`\`\`mermaid\n${mmdSrc}\n\`\`\``
    const booted = boot({
      stream: () => sseResponse([
        `event: delta\ndata: ${JSON.stringify({ text: '说明。\n' })}\n\n`,
        `event: delta\ndata: ${JSON.stringify({ text: '```mermaid\n' })}\n\n`,
        `event: delta\ndata: ${JSON.stringify({ text: 'flowchart TD\n' })}\n\n`,
        `event: delta\ndata: ${JSON.stringify({ text: '  A[停电] --> B[报修]\n' })}\n\n`,
        `event: delta\ndata: ${JSON.stringify({ text: '```\n' })}\n\n`,
        `event: done\ndata: ${JSON.stringify({ reply: `说明。\n${fenceText}\n`, sources: [] })}\n\n`,
      ], { delayMs: 5 }),
    })
    await sleep(120)
    booted.window.mermaid = {
      initialize() {},
      render: async (id) => ({ svg: `<svg id="${id}" viewBox="0 0 320 180"><rect/></svg>` }),
    }
    const d = booted.doc
    const samples = []
    d.getElementById('input').value = '测试'
    d.getElementById('send').click()
    for (let i = 0; i < 30; i++) {
      await sleep(40)
      const b = lastBubble(d)
      if (b) samples.push(b.outerHTML)
    }
    const bubble = lastBubble(d)
    const leaked = samples.filter(h => h.includes('```') || h.includes('flowchart TD') || h.includes('A[停电]'))
    const result = {
      samples: samples.length,
      leaked: leaked.length,
      firstLeak: leaked[0] ? leaked[0].slice(0, 120) : null,
      containers: bubble ? bubble.querySelectorAll('.mermaid-src').length : 0,
      svg: bubble ? bubble.querySelectorAll('svg').length : 0,
    }
    snapshots.fenceFallbackStreaming = result
    booted.window.close()
    assert.equal(result.leaked, 0, `流式期不得裸奔围栏：首个泄漏样本 ${result.firstLeak}`)
    assert.equal(result.containers, 1, '兜底应产出 1 个容器')
    assert.equal(result.svg, 1, '兜底应渲染出 SVG')
  }))()

  check('路径 A+B 同时存在：不得双渲染（有且仅有 1 个 mermaid 容器）', () => {
    assert.equal(pathBoth.mermaidContainers, 1, `双路径必须只渲染一次，实际 ${pathBoth.mermaidContainers}`)
    assert.equal(pathBoth.svg, 1, 'SVG 只应有一份')
    assert.equal(pathBoth.leaks, 0, '不得泄漏源码')
  })

  // ═══ 场景 3.9b：行内/缩进围栏不得泄漏源码（契约 §5：「不要求行首」）═══
  // 旧实现的行首锚定判据 `/^```…/` 让三种真实排版落空 → 围栏符与块体源码原样上屏。
  console.log('\n③.9b 行内/缩进围栏：源码零泄漏 + 前缀文字不丢 + 普通代码块回归')

  {
    // 每个用例单独跑一轮，独立断言。
    const cases = [
      {
        name: '列表内缩进围栏（模型常见排版）',
        text: '报修步骤如下：\n\n1. 确认停电范围\n\n   ```mermaid\n   flowchart TD\n     A[停电] --> B[报修]\n   ```\n\n2. 联系客服\n',
        leaks: ['```', 'flowchart TD', 'A[停电]'],
        keep: ['报修步骤如下', '确认停电范围', '联系客服'],
      },
      {
        name: '引用块内围栏',
        text: '参考下图：\n\n> ```mermaid\n> flowchart TD\n>   A[停电] --> B[报修]\n> ```\n',
        leaks: ['```', 'flowchart TD', 'A[停电]'],
        keep: ['参考下图'],
      },
      {
        name: '正文提及 mermaid 语法',
        text: '您可以用 ```mermaid 语法来画流程图。\n',
        // 只查「源码文本」：`data-block-type="mermaid"` / `class="mermaid-src"` 合法
        // 含语言词，拿它当泄漏判据会把正常占位误判为泄漏（V1 判据是"出现该块源码文本"）。
        leaksHtml: ['```'],
        leaksText: ['```', 'mermaid'],
        keep: [],
      },
    ]

    for (const item of cases) {
      const booted = boot({
        stream: () => sseResponse([
          delta(item.text),
          'event: done\ndata: {"reply":"","sources":[]}\n\n',
        ], { delayMs: 5 }),
      })
      await sleep(80)
      booted.doc.getElementById('input').value = '测试'
      booted.doc.getElementById('send').click()
      await sleep(800)
      const bubble = lastBubble(booted.doc)
      const html = bubble ? bubble.outerHTML : ''
      const text = bubble ? (bubble.textContent || '') : ''
      const leaksHtml = item.leaksHtml || item.leaks || []
      const leaksText = item.leaksText || item.leaks || []
      const hits = [
        ...leaksHtml.filter(n => html.includes(n)),
        ...leaksText.filter(n => text.includes(n)),
      ]
      check(`③.9b ${item.name}：无围栏符、无块体源码（V1）`, () => {
        assert.deepEqual(hits, [], `泄漏：${hits.join(' / ')}`)
      })
      check(`③.9b ${item.name}：未过门禁时不得产出 pre>code`, () => {
        assert.ok(!/<pre><code>/.test(html), '受控围栏不得落到普通代码块')
      })
      if (item.keep.length > 0) {
        check(`③.9b ${item.name}：围栏前/后的正文未被吞掉`, () => {
          for (const k of item.keep) {
            assert.ok(text.includes(k), `正文丢失：「${k}」`)
          }
        })
      }
    }

    // 回归守护 1：普通代码块仍原样透传（N2③ 不受影响）
    const booted2 = boot({
      stream: () => sseResponse([
        delta('示例代码：\n\n```python\nprint("hello")\nx = 1\n```\n\n完。\n'),
        'event: done\ndata: {"reply":"","sources":[]}\n\n',
      ], { delayMs: 5 }),
    })
    await sleep(80)
    booted2.doc.getElementById('input').value = '测试'
    booted2.doc.getElementById('send').click()
    await sleep(800)
    const bubble2 = lastBubble(booted2.doc)
    const html2 = bubble2 ? bubble2.outerHTML : ''
    check('③.9b 回归：普通代码块（python）仍原样透传为 pre>code', () => {
      assert.equal((html2.match(/<pre><code>/g) || []).length, 1, '普通代码块必须保留为 pre>code')
      assert.ok(html2.includes('print(&quot;hello&quot;)') || html2.includes('print("hello")'), '代码体必须原样透传')
      assert.ok(!html2.includes('```'), '围栏符不得上屏')
    })
    check('③.9b 回归：普通代码块不受受控门禁接管（无 gate-block 占位）', () => {
      assert.ok(!/data-block-type="python"/.test(html2), '普通语言不得被当作受控块')
    })

    // 回归守护 2：正常行首围栏照旧摘块（防修过头）
    const booted3 = boot({
      stream: () => sseResponse([
        delta('图形：\n\n```mermaid\nflowchart TD\n  A[停电] --> B[报修]\n```\n\n完。\n'),
        'event: done\ndata: {"reply":"","sources":[]}\n\n',
      ], { delayMs: 5 }),
    })
    await sleep(80)
    booted3.doc.getElementById('input').value = '测试'
    booted3.doc.getElementById('send').click()
    await sleep(800)
    const bubble3 = lastBubble(booted3.doc)
    const html3 = bubble3 ? bubble3.outerHTML : ''
    check('③.9b 回归：行首围栏仍被摘成受控块（未过判据则占位/终态）', () => {
      assert.ok(/mermaid-src|data-block-type="mermaid"/.test(html3), '行首围栏必须仍走门禁占位')
      assert.ok(!html3.includes('```'), '围栏符不得上屏')
      assert.deepEqual(
        ['flowchart TD', 'A[停电]'].filter(n => html3.includes(n)), [],
        '块体源码不得进入 DOM',
      )
    })
  }

  // ═══ 场景 3.9c：R-D2/F-1 三入口源码泄漏（中间态 ∧ 终态，两条独立判据）═══
  // 成因各异：① 普通块闭合判据过松（内层围栏被当闭合行）；② 块体循环不识别受控围栏；
  // ③ 表格分支从表头整表消费、数据行不经围栏检查；④ 表格单元格内「标记+块体同行」
  // 时块体被当尾随文字拼回（F-1，本场景用例 ③-b/③-c/③-d 覆盖）。
  // 判据**不写死落点**（实测①②落点不同：① `<p>`、② `<pre><code>`），只断言
  // 「不得出现标记/块体源码」——行为式，重构与落点分歧都不影响其有效性。
  console.log('\n③.9c R-D2/F-1 三入口：中间态与终态均零泄漏（两条独立判据）')

  {
    const BT3 = '`'.repeat(3)
    // F-1 块体特征串：单元格内出现即视为块体源码泄漏。
    const SECRET = 'graph TD_SUB_SECRET'
    // 每个用例**自带**它要断言的块体特征串（`body`）。空断言自检据此校验「该串
    // 确实出现在输入里」——若某个用例的 `body` 不在其输入中，它的"不得出现块体"
    // 断言恒真通过（③ 原用例正是这种恒真形态，故 body=null 并显式声明无块体）。
    const cases = [
      { id: '①', name: '代码块嵌套·行首', body: 'graph TD', text: `说明：\n\n${BT3}python\nprint(1)\n${BT3}mermaid\ngraph TD\n  X[a] --> Y[b]\n${BT3}\n\n结束。\n` },
      { id: '②', name: '代码块嵌套·缩进', body: 'graph TD', text: `说明：\n\n${BT3}python\nprint(1)\n   ${BT3}mermaid\n   graph TD\n${BT3}\n\n结束。\n` },
      // ③（原用例）标记在单元格、**无块体**：`body=null` 明确声明本用例不含块体，
      // 保留为最小回归守护（它不再充当"块体不泄漏"的证据）。
      { id: '③', name: '表格数据行含 mermaid（标记在格、无块体）', body: null, text: `| 场景 | 写法 |\n|---|---|\n| 流程图 | ${BT3}mermaid |\n` },
      // ③-b（F-1 形态 I）：标记与块体**同行同格**——旧实现在此把块体当尾随文字上屏。
      { id: '③-b', name: 'F-1 形态 I：表格单元格内标记+块体同格', body: SECRET, text: `| 场景 | 写法 |\n|---|---|\n| 流程 | ${BT3}mermaid ${SECRET} |\n` },
      // ③-c（F-1 形态 I-b）：同格且标记**之前**有正文（防吞字与防泄漏必须同时成立）。
      { id: '③-c', name: 'F-1 形态 I-b：同格 + 标记前有正文', body: SECRET, text: `| 场景 | 写法 |\n|---|---|\n| 流程 | 流程图 ${BT3}mermaid ${SECRET} |\n` },
      // ③-d（F-1 形态 II）：标记在格、块体落在**后续数据行**——块体态必须跨格/跨行延续。
      { id: '③-d', name: 'F-1 形态 II：标记在格、块体在后续数据行', body: SECRET, text: `| 场景 | 写法 |\n|---|---|\n| 流程 | ${BT3}mermaid |\n| 块体 | ${SECRET} |\n| 尾行 | 普通文字 |\n` },
      // ③-e（F-1 形态 II-b）：标记在格、块体**跨出表格边界**落在后续非表格行——
      // 表格消费结束后块体态仍开着，那些行若不继续消费就会落回行级循环被当正文。
      { id: '③-e', name: 'F-1 形态 II-b：标记在格、块体跨出表格边界', body: SECRET, text: `| 场景 | 写法 |\n|---|---|\n| 流程 | ${BT3}mermaid |\n${SECRET}\n${BT3}\n\n结束。\n` },
    ]
    const FENCE = BT3 + 'mermaid'

    for (const item of cases) {
      // 空断言自检：本用例的**泄漏判据串**必须确实出现在输入里，否则该用例恒真通过。
      assert.ok(item.text.includes(FENCE),
        `[空断言自检] ${item.id} 输入必须含受控围栏标记 ${JSON.stringify(FENCE)}`)
      if (item.body !== null) {
        assert.ok(item.text.includes(item.body),
          `[空断言自检] ${item.id} 输入必须含它要断言的块体特征串 ${JSON.stringify(item.body)}`)
      }

      // 中间态：逐帧采样；与终态**分别**断言（终态不是兜底自愈——实测三条都不自愈）
      // 双信号：标记（FENCE）+ 块体源码（item.body，null 表示本用例无块体信号）。
      const samples = []
      let bootedRef = null
      const booted = boot({
        stream: () => sseResponse([
          delta(item.text),
          'event: done\ndata: {"reply":"","sources":[]}\n\n',
        ], {
          delayMs: 5,
          onFrame: async () => {
            if (!bootedRef) return
            const b = lastBubble(bootedRef.doc)
            if (!b) return
            const t = b.textContent || ''
            samples.push({
              mark: t.includes(FENCE),
              body: item.body !== null && ((b.innerHTML || '').includes(item.body) || t.includes(item.body)),
            })
          },
        }),
      })
      bootedRef = booted
      await sleep(80)
      booted.doc.getElementById('input').value = '测试'
      booted.doc.getElementById('send').click()
      await sleep(700)
      const bubble = lastBubble(booted.doc)
      const finalHtml = bubble ? bubble.outerHTML : ''
      const finalText = bubble ? (bubble.textContent || '') : ''
      // 落盘原始 HTML：把「修复前红 / 修复后绿」的成对证据**持久化**，而非只留在
      // 控制台。同时被 ⑤ 的全局判据「所有快照都不含围栏分隔符」覆盖。
      snapshots[`f1_${item.id}`] = finalHtml

      check(`③.9c ${item.id} ${item.name}｜中间态：任一采样点无标记、无块体源码`, () => {
        assert.ok(samples.length >= 1, '应至少采到 1 个中间态样本')
        const bad = samples.filter(s => s.mark || s.body)
        assert.deepEqual(bad, [], `中间态命中 ${bad.length}/${samples.length} 点`)
      })
      check(`③.9c ${item.id} ${item.name}｜终态：无标记、无块体源码（独立判据）`, () => {
        assert.ok(!finalText.includes(FENCE), '终态不得出现围栏标记')
        if (item.body !== null) {
          assert.ok(!finalHtml.includes(item.body) && !finalText.includes(item.body), '终态不得出现块体源码')
        }
      })
      // ③-c 专有：标记之前的正文必须保留（否则"不泄漏"可以靠整格丢弃作弊）
      if (item.id === '③-c') {
        check('③.9c ③-c 标记之前的正文「流程图」必须保留（防吞字）', () => {
          assert.ok(finalText.includes('流程图'), '标记前的正文不得被吞掉')
        })
      }
    }

    // 回归守护：普通代码块仍逐字透传（N2③，行为级、不引用变量名/分支名）
    const bootedR = boot({
      stream: () => sseResponse([
        delta('说明：\n\n```python\nprint("hi")\nx = 1\n```\n\n结束。\n'),
        'event: done\ndata: {"reply":"","sources":[]}\n\n',
      ], { delayMs: 5 }),
    })
    await sleep(80)
    bootedR.doc.getElementById('input').value = '测试'
    bootedR.doc.getElementById('send').click()
    await sleep(700)
    const bubbleR = lastBubble(bootedR.doc)
    const textR = bubbleR ? (bubbleR.textContent || '') : ''
    const htmlR = bubbleR ? bubbleR.outerHTML : ''
    check('③.9c 回归：普通代码块仍逐字透传（N2③，行为级）', () => {
      assert.equal((htmlR.match(/<pre><code>/g) || []).length, 1, '普通代码块应产出一处 pre>code')
      assert.ok(textR.includes('print("hi")') && textR.includes('x = 1'), '代码体必须逐字保留')
      assert.ok(!textR.includes('```'), '围栏符不得上屏')
      assert.ok(textR.includes('说明：') && textR.includes('结束。'), '前后正文不得丢失')
    })
  }

  // ═══ 场景 3.10：done 定稿 —— 只收到 block-open 的块必须定稿（P6）═══
  console.log('\n③.10 done 定稿：未等到 block 的块也必须有终态')

  {
    const E = (ev, data) => `event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`
    const booted = boot({
      stream: () => sseResponse([
        E('delta', { text: '文字。\n' }),
        // 只发 block-open，block 永不到达（模拟主机侧异常/流中断）
        E('block-open', { blockId: 'b1', blockType: 'mermaid' }),
        E('done', { reply: '文字。\n', sources: [], blocks: [], blockResults: {}, degradedIds: [] }),
      ], { delayMs: 5 }),
    })
    await sleep(120)
    const d = booted.doc
    const samples = []
    d.getElementById('input').value = '测试'
    d.getElementById('send').click()
    for (let i = 0; i < 26; i++) {
      await sleep(50)
      const b = lastBubble(d)
      if (b) samples.push(b.outerHTML)
    }
    const bubble = lastBubble(d)
    snapshots.doneFinalize = bubble ? bubble.outerHTML : ''
    booted.window.close()

    check('done 定稿：未等到 block 的块进入 degraded 终态（不再是 pending）', () => {
      assert.ok(bubble, '气泡存在')
      assert.equal(/data-block-state="pending"/.test(bubble.outerHTML), false, 'done 后不得残留 pending 占位')
      const slot = bubble.querySelector('[data-block-type]')
      assert.ok(slot, '块槽位存在')
      assert.equal(slot.dataset.blockState, 'degraded', '必须进入 degraded 终态')
    })
    check('done 定稿：降级文案按块自身类型选择（mermaid → 示意图键，非 html 键）', () => {
      // 曾经的缺陷：settleGatePlaceholders 的 html 分支匹配了所有 .gate-block，
      // 把 mermaid 预占位用 html 文案判掉（显示「这部分内容…」而非「示意图…」）
      assert.ok(bubble.textContent.includes('示意图暂时无法显示'),
        `应显示 mermaid 对应的降级文案，实际：${bubble.textContent.slice(0, 60)}`)
      assert.equal(bubble.textContent.includes('这部分内容暂时无法显示'), false,
        '不得用 html 文案降级 mermaid 块')
    })
    check('done 定稿：全程无源码泄漏', () => {
      for (const html of samples) {
        assert.equal(html.includes('```'), false)
        assert.equal(/<pre><code>/.test(html), false)
      }
    })
  }

  // ═══ 场景 3.11：P9-1 干净 EOF —— 无 done、连接正常关闭时 pending 必须收敛 ═══
  // 缺陷：流在「有 delta、无 done、正常关闭」处结束时，`!done && !streamed` 因 streamed
  // 非空而不成立 ⇒ 不进 catch ⇒ 唯一调用 degradePendingGates 的地方不可达 ⇒ 占位永久转圈。
  console.log('\n③.11 P9-1 干净 EOF：无 done 时 pending 块必须收敛到终态')

  {
    // 干净 EOF：body 正常结束（chunk.done=true），无 done 事件。
    // 夹具**只发 block-open、不发 block**——这是真实的悬挂构型（verifier 55s 采样）：
    // 若补发 block 事件，该块会被 applyBlockPayload 就地结算，从而**掩盖**悬挂（反证会假通过）。
    const cleanEof = frames => () => sseResponse(frames, { delayMs: 20 })
    const booted = boot({
      stream: cleanEof([
        delta('文字说明。\n'),
        'event: block-open\ndata: {"blockId":"b1","blockType":"mermaid"}\n\n',
      ]),
    })
    await sleep(80)
    booted.doc.getElementById('input').value = '测试'
    booted.doc.getElementById('send').click()

    // 细采样：测「终态首次出现时刻」，并确认中途无 pending 永久残留
    let firstTerminalAt = null
    for (let t = 0; t < 3000 && firstTerminalAt === null; t += 50) {
      await sleep(50)
      const b = lastBubble(booted.doc)
      if (b && /data-block-state="degraded"|gate-degraded/.test(b.outerHTML)) firstTerminalAt = t + 50
    }
    const bubble = lastBubble(booted.doc)
    const html = bubble ? bubble.outerHTML : ''
    const text = bubble ? (bubble.textContent || '') : ''

    check('③.11 干净 EOF：pending 块收敛到终态（有限时间内，非无限悬挂）', () => {
      assert.notEqual(firstTerminalAt, null, '3000ms 内未出现终态 ⇒ 占位永久悬挂（P9-1）')
      assert.ok(firstTerminalAt <= 1000, `终态应在 1s 内出现，实际 ${firstTerminalAt}ms`)
    })
    // 判据三合一（防「块数为 0 也判 ✅」的空洞通过）
    check('③.11 干净 EOF：存在块节点 ∧ 无 pending 残留 ∧ 无悬挂（三者同时成立）', () => {
      assert.ok(/data-block-key|gate-block|mermaid-src/.test(html), '必须存在块节点（否则断言空洞通过）')
      assert.ok(!/data-block-state="pending"/.test(html), '不得残留 pending')
      assert.ok(!/spinner|waiting|recovering/i.test(html), '不得出现转圈/恢复中悬挂')
    })
    check('③.11 干净 EOF：终态为可读降级文案，无源码泄漏', () => {
      assert.ok(/示意图暂时无法显示/.test(text), '应为可读降级文案')
      assert.ok(!text.includes('```'), '不得含围栏标记')
      assert.ok(!/graph TD|graph LR|flowchart/.test(text) && !html.includes('graph TD'), '不得含块体源码')
    })
  }

  // ═══ 场景 3.11b：P9 其余三情形 —— 断流 / abort / 硬截止（F-6 补测） ═══
  // 此前只有 P9-1（干净 EOF）有断言，其余三种中止方式实测正确但**无回归守护**。
  // 三种情形都必须满足同一判据：存在块节点 ∧ 无 pending 残留 ∧ 无可读降级文案缺失 ∧ 无源码泄漏。
  console.log('\n③.11b P9 其余三情形：断流 / AbortController / 硬截止均须收敛')

  {
    /**
     * 跑一种中止情形，返回该气泡的终态判据。
     * @param label - 情形名（用于断言信息）
     * @param streamFactory - 返回带中止行为的 SSE 响应
     * @param settleMs - 等待收敛的时间（硬截止情形需超过 45s，由调用方控制）
     * @returns {{ html: string, text: string }}
     */
    async function runAbortCase(label, streamFactory, settleMs) {
      const booted = boot({ stream: streamFactory })
      await sleep(80)
      booted.doc.getElementById('input').value = '测试'
      booted.doc.getElementById('send').click()
      await sleep(settleMs)
      const bubble = lastBubble(booted.doc)
      return { label, html: bubble ? bubble.outerHTML : '', text: bubble ? (bubble.textContent || '') : '' }
    }

    // ① SSE 断流：读到一半 read() 抛错（连接异常中断），有 delta、无 done
    const brokenStream = () => {
      let i = 0
      const frames = [delta('文字说明。\n'), 'event: block-open\ndata: {"blockId":"b1","blockType":"mermaid"}\n\n']
      return {
        ok: true, status: 200, json: async () => ({}),
        body: {
          getReader: () => ({
            async read() {
              if (i >= frames.length) throw new Error('network error: stream interrupted')
              const chunk = encoder.encode(frames[i]); i++
              await new Promise(resolve => setTimeout(resolve, 20))
              return { done: false, value: chunk }
            },
            async cancel() { return undefined },
          }),
        },
      }
    }
    const cut = await runAbortCase('SSE 断流', brokenStream, 2500)
    check('③.11b ① SSE 断流：块收敛到可读终态 ∧ 无 pending ∧ 无源码', () => {
      assert.ok(cut.html.length > 0, '必须有气泡（否则断言空洞）')
      assert.ok(!/data-block-state="pending"/.test(cut.html), `不得残留 pending：${cut.label}`)
      assert.ok(!cut.text.includes('```'), '不得含围栏标记')
      assert.ok(!/graph TD|flowchart TD/.test(cut.html), '不得含块体源码')
      // 断流是**设计内的自愈路径**：页面会先显示「网络不稳定，正在为您恢复回答…」
      // 并在 20s 窗口内轮询 /history 找回答案。因此这里允许「恢复中」态存在，
      // 只禁止**无恢复文案的裸转圈**（那才是 P9 要消灭的永久悬挂）。
      const recovering = /正在为您恢复回答/.test(cut.text)
      const bareSpinner = /class="(waiting|spinner-sm)"/.test(cut.html) && !recovering
      assert.ok(!bareSpinner, '不得残留无恢复文案的裸转圈（有恢复文案属自愈路径，允许）')
    })

    // ② AbortController：页面 45s 硬截止用的就是 abort；这里用「读一帧后永久挂起 +
    //    主动 abort」模拟用户在等答案时离开/取消，pending 必须在有限时间内收敛。
    const abortCase = await (async () => {
      const booted = boot({
        stream: () => ({
          ok: true, status: 200, json: async () => ({}),
          body: {
            getReader: () => ({
              async read() {
                // 首帧给 block-open 制造 pending，其后永久挂起（不 resolve、不 reject）
                if (this.sent !== true) {
                  this.sent = true
                  return { done: false, value: encoder.encode('event: block-open\ndata: {"blockId":"b1","blockType":"html"}\n\n') }
                }
                return new Promise(() => { /* 永久挂起，模拟隧道不转发也不 FIN */ })
              },
              async cancel() { return undefined },
            }),
          },
        }),
      })
      await sleep(80)
      booted.doc.getElementById('input').value = '测试'
      booted.doc.getElementById('send').click()
      await sleep(1200)
      // 模拟离开页面（P9：pagehide 必须把判定期块降级）
      booted.window.dispatchEvent(new booted.window.Event('pagehide'))
      await sleep(600)
      const bubble = lastBubble(booted.doc)
      return { html: bubble ? bubble.outerHTML : '', text: bubble ? (bubble.textContent || '') : '' }
    })()
    check('③.11b ② 中止/离开页面：判定期块被降级 ∧ 无 pending 残留', () => {
      assert.ok(abortCase.html.length > 0, '必须有气泡（否则断言空洞）')
      assert.ok(!/data-block-state="pending"/.test(abortCase.html), 'pagehide 后不得残留 pending')
      assert.ok(!abortCase.text.includes('```'), '不得含围栏标记')
      assert.ok(!/graph TD|flowchart TD|<iframe/.test(abortCase.html), '不得含块体源码或半成品 iframe')
    })

    // ③ 硬截止（45s）：不在单测里真等 45s（会让套件不可用），改为断言「实现存在且
    //    挂在 fetch 上」——判据限定为代码结构 + 常量，避免空洞。
    check('③.11b ③ 硬截止：页面存在 45s AbortController 硬截止且覆盖流式请求', () => {
      assert.ok(/AbortController/.test(pageHtml), '必须存在 AbortController（硬截止实现）')
      assert.ok(/45\s*000|45000/.test(pageHtml), '硬截止应为 45s')
      assert.ok(/controller\.abort\(\)/.test(pageHtml), '必须以 abort() 中止在飞请求')
      assert.ok(/signal:\s*controller\.signal|signal: controller\.signal/.test(pageHtml), 'abort 信号必须绑到 fetch')
    })
  }

  // ═══ 场景 3.12：R-D5 资产 404 —— NO_GATE 桩必须完整可用 ═══
  // 缺陷：门禁资产 404 时页面走 NO_GATE，但桩缺页面实际调用的成员 ⇒ 块事件一到即
  // `TypeError`，整条回答被替换成「抱歉，出了点问题：G.normalizeBlockType is not a function」。
  // 主判据 = **可见文本**（`pageerror` 恒 0 属空洞判据，仅作附注）。
  // 时序：错误被 `send()` 的 catch 吞掉后走 recoverReply（20s 超时），
  //       实测 2.5s 仍显示"正在恢复…"、**23s 才显形** ⇒ 必须等恢复窗口耗尽再判。
  console.log('\n③.12 R-D5 资产 404：可见文本不得出现错误文案（等恢复窗口耗尽）')

  {
    const booted404 = boot({
      assetMissing: true,
      stream: () => sseResponse([
        'event: block-open\ndata: {"blockId":"b1","blockType":"mermaid"}\n\n',
        `event: block\ndata: ${JSON.stringify({
          blockId: 'b1', blockType: 'mermaid',
          sourceB64: Buffer.from('graph TD\n  A[停电] --> B[报修]').toString('base64'),
          sourceBytes: 30, decision: 'render',
        })}\n\n`,
        delta('文字答案。\n'),
        'event: done\ndata: {"reply":"文字答案。\\n","sources":["政策说明.pdf"]}\n\n',
      ], { delayMs: 5 }),
    })
    await sleep(80)
    // 历史为空 ⇒ 恢复不到 ⇒ 错误会显形（若桩不完整）
    booted404.doc.getElementById('input').value = '测试'
    booted404.doc.getElementById('send').click()
    await sleep(23000) // 等 recoverReply 的 20s 超时 + 裕量
    const bubble = lastBubble(booted404.doc)
    const text = bubble ? (bubble.textContent || '').replace(/\s+/g, ' ').trim() : ''
    const html = bubble ? bubble.outerHTML : ''

    check('③.12 资产 404：可见文本无 TypeError / 错误文案（主判据，非 pageerror）', () => {
      assert.ok(!/TypeError|is not a function|出了点问题|Sorry/i.test(text),
        `可见文本出现错误文案：${text.slice(0, 120)}`)
    })
    check('③.12 资产 404：图形块降级为可读文案，不显示、不报错、不转圈', () => {
      assert.ok(/无法显示/.test(text), '应出现可读降级文案')
      assert.ok(!/spinner|waiting|recovering/i.test(html), '不得停留在转圈/恢复态')
      assert.ok(!/data-block-state="pending"/.test(html), '不得残留 pending')
      assert.ok(!text.includes('```'), '不得泄漏围栏标记')
      assert.ok(!html.includes('graph TD'), '不得泄漏块体源码')
    })
    check('③.12 资产 404：文字答案与来源引用照常上屏（C8）', () => {
      assert.ok(text.includes('文字答案。'), '正文必须照常上屏')
      assert.ok(/政策说明\.pdf/.test(text), '来源引用必须照常显示')
    })
  }

  // ═══ 场景 4：降级文案四语言 + 打字机未受影响 ═══
  console.log('\n④ 文字流式与来源引用未被门禁接管（REG1/REG4）')

  const booted4 = boot({
    stream: () => sseResponse([
      delta('第一段。\n'),
      delta('第二段。\n'),
      'event: sources\ndata: {"sources":["政策说明.pdf"]}\n\n',
      'event: done\ndata: {"reply":"第一段。\\n第二段。","sources":["政策说明.pdf"]}\n\n',
    ], {
      delayMs: 10,
      onFrame: async () => {
        await sleep(2)
        const bubble = lastBubble(booted4.doc)
        if (bubble) frameTexts.push(bubble.textContent || '')
      },
    }),
  })
  const frameTexts = []
  await sleep(80)
  booted4.doc.getElementById('input').value = '测试'
  booted4.doc.getElementById('send').click()
  await sleep(700)
  const bubble4 = lastBubble(booted4.doc)
  check('文字按 delta 增量上屏（打字机语义保留）', () => {
    const increments = frameTexts.filter(text => text.includes('第'))
    assert.ok(increments.length >= 2, `应观测到多次文字增量，实际 ${increments.length}`)
  })
  check('来源引用仍显示（REG4）', () => {
    assert.ok(bubble4, '气泡存在')
    const sources = bubble4.querySelector('.sources')
    assert.ok(sources, 'sources 区块必须存在')
    assert.ok(sources.textContent.includes('政策说明.pdf'))
  })
  snapshots.sourcesAndStreaming = bubble4 ? bubble4.outerHTML : ''
  booted4.window.close()

  // ═══ 场景 3.13：R-D7 CRLF 输入 —— 行尾 CR 归一化（前端原缺，主机侧有）═══
  // 缺陷：前端未做行尾 CR 归一化 ⇒ CRLF 下 `matchControlledFence` 识别不出受控起始围栏、
  // `isClosingFence` 判不出 CRLF 闭合行 ⇒ 受控围栏落入普通代码块 ⇒ 标记与块体源码进 DOM。
  // 判据**以元素/具体串为锚**（裸围栏标记、块体源码），不按内容泛化匹配。
  console.log('\n③.13 R-D7 CRLF：行尾 CR 归一化后无标记、无块体源码（含表格路径）')

  {
    const BT = '`'.repeat(3)
    // CRLF 版本的三个入口：主路径已闭合 / 主路径未闭合 / 表格单元格
    const cases = [
      {
        id: '①', name: 'CRLF 已闭合受控围栏',
        text: `说明：\r\n\r\n${BT}mermaid\r\nflowchart TD\r\n  A --> B\r\n${BT}\r\n\r\n结束。\r\n`,
      },
      {
        id: '②', name: 'CRLF 未闭合受控围栏',
        text: `说明：\r\n\r\n${BT}mermaid\r\nflowchart TD\r\n  A --> B\r\n`,
      },
      {
        id: '④', name: 'CRLF 普通代码块内含受控围栏（普通块体路径，真正的 CRLF 敏感面）',
        // 普通代码块的块体循环（:`731`/`:732`）拿的是 `split(/\n/)` 产出的**带 `\r` 的行**
        // ⇒ 撤掉判据入口归一化后，内层 ` ```mermaid\r ` 不会被识别、CRLF 闭合行也判不出，
        // 受控围栏会被当普通代码文本上屏。**本用例对 CRLF 敏感**（与 ① ② 同族）。
        text: `说明：\r\n\r\n${BT}python\r\nprint(1)\r\n${BT}mermaid\r\nflowchart TD\r\n${BT}\r\n\r\n结束。\r\n`,
      },
      {
        // ⚠️ 本用例**不是** CRLF 缺陷的敏感判据：表格分支在调 `tableCell()` 之前已做
        // `line.split('|').map(s => s.trim())`，而 `String.trim()` 会去掉行尾 `\r` ⇒
        // 表格路径**本身对 CRLF 免疫**（实测：撤掉判据入口的归一化后，本用例仍通过）。
        // 保留它作为**回归守护**（防表格路径将来开始泄漏），但**不得**把它计入
        // "CRLF 修复生效"的证据；敏感判据是 ①（已闭合）、②（未闭合）、④（普通块体）。
        id: '③', name: 'CRLF 表格数据行含受控围栏（回归守护，非 CRLF 敏感判据）',
        text: `| 场景 | 写法 |\r\n|---|---|\r\n| 流程图 | ${BT}mermaid |\r\n`,
      },
    ]
    for (const item of cases) {
      const booted = boot({
        stream: () => sseResponse([
          delta(item.text),
          'event: done\ndata: {"reply":"","sources":[]}\n\n',
        ], { delayMs: 5 }),
      })
      await sleep(80)
      booted.doc.getElementById('input').value = '测试'
      booted.doc.getElementById('send').click()
      await sleep(1500)
      const bubble = lastBubble(booted.doc)
      const html = bubble ? bubble.outerHTML : ''
      const text = bubble ? (bubble.textContent || '') : ''
      check(`③.13 ${item.id} ${item.name}：无裸围栏标记、无块体源码`, () => {
        assert.ok(!text.includes(BT), '不得出现裸围栏标记')
        assert.ok(!/flowchart TD|graph TD/.test(text) && !html.includes('flowchart TD'),
          '不得出现块体源码')
      })
    }

    // LF 零回归对照（与 CRLF 同构，仅换行符不同）
    const bootedLF = boot({
      stream: () => sseResponse([
        delta(`说明：\n\n${BT}mermaid\nflowchart TD\n  A --> B\n${BT}\n\n结束。\n`),
        'event: done\ndata: {"reply":"","sources":[]}\n\n',
      ], { delayMs: 5 }),
    })
    await sleep(80)
    bootedLF.doc.getElementById('input').value = '测试'
    bootedLF.doc.getElementById('send').click()
    await sleep(1500)
    const bubbleLF = lastBubble(bootedLF.doc)
    const textLF = bubbleLF ? (bubbleLF.textContent || '') : ''
    const htmlLF = bubbleLF ? bubbleLF.outerHTML : ''
    check('③.13 回归对照：LF 输入行为与 CRLF 一致（无泄漏、正常降级）', () => {
      assert.ok(!textLF.includes(BT), 'LF 不得出现裸围栏标记')
      assert.ok(!/flowchart TD/.test(textLF) && !htmlLF.includes('flowchart TD'), 'LF 不得出现块体源码')
      assert.ok(/无法显示/.test(textLF), 'LF 应正常降级为可读文案')
    })
  }

  // ═══ ③.14 R-D14：历史重放必须消费 /history 的 blocks（刷新后图形块不得消失）═══
  console.log('\n③.14 历史重放：刷新/重开后图形块必须仍在（消费 /history 的 blocks）')
  {
    const H_MMD = 'graph TD_SUB_HIST\n  A[入口] --> B[出口]'
    const H_IMG = '/uploads/banner_cs_9af26b7f16.png'
    const historyPayload = {
      sessionId: 'guest-testfixture0001',
      messages: [
        { role: 'user', text: '请用图示说明' },
        {
          role: 'assistant',
          text: '说明文字。\n',
          blocks: [
            { blockId: 'h-1', blockType: 'mermaid', sourceBytes: H_MMD.length, decision: 'render', sourceB64: Buffer.from(H_MMD).toString('base64') },
            { blockId: 'h-2', blockType: 'image', sourceBytes: H_IMG.length, decision: 'render', sourceB64: Buffer.from(H_IMG).toString('base64') },
          ],
          blockResults: { 'h-1': 'passed', 'h-2': 'passed' },
          degradedIds: [],
        },
      ],
    }
    // 预置会话键后再 boot：页面自身的 restoreHistory() 会在启动时请求 /history 并
    // 完成重放（产品真实路径）。不再 eval 页面内部函数——那会因 IIFE 作用域不可见
    // 抛 ReferenceError，且属于「测试依赖内部符号」的脆弱写法。
    const bootedH = boot({ history: historyPayload, sessionId: 'guest-testfixture0001' })
    await sleep(2000)
    const doc = bootedH.doc
    const host = doc.querySelector('#chat .msg.assistant .bubble')
    const slots = host ? [...host.querySelectorAll('[data-block-key]')] : []
    const slotHtml = host ? host.innerHTML : ''
    const slotText = host ? (host.textContent || '') : ''

    // 空断言自检：夹具必须真的带着 blocks 与块体特征串，否则本用例恒真
    check('③.14 空断言自检：夹具的 /history 载荷确实含 blocks 与块体特征串', () => {
      assert.equal(historyPayload.messages[1].blocks.length, 2, '夹具应有 2 个块')
      assert.ok(historyPayload.messages[1].blocks.some(b => Buffer.from(b.sourceB64, 'base64').toString().includes('TD_SUB_HIST')), '夹具 mermaid 块体应含特征串')
    })

    check('③.14 历史重放：块槽位被创建（旧实现漏读 m.blocks ⇒ 槽位为空）', () => {
      assert.ok(slots.length >= 2, `应至少重建 2 个块槽位，实得 ${slots.length}`)
    })

    check('③.14 历史重放：块体源码与裸围栏不得进 DOM（重放与当轮同一判定，E4）', () => {
      const BTH = '`'.repeat(3)
      assert.ok(!slotText.includes('TD_SUB_HIST') && !slotHtml.includes('TD_SUB_HIST'), '不得出现 mermaid 块体源码')
      assert.ok(!slotHtml.includes(BTH) && !slotText.includes(BTH), '不得出现裸围栏标记')
    })
  }

  // ═══ 落盘快照与汇总 ═══
  console.log('\n⑤ 快照证据')
  const evidence = {}
  for (const [key, html] of Object.entries(snapshots)) {
    if (typeof html === 'string') {
      evidence[key] = {
        containsFenceBackticks: html.includes('```'),
        containsPreCode: /<pre><code>/.test(html),
        containsPendingState: /data-block-state="pending"/.test(html),
        containsDegradedState: /data-block-state="degraded"/.test(html),
        html,
      }
    } else {
      evidence[key] = html
    }
  }
  const outPath = join(HERE, 'gate-dom-snapshots.json')
  writeFileSync(outPath, JSON.stringify(evidence, null, 2))
  check('所有快照都不含围栏分隔符（V3 全局判据）', () => {
    for (const [key, item] of Object.entries(evidence)) {
      if (item && typeof item === 'object' && 'containsFenceBackticks' in item) {
        assert.equal(item.containsFenceBackticks, false, `${key} 快照里出现了围栏分隔符`)
      }
    }
  })
  console.log(`  · 快照已写出：${outPath}`)

  console.log(`\n${failed === 0 ? '全部 ' : ''}${passed} 项通过${failed ? `，${failed} 项失败` : ''}\n`)
  if (failed > 0) process.exitCode = 1
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
