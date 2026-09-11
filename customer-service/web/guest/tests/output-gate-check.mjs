/**
 * 访客前端「输出前自我审核」门禁的单测（AS-10）。
 *
 * 纯 Node + node:assert，失败非零退出：
 *
 *     node customer-service/web/guest/tests/output-gate-check.mjs
 *
 * 覆盖四组判据：
 *   ① 纯逻辑砖块的决策正确性（状态机、图片白名单、几何/naturalWidth 判据、回传载荷）；
 *   ② 页面组合层对四条源码回退路径的消除（源码级断言：index.html 里再没有把块体
 *      塞进 `pre > code` 的路径，且门禁入口被正确接线）；
 *   ③ i18n 五个键在四语言字典里齐备且可读（D3/D1）；
 *   ④ 资产加载形态（浏览器 `<script>` 与 Node `import` 是同一组函数）。
 */

import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const PAGE = join(HERE, '..', 'index.html')
const MODULE_PATH = join(HERE, '..', 'assets', 'output-gate.js')
const GUEST = join(HERE, '..')

const page = readFileSync(PAGE, 'utf8')
const gate = await import(MODULE_PATH)

let passed = 0
/** 跑一个用例：失败即抛出，由文件末尾统一汇总（非零退出）。 */
function check(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (error) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${error && error.message}`)
    throw error
  }
}

// ── ① 导出形态（页面与 Node 共用同一份代码）─────────────────────────────────

console.log('\n导出形态')
check('planBlocks / checkRendered / buildReport 都是函数（verify 脚本同款断言）', () => {
  for (const fn of ['planBlocks', 'checkRendered', 'buildReport']) {
    assert.equal(typeof gate[fn], 'function', `missing export: ${fn}`)
  }
})
check('状态机六态齐备且 passed/degraded 为终态', () => {
  assert.deepEqual(Object.values(gate.GATE_STATES).sort(),
    ['absent', 'degraded', 'loading', 'passed', 'pending', 'validating'])
  assert.deepEqual(gate.TERMINAL_STATES, ['passed', 'degraded'])
})
check('降级原因枚举与 O2 冻结清单逐字一致', () => {
  assert.deepEqual(Object.values(gate.GATE_REASONS).sort(), [
    'chart-invalid', 'html-invalid', 'image-decode-failed', 'image-path-invalid',
    'image-unreachable', 'library-unavailable', 'parse-error', 'render-empty', 'timeout',
  ])
})
check('assets/package.json 的 CJS 标记在位 —— 具名导出的前提（不是冗余文件）', () => {
  // 仓库根 package.json 是 "type":"module"，若 assets/ 下没有 {"type":"commonjs"} 标记，
  // Node 会把这个文件当 ESM 解析，module.exports 分支永不执行，契约要求的
  // planBlocks/checkRendered/buildReport 具名导出就会全部丢失（实测可复现）。
  const marker = JSON.parse(readFileSync(join(GUEST, 'assets', 'package.json'), 'utf8'))
  assert.equal(marker.type, 'commonjs', 'assets/package.json 必须是 CJS 标记')
  const rootType = JSON.parse(readFileSync(join(GUEST, '..', '..', '..', 'package.json'), 'utf8')).type
  assert.equal(rootType, 'module', '本断言成立的前提：仓库根是 ESM')
})

check('门禁资产可被静态服务器读取（权限位不是 0600）', () => {
  // web/guest 是 nginx 只读挂载，由非 root 的 nginx 进程读取。文件若以 0600 落盘，
  // 访客侧 /assets/output-gate.js 会 403，页面拿不到门禁模块（实测可复现）。
  const mode = statSync(MODULE_PATH).mode & 0o777
  assert.ok((mode & 0o044) !== 0, `门禁资产必须组/其他可读，实际 ${mode.toString(8)}`)
  const pageMode = statSync(PAGE).mode & 0o777
  assert.ok((pageMode & 0o044) !== 0, `index.html 必须组/其他可读，实际 ${pageMode.toString(8)}`)
})

check('模块不触碰 DOM（纯逻辑砖块可被 Node import）', () => {
  const source = readFileSync(MODULE_PATH, 'utf8')
  for (const banned of ['document.', 'window.addEventListener', 'localStorage.', 'querySelector']) {
    assert.ok(!source.includes(banned), `纯逻辑模块不得出现 ${banned}`)
  }
  // 唯一允许的 window 用法：浏览器 <script> 加载时挂全局
  assert.ok(source.includes('window.DshOutputGate = api'))
})

// ── ② 块裁决与状态机（P3/P4/P7/C8）──────────────────────────────────────────

console.log('\n块裁决与状态机')
check('planBlocks 只放行通过判定的块，缺字段/未知类型一律降级（C8 安全降级）', () => {
  const plan = gate.planBlocks({
    blocks: [
      { blockId: 'b1', blockType: 'mermaid', source: 'flowchart TD\nA' },
      { blockId: 'b2', blockType: 'img', source: '/uploads/x.png' },
      { blockId: 'b3', blockType: 'canvas', source: 'x' },
      { blockId: '', blockType: 'chart', source: '[]' },
    ],
    blockResults: { b1: 'degraded' },
    degradedIds: ['b9'],
  })
  assert.deepEqual(plan.blocks.map(b => b.blockId), ['b2'])
  assert.equal(plan.blocks[0].blockType, 'image')
  assert.deepEqual(plan.degradedIds, ['b9', 'b1', 'b3'])
})
check('planBlocks 面对空载荷/服务端裁决不可得时返回空队列（不渲染未校验块）', () => {
  assert.deepEqual(gate.planBlocks(undefined), { blocks: [], degradedIds: [] })
  assert.deepEqual(gate.planBlocks({}), { blocks: [], degradedIds: [] })
  assert.deepEqual(gate.planBlocks({ blocks: 'nope' }).blocks, [])
})

// ── ③ 图片地址白名单（IMG1/IMG2/IMG3/IMG5）──────────────────────────────────

console.log('\n图片地址白名单')
check('合法站点相对路径通过（KB 实测样例）', () => {
  for (const ok of ['/uploads/banner_cs_9af26b7f16.png', '/uploads/Cover_2023_ccb9475205.jpg',
    '/uploads/_6a4f894bad.svg', '/uploads/a.JPEG', '/uploads/a.webp', '/uploads/a.avif', '/uploads/a.bmp']) {
    assert.equal(gate.checkImagePath(ok).ok, true, `应通过：${ok}`)
  }
})
check('目录穿越/编码绕过/查询串/外部主机/协议相对/data: 全部拒绝（IMG1/IMG8）', () => {
  const bad = [
    '/uploads/../api/guest/health', '/uploads/%2e%2e/x.png', '/uploads/a.png?x=1',
    '/uploads/a.png#frag', 'http://evil.test/uploads/a.png',
    'https://evil.example.com/track.png', 'https://evil.example.com/x.svg',
    'data:image/png;base64,AAAA', 'data:image/svg+xml;base64,AAAA',
    '/uploads/sub/a.png', '/uploads//a.png', '//evil.example.com/x.png',
    '/uploads/a.txt', '/uploads/a.pdf', '/uploads/a.zip', '/uploads/a.docx', '/uploads/.png',
    '/uploads/a.png ', ' /uploads/a.png', '/uploads/a%20b.png', '', '/uploads/',
  ]
  for (const src of bad) {
    assert.equal(gate.checkImagePath(src).ok, false, `应拒绝：${JSON.stringify(src)}`)
    assert.equal(gate.checkImagePath(src).reason, 'image-path-invalid')
  }
  assert.equal(gate.checkImagePath(null).ok, false, '非字符串同样拒绝')
})
check('非法地址拿不到 src —— 调用方无法发起请求（IMG2）', () => {
  assert.equal(gate.toImageSrc('/uploads/../api/guest/health', ''), null)
  assert.equal(gate.toImageSrc('data:image/png;base64,AAAA', '/guest'), null)
  assert.equal(gate.toImageSrc('https://evil.test/x.png', ''), null)
})
check('自家源站绝对 URL 归一化后通过，其余主机一律拒绝（IMG6）', () => {
  // KB 实测 4 条该形态引用（car-model.md / ev-tip.md）：允许，但先归一化再判定
  assert.deepEqual(gate.checkImagePath('https://www.cem-macau.com/uploads/a.png'),
    { ok: true, path: '/uploads/a.png', reason: null })
  assert.deepEqual(gate.checkImagePath('https://cem-macau.com/uploads/a.png'),
    { ok: true, path: '/uploads/a.png', reason: null })
  assert.equal(gate.normalizeOwnUploadUrl('https://www.cem-macau.com/uploads/a.png'), '/uploads/a.png')
  // 归一化之后仍走完整 IMG1 判定：自家主机也不能带查询串/穿越
  assert.equal(gate.checkImagePath('https://www.cem-macau.com/uploads/a.png?x=1').ok, false)
  assert.equal(gate.checkImagePath('https://www.cem-macau.com/uploads/../api/guest/health').ok, false)
  // 不做后缀匹配：长得像自家但主机不同的一律拒绝
  for (const hostile of [
    'https://evil.example.com/uploads/a.png',
    'https://www.cem-macau.com.evil.test/uploads/a.png',
    'https://evil-cem-macau.com/uploads/a.png',
    '//www.cem-macau.com/uploads/a.png',
  ]) {
    assert.equal(gate.checkImagePath(hostile).ok, false, `应拒绝：${hostile}`)
  }
  // 归一化函数对非自家输入原样返回（不假装归一化过）
  assert.equal(gate.normalizeOwnUploadUrl('https://evil.test/uploads/a.png'), 'https://evil.test/uploads/a.png')
  assert.deepEqual([...gate.OWN_HOSTS], ['www.cem-macau.com', 'cem-macau.com'])
})

check('同源化：合法路径只在站点前缀下拼装，绝不指向外部主机（IMG3）', () => {
  assert.equal(gate.toImageSrc('/uploads/a.png', ''), '/uploads/a.png')
  assert.equal(gate.toImageSrc('/uploads/a.png', '/guest'), '/guest/uploads/a.png')
  assert.equal(gate.toImageSrc('/uploads/a.png', '/guest/'), '/guest/uploads/a.png')
})

// ── ④ 渲染后实测判据（C1–C4）───────────────────────────────────────────────

console.log('\n渲染后实测判据')
check('naturalWidth 判据：decode 失败 / 零尺寸 / 缺失一律降级（C4）', () => {
  assert.equal(gate.checkRendered('image', { naturalWidth: 0, naturalHeight: 0 }, {}).ok, false)
  assert.equal(gate.checkRendered('image', { naturalWidth: 0, naturalHeight: 0 }, {}).reason, 'image-decode-failed')
  assert.equal(gate.checkRendered('image', { naturalWidth: 800, naturalHeight: 0 }, {}).ok, false)
  assert.equal(gate.checkRendered('image', { decodeFailed: true, naturalWidth: 800, naturalHeight: 600 }, {}).ok, false)
  assert.equal(gate.checkRendered('image', {}, {}).ok, false)
  assert.equal(gate.checkRendered('image', { naturalWidth: 1200, naturalHeight: 630 }, {}).ok, true)
})
check('布局尺寸不得作为图片判据（硬编码 1000×560 恒有效）', () => {
  // 只给布局尺寸（无自然尺寸）时判据必须失败——旧实现正是拿布局尺寸当"有效"
  const layoutOnly = { width: 1000, height: 560, bboxWidth: 1000, bboxHeight: 560 }
  assert.equal(gate.checkRendered('image', layoutOnly, {}).ok, false)
  assert.equal(gate.checkImageMetrics(layoutOnly).ok, false)
})
check('mermaid 几何判据：空图/无尺寸/异常宽高比降级（C1/C5）', () => {
  assert.equal(gate.checkRendered('mermaid', { childNodeCount: 0, width: 100, height: 100 }, {}).reason, 'render-empty')
  assert.equal(gate.checkRendered('mermaid', { childNodeCount: 3 }, {}).reason, 'render-empty')
  assert.equal(gate.checkRendered('mermaid', { childNodeCount: 3, viewBox: '0 0 0 0', width: 0, height: 0 }, {}).reason, 'render-empty')
  assert.equal(gate.checkRendered('mermaid', { childNodeCount: 3, width: 4000, height: 4 }, {}).ok, false, '极扁图形判失败')
  assert.equal(gate.checkRendered('mermaid', { childNodeCount: 5, viewBox: '0 0 320 180' }, {}).ok, true)
  assert.equal(gate.checkRendered('mermaid', { childNodeCount: 5, bboxWidth: 320, bboxHeight: 180 }, {}).ok, true)
})
check('chart 判据：非数组/畸形 JSON/NaN/负值/空数组/缺标签降级（C2）', () => {
  for (const bad of ['{}', 'not json', '[]', '[{"label":"A","value":null}]', '[{"label":"A","value":NaN}]',
    '[{"label":"A","value":-1}]', '[{"label":"  ","value":1}]', '[{"value":1}]', '[1,2]', '']) {
    assert.equal(gate.checkChartData(bad).ok, false, `应降级：${bad}`)
    assert.equal(gate.checkChartData(bad).reason, 'chart-invalid')
  }
  const good = gate.checkChartData('[{"label":"A","value":3},{"name":"B","count":1}]')
  assert.equal(good.ok, true)
  assert.deepEqual(good.rows, [{ label: 'A', value: 3 }, { label: 'B', value: 1 }])
})
check('chart 判据拒绝 Infinity 与字符串数值', () => {
  assert.equal(gate.checkChartData('[{"label":"A","value":1e999}]').ok, false)
  assert.equal(gate.checkChartData('[{"label":"A","value":"3"}]').ok, false)
})
check('html 判据：空白块与超字节上限降级（C3）', () => {
  assert.equal(gate.checkRendered('html', null, { source: '   ' }).reason, 'html-invalid')
  assert.equal(gate.checkRendered('html', null, { source: '<p>x</p>', maxBytes: 4 }).reason, 'html-invalid')
  assert.equal(gate.checkRendered('html', null, { source: '<p>x</p>', maxBytes: 32768 }).ok, true)
  const wide = '汉'.repeat(3)
  assert.equal(gate.byteLength(wide), 9, '按 UTF-8 计字节数')
})
check('未知块类型不渲染（不猜、不放行）', () => {
  assert.equal(gate.checkRendered('canvas', { childNodeCount: 5 }, {}).ok, false)
  assert.equal(gate.normalizeBlockType('canvas'), null)
  assert.equal(gate.normalizeBlockType('img'), 'image')
})

// ── ⑤ 回传载荷（O2/O3）─────────────────────────────────────────────────────

console.log('\n回传载荷与幂等')
check('buildReport 只带 O2 字段，且**不含源码**', () => {
  const report = gate.buildReport({
    sessionId: 'guest-abc', blockId: 'b1', blockType: 'image',
    reason: 'image-decode-failed', source: '/uploads/dead.png', outcome: 'degraded', occurredAt: 1234,
  })
  assert.deepEqual(Object.keys(report).sort(),
    ['blockId', 'blockType', 'occurredAt', 'outcome', 'reason', 'sessionId', 'sourceBytes', 'sourceDigest'])
  assert.equal(JSON.stringify(report).includes('/uploads'), false, '载荷不得含源码/路径')
  assert.equal(report.sourceDigest.length, 16, 'O2 要求 16 位摘要')
  assert.equal(report.sourceBytes, 17, "/uploads/dead.png 的 UTF-8 字节数")
  assert.equal(report.occurredAt, 1234)
})
check('buildReport 拒绝枚举外原因与缺字段（服务端只收白名单）', () => {
  assert.equal(gate.buildReport({ blockId: 'b', blockType: 'image', reason: 'render-overflow' }), null)
  assert.equal(gate.buildReport({ blockId: '', blockType: 'image', reason: 'timeout' }), null)
  assert.equal(gate.buildReport({ blockId: 'b', blockType: 'canvas', reason: 'timeout' }), null)
  assert.equal(gate.buildReport({ blockId: 'b', blockType: 'image', reason: '' }), null)
})
check('sourceDigest 可复算（同一源码同一摘要）', () => {
  assert.equal(gate.shortDigest('flowchart TD'), gate.shortDigest('flowchart TD'))
  assert.notEqual(gate.shortDigest('flowchart TD'), gate.shortDigest('flowchart LR'))
  assert.equal(gate.shortDigest(''), '811c9dc501000193')
})
check('幂等去重：同一 (blockId, digest) 只放行一次（O3）', () => {
  const deduper = gate.createReportDeduper()
  assert.equal(deduper.shouldSend('b1', 'abc'), true)
  assert.equal(deduper.shouldSend('b1', 'abc'), false, '重复回传必须被吞掉')
  assert.equal(deduper.shouldSend('b1', 'def'), true, '不同源码是新事件')
  assert.equal(deduper.shouldSend('b2', 'abc'), true, '不同块是新事件')
  deduper.reset()
  assert.equal(deduper.shouldSend('b1', 'abc'), true, '新一轮回答重新计数')
})

// ── ⑥ 文案映射与四语言字典（D1/D3）─────────────────────────────────────────

console.log('\n降级文案与 i18n')
check('状态 → 文案键的映射符合 D3 清单', () => {
  assert.equal(gate.textKeyFor('pending', 'mermaid'), 'gatePreparing')
  assert.equal(gate.textKeyFor('loading', 'image'), 'gatePreparing')
  assert.equal(gate.textKeyFor('validating', 'html'), 'gatePreparing')
  assert.equal(gate.textKeyFor('degraded', 'mermaid'), 'gateDiagramUnavailable')
  assert.equal(gate.textKeyFor('degraded', 'chart'), 'gateChartUnavailable')
  assert.equal(gate.textKeyFor('degraded', 'image'), 'gateImageUnavailable')
  assert.equal(gate.textKeyFor('degraded', 'html'), 'gateRichContentUnavailable')
  assert.equal(gate.textKeyFor('passed', 'mermaid'), null)
})

const I18N_KEYS = ['gatePreparing', 'gateDiagramUnavailable', 'gateChartUnavailable',
  'gateImageUnavailable', 'gateRichContentUnavailable']

/** 从页面源码里取出每个语言字典的键集合（按字面量解析，不执行页面脚本）。 */
function dictKeysByLang() {
  const start = page.indexOf('const I18N = {')
  assert.ok(start !== -1, '页面应包含 I18N 字典')
  const end = page.indexOf('\n  }', page.indexOf('  },\n', start))
  const text = page.slice(start, end)
  const result = {}
  const langRe = /^    (zh|zhHant|en|pt): \{$/gm
  const marks = []
  let match
  while ((match = langRe.exec(text)) !== null) marks.push({ lang: match[1], at: match.index })
  for (let i = 0; i < marks.length; i++) {
    const chunk = text.slice(marks[i].at, i + 1 < marks.length ? marks[i + 1].at : text.length)
    const keys = new Set()
    const keyRe = /^\s{6}([A-Za-z][\w]*):/gm
    let keyMatch
    while ((keyMatch = keyRe.exec(chunk)) !== null) keys.add(keyMatch[1])
    result[marks[i].lang] = keys
  }
  return result
}

check('四语言字典都含全部 5 个门禁键（D3）', () => {
  const dicts = dictKeysByLang()
  assert.deepEqual(Object.keys(dicts).sort(), ['en', 'pt', 'zh', 'zhHant'])
  for (const [lang, keys] of Object.entries(dicts)) {
    for (const key of I18N_KEYS) {
      assert.ok(keys.has(key), `${lang} 缺少 ${key}`)
    }
  }
})
check('四语言字典都没有空文案，且降级文案可读（D1）', () => {
  const dicts = dictKeysByLang()
  for (const lang of Object.keys(dicts)) {
    for (const key of I18N_KEYS) {
      const value = readI18nValue(lang, key)
      assert.ok(typeof value === 'string' && value.trim() !== '', `${lang}.${key} 不能为空`)
      const readable = gate.assertReadable(value)
      assert.equal(readable.ok, true, `${lang}.${key} 含技术词/英文报错：${readable.pattern}`)
    }
  }
})
check('assertReadable 拒绝技术词与英文报错（D1 判据本身有效）', () => {
  for (const bad of ['mermaid render failed', 'Syntax error near line 3', '```mermaid',
    'undefined', 'null', '<pre>', 'Unexpected token NaN']) {
    assert.equal(gate.assertReadable(bad).ok, false, `应拒绝：${bad}`)
  }
  // chart/image/diagram 是普通名词（D3 英文参考值即 "The chart is...")，不属技术词
  assert.equal(gate.assertReadable('示意图暂时无法显示，您可以先看上面的文字说明。').ok, true)
  assert.equal(gate.assertReadable('The chart is temporarily unavailable; please refer to the text above.').ok, true)
})

/** 取某个语言字典里某个键的字面量值。 */
function readI18nValue(lang, key) {
  const langAt = page.indexOf(`    ${lang}: {`)
  assert.ok(langAt !== -1, `找不到语言字典 ${lang}`)
  const keyAt = page.indexOf(`      ${key}:`, langAt)
  assert.ok(keyAt !== -1, `找不到 ${lang}.${key}`)
  const line = page.slice(keyAt, page.indexOf('\n', keyAt))
  const quoted = /'([^']*)'/.exec(line) || /"([^"]*)"/.exec(line)
  return quoted ? quoted[1] : ''
}

// ── ⑦ 页面接线与四处源码回退的消除（V1/V3/REP2/D2）─────────────────────────

console.log('\n页面接线与源码回退消除')
check('普通代码块仍原样透传（N2③ 行为级判据，不引用变量名/分支名）', () => {
  // 行为级判据：把一段普通代码块喂进真实 renderMarkdown，断言
  // ① 产出唯一一处 <pre><code>；② 代码体**逐字**保留（含未闭合情形）。
  // 该断言不引用任何分支名/变量名，因此重构不会让它失效（区别于结构锚点）。
  const fnStart = page.indexOf('function renderMarkdown(')
  const fnEnd = page.indexOf('\n  /**', fnStart + 10)
  assert.ok(fnStart !== -1 && fnEnd > fnStart, '必须能定位 renderMarkdown 源码段')
  const src = page.slice(fnStart, fnEnd)
  // 逐字透传的证据：块体经 esc() 原样拼接（而非按行丢弃/改写）
  assert.ok(/\$\{esc\(buf\.join\('\\n'\)\)\}/.test(src), '块体必须整体 esc 后原样拼接')
  // 且该产出是本函数内唯一一处 <pre><code>
  const emissions = [...src.matchAll(/<pre><code>/g)]
  assert.equal(emissions.length, 1, `renderMarkdown 内只应有一处 pre>code，实际 ${emissions.length}`)
})
check('页面只剩一处 pre > code —— 普通代码块（四处源码回退已消除）', () => {
  // 页面上唯一允许的块体源码输出是普通代码块（python/bash 等，N2③ 明确不改行为）
  const emissions = [...page.matchAll(/<pre><code>[^`]*<\/code><\/pre>`/g)]
  assert.equal(emissions.length, 1, `只应剩普通代码块一处，实际 ${emissions.length} 处`)
  const at = emissions[0].index
  const around = page.slice(Math.max(0, at - 1200), at + 200)
  assert.ok(/普通代码块/.test(around), '剩下那处必须是普通代码块分支')
  // 锚「事实」而非标识符：该唯一发射点两侧必须是「闭合判据处理」与「后接 continue」，
  // 即它确实是普通代码块分支的产出，而不是靠某个变量名存在来证明。
  assert.ok(/if \(closed\) i\+\+/.test(around), '唯一发射点应位于闭合判据之后')
  assert.ok(/\n\s+continue\n/.test(page.slice(at, at + 200)), '唯一发射点后应立即 continue（分支结束）')
  // 未闭合围栏分支只出占位
  const unclosedAt = page.indexOf('if (!closed) {')
  assert.ok(unclosedAt !== -1, '必须存在未闭合围栏分支')
  const unclosed = page.slice(unclosedAt, unclosedAt + 400)
  assert.ok(unclosed.includes('data-block-state="pending"'), '未闭合围栏必须只出占位')
  assert.ok(!unclosed.includes('<pre>'), '未闭合围栏分支不得出现 pre')
})
check('四类图形块统一走门禁入口，不存在绕过判据的直渲染路径', () => {
  // renderMarkdown 的受控围栏分支只调 gateBlockHtml（占位/终态唯一入口）
  assert.ok(/out\.push\(gateBlockHtml\(fence\.lang, fence\.info, body\)\)/.test(page), '受控围栏必须走 gateBlockHtml')
  // 四个旧的直渲染函数必须已被删除（它们各自持有源码回退或先发请求）
  for (const gone of ['function renderMermaidBlock', 'function renderImageBlock']) {
    assert.equal(page.includes(gone), false, `直渲染函数必须删除：${gone}`)
  }
  // renderImageBlock 的旧行为（立刻写 <img src>，先于判定发请求）必须不存在
  assert.equal(/return `<figure class="kb-image"><img src=\"/.test(page), false,
    '不得存在"立刻产出 img src"的图片渲染路径（会绕过判定发请求）')
  // 内容路径建 img 只允许 settleGateImages 一处（图片阅读器里的克隆不算内容渲染）
  const gateImgSites = [...page.matchAll(/document\.createElement\('img'\)/g)]
    .filter(m => !/viewer/i.test(page.slice(Math.max(0, m.index - 400), m.index)))
  assert.equal(gateImgSites.length, 1, `内容路径建 img 只允许一处，实际 ${gateImgSites.length}`)
})

check('四类块在结算阶段各自判定并降级为对应 i18n 文案（D3/D4 逐点映射）', () => {
  // mermaid 失败 → degradeElement('mermaid')
  assert.ok(/node\.innerHTML = degradeElement\('mermaid'\)/.test(page))
  // chart 不通过 → degradeElement('chart')（同步判据）
  assert.ok(/node\.innerHTML = degradeElement\('chart'\)[\s\S]{0,120}reportGateFailure\('chart'/.test(page))
  // html 不通过 → degradeElement('html')
  assert.ok(/node\.innerHTML = degradeElement\('html'\)[\s\S]{0,120}reportGateFailure\('html'/.test(page))
  // image 不通过（路径非法 → 静态路径；解码失败 → 真机路径）都在 figure 上降级
  const imgDegrades = (page.match(/figure\.innerHTML = degradeElement\('image'\)/g) || []).length
  assert.ok(imgDegrades >= 2, `图片两条失败路径都必须降级，实际 ${imgDegrades}`)
  // 三个旧回退标记必须彻底消失
  assert.equal(page.includes('保留代码块'), false, '不得再保留代码块')
  assert.equal(page.includes('mermaid 渲染失败，保留代码块'), false, '旧 console.warn 回退必须消失')
})
check('mermaid 容器初始只含占位，不含 pre/code（V1/V2/P4）', () => {
  // 本地扫描路径（gatePlaceholderHtml）的 mermaid 分支
  const fnStart = page.indexOf('function gatePlaceholderHtml')
  const fn = page.slice(fnStart, page.indexOf('function settleGatePlaceholders', fnStart))
  const branch = fn.slice(fn.indexOf("if (type === 'mermaid') {"))
  assert.ok(branch.slice(0, 400).includes('data-block-state="pending"'), '容器必须标记 pending')
  assert.ok(!branch.includes('<pre>'), '容器不得预置源码块')
  assert.ok(branch.includes('pendingPlaceholder()'), '容器初始内容只能是占位')
  assert.ok(/localGateKey\(/.test(branch), '源码必须只进内存台账（经稳定键登记）')
})
check('未闭合围栏在流式渲染路径只出占位（P4）', () => {
  assert.ok(/if \(!closed\) \{[\s\S]{0,320}data-block-state="pending"/.test(page),
    '未闭合围栏必须走占位分支')
})
check('门禁脚本先于页面脚本加载，且失败不阻塞页面（页面能拿到 window.DshOutputGate）', () => {
  const tagAt = page.indexOf('<script src="assets/output-gate.js"')
  const pageScriptAt = page.indexOf("(() => {\n  'use strict'")
  assert.ok(tagAt !== -1, 'index.html 必须外链门禁资产')
  assert.ok(pageScriptAt !== -1 && tagAt < pageScriptAt, '门禁脚本必须在页面脚本之前')
  // 资产 404/慢加载不得阻塞页面脚本：onerror 只做标记，页面用 NO_GATE 兜底
  assert.ok(page.includes('onerror="window.__dshGateAssetFailed=true"'), '门禁资产失败必须被标记而不是抛错')
})
check('R-D7 两个围栏判据入口都做行尾 CR 归一化（与主机侧 stripCr 同口径）', () => {
  // 缺陷：前端未剥 `\r` ⇒ CRLF 下受控起始围栏识别失败、CRLF 闭合行判为非闭合
  // ⇒ 受控围栏落入普通代码块，标记与块体源码进 DOM（SRC1）。
  // 判据锚在「判据函数入口是否调用 stripCr」这一**结构事实**上（行为面由 DOM 套件覆盖）。
  assert.ok(/function stripCr\(line\)/.test(page), '必须有 stripCr 归一化函数')
  for (const fn of ['matchControlledFence', 'isClosingFence']) {
    const i = page.indexOf(`function ${fn}(`)
    assert.ok(i !== -1, `必须存在 ${fn}`)
    const body = page.slice(i, page.indexOf('\n  }\n', i))
    assert.ok(/stripCr\(/.test(body), `${fn} 入口必须做行尾 CR 归一化`)
  }
  // 归一化放在**判据入口**而不是 `renderMarkdown` 的 `split` 处：判据共 5 个调用点
  // （`:683` 行级循环 / `:694` 受控闭合 / `:731` 普通块体 / `:732` 普通闭合 拿到的是
  // `split(/\n/)` 产出的**带 `\r` 的行**；`:663` tableCell 拿到的是已 `trim()` 的单元格
  // ——后者天然免疫，前者才是缺陷面）。放在入口可一次性覆盖全部调用点。
  const linesSplitAt = page.indexOf('const lines = src.split(/\\n/)')
  assert.ok(linesSplitAt !== -1, '必须能定位 split(/\\n/)')
  assert.ok(!/split\(\/\\r\?\\n\/\)|split\(\/\\r\\n\/\)/.test(page),
    '不得靠改 split 实现归一化（会漏掉 tableCell 之外的调用形态，且改面更大）')
  // tableCell 是判据的真实调用点之一（故入口归一化才必要）
  const tableCellAt = page.indexOf('function tableCell(')
  assert.ok(tableCellAt !== -1, '必须存在 tableCell（表格单元格路径）')
  // 切片到函数体结束，**不用固定字符数窗口**——窗口长度会随函数体增长而失配，
  // 使断言从"检查函数体"退化为"检查函数头附近"，属脆弱判据。
  const tableCellBody = page.slice(tableCellAt, page.indexOf('\n  }\n', tableCellAt))
  assert.ok(/matchControlledFence\(/.test(tableCellBody),
    'tableCell 必须直接调 matchControlledFence（判据被多处复用 ⇒ 归一化须在入口）')
})
check('R-D7 残留差异已记录：前置空白字符类未对齐（已知差异，刻意不修）', () => {
  // 本次**只做 CR 归一化**，不对齐空白字符类（主机 `\s` 含 NBSP/VT/FF/BOM，前端 `[ \t]`）。
  // 理由：对齐会**改变既有行为**（NBSP 缩进的围栏将从"正文"变成"受控块并降级"），
  // 两个成因混在一次改动里会破坏"分开自证"。故如实记录为已知差异。
  assert.ok(/前置空白字符类/.test(page) && /已知差异/.test(page),
    '页面注释中必须记录"前置空白字符类未对齐"为已知差异')
})
// ── F-1（blocker）：单元格内「标记+块体同行」致块体源码进 <td> ──────────────
// 判据锚在**不变量**上，不锚行号：① 标记之后的剩余文本只能进「闭合判定」或「丢弃」，
// 不得被当正文 `esc()` 拼回；② `tableCell` 接受跨格延续的块体状态参数。
// 行为面（两种形态的真机 DOM）由 gate-dom-check.mjs ③.9c ③-b/③-c/③-d 覆盖。
check('F-1 表格单元格必须消费「标记之后的剩余文本」，不得当尾随正文拼回', () => {
  const at = page.indexOf('function tableCell(')
  assert.ok(at !== -1, '必须存在 tableCell')
  const end = page.indexOf('\n  }\n', at)
  assert.ok(end !== -1, '必须能定位 tableCell 函数体')
  const body = page.slice(at, end)
  // 旧实现在此把 `cell.slice(fence.at)` 剥掉语言词后 `esc()` 拼回 parts —— 块体即泄漏。
  assert.ok(!/parts\.push\(esc\(tail\)\)/.test(body), '不得再把标记之后的 tail 当正文拼回')
  assert.ok(/cellClosingFenceAt\(rest, fence\.char, fence\.run\)/.test(body),
    '标记之后的剩余文本（rest）必须交给闭合判定，未闭合即延续块体态')
  assert.ok(/state\.push\(\{ char: fence\.char, minLen: fence\.run \}\)/.test(body),
    '未在同一格闭合时必须登记块体态，供后续单元格/数据行延续')
})
check('F-1 块体态必须跨单元格/数据行延续，且整格丢弃（不保留闭合符之前的部分）', () => {
  assert.ok(/function cellClosingFenceAt\(fragment, char, minLen\)/.test(page),
    '必须有单元格级闭合判据 cellClosingFenceAt')
  const at = page.indexOf('function tableCell(')
  const end = page.indexOf('\n  }\n', at)
  const body = page.slice(at, end)
  // 块体态分支：命中闭合才清状态；**不保留**闭合符之前的文本（那也是块体）。
  assert.ok(/if \(open !== null\) \{/.test(body), '必须有块体态分支')
  assert.ok(/if \(cellClosingFenceAt\(cell, open\.char, open\.minLen\) !== -1\) state\.length = 0/.test(body),
    '块体态必须在见到闭合围栏时结束')
  assert.ok(!/const kept = cell\.slice\(0, closeAt\)/.test(body),
    '块体态不得保留闭合符之前的文本（同属块体，保留即换个位置漏）')
  // 状态由表格分支持有并跨格共享（run 必须在 header/rows 两处都透传）
  const tableAt = page.indexOf('const cellRun = []')
  assert.ok(tableAt !== -1, '表格分支必须持有 cellRun 状态')
  const tableSlice = page.slice(tableAt, tableAt + 900)
  assert.ok(/tableCell\(h, cellRun\)/.test(tableSlice), '表头单元格必须透传块体态')
  assert.ok(/tableCell\(c, cellRun\)/.test(tableSlice), '数据单元格必须透传块体态')
})
check('块源码只存 JS 内存台账，DOM 上没有任何承载源码的属性（V1/V4）', () => {
  for (const attribute of ['data-src=', 'data-src-path=', 'data-caption=', 'data-source=']) {
    assert.ok(!page.includes(attribute), `不得把源码写进 ${attribute} 属性（V4 快照会命中泄漏判据）`)
  }
  assert.ok(/const blockSources = new Map\(\)/.test(page), '必须存在源码内存台账')
  assert.ok(/function blockSourceOf\(key\)/.test(page), '必须有台账读取函数')
  // DOM 上只允许出现「稳定键」（blockId 或类型+源码摘要），不得出现源码本身
  assert.ok(/data-block-key="\$\{esc\(key\)\}"/.test(page), 'DOM 上只允许出现不含源码的稳定键')
  assert.ok(/function registerBlockSource\(source, stableId\)/.test(page), '稳定键必须由 blockId/摘要派生')
})

check('门禁资产缺失时安全降级（不渲染未校验块、不抛异常）', () => {
  assert.ok(page.includes('DshOutputGate'), '页面必须从全局取门禁模块')
  assert.ok(/const G = gate \|\| NO_GATE/.test(page), '必须有 NO_GATE 兜底')
  assert.ok(/console\.warn\('\[guest\] output-gate\.js 未加载/.test(page))
  // NO_GATE 下所有判据必须返回"不通过"，绝不放行
  const noGate = page.slice(page.indexOf('const NO_GATE = {'), page.indexOf('const G = gate || NO_GATE'))
  assert.ok(noGate.includes("checkImagePath: () => ({ ok: false"), '缺模块时图片路径必须判非法')
  assert.ok(noGate.includes("checkChartData: () => ({ ok: false"), '缺模块时图表必须判非法')
  assert.ok(noGate.includes("checkRendered: () => ({ ok: false"), '缺模块时渲染判据必须判非法')
})
check('NO_GATE 键集覆盖页面真实访问的全部 G.<member>（R-D5：桩必须完整可用）', () => {
  // 缺陷 R-D5：资产 404 走 NO_GATE 时，桩缺页面实际调用的成员 ⇒ 块事件一到即
  // `TypeError`，整条回答被替换成错误文案（违反页面自述与 C8）。
  // 判据**以键集覆盖为锚**（静态），不按文本内容泛化匹配：
  //   ① 收集页面里「真实代码访问」的 `G.<member>`（排除仅出现在注释中的名字）；
  //   ② 收集 `NO_GATE` 对象字面量的顶层键；③ 断言 ① ⊆ ②。
  const lines = page.split('\n')
  const accessed = new Set()
  for (const line of lines) {
    const t = line.trim()
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue // 注释不算访问
    for (const m of line.matchAll(/\bG\.([A-Za-z_][A-Za-z0-9_]*)/g)) accessed.add(m[1])
  }
  const noGateSrc = page.slice(page.indexOf('const NO_GATE = {'), page.indexOf('const G = gate || NO_GATE'))
  const provided = new Set([...noGateSrc.matchAll(/^ {4}([A-Za-z_][A-Za-z0-9_]*):/gm)].map(m => m[1]))
  const missing = [...accessed].filter(k => !provided.has(k)).sort()
  assert.deepEqual(missing, [], `NO_GATE 缺少页面真实访问的成员：${missing.join(' / ')}`)
})
check('NO_GATE 三态齐备 + decodeBlockPayload 返回非空 block（R-D5 的两个具体成因）', () => {
  const noGateSrc = page.slice(page.indexOf('const NO_GATE = {'), page.indexOf('const G = gate || NO_GATE'))
  // ① GATE_STATES 完备（页面按状态字面量取值，缺键得 undefined；属完整性项）
  for (const state of ['absent', 'pending', 'loading', 'validating', 'passed', 'degraded']) {
    assert.ok(new RegExp(`${state}:\\s*'${state}'`).test(noGateSrc), `GATE_STATES 缺 ${state}`)
  }
  // ② decodeBlockPayload 必须返回**非空** block：页面在 applyBlockPayload 里直接读
  //    `decoded.block.blockType`，返回 null 会抛 TypeError，把"降级"变成"整条回答失败"
  assert.ok(!/decodeBlockPayload:\s*\(\)\s*=>\s*\(\{\s*ok:\s*false,\s*block:\s*null/.test(noGateSrc),
    'decodeBlockPayload 不得返回 block:null（会触发 Cannot read properties of null）')
  assert.ok(/block:\s*\{/.test(noGateSrc), 'decodeBlockPayload 必须构造非空 block')
})
check('图片两条通道共用同一白名单函数（IMG2：单一实现，禁止两处各写正则）', () => {
  // 通道 A：```image 围栏；通道 B：行内 ![](url)
  assert.ok(/if \(!G\.checkImagePath\(first\)\.ok\) return evidenceHint\('image'/.test(page), '围栏通道必须用白名单')
  assert.ok(/const checked = G\.checkImagePath\(unescapeHtml\(url\)\)/.test(page), '行内通道必须用同一白名单')
  assert.ok(/if \(checked\.ok\) \{[\s\S]{0,160}<img src=/.test(page), '行内通道仅在通过后才产出 img')
  // 旧的两套宽松放行规则必须消失
  assert.equal(/\/\^\(https\?\|data:image\/\|\/\/\/\.test\(url\)/.test(page), false, '旧的行内宽松正则必须删除')
  assert.equal(page.includes('imageSrcOf'), false, '旧归一化函数（正则比 IMG1 宽）必须删除，避免第二条放行路径')
})

check('html 沙箱 CSP 的 img-src 已收紧，不再允许外部主机（IMG7）', () => {
  const csp = /content="default-src 'none';[^"]*"/.exec(page)
  assert.ok(csp, '必须能找到 CSP')
  assert.ok(/img-src 'self' data:;/.test(csp[0]), "img-src 必须是 'self' data:")
  assert.equal(/img-src[^;]*https:/.test(csp[0]), false, 'img-src 不得再含 https:（沙箱内外部图会泄露访客 IP/UA）')
  // 沙箱属性本身不得放宽（安全不变量）
  assert.ok(page.includes('sandbox="allow-scripts"'))
})

check('P7 并行语义：无串行总配额，改为 done 前的结算窗口（v3.2 CF-1）', () => {
  // 串行配额三件套必须彻底删除
  for (const gone of ['gateTurnSpent', 'remainingGateBudget', 'spendGateTime']) {
    assert.equal(page.includes(gone), false, `串行配额实现必须删除：${gone}`)
  }
  // 并行推进：单块只用 blockTimeoutMs 上限
  assert.ok(/withTimeout\(lib\.render\([^)]*\), GATE_BLOCK_TIMEOUT_MS\)/.test(page), '单块上限必须是 blockTimeoutMs')
  assert.ok(/setTimeout\(\(\) => \{ if \(img\.naturalWidth === 0\) finish\(false\) \}, GATE_BLOCK_TIMEOUT_MS\)/.test(page),
    '图片超时兜底必须用单块上限，不受其它块影响')
  // 结算窗口：等待上限 + 到点降级 + 不阻塞 done
  assert.ok(/async function awaitGateSettlement/.test(page), '必须有结算窗口函数')
  assert.ok(/function settleWindowMs\(\)/.test(page), '窗口取值必须来自 answerWaitBudgetMs')
  // 窗口内轮询：步长必须收敛到 deadline（固定步长会越界，实测 600ms 窗口下 619ms）
  assert.ok(/while \(hasUnsettledGates\(root\)\)/.test(page), '窗口内需轮询等待未结算块')
  assert.ok(/const remaining = deadline - Date\.now\(\)/.test(page), '轮询必须按剩余时间计算步长')
  assert.ok(/setTimeout\(resolve, Math\.min\(20, remaining\)\)/.test(page), '步长必须 min(20ms, 剩余时间)')
  // 预算起点必须是 done 帧到达，且留出降级收尾余量
  assert.ok(/await awaitGateSettlement\(bubble, doneFrameAt\)/.test(page), '窗口起点必须是 done 帧到达时刻')
  assert.ok(/SETTLE_MARGIN_MS = 30/.test(page), '必须为降级收尾留余量，保证总耗时 ≤ 预算')
})

check('planBlocks 兼容主机侧 sourceB64 载荷（不兼容会得到 0 字节 → 块静默丢失）', () => {
  const b64 = text => Buffer.from(text, 'utf8').toString('base64')
  const mmd = 'flowchart TD\n  A[停电] --> B[报修]'
  const plan = gate.planBlocks({
    blocks: [
      { blockId: 'b1', blockType: 'mermaid', sourceBytes: Buffer.byteLength(mmd, 'utf8'), decision: 'render', sourceB64: b64(mmd) },
      { blockId: 'b2', blockType: 'image', sourceBytes: 0, decision: 'render', imagePath: '/uploads/a.png', imageCaption: '图注' },
      { blockId: 'b3', blockType: 'chart', sourceBytes: 9, decision: 'degraded', reason: 'chart-invalid' },
    ],
    blockResults: { b1: 'passed', b3: 'degraded' },
    degradedIds: ['b3'],
  })
  assert.equal(plan.blocks.length, 2, 'render 块应入队，degraded 块应剔除')
  assert.equal(plan.blocks[0].source, mmd, 'sourceB64 必须解码成源码（含中文）')
  assert.equal(plan.blocks[0].sourceBytes, gate.byteLength(mmd), 'sourceBytes 按解码后字节数')
  assert.equal(plan.blocks[1].imagePath, '/uploads/a.png', '图片块保留 imagePath')
  assert.equal(plan.blocks[1].imageCaption, '图注', '图片块保留 imageCaption')
  assert.deepEqual(plan.degradedIds, ['b3'])
  // 已解码形态（内部使用）仍要能用
  const plain = gate.planBlocks({ blocks: [{ blockId: 'b9', blockType: 'html', source: '<p>x</p>' }] })
  assert.equal(plain.blocks[0].source, '<p>x</p>')
})

check('base64Decode 正确处理多字节（atob 会按 latin1 损坏中文）', () => {
  const cases = [
    'flowchart TD\n  A[停电] --> B[报修]',
    '简单 ASCII',
    'Emoji 🎉 与繁體字 電費',
    '',
  ]
  for (const text of cases) {
    const encoded = Buffer.from(text, 'utf8').toString('base64')
    assert.equal(gate.base64Decode(encoded), text, `往返失败：${text}`)
  }
  // 坏 base64 必须抛错（调用方据此降级）
  assert.throws(() => gate.base64Decode('!!!not-base64!!!'))
})

check('口径 B：访客端消费 block-open / block / done(blocks) 三种事件（E5/E6）', () => {
  // 三个事件分支必须都在 SSE 处理里
  assert.ok(/event === 'block-open'/.test(page), '必须消费 block-open（占位）')
  assert.ok(/event === 'block' && data\.blockId/.test(page), '必须消费 block（裁决结果）')
  assert.ok(/adoptDoneBlocks\(data\)/.test(page), 'done 必须采纳权威 blocks/blockResults/degradedIds')
  // 降级/占位/渲染三分支
  assert.ok(/function renderBlockSlots\(/.test(page), '必须有槽位渲染')
  assert.ok(/function applyBlockPayload\(/.test(page), '必须把裁决并入台账')
  assert.ok(/function adoptDoneBlocks\(/.test(page), '必须有 done 权威终态采纳')
  // block-open 只出占位：不得在裁决到达前判死（decision 未定 ≠ degraded）
  assert.ok(/slot\.decision === undefined \|\| slot\.decision === null/.test(page),
    'block-open 后的待裁决态必须出占位，不得当成 degraded')
  // 源码不进 DOM：renderBlockSlots 用稳定键
  const slotsFn = page.slice(page.indexOf('function renderBlockSlots()'), page.indexOf('function paintStream'))
  assert.ok(/data-block-key=/.test(slotsFn), '槽位用 data-block-key 指向内存台账')
  assert.equal(/data-src=/.test(slotsFn), false, '槽位不得把源码写进属性')
})

check('块来源唯一裁决（chooseBlockSource）：有事件则事件权威，无事件才兜底', () => {
  // 这条是 R2 会审的「兜底会不会演变成第二事实源」：把优先级收敛成一个纯函数，
  // 单向不可逆（一旦走事件路径就不再回退），DOM 层只照结论执行。
  assert.equal(gate.chooseBlockSource({ sawBlockEvent: true }), 'block-events')
  assert.equal(gate.chooseBlockSource({ sawBlockEvent: false }), 'fence-fallback')
  assert.equal(gate.chooseBlockSource(), 'fence-fallback', '缺省（老后端无事件）走兜底')
  assert.equal(gate.chooseBlockSource(null), 'fence-fallback')
  assert.equal(gate.chooseBlockSource({ sawBlockEvent: 'yes' }), 'fence-fallback', '非布尔 true 不当作事件存在')
})

check('页面把块来源收敛到单一裁决点（围栏路径受其门控）', () => {
  assert.ok(/function blockSourcePolicy\(\)/.test(page), '必须有页面侧策略入口')
  assert.ok(/return G\.chooseBlockSource\(\{ sawBlockEvent \}\)/.test(page), '页面不得自判，须委托纯函数')
  assert.ok(/let sawBlockEvent = false/.test(page), '必须有本轮事件标志')
  // 两处围栏产出点（未闭合占位 / 已闭合终态）都必须先问策略，
  // 否则会与 block 事件重复渲染。按「产出点紧跟门控」断言，不依赖分支变量名。
  const guarded = [...page.matchAll(/blockSourcePolicy\(\) === 'block-events'\) continue/g)].length
  assert.equal(guarded, 2, `受控围栏应有未闭合/已闭合两个产出分支且各自受门控，实际 ${guarded} 处`)
  assert.ok(/blockSourcePolicy\(\) === 'block-events'\) continue\s*out\.push\(`<div class="gate-block"[\s\S]{0,80}data-block-state="pending"/
    .test(page), '未闭合产出点必须受策略门控')
  assert.ok(/blockSourcePolicy\(\) === 'block-events'\) continue\s*out\.push\(gateBlockHtml\(/
    .test(page), '已闭合产出点必须受策略门控')
  // 每轮重置：不得把上一轮的来源带进下一轮
  const sendFn2 = page.slice(page.indexOf('async function send()'), page.indexOf('sendEl.addEventListener'))
  assert.ok(/sawBlockEvent = false/.test(sendFn2), 'send() 必须按轮重置来源标志')
})

check('F-2：渲染器加载失败后本轮不再重试（否则单轮 404 请求风暴）', () => {
  // 实测缺陷：onerror 把 mermaidPromise 置回 null → 每个块都再试一次，
  // 单轮 3 块产生 9 次脚本请求 / 6+ 次 ERR_ABORTED（verifier 报告 F-2）。
  assert.ok(/let mermaidLoadFailed = false/.test(page), '必须有「本轮加载失败」标志')
  assert.ok(/if \(mermaidLoadFailed\) \{/.test(page), 'loadMermaid 必须在入口短路')
  // 失败置位点必须覆盖两条失败路径：onerror 与「脚本加载了但没暴露 mermaid」
  const loadFn = page.slice(page.indexOf('function loadMermaid()'), page.indexOf('function renderDiagrams'))
  const failFlags = (loadFn.match(/mermaidLoadFailed = true/g) || []).length
  assert.ok(failFlags >= 2, `两条失败路径都要置位，实际 ${failFlags} 处`)
  // 重置粒度 = 每轮（不得永久失败：一次抖动不该毁掉整个会话）
  assert.ok(/mermaidLoadFailed = false\n  \}/.test(page) || /mermaidLoadFailed = false/.test(page), '必须有重置')
  const sendFn = page.slice(page.indexOf('async function send()'), page.indexOf('sendEl.addEventListener'))
  assert.ok(/mermaidLoadFailed = false/.test(sendFn), '重置必须发生在 send()（按轮，而非永久）')
  // 注释里必须写清重置粒度，避免后人误改成永久失败
  assert.ok(/重置粒度/.test(page), '必须注明重置粒度')
})

check('兜底必须是「每帧」而非「只在 done」——否则流式期裸奔明文围栏（SRC5/V1）', () => {
  // 旧后端把围栏分帧下发：若只在 done 才解析，中间帧的正文就是明文围栏。
  // 页面用 renderStreamMarkdown 逐帧渲染，围栏分支逐帧产出占位，因此不裸奔。
  assert.ok(/function renderStreamMarkdown\(src, options = \{\}\)/.test(page), '流式渲染入口必须存在')
  assert.ok(/return renderMarkdown\(src\)/.test(page), '流式渲染必须走 renderMarkdown（含围栏分支）')
  // 每帧调用点：delta 分支与 done 定稿都经 renderStreamMarkdown
  const delta = page.slice(page.indexOf("} else if (event === 'delta'"), page.indexOf("} else if (event === 'sources'"))
  assert.ok(/renderStreamMarkdown\(streamed\)/.test(delta), 'delta 每帧都必须过围栏分支')
  const doneBranch = page.slice(page.indexOf("} else if (event === 'done')"), page.indexOf("} else if (event === 'error')"))
  assert.ok(/renderStreamMarkdown\(streamed, \{ final: true \}\)/.test(doneBranch), 'done 定稿同样过围栏分支')
  // 兜底分支的注释必须点明「仅服务旧后端」，供 t6 审「是否第二事实源」
  assert.ok(/仅服务旧后端/.test(page), '兜底分支必须有「仅服务旧后端」注释')
})

check('契约 §9.7：不存在 block-replace 事件（v3.2 无事后重写）', () => {
  // 契约文档明确「每个块最多一个 block 事件；done 即终态」，因此页面不得有该分支。
  // 若未来重新引入重写，必须同步契约与实现——这里作为反向守卫。
  assert.equal(/block-replace/.test(page), false, '不得出现 block-replace 分支（契约已删除该事件）')
})

check('口径 B：块键稳定（同一块跨帧同键），否则节点搬运失配', () => {
  // 键必须由 blockId 或「类型+摘要」派生；不得用会漂移的计数器
  assert.ok(/function registerBlockSource\(source, stableId\)/.test(page), '稳定键签名必须带 stableId')
  assert.ok(/function localGateKey\(type, source, block\)/.test(page), '本地路径必须有稳定键函数')
  assert.equal(/blockSources\.size\}`/.test(page), false, '不得用台账 size 递增作键（跨帧会漂移）')
})

check('P5 计时起点：块闭合即开判（不得全部堆到 done），且流式重渲染保住块状态', () => {
  // ① 块闭合后必须立即开判：delta 分支里要启动未结算的块
  const deltaBranch = page.slice(page.indexOf("} else if (event === 'delta'"), page.indexOf("} else if (event === 'sources'"))
  assert.ok(/startClosedGates\(bubble\)/.test(deltaBranch), 'delta 分支必须启动已闭合块的判定（P5）')
  // ② 打字机每帧 innerHTML 重渲染会销毁在飞的 img/mermaid：必须走 paintStream 搬运状态
  assert.ok(/function paintStream\(root, html\)/.test(page), '必须有 paintStream 承接重渲染')
  assert.ok(/paintStream\(bubble, renderStreamMarkdown\(streamed\)\)/.test(page), 'delta 重渲染必须走 paintStream')
  assert.ok(/paintStream\(bubble, renderStreamMarkdown\(streamed, \{ final: true \}\)\)/.test(page),
    'done 定稿重渲染也必须走 paintStream（否则在飞的块被清掉）')
  // ③ 搬运必须用**真节点**：cloneNode 会造出新 img，请求与 load 监听一起丢
  const paintFn = page.slice(page.indexOf('function paintStream'), page.indexOf('function finalizeHistoryGates'))
  // 只看真实调用（去掉注释行），注释里出现该词不算违规
  const paintCode = paintFn.split('\n').filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n')
  assert.equal(/cloneNode\(/.test(paintCode), false, '不得用 cloneNode 搬运（会丢在飞请求与监听）')
  assert.ok(/placeholder\.replaceWith\(live\)/.test(paintFn), '必须用真节点 replaceWith 回填')
  // ④ 收尾窗口必须覆盖 validating（图片 decode 跨网络，最可能停在这个状态）
  const degradeFn = page.slice(page.indexOf('function degradePendingGates'), page.indexOf('function addMessage'))
  assert.ok(/querySelectorAll\('\.kb-image'\)/.test(degradeFn), '降级必须扫描 .kb-image（含 validating）')
  assert.ok(/querySelectorAll\('\.gate-block, \.chart'\)/.test(degradeFn), '降级必须覆盖 chart 占位')
})

check('P7 块间互不扣减：块级判定只依赖 blockTimeoutMs，不存在跨块共享额度（CF-1 收口）', () => {
  // ① 块级判定的两处超时都必须直接取单块常量，不能经过任何「本块还能用多少」的换算
  const blockTimeouts = [...page.matchAll(/GATE_BLOCK_TIMEOUT_MS/g)].map(m => m.index)
  assert.ok(blockTimeouts.length >= 2, '块级超时至少应有 mermaid 与 image 两处')
  // ② 两个块级判定点必须各自独立取常量（而不是共享一个递减变量）
  assert.ok(/withTimeout\(lib\.render\([^)]*\), GATE_BLOCK_TIMEOUT_MS\)/.test(page),
    'mermaid 判定上限必须是单块常量')
  assert.ok(/setTimeout\(\(\) => \{ if \(img\.naturalWidth === 0\) finish\(false\) \}, GATE_BLOCK_TIMEOUT_MS\)/.test(page),
    '图片判定上限必须是单块常量（不得经 Math.min 与共享池换算）')
  // ③ 明确不得存在「额度为 0 就连试都不试」的硬降级
  assert.equal(/budget\s*<=\s*0/.test(page), false, '不得有「额度耗尽即直接降级」的分支')
  assert.equal(/Math\.min\(GATE_BLOCK_TIMEOUT_MS,\s*budget\)/.test(page), false, '不得把共享额度折算进块级上限')
  // ④ 块级判定函数体内不得引用任何跨块累计量
  const mermaidFn = page.slice(page.indexOf('async function advanceMermaidNode'), page.indexOf('function measureSvg'))
  const imageFn = page.slice(page.indexOf('function settleGateImages'), page.indexOf('function settleGateMermaid'))
  for (const [name, fn] of [['advanceMermaidNode', mermaidFn], ['settleGateImages', imageFn]]) {
    for (const forbidden of ['gateTurnSpent', 'remainingGateBudget', 'spendGateTime', 'gateTurnStart']) {
      assert.equal(fn.includes(forbidden), false, `${name} 不得引用跨块累计量 ${forbidden}`)
    }
  }
  // ⑤ 收尾窗口只在 done 处使用（不得提前到块级）
  // 只统计调用点（`await awaitGateSettlement(`），函数声明处不算
  const settleCalls = (page.match(/await awaitGateSettlement\(/g) || []).length
  assert.equal(settleCalls, 1, `收尾窗口只允许在 done 分支调用一次，实际 ${settleCalls}`)
  assert.ok(/\} else if \(event === 'done'\) \{[\s\S]*await awaitGateSettlement\(/.test(page),
    '收尾窗口必须位于 done 分支内')
  assert.ok(/degradePendingGates\(root\)\n  \}/.test(page), '窗口耗尽必须降级未结算块')
  // done 分支：先**启动**并行判定（不 await），再在窗口内等结算——顺序不能反，
  // 否则窗口等的是尚未开始的活儿；且渲染本身绝不能被 await（会推迟 done 下发）
  const doneIdx = page.indexOf('finalizeBubble(bubble).catch(')
  const waitIdx = page.indexOf('await awaitGateSettlement(bubble, doneFrameAt)')
  assert.ok(doneIdx !== -1, 'done 分支必须先启动 finalizeBubble')
  assert.ok(waitIdx !== -1, 'done 分支必须有结算窗口等待')
  assert.ok(doneIdx < waitIdx, '必须先启动判定再等窗口（顺序反了窗口会空等）')
  // done 分支的这几行必须不含 await（断流恢复路径可以 await，它不在 done 帧上）
  const doneBranch = page.slice(page.indexOf("} else if (event === 'done') {"), page.indexOf("} else if (event === 'error') {"))
  assert.equal(/await finalizeBubble\(/.test(doneBranch), false, 'done 分支内渲染不得被 await（会推迟 done）')
  assert.equal(/\bvoid finalizeBubble\(bubble\)/.test(page), false, '不得用 void 丢弃启动结果')
})

check('图片请求只发生在真机解码判据阶段（占位期不发请求；C4/IMG2）', () => {
  assert.ok(/data-block-key="\$\{esc\(key\)\}"/.test(page), '图片占位只存短键，不存路径或 src')
  // 本地扫描路径的 image 分支：只出 figure 占位，不创建 img
  const localStart = page.indexOf('function gatePlaceholderHtml')
  const localFn = page.slice(localStart, page.indexOf('function settleGatePlaceholders', localStart))
  const imgBranch = localFn.slice(localFn.indexOf("if (type === 'image') {"))
  assert.ok(!/<img/i.test(imgBranch.slice(0, 500)), '图片占位阶段不得创建 img')
  // 真图只在主判据路径里建，且监听先于 src 赋值（缓存命中时 load 可能同任务派发）
  const imgBlock = page.slice(page.indexOf("const img = document.createElement('img')"))
  assert.ok(imgBlock.indexOf("addEventListener('load'") < imgBlock.indexOf('img.src = src'),
    'load/error 监听必须先于 src 赋值，否则命中缓存时会永久错过')
  assert.ok(/figure\.dataset\.blockState = G\.GATE_STATES\.validating/.test(page))
  assert.ok(/img\.addEventListener\('load'/.test(page))
})
check('断流与离开页面把判定期块降级（P9）', () => {
  assert.ok(/function degradePendingGates/.test(page))
  assert.ok(/degradePendingGates\(chatEl\)/.test(page), '断流路径必须降级未定稿块')
  assert.ok(/addEventListener\('pagehide'/.test(page), '离开页面必须降级')
})
check('已上屏内容不回改：passed/degraded 为终态且被跳过（REP5）', () => {
  // mermaid 推进器：已是终态就直接返回，不再改写 DOM
  assert.ok(/node\.dataset\.blockState === 'passed' \|\| node\.dataset\.blockState === 'degraded'\) return/.test(page),
    'mermaid 终态必须被跳过')
  // 图片：只有仍处于 validating 的占位才允许落终态（防止延迟回调覆盖已定稿内容）
  assert.ok(/figure\.dataset\.blockState !== G\.GATE_STATES\.validating\) return/.test(page),
    '图片延迟回调不得覆盖已定稿状态')
  // 断流降级只挑非终态的节点：mermaid 用常量比较 + mermaid-done 守卫，其余类型同理
  const degradeFn = page.slice(page.indexOf('function degradePendingGates'), page.indexOf('function addMessage'))
  assert.ok(/state === G\.GATE_STATES\.passed \|\| state === G\.GATE_STATES\.degraded/.test(degradeFn),
    '断流降级必须跳过 passed/degraded')
  assert.ok(/node\.classList\.contains\('mermaid-done'\)/.test(degradeFn), 'mermaid 已渲染的必须跳过')
})
check('回传是 fire-and-forget，失败被吞掉（O3）', () => {
  const start = page.indexOf('function reportGateFailure')
  const fn = page.slice(start, page.indexOf('/** 可读降级元素', start))
  assert.ok(fn.includes('catch(() =>'), '回传失败必须静默')
  assert.ok(fn.includes('keepalive: true'), '回传不应阻塞离页')
  assert.ok(!fn.includes('await'), '回传不得阻塞访客已见内容')
})
check('门禁预算来自服务端下发，前端只留兜底默认（G1）', () => {
  assert.ok(/function applyGateConfig/.test(page))
  assert.ok(/if \(data\.gate\) applyGateConfig\(data\.gate\)/.test(page), 'meta 事件必须被采纳')
  assert.ok(/GATE_BLOCK_TIMEOUT_MS = 1500/.test(page), '兜底默认与 §12 冻结值一致')
  assert.ok(/GATE_ANSWER_WAIT_BUDGET_MS = 600/.test(page))
  assert.ok(/GATE_LIBRARY_LOAD_TIMEOUT_MS = 8000/.test(page))
})
check('文字流式与来源引用未被门禁接管（N3/REG1/REG4）', () => {
  // 正文仍逐帧整体重渲染（打字机语义不变），只有图形块换成占位
  assert.ok(/streamed \+= data\.text/.test(page))
  assert.ok(/bubble\.innerHTML = renderStreamMarkdown\(streamed\)/.test(page))
  assert.ok(/src\.className = 'sources'/.test(page), '来源引用仍在')
})
check('图片阅读器与 HTML 沙箱属性未被破坏（REG7/REG8）', () => {
  assert.ok(page.includes("sandbox=\"allow-scripts\""), '沙箱属性不得放宽')
  assert.ok(page.includes("script-src 'nonce-"), 'CSP nonce 必须仍在')
  assert.ok(/closest\('\.bubble img'\)/.test(page), '图片阅读器入口仍在')
  assert.ok(/closest\('\.bubble \.mermaid-src\.mermaid-done'\)/.test(page), '图表阅读器入口仍在')
})
check('未引入新依赖（T5/Q3）', () => {
  const scripts = [...page.matchAll(/<script[^>]*src="([^"]+)"/g)].map(m => m[1])
  for (const src of scripts) {
    assert.ok(typeof src === 'string' && src !== '', 'script src 不得为空')
    assert.ok(!/^https?:/.test(src), `不得引入外部依赖：${src}`)
  }
  assert.deepEqual(scripts, ['assets/output-gate.js'])
})

// ── 汇总 ────────────────────────────────────────────────────────────────────

console.log(`\n全部 ${passed} 项通过\n`)
// MODULE_PATH

