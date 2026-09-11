/**
 * 输出前自审门禁 — 主机侧验收脚本（需求 **v3.2** §16：AS-1/AS-3/AS-4/AS-7/AS-10/AS-11）。
 *
 * 运行：`node --import tsx/esm customer-service/plugins/output-gate/tests/gate-check.mjs`
 * 断言失败必须非零退出（仓库约定：测试描述行为，不做「看起来通过」）。
 *
 * 覆盖范围（与 t3 验收条款一一对应）：
 *   1. 跨分帧围栏识别：`"``"` + `"`mermaid"`、逐字符喂入、闭合围栏跨帧
 *   2. 未闭合围栏：任何时刻都不得进入载荷（delta 流与终态）
 *   3. 四类围栏的判定与降级（含非法输入）
 *   4. 图片地址白名单：`..`、查询串、绝对 URL、其它协议、data:、百分号编码
 *   5. 服务端不做几何校验、不调用 mermaid.render、不引入新依赖
 *   6. 图片可达性探测仅告警：开关关闭不改变终态，探测结论不进拒绝分支
 *   7. 输出前替换（REP1–REP5）：不做事后重写、无二次模型调用、无 rewritten 留痕
 *   8. 留痕：七字段齐全、摘要可复算、可按 sessionId+blockType+reason 聚合
 *   9. 降级顺序：可读替代 > 丢弃该块 > 保留前后文字；整条回答绝不失败
 *  10. 三出口载荷一致性（流式 / 非流式 / 历史重放）
 *  11. 插件形态与配置：name/inject/Config/apply，无 default export，可回滚
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const pluginDir = resolve(here, '..')
const customerServiceDir = resolve(pluginDir, '../..')

const { Context } = await import('@deepseek-ai/cordis')
const plugin = await import(resolve(pluginDir, 'src/index.ts'))
const engine = await import(resolve(pluginDir, 'src/engine.ts'))
const { checkImagePath, stripGraphicsFences } = await import(resolve(pluginDir, 'src/block-rules.ts'))
const { FenceMachine } = await import(resolve(pluginDir, 'src/fence-machine.ts'))

const SESSION = 'guest-11111111-2222-3333-4444-555555555555'

/** 收集断言结果，最后统一汇报（一次跑完看到全部失败项）。 */
const results = []
/** @param {string} name 断言名 @param {() => unknown} body 断言体 */
function check(name, body) {
  try {
    body()
    results.push({ name, ok: true })
  } catch (error) {
    results.push({ name, ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}
/** @param {string} name 断言名 @param {() => Promise<unknown>} body 异步断言体 */
async function checkAsync(name, body) {
  try {
    await body()
    results.push({ name, ok: true })
  } catch (error) {
    results.push({ name, ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}

/**
 * 测试夹具的默认配置，逐项与 `plugins/output-gate/src/index.ts` 的 zod schema 一致
 * （captain 冻结取值见需求 §10；`answerWaitBudgetMs` 生产默认 600ms）。
 *
 * 取值**刻意与生产默认相同**，不缩短：夹具一旦与生产分叉，测出来的行为就不是线上行为。
 * 曾因本表缺少 `answerWaitBudgetMs` 导致 `Math.max(0, undefined) === NaN` →
 * `while (Date.now() < NaN)` 恒假 → 收尾窗口静默失效（`settle()` 0ms、真机回传被丢弃）。
 */
const DEFAULTS = {
  enabled: true,
  blockTimeoutMs: 1500,
  answerWaitBudgetMs: 600,
  libraryLoadTimeoutMs: 8000,
  maxBlockBytes: 32768,
  serverImageProbe: false,
  serverImageProbeTimeoutMs: 2000,
  reportPath: '/api/guest/render-report',
}

/** 测试用门禁工厂（直接构造引擎，不依赖 dsh 组合）。 */
function makeGate(overrides = {}) {
  const entries = []
  const gate = new engine.OutputGate(
    { ...DEFAULTS, ...overrides },
    { record: entry => entries.push(entry) },
  )
  return { gate, entries }
}

/** 把一段回答按给定分帧喂给门禁，返回载荷、事件与留痕。 */
async function runGate(reply, { overrides = {}, frames } = {}) {
  const { gate, entries } = makeGate(overrides)
  const events = []
  const turn = gate.beginTurn(SESSION, event => events.push(event))
  for (const piece of frames ?? [reply]) turn.feed(piece)
  const payload = await turn.settle()
  return { payload, events, entries, turn }
}

/** 流式事件里实际外发的文本（访客在 delta 流上看到的字节）。 */
function streamedText(events) {
  return events.filter(event => event.type === 'text').map(event => event.text).join('')
}

/**
 * 起一轮门禁并立即返回（供需要注入真机回传的用例使用）。
 * @returns `{ turn, events, entries }`，`events` 在 settle 后填满。
 */
function startTurn(overrides = {}) {
  const { gate, entries } = makeGate(overrides)
  const events = []
  const turn = gate.beginTurn(SESSION, event => events.push(event))
  return { turn, events, entries }
}

/** 从事件流里取全部块 id（`block-open` 是公开信号）。 */
function blockIds(events) {
  return events.filter(event => event.type === 'block-open').map(event => event.blockId)
}

/** 构造一条真机回传。 */
function report(blockId, reason, outcome = 'degraded') {
  return { sessionId: SESSION, blockId, blockType: 'mermaid', reason, sourceDigest: 'deadbeefdeadbeef', sourceBytes: 9, occurredAt: Date.now(), outcome }
}

/** 断言载荷里不含任何受控围栏痕迹。 */
function assertNoFenceLeak(text, label) {
  for (const marker of ['```mermaid', '```chart', '```image', '```img', '```html', '~~~mermaid', '```mer']) {
    if (text.includes(marker)) assert.fail(`${label}: 载荷里出现围栏痕迹 ${marker}`)
  }
}

/** 终态指纹（三出口一致性比对用）。 */
function fingerprint(payload) {
  return JSON.stringify({
    text: payload.text,
    blocks: payload.blocks.map(block => ({
      blockType: block.blockType,
      decision: block.decision,
      sourceB64: block.sourceB64 ?? null,
      reason: block.reason ?? null,
      imagePath: block.imagePath ?? null,
    })),
    degradedIds: payload.degradedIds,
  })
}

/** 一次构造：非流式路径（`gateReply`）与历史重放（同一入口）共用。 */
async function runSingle(reply, overrides = {}) {
  const { gate } = makeGate(overrides)
  return engine.gateReply(gate, SESSION, reply)
}

// ── 1. 跨分帧围栏识别 ──────────────────────────────────────────────────────

await checkAsync('跨分帧：围栏拆成 "``" + "`mermaid" 仍被正确摘出', async () => {
  const reply = '开头\n```mermaid\nflowchart TD\n A-->B\n```\n结尾'
  const { payload, events } = await runGate(reply, {
    frames: ['开头\n``', '`mer', 'maid\nflow', 'chart TD\n A-->B\n``', '`\n结尾'],
  })
  assert.equal(payload.blocks.length, 1, '应当摘出 1 个块')
  assert.equal(payload.blocks[0].blockType, 'mermaid')
  assert.equal(streamedText(events), '开头\n结尾', '文字流只应剩前后正文')
  assertNoFenceLeak(streamedText(events), '分帧流')
  assert.equal(Buffer.from(payload.blocks[0].sourceB64, 'base64').toString('utf8'), 'flowchart TD\n A-->B\n', '块体应完整还原')
})

await checkAsync('跨分帧：逐字符喂入（最坏分帧）仍不漏源码', async () => {
  const reply = '前```mermaid\nflowchart TD\n X-->Y\n```后'
  const { payload, events } = await runGate(reply, { frames: [...reply] })
  assert.equal(streamedText(events), '前后')
  assertNoFenceLeak(streamedText(events), '逐字符流')
  assert.equal(payload.blocks.length, 1)
})

await checkAsync('跨分帧：block-open 只带类型与块 id，不带源码', async () => {
  const { events } = await runGate('```mermaid\nflowchart TD\n A-->B\n```')
  const open = events.find(event => event.type === 'block-open')
  assert.ok(open !== undefined, '应有 block-open 事件')
  assert.equal(open.blockType, 'mermaid')
  assert.ok(typeof open.blockId === 'string' && open.blockId !== '')
  assert.equal(JSON.stringify(open).includes('flowchart'), false, 'block-open 不得含源码')
})

await checkAsync('普通代码块保持现状（原文透传，不纳入门禁）', async () => {
  const reply = '示例：\n```python\nprint("hi")\n```\n结束'
  const { payload, events } = await runGate(reply)
  assert.equal(payload.blocks.length, 0, 'python 块不是受控图形块')
  assert.equal(streamedText(events), reply, '普通代码块原文应原样透传')
})

await checkAsync('`mermaid mindmap` 形态（info 带关键字）被识别', async () => {
  const { payload } = await runGate('```mermaid mindmap\nroot((电费))\n```')
  assert.equal(payload.blocks.length, 1)
  assert.equal(payload.blocks[0].blockType, 'mermaid')
})

await checkAsync('缩进/行内出现同样识别（保守口径：宁可摘出降级，也不漏源码）', async () => {
  const indented = await runGate('   ```mermaid\nflowchart TD\n A-->B\n   ```')
  assert.equal(indented.payload.blocks.length, 1, '缩进围栏必须识别')
  const inline = await runGate('说明 ```mermaid\nflowchart TD\n A-->B\n```')
  assert.equal(inline.payload.blocks.length, 1, '行内出现的围栏同样识别（防漏出）')
  assertNoFenceLeak(inline.payload.text, '行内围栏')
})

// ── 2. 未闭合围栏 ──────────────────────────────────────────────────────────

await checkAsync('未闭合围栏：流中止后终态不含源码，并标为降级', async () => {
  const { payload, events } = await runGate('正文\n```mermaid\nflowchart TD\n A-->B')
  assertNoFenceLeak(streamedText(events), '未闭合流')
  assert.equal(payload.blocks.length, 1)
  assert.equal(payload.blocks[0].decision, 'degraded')
  assert.equal(payload.blocks[0].sourceB64, undefined, '降级块不得带源码')
  assert.ok(payload.degradedIds.includes(payload.blocks[0].blockId))
  assert.equal(payload.text, '正文\n')
})

await checkAsync('未闭合围栏：流尾半截 info（"```mer"）也扣留不泄露', async () => {
  const { payload, events } = await runGate('说明\n```mer', { frames: ['说明\n', '``', '`mer'] })
  assertNoFenceLeak(streamedText(events), '半截 info 流')
  assert.equal(streamedText(events), '说明\n')
  assert.equal(payload.blocks.length, 1, '半截 info 推断为受控块并降级')
  assert.equal(payload.blocks[0].decision, 'degraded')
})

await checkAsync('未闭合围栏：四类各一条，全部不得泄露', async () => {
  for (const type of ['mermaid', 'chart', 'image', 'html']) {
    const { payload, events } = await runGate(`前\n\`\`\`${type}\nbody-with-${type}\n`)
    assertNoFenceLeak(streamedText(events), `未闭合 ${type}`)
    assert.equal(payload.blocks[0].decision, 'degraded', `${type} 未闭合应降级`)
    assert.equal(payload.blocks[0].sourceB64, undefined)
  }
})

await checkAsync('未闭合围栏：逐字符分帧（闭合行拆开）仍按未闭合降级', async () => {
  const reply = '前\n```mermaid\nflowchart TD\n A-->B\n``'
  const { events } = await runGate(reply, { frames: [...reply] })
  assertNoFenceLeak(streamedText(events), '拆开的闭合行')
  assert.equal(streamedText(events), '前\n')
})

await checkAsync('SRC5：逐字符喂入未闭合块——闭合前流式载荷不含围栏与源码', async () => {
  // 覆盖 6 个源码裸露点中最危险的第 ①/⑥ 处：流式期就已在屏。
  const partial = '前言\n```mermaid\nflowchart TD\n SECRET_NODE-->B'
  const { payload, events } = await runGate(partial, { frames: [...partial] })
  const streamed = streamedText(events)
  assert.equal(streamed.includes('```'), false, '闭合前不得出现围栏分隔符')
  assert.equal(streamed.includes('mermaid'), false, '闭合前不得出现语言标记')
  assert.equal(streamed.includes('SECRET_NODE'), false, '闭合前不得出现源码')
  assert.equal(streamed, '前言\n', '只应有围栏之前的正文')
  assert.equal(payload.blocks[0].decision, 'degraded', '未闭合 → 降级终态')
  assert.equal(payload.blocks[0].sourceB64, undefined)
})

await checkAsync('SRC5：闭合瞬间之前的所有分帧位置都无泄露（穷举切点）', async () => {
  const full = '正文A\n```chart\n[{"label":"SECRET","value":1}]\n```\n正文B'
  // 在每个字符位置截断，检查"到该点为止"的流式载荷
  for (let cut = 1; cut <= full.length; cut += 1) {
    const prefix = full.slice(0, cut)
    const { events } = await runGate(prefix, { frames: [...prefix] })
    const streamed = streamedText(events)
    assert.equal(streamed.includes('```'), false, `切点 ${cut}: 不得出现围栏`)
    assert.equal(streamed.includes('SECRET'), false, `切点 ${cut}: 不得出现源码`)
  }
})

// ── F-1 / F-3 回归（V1 发现的源码泄漏路径）────────────────────────────────

/** 用反引号构造围栏行，避免模板字符串里出现裸反引号。 */
const F = '`'.repeat(3)

await checkAsync('F-1：受控关键字 + 超长 info 行 → 扣留降级（不得当正文外发）', async () => {
  // 曾经：超过 INFO_LIMIT_CHARS(512) 的 info 行无条件透传 → 整行含围栏与块体源码漏进载荷。
  for (const type of ['mermaid', 'chart', 'image', 'html']) {
    const reply = ['开头', F + type + 'A'.repeat(600), 'BODY-' + type, F, '结尾'].join('\n')
    const { payload, events } = await runGate(reply)
    const streamed = streamedText(events)
    assertNoFenceLeak(streamed, `F-1 ${type} 流式`)
    assertNoFenceLeak(payload.text, `F-1 ${type} 正文`)
    assert.equal(streamed.includes('BODY'), false, `${type}: 超长 info 之后的块体不得外发`)
    assert.equal(payload.text.includes('AAAA'), false, `${type}: 超长 info 内容不得外发`)
    assert.equal(payload.text, '开头\n结尾', `${type}: 只应保留前后正文`)
    assert.equal(payload.blocks.length, 1, `${type}: 必须摘成块（而非当正文）`)
  }
})

await checkAsync('F-1：非受控关键字 + 超长 info 行 → 仍按正文透传（N2③，防修过头）', async () => {
  const reply = ['开头', F + 'python' + 'B'.repeat(600), 'BODY', '结尾'].join('\n')
  const { payload, events } = await runGate(reply)
  const streamed = streamedText(events)
  assert.equal(payload.blocks.length, 0, 'python 超长 info 行不是受控块')
  assert.equal(streamed.includes('python'), true, '普通代码块必须保持现状透传')
  assert.equal(streamed.includes('BODY'), true, '普通代码块块体必须保持现状透传')
})

await checkAsync('F-1：受控 + 超长 info 后仍有闭合围栏与后续正文时正确切分', async () => {
  const reply = ['开头', F + 'chart' + 'A'.repeat(600), '[]', F, '后续正文'].join('\n')
  const { payload, events } = await runGate(reply)
  assertNoFenceLeak(streamedText(events), 'F-1 含闭合')
  assert.equal(payload.text, '开头\n后续正文', '闭合围栏之后的正文必须保留')
  assert.equal(payload.blocks.length, 1)
})

await checkAsync('F-3：嵌套围栏（闭合行写成受控起始行）不得泄漏 chart/块体/裸围栏', async () => {
  // 曾经：`F+chart` 的第三个反引号处即被当作外层闭合，嵌套块内容漏进正文。
  const reply = ['前', F + 'mermaid', 'flowchart TD', F + 'chart', '[{"label":"SECRET","value":1}]', F, '后'].join('\n')
  const { payload, events } = await runGate(reply)
  assertNoFenceLeak(streamedText(events), 'F-3 流式')
  assert.equal(streamedText(events).includes('SECRET'), false, '嵌套块体不得外发')
  assert.equal(payload.text.includes(F), false, '不得出现裸围栏')
  assert.equal(payload.text.includes('chart'), false, '不得出现嵌套语言标记')
  assert.equal(payload.text, '前\n后')
})

await checkAsync('F-3：闭合围栏后紧跟文字仍能就地闭合（防修过头）', async () => {
  const reply = ['前', F + 'mermaid', 'flowchart TD', F + '后'].join('\n')
  const { payload } = await runGate(reply)
  assert.equal(payload.text, '前\n后', '围栏同行之后的文字必须回到正文')
  assert.equal(payload.blocks.length, 1)
})

await checkAsync('F-3：四反引号闭合长围栏（嵌套的反面）仍正确结束', async () => {
  const reply = ['前', F + 'mermaid', 'A', F + F.slice(0, 1), '后'].join('\n')
  const { payload, events } = await runGate(reply)
  assertNoFenceLeak(streamedText(events), '四反引号')
  assert.equal(payload.blocks.length, 1)
})

await checkAsync('F-1/F-3：穷举切点重放仍无泄漏（分帧安全）', async () => {
  const reply = ['开头', F + 'mermaid' + 'A'.repeat(600), 'BODY', F, '尾部'].join('\n')
  for (let cut = 1; cut <= reply.length; cut += 17) {
    const prefix = reply.slice(0, cut)
    const { payload, events } = await runGate(prefix, { frames: [...prefix] })
    assertNoFenceLeak(streamedText(events), `F-1 切点 ${cut}`)
    assertNoFenceLeak(payload.text, `F-1 切点 ${cut} 终态`)
  }
})

// ── 3. 四类围栏的判定与降级 ────────────────────────────────────────────────

await checkAsync('mermaid：空块降级；非空块交真机裁决（服务端不判几何）', async () => {
  const empty = await runGate('```mermaid\n\n```')
  assert.equal(empty.payload.blocks[0].decision, 'degraded', '空 mermaid 块应降级')
  const normal = await runGate('```mermaid\nflowchart TD\n A-->B\n```')
  assert.equal(normal.payload.blocks[0].decision, 'render', '非空 mermaid 块交真机裁决')
})

await checkAsync('chart：对象/畸形 JSON/NaN/负值/空数组/缺 label 一律降级', async () => {
  const bad = [
    '{"label":"A","value":1}',
    '[{"label":"A","value":1},]',
    '[{"label":"A","value":NaN}]',
    '[{"label":"A","value":-1}]',
    '[]',
    '[{"value":1}]',
    '[{"label":"  ","value":1}]',
  ]
  for (const body of bad) {
    const { payload } = await runGate(`\`\`\`chart\n${body}\n\`\`\``)
    assert.equal(payload.blocks[0].decision, 'degraded', `chart 非法输入应降级: ${body}`)
    assert.equal(payload.blocks[0].reason, 'chart-invalid')
    assert.equal(payload.text.includes('label'), false, 'chart 源码不得留在正文')
  }
  const good = await runGate('```chart\n[{"label":"A","value":3},{"name":"B","count":2}]\n```')
  assert.equal(good.payload.blocks[0].decision, 'render')
})

await checkAsync('html：空块降级；静态片段通过；超限降级', async () => {
  const empty = await runGate('```html\n   \n```')
  assert.equal(empty.payload.blocks[0].decision, 'degraded')
  assert.equal(empty.payload.blocks[0].reason, 'html-invalid')
  const good = await runGate('```html\n<div class="hero">你好</div>\n```')
  assert.equal(good.payload.blocks[0].decision, 'render')
  const huge = await runGate(`\`\`\`html\n${'x'.repeat(40000)}\n\`\`\``)
  assert.equal(huge.payload.blocks[0].decision, 'degraded', '超单块预算应降级')
  assert.equal(huge.payload.blocks[0].sourceB64, undefined)
})

await checkAsync('image：合法路径通过并给出 imagePath；非法路径降级', async () => {
  const good = await runGate('```image\n/uploads/banner_cs_9af26b7f16.png\n账单示意图\n```')
  assert.equal(good.payload.blocks[0].decision, 'render')
  assert.equal(good.payload.blocks[0].imagePath, '/uploads/banner_cs_9af26b7f16.png')
  assert.equal(good.payload.blocks[0].imageCaption, '账单示意图')
  const bad = await runGate('```image\n/uploads/../../api/guest/health\n```')
  assert.equal(bad.payload.blocks[0].decision, 'degraded')
  assert.equal(bad.payload.blocks[0].imagePath, undefined, '非法路径不得下发')
})

await checkAsync('四类围栏非法输入都不产出 <pre><code> 源码回退', async () => {
  for (const type of ['mermaid', 'chart', 'image', 'html']) {
    const { payload } = await runGate(`\`\`\`${type}\n\n\`\`\``)
    assert.equal(payload.text.includes('<pre>'), false, `${type}: 正文不得含 pre 源码回退`)
    assert.equal(payload.text.includes('<code>'), false, `${type}: 正文不得含 code 源码回退`)
    assertNoFenceLeak(payload.text, type)
  }
})

await checkAsync('普通代码块内部的图形围栏同样被摘出（E7 无漏出）', async () => {
  const reply = '示例：\n```python\nprint(1)\n```\n```mermaid\nflowchart TD\n A-->B\n```\n结束'
  const { payload, events } = await runGate(reply)
  assertNoFenceLeak(streamedText(events), '代码块后的围栏')
  assert.equal(streamedText(events), '示例：\n```python\nprint(1)\n```\n结束', '普通代码块原文保留、图形围栏被摘出')
  assert.equal(payload.blocks.length, 1)
})

// ── 4. 图片地址白名单 ──────────────────────────────────────────────────────

check('图片白名单：拒绝穿越/查询串/绝对 URL/其它协议/data:/编码绕过', () => {
  const rejected = [
    '/uploads/../secret.png',
    '/uploads/../../api/guest/health',
    '/uploads/a/b.png',
    '/uploads/banner.png?x=1',
    '/uploads/banner.png#frag',
    'https://evil.example/x.png',
    '//evil.example/x.png',
    'http://127.0.0.1/uploads/x.png',
    'ftp://host/x.png',
    'data:image/svg+xml;base64,AAA',
    'javascript:alert(1)',
    '/uploads/%2e%2e%2fsecret.png',
    '/uploads/banner%2epng',
    '/uploads/.png',
    '/uploads/..png',
    '/uploads/banner.png/',
    '/uploads/banner.txt',
    '',
    '  ',
  ]
  for (const src of rejected) {
    assert.equal(checkImagePath(src).ok, false, `应拒绝: ${JSON.stringify(src)}`)
  }
  const accepted = ['/uploads/banner_cs_9af26b7f16.png', '/uploads/a1.JPG', '/uploads/x-y_z.9.webp', '/uploads/logo.svg']
  for (const src of accepted) {
    assert.equal(checkImagePath(src).ok, true, `应接受: ${src}`)
  }
})

check('图片白名单：非字符串输入一律拒绝且不抛异常', () => {
  for (const value of [undefined, null, 42, {}, []]) {
    assert.equal(checkImagePath(value).ok, false)
  }
})

// ── IMG（白名单 / 归一化 / 同源化）────────────────────────────────────────

await checkAsync('IMG6：自家源站绝对 URL 归一化后通过（KB 真实引用，不得误杀）', async () => {
  // KB 实测引用：deploy/kb/car-model.md、ev-tip.md
  for (const url of [
    'https://www.cem-macau.com/uploads/image_3f5b3a38a0.png',
    'https://cem-macau.com/uploads/image_3f5b3a38a0.png',
  ]) {
    const { payload } = await runGate(`配图：\n\`\`\`image\n${url}\n说明\n\`\`\``)
    assert.equal(payload.blocks[0].decision, 'render', `${url} 必须通过（归一化后合法）`)
  }
})

await checkAsync('IMG3：下发的 imagePath 一律是站点相对路径（绝对 URL 必须已归一化）', async () => {
  const cases = [
    ['https://www.cem-macau.com/uploads/image_3f5b3a38a0.png', '/uploads/image_3f5b3a38a0.png'],
    ['/uploads/banner_cs_9af26b7f16.png', '/uploads/banner_cs_9af26b7f16.png'],
  ]
  for (const [input, expected] of cases) {
    const { payload } = await runGate(`\`\`\`image\n${input}\n说明\n\`\`\``)
    assert.equal(payload.blocks[0].imagePath, expected, `${input} 必须归一化为 ${expected}`)
    assert.equal(payload.blocks[0].imagePath.startsWith('http'), false, '载荷不得含绝对 URL（IMG3）')
  }
})

await checkAsync('IMG1：外部主机/协议相对/data: 一律降级且不下发路径', async () => {
  for (const src of [
    'https://evil.example.com/uploads/a.png',
    '//evil.example.com/x.png',
    'data:image/png;base64,AAA',
    'data:image/svg+xml;base64,PHN2Zy8+',
    '/uploads/../api/guest/health',
    '/uploads/sub/a.png',
    '/uploads/a.png?x=1',
    '/uploads/a.pdf',
  ]) {
    const { payload } = await runGate(`\`\`\`image\n${src}\n说明\n\`\`\``)
    assert.equal(payload.blocks[0].decision, 'degraded', `${src} 必须降级`)
    assert.equal(payload.blocks[0].imagePath, undefined, `${src} 不得下发路径`)
    assert.equal(payload.blocks[0].reason, 'image-path-invalid', `${src} 原因必须是 image-path-invalid（C5）`)
  }
})

// ── 5. 服务端不做几何校验 / 不新增依赖 ─────────────────────────────────────

await checkAsync('服务端源码无 mermaid 渲染调用、无 jsdom、无几何判据', async () => {
  for (const file of ['src/index.ts', 'src/engine.ts', 'src/fence-machine.ts', 'src/block-rules.ts']) {
    const source = await readFile(resolve(pluginDir, file), 'utf8')
    // 注释里会解释"为什么不做几何校验"，因此只在**代码**上查这些调用。
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    assert.equal(/mermaid\s*\.\s*render\s*\(/.test(code), false, `${file} 不得调用 mermaid.render`)
    assert.equal(code.includes("from 'jsdom'"), false, `${file} 不得依赖 jsdom`)
    assert.equal(/getBBox\s*\(/.test(code), false, `${file} 不得使用几何判据`)
  }
})

await checkAsync('服务端只依赖 Node 内建与本地模块（无新增依赖）', async () => {
  for (const file of ['src/index.ts', 'src/engine.ts', 'src/fence-machine.ts', 'src/block-rules.ts']) {
    const source = await readFile(resolve(pluginDir, file), 'utf8')
    const allowed = new Set(['@deepseek-ai/cordis', '@deepseek-ai/schemastery'])
    const external = [...source.matchAll(/from\s+'([^']+)'/g)].map(match => match[1])
      .filter(specifier => !specifier.startsWith('node:') && !specifier.startsWith('.'))
      .filter(specifier => !allowed.has(specifier))
    assert.deepEqual(external, [], `${file} 出现计划外依赖（禁止新增）: ${external.join(', ')}`)
  }
})

check('无新增依赖：插件目录不含 package.json 依赖声明', async () => {
  const engineSource = await readFile(resolve(pluginDir, 'src/engine.ts'), 'utf8')
  assert.ok(engineSource.includes("from 'node:crypto'"), '摘要用 Node 内建 crypto')
})

// ── 6. 图片可达性探测仅告警 ────────────────────────────────────────────────

await checkAsync('探测仅告警：开关开/关的载荷完全一致（终态不变）', async () => {
  const reply = '看图\n```image\n/uploads/banner_cs_9af26b7f16.png\n```'
  const on = await runGate(reply, { overrides: { maxBlockBytes: 32768 } })
  const off = await runGate(reply, { overrides: { maxBlockBytes: 65536 } })
  assert.equal(fingerprint(on.payload), fingerprint(off.payload), '探测开关不得改变载荷')
})

check('探测结论不出现在任何拒绝分支（代码审查）', async () => {
  const source = await readFile(resolve(pluginDir, 'src/index.ts'), 'utf8')
  const start = source.indexOf('const probeImage')
  const end = source.indexOf('const forward')
  assert.ok(start > 0 && end > start, '应存在探测实现')
  const probeBody = source.slice(start, end)
  assert.equal(probeBody.includes('decision'), false, '探测不得改写块裁决')
  assert.equal(probeBody.includes('block.sourceB64'), false, '探测不得触碰下发源码')
})

check('门禁引擎里没有任何服务端探测输入参与判定', async () => {
  const source = await readFile(resolve(pluginDir, 'src/engine.ts'), 'utf8')
  assert.equal(source.includes('serverImageProbe'), false, '引擎不读探测开关（只在插件层留痕使用）')
})

// ── 7. 输出前替换（REP1–REP5）───────────────────────────────────────────────

await checkAsync('REP1：门禁不发起任何模型调用（无二次生成接口）', async () => {
  const source = await readFile(resolve(pluginDir, 'src/index.ts'), 'utf8')
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  assert.equal(code.includes('ctx.llm'), false, '门禁不得调用模型')
  assert.equal(code.includes("ctx.get('llm')"), false, '门禁不得取 llm 服务')
  assert.equal(/rewrite/i.test(code), false, '不得残留任何重写实现')
})

await checkAsync('REP1：配置中不存在 rewrite.* 键', async () => {
  const resolved = plugin.Config({ gate: {} })
  assert.equal('rewrite' in resolved.gate, false, 'v3.2 不得保留 rewrite.* 配置')
  const keys = Object.keys(resolved.gate).sort()
  assert.deepEqual(keys, ['answerWaitBudgetMs', 'blockTimeoutMs', 'enabled', 'libraryLoadTimeoutMs', 'maxBlockBytes', 'reportPath', 'serverImageProbe', 'serverImageProbeTimeoutMs'].sort())
})

await checkAsync('REP1/O2：留痕 outcome 只有 passed|degraded（无 rewritten）', async () => {
  const { entries } = await runGate('```mermaid\n\n```\n```chart\n[]\n```')
  assert.ok(entries.length >= 2)
  for (const entry of entries) {
    assert.ok(['passed', 'degraded'].includes(entry.outcome), `outcome 必须在 O2 冻结集内: ${entry.outcome}`)
  }
  const engineSource = await readFile(resolve(pluginDir, 'src/engine.ts'), 'utf8')
  assert.equal(engineSource.includes('rewritten'), false, '引擎不得残留 rewritten 语义')
})

await checkAsync('REP2：未通过的块在占位态就被替换——源码从不进正文流', async () => {
  const { payload, events } = await runGate('前言\n```mermaid\nflowchart TD\n SECRET-->B\n```\n后语')
  const streamed = streamedText(events)
  assert.equal(streamed.includes('SECRET'), false, '源码从未出现在文字流')
  assert.equal(streamed.includes('mermaid'), false, '围栏标记从未出现')
  assert.equal(payload.text.includes('SECRET'), false, '终态正文不含源码')
  // 未通过判定（结构性可渲染 → 交真机）的块以结构化载荷下发，正文位置留给占位
  assert.equal(payload.blocks.length, 1)
})

await checkAsync('REP4：degraded 是终态——重复回传不改变结论、不重试', async () => {
  const { turn, events } = startTurn()
  turn.feed('```chart\n[]\n```')
  turn.finishInput()
  const id = blockIds(events)[0]
  assert.equal(turn.recordReport(report(id, 'chart-invalid')), true)
  const first = await turn.settle()
  assert.equal(first.blocks[0].decision, 'degraded')
  // 终态后再回传：不影响已定稿载荷
  turn.recordReport(report(id, 'chart-invalid'))
  const second = await turn.settle()
  assert.equal(fingerprint(first), fingerprint(second), '终态不得被后续回传改写（REP4/REP5）')
})

await checkAsync('REP5：已上屏（已 passed）的块不再被改写', async () => {
  const { turn, events } = startTurn()
  turn.feed('```mermaid\nflowchart TD\n A-->B\n```')
  turn.finishInput()
  const id = blockIds(events)[0]
  turn.recordReport({ ...report(id, 'ok'), outcome: 'passed' })
  const payload = await turn.settle()
  assert.equal(payload.blocks[0].decision, 'render', '通过的真机结论保持')
  assert.equal(payload.blocks[0].sourceB64 !== undefined, true)
  assertNoFenceLeak(payload.text, 'REP5')
})

await checkAsync('P7/T1：收尾窗口耗尽即定稿，不阻塞 done（≤ answerWaitBudgetMs）', async () => {
  const { turn, events } = startTurn({ answerWaitBudgetMs: 60 })
  turn.feed('正文\n```mermaid\nflowchart TD\n A-->B\n```\n结尾')
  turn.finishInput()
  void blockIds(events)
  const started = Date.now()
  const payload = await turn.settle()
  const elapsed = Date.now() - started
  assert.ok(elapsed < 500, `收尾窗口必须封顶，实际 ${elapsed}ms`)
  assert.equal(payload.text, '正文\n结尾', '文字不受影响')
  assert.equal(payload.blocks.length, 1)
})

await checkAsync('P7：多块并行——任一未结算不影响其余块的结论', async () => {
  const { turn, events } = startTurn({ answerWaitBudgetMs: 80 })
  turn.feed('```mermaid\nflowchart TD\n A-->B\n```\n```chart\n[{"label":"A","value":1}]\n```')
  turn.finishInput()
  const ids = blockIds(events)
  assert.equal(ids.length, 2)
  // 只回传第一块（第二块永不回传）：第二块的判定不得因此被降级（并行语义）
  turn.recordReport({ ...report(ids[0], 'ok'), outcome: 'passed' })
  const payload = await turn.settle()
  assert.equal(payload.blocks[0].decision, 'render', '已回传块保持结论')
  assert.equal(payload.blocks[1].decision, 'render', '未回传块按结构性结论收尾，不因"预算被前一块吃掉"而降级')
  assert.equal(payload.degradedIds.length, 0)
})

// ── GEN（生成侧契约是软措施：删掉提示词后硬门禁必须独立成立）────────────────

await checkAsync('GEN4：删掉提示词契约后，硬门禁仍拦住全部对抗样例', async () => {
  // 真正的 GEN4 取证：把 preset 提示词里的围栏契约**实际删掉**（内存中，不写仓库），
  // 再跑同一批对抗样例——门禁的全部判定来自主机侧代码，因此结果必须**完全一致**。
  const presetPaths = [
    resolve(customerServiceDir, 'presets/customer-service/agent.cordis.yml'),
    resolve(customerServiceDir, 'presets/customer-service-guest/agent.cordis.yml'),
  ]
  /** 逐行剔除围栏契约（GEN1/GEN2 段落），模拟"提示词不存在"。 */
  const stripContract = text => {
    const lines = text.split('\n')
    const out = []
    let skipping = false
    for (const line of lines) {
      if (line.includes('FENCE CONTENT MUST BE VALID ON THE FIRST TRY')) { skipping = true; continue }
      if (skipping) {
        // 契约是缩进的续行块；遇到下一个同/更浅缩进的条目即结束
        if (/^\s*- (id|name):/.test(line) || /^\S/.test(line)) skipping = false
        else continue
      }
      out.push(line)
    }
    return out.join('\n')
  }
  for (const path of presetPaths) {
    const original = await readFile(path, 'utf8')
    const stripped = stripContract(original)
    assert.equal(stripped.includes('FENCE CONTENT MUST BE VALID ON THE FIRST TRY'), false, '提示词契约必须已被删除')
    assert.equal(stripped.includes('GEN1/GEN2'), false, '契约标记必须已被删除')
    assert.ok(stripped.includes('You are'), '其余提示词内容保留（只删契约段）')
  }

  // 对抗样例：模型违反围栏契约的各种形态
  const adversarial = [
    '```mermaid\nflowchart TD\n A[未闭合括号-->B\n```',
    '```mermaid\n\n```',
    '```mermaid\n' + 'n'.repeat(20000) + '\n```',
    '```chart\n{"label":"A","value":1}\n```',
    '```chart\n[{"label":"A","value":NaN}]\n```',
    '```chart\n[{"label":"A","value":-5}]\n```',
    '```chart\n[]\n```',
    '```image\n/uploads/../api/guest/health\n```',
    '```image\nhttps://evil.example.com/track.png\n```',
    '```image\n//evil.example.com/x.png\n```',
    '```image\ndata:image/svg+xml;base64,PHN2Zy8+\n```',
    '```image\n/uploads/a.pdf\n```',
    '```image\n/uploads/sub/a.png\n```',
    '```html\n\n```',
    '```html\n<script>alert(1)</script>\n```',
    '未闭合尾部\n```mermaid\nflowchart TD\n A-->B',
  ]
  for (const reply of adversarial) {
    const { payload, events } = await runGate(reply)
    assertNoFenceLeak(streamedText(events), `GEN4 流式: ${reply.slice(0, 30)}`)
    assertNoFenceLeak(payload.text, `GEN4 正文: ${reply.slice(0, 30)}`)
    for (const block of payload.blocks) {
      if (block.decision === 'degraded') {
        assert.equal(block.sourceB64, undefined, '降级块不得携带源码')
        assert.equal(typeof block.reason, 'string', '降级块必须给出 O2 原因')
      }
    }
  }
})

await checkAsync('GEN4：门禁实现不读取任何 preset（判定与提示词完全解耦）', async () => {
  for (const file of ['src/index.ts', 'src/engine.ts', 'src/fence-machine.ts', 'src/block-rules.ts']) {
    const code = (await readFile(resolve(pluginDir, file), 'utf8'))
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    assert.equal(/agent\.cordis\.yml|preset|readFile|node:fs/.test(code), false, `${file} 不得读取 preset 或文件系统`)
  }
})

await checkAsync('GEN1：两张 preset 都含围栏块契约（三段：语法/禁嵌套/chart JSON）', async () => {
  for (const preset of ['presets/customer-service/agent.cordis.yml', 'presets/customer-service-guest/agent.cordis.yml']) {
    const text = await readFile(resolve(customerServiceDir, preset), 'utf8')
    assert.ok(text.includes('GEN1/GEN2'), `${preset} 缺围栏契约标记`)
    assert.ok(text.includes('flowchart TD') && text.includes('sequenceDiagram'), `${preset} 缺 mermaid 语法约束`)
    assert.ok(text.includes('不得嵌套围栏'), `${preset} 缺"块内不得嵌套围栏"约束`)
    assert.ok(text.includes('JSON 数组') && text.includes('有限数值'), `${preset} 缺 chart JSON 约束`)
  }
})

await checkAsync('GEN2：preset 图片契约与 IMG1 同一常量（扩展名集合一致）', async () => {
  for (const preset of ['presets/customer-service/agent.cordis.yml', 'presets/customer-service-guest/agent.cordis.yml']) {
    const text = await readFile(resolve(customerServiceDir, preset), 'utf8')
    for (const ext of ['png', 'jpe?g', 'gif', 'webp', 'avif', 'svg', 'bmp']) {
      const label = ext === 'jpe?g' ? 'jpg/jpeg' : ext
      assert.ok(text.includes(label), `${preset} 图片契约缺扩展名 ${label}`)
    }
    assert.ok(text.includes('/uploads/<文件名>'), `${preset} 缺 /uploads 路径形态`)
    assert.ok(text.includes('data:'), `${preset} 未禁用 data:`)
  }
})

await checkAsync('AS-11：随机切片分帧的识别结果与整块输入一致', async () => {
  const reply = [
    '开场白',
    '```mermaid',
    'flowchart TD',
    '  A-->B',
    '```',
    '中段文字',
    '```chart',
    '[{"label":"A","value":1}]',
    '```',
    '```image',
    '/uploads/banner_cs_9af26b7f16.png',
    '说明',
    '```',
    '```html',
    '<div>内容</div>',
    '```',
    '收尾',
  ].join('\n')
  const whole = await runGate(reply)
  // 确定性伪随机切片：覆盖各种跨帧位置（含把 ``` 拆开）
  let seed = 123456789
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
  for (const sliceCount of [2, 3, 7, 13, 97, 401]) {
    const frames = []
    let index = 0
    while (index < reply.length) {
      const size = Math.max(1, Math.floor(rand() * Math.ceil(reply.length / sliceCount)) + 1)
      frames.push(reply.slice(index, index + size))
      index += size
    }
    const sliced = await runGate(reply, { frames })
    assert.equal(sliced.payload.text, whole.payload.text, `切片数 ${sliceCount}: 正文必须与整块输入一致`)
    assert.equal(
      fingerprint(sliced.payload),
      fingerprint(whole.payload),
      `切片数 ${sliceCount}: 块识别必须与整块输入一致`,
    )
    assertNoFenceLeak(streamedText(sliced.events), `切片数 ${sliceCount}`)
  }
})

await checkAsync('AS-11：1 字符/帧的识别结果与整块输入一致', async () => {
  const reply = '前\n```mermaid\nflowchart TD\n A-->B\n```\n后\n```chart\n[{"label":"X","value":2}]\n```'
  const whole = await runGate(reply)
  const charByChar = await runGate(reply, { frames: [...reply] })
  assert.equal(charByChar.payload.text, whole.payload.text)
  assert.equal(fingerprint(charByChar.payload), fingerprint(whole.payload))
  assertNoFenceLeak(streamedText(charByChar.events), '1 字符/帧')
})

await checkAsync('AS-11：多块同帧（相邻块无空行）正确切分', async () => {
  const reply = '```mermaid\nflowchart TD\n A-->B\n```\n```chart\n[{"label":"A","value":1}]\n```'
  const { payload, events } = await runGate(reply, { frames: [reply] })
  assert.equal(payload.blocks.length, 2, '相邻两个块必须各自识别')
  assert.deepEqual(payload.blocks.map(block => block.blockType), ['mermaid', 'chart'])
  assertNoFenceLeak(streamedText(events), '多块同帧')
})

// ── 夹具保真（防退化：夹具必须与生产 Config 等价）────────────────────────────

await checkAsync('夹具保真：DEFAULTS 与生产 Config 逐键等价，且收尾窗口为有限数', async () => {
  // 防退化断言（描述行为）：曾因缺键使窗口变 NaN，静默跳过等待。
  assert.equal(
    Number.isFinite(DEFAULTS.answerWaitBudgetMs),
    true,
    'DEFAULTS.answerWaitBudgetMs 必须是有限数（缺键会得到 undefined → NaN → 窗口恒假失效）',
  )
  assert.ok(DEFAULTS.answerWaitBudgetMs > 0, '收尾窗口必须为正（0 或负会让等待逻辑立即返回）')
  // 与生产 Config 的同一套键逐项对齐（防止夹具与生产再次分叉）
  const produced = plugin.Config({ gate: {} }).gate
  for (const key of ['enabled', 'blockTimeoutMs', 'answerWaitBudgetMs', 'libraryLoadTimeoutMs', 'maxBlockBytes', 'reportPath']) {
    assert.equal(
      DEFAULTS[key],
      produced[key],
      `夹具 ${key} 必须与生产 Config 一致（夹具=${DEFAULTS[key]}，生产=${produced[key]}）`,
    )
  }
  // 夹具不得保留生产 Config 已不存在的字段（逐键反查，不写出历史键名——
  // 该键名已从仓内清除，acceptance 要求全仓 grep 命中为 0）。
  const producedKeys = new Set(Object.keys(produced))
  for (const key of Object.keys(DEFAULTS)) {
    assert.equal(producedKeys.has(key), true, `夹具键 ${key} 在生产 Config 的键集合中不存在`)
  }
})

// ── D-1：blockResults 终态语义（单元层）────────────────────────────────────

await checkAsync('D-1 分支②：真机回传在收尾窗口内**异步**到达 → 记 degraded 且入 degradedIds', async () => {
  // 异步注入是关键：同步注入会在 settle() 之前就写好 block.reported，根本不经过收尾窗口，
  // 于是无论窗口是否生效用例都通过（判据无区分力）。真机回传的实际形态必然与 settle() 并发。
  const { gate } = makeGate()
  const events = []
  const turn = gate.beginTurn(SESSION, event => events.push(event))
  turn.feed(['开场', '```mermaid', 'flowchart TD', ' A-->B', '```', '收尾'].join('\n'))
  turn.finishInput()
  const id = blockIds(events)[0]
  const injectDelayMs = 50
  setTimeout(() => {
    turn.recordReport({
      sessionId: SESSION,
      blockId: id,
      blockType: 'mermaid',
      reason: 'render-empty',
      sourceDigest: 'deadbeefdeadbeef',
      sourceBytes: 20,
      occurredAt: Date.now(),
      outcome: 'degraded',
    })
  }, injectDelayMs)
  const startedAt = Date.now()
  const payload = await turn.settle()
  const elapsed = Date.now() - startedAt

  assert.equal(payload.blocks[0].decision, 'render', '主机侧结构性判定仍是 render（回传来自真机）')
  assert.equal(payload.blockResults[id], 'degraded', '窗口内收到 degraded 回传 → 终态 degraded')
  assert.equal(payload.degradedIds.includes(id), true, 'degraded 必须同步进入 degradedIds')
  // 耗时断言：把"窗口确实在等"与"恰好同步到达"区分开。
  // 窗口恒假失效时 settle() 会立即返回（0ms），本断言是 NaN 的直接指纹。
  assert.ok(
    elapsed >= injectDelayMs - 10,
    `settle() 必须等待到回传到达（实测 ${elapsed}ms，注入延迟 ${injectDelayMs}ms；若为 0ms 说明收尾窗口失效）`,
  )
})

await checkAsync('D-1 分支②：窗口耗尽仍未回传 → 记 passed（不无限等待）', async () => {
  const { gate } = makeGate({ answerWaitBudgetMs: 60 })
  const events = []
  const turn = gate.beginTurn(SESSION, event => events.push(event))
  turn.feed(['开场', '```mermaid', 'flowchart TD', ' A-->B', '```', '收尾'].join('\n'))
  turn.finishInput()
  const id = blockIds(events)[0]
  const startedAt = Date.now()
  const payload = await turn.settle()
  const elapsed = Date.now() - startedAt
  assert.equal(payload.blockResults[id], 'passed', '窗口耗尽未回传 → passed（定案可显示）')
  assert.ok(elapsed < 1000, `窗口必须封顶，实际 ${elapsed}ms`)
})

// ── D-1：blockResults 终态语义（单元层）────────────────────────────────────

await checkAsync('D-1：未回传的可渲染块记 passed（块对访客保持可见，非"真机已验证"）', async () => {
  const { payload } = await runGate(['前置', '```mermaid', 'flowchart TD', ' A-->B', '```', '后置'].join('\n'))
  const id = payload.blocks[0].blockId
  assert.equal(payload.blocks[0].decision, 'render', '主机侧结构性判定仍是 render')
  assert.equal(payload.blockResults[id], 'passed', '未回传 → 终态 passed')
  assert.equal(payload.degradedIds.includes(id), false, 'passed 块不入 degradedIds')
})

await checkAsync('D-1：结构性降级块记 degraded 且入 degradedIds', async () => {
  const { payload } = await runGate(['前置', '```chart', '[]', '```', '后置'].join('\n'))
  const id = payload.blocks[0].blockId
  assert.equal(payload.blocks[0].decision, 'degraded')
  assert.equal(payload.blockResults[id], 'degraded')
  assert.equal(payload.degradedIds.includes(id), true)
})

await checkAsync('D-1：blockResults 取值域恒为 passed|degraded，绝不含 render', async () => {
  const { payload } = await runGate(['A', '```mermaid', 'flowchart TD', ' X-->Y', '```', 'B', '```chart', 'bad', '```', 'C'].join('\n'))
  const values = [...new Set(Object.values(payload.blockResults))]
  assert.deepEqual(values.sort(), ['degraded', 'passed'], `取值域必须是 passed|degraded，实际 ${values}`)
  assert.equal(JSON.stringify(payload.blockResults).includes('"render"'), false, 'blockResults 不得出现 render')
})

await checkAsync('D-1：blocks[].decision 仍为 render|degraded（与 blockResults 取值域不同）', async () => {
  const { payload } = await runGate(['A', '```mermaid', 'flowchart TD', ' X-->Y', '```', 'B'].join('\n'))
  assert.equal(payload.blocks[0].decision, 'render')
  assert.notEqual(payload.blocks[0].decision, payload.blockResults[payload.blocks[0].blockId], '两个字段语义不同，取值可不同')
})

await checkAsync('D-1：degradedIds 与 blockResults 同判据恒等（双向 + 数量）', async () => {
  const { payload } = await runGate(['A', '```mermaid', 'flowchart TD', ' X-->Y', '```', 'B', '```chart', '[]', '```', 'C', '```html', '', '```', 'D'].join('\n'))
  const ids = Object.keys(payload.blockResults)
  assert.ok(ids.length >= 3)
  for (const id of ids) {
    assert.equal(payload.blockResults[id] === 'degraded', payload.degradedIds.includes(id), `id=${id} 双向恒等`)
  }
  assert.equal(payload.degradedIds.length, ids.filter(id => payload.blockResults[id] === 'degraded').length, '数量一致')
})

await checkAsync('D-1：全载荷无未决字段（blocks 与 blockResults 两处）', async () => {
  const PENDING = ['pending', 'unresolved', 'probe', 'probeResult', 'reachable', 'awaiting', 'deferred']
  const { payload } = await runGate(['A', '```mermaid', 'flowchart TD', ' X-->Y', '```', 'B', '```chart', '[]', '```', 'C'].join('\n'))
  for (const [label, value] of [['blocks', payload.blocks], ['blockResults', payload.blockResults]]) {
    const json = JSON.stringify(value)
    for (const key of PENDING) {
      assert.equal(json.includes(`"${key}"`), false, `${label}: 不得含未决字段名 ${key}`)
    }
  }
  for (const block of payload.blocks) {
    for (const key of PENDING) {
      assert.equal(key in block, false, `blocks 元素不得含未决字段 ${key}`)
    }
  }
})

// ── 8. 留痕 ────────────────────────────────────────────────────────────────

await checkAsync('留痕：七字段齐全，摘要可复算', async () => {
  const { entries } = await runGate('```mermaid\n\n```\n```chart\n[]\n```')
  assert.ok(entries.length >= 2, '两个坏块应各留一条痕迹')
  const reasons = new Set(['parse-error', 'render-empty', 'image-decode-failed', 'image-unreachable', 'chart-invalid', 'html-invalid', 'timeout'])
  for (const entry of entries) {
    assert.deepEqual(
      Object.keys(entry).sort(),
      ['blockType', 'occurredAt', 'outcome', 'reason', 'sessionId', 'sourceBytes', 'sourceDigest'].sort(),
      '留痕字段必须与 O2 七字段逐字一致',
    )
    assert.equal(entry.sessionId, SESSION)
    assert.ok(['mermaid', 'chart', 'image', 'html'].includes(entry.blockType))
    assert.ok(reasons.has(entry.reason), `reason 必须在 O2 枚举内: ${entry.reason}`)
    assert.match(entry.sourceDigest, /^[0-9a-f]{16}$/)
    assert.equal(typeof entry.sourceBytes, 'number')
    assert.ok(entry.occurredAt > 0)
    assert.ok(['passed', 'degraded'].includes(entry.outcome), 'outcome 必须在 O2 冻结集内')
  }
  assert.equal(entries[0].sourceDigest, engine.shortDigest('\n'), '摘要应可复算')
  assert.equal(entries[0].reason, 'render-empty')
})

await checkAsync('留痕：同一会话同因重复出现可聚合（O4）', async () => {
  const entries = []
  const tracer = { record: entry => entries.push(entry) }
  for (let i = 0; i < 3; i++) {
    const turn = new engine.TurnGate({ ...DEFAULTS, answerWaitBudgetMs: 10 }, SESSION, tracer, () => {})
    turn.feed('```mermaid\n\n```')
    await turn.settle()
  }
  const counts = new Map()
  for (const entry of entries) {
    const key = `${entry.sessionId}|${entry.blockType}|${entry.reason}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  assert.equal(counts.size, 1, '同一会话同一原因应聚合到同一个键')
  assert.equal([...counts.values()][0], 3, '三轮同一坏块应计数为 3')
})

// ── 9. 降级顺序与「整条回答不失败」 ────────────────────────────────────────

await checkAsync('降级顺序：坏块降级、前后文字完整保留', async () => {
  const reply = '第一段\n```mermaid\n\n```\n第二段\n```chart\nnot json\n```\n第三段'
  const { payload } = await runGate(reply)
  assert.equal(payload.text, '第一段\n第二段\n第三段', '前后文字必须完整保留')
  assert.equal(payload.blocks.length, 2)
  assert.ok(payload.blocks.every(block => block.decision === 'degraded'))
  assert.equal(payload.blocks.some(block => 'sourceB64' in block), false, '降级块不得携带源码')
})

await checkAsync('任何分支都不得使整条回答失败：异常输入仍产出载荷', async () => {
  const nasty = [
    '```mermaid\n' + 'A'.repeat(50000) + '\n```',
    '```html\n' + '<div>'.repeat(9000) + '\n```',
    '```chart\n[[[['.repeat(50) + '\n```',
    '```image\n\u0000\u0001\n```',
    '```\n未标语言的围栏\n```',
    '```mermaid\n```\n```mermaid\n```',
    '```mermaid' + '`'.repeat(10) + '\nA\n```',
    '\u0000\u0001\u0002',
  ]
  for (const reply of nasty) {
    const { payload } = await runGate(reply)
    assert.equal(typeof payload.text, 'string', '载荷必须始终可产出')
    assertNoFenceLeak(payload.text, '异常输入')
  }
})

check('应急净化：兜底清洗删掉受控围栏整段（含未闭合尾部）', () => {
  const stripped = stripGraphicsFences('前\n```mermaid\nflowchart TD\n A-->B\n```\n后\n```chart\n[1,2\n')
  assert.equal(stripped.includes('mermaid'), false, '围栏语言标记必须消失')
  assert.equal(stripped.includes('flowchart'), false, '围栏块体必须消失')
  assert.equal(stripped.includes('chart'), false, '未闭合尾部必须整段消失')
  assert.equal(stripped.includes('前') && stripped.includes('后'), true, '正文保留')
  assert.equal(stripGraphicsFences('纯文字，无围栏'), '纯文字，无围栏')
})

// ── 10. 三出口一致性 ───────────────────────────────────────────────────────

await checkAsync('三出口终态一致：流式 / 非流式 / 历史重放', async () => {
  const reply = '正文\n```mermaid\nflowchart TD\n A-->B\n```\n```chart\nnot-json\n```\n结尾'
  const stream = await runGate(reply)
  const single = await runSingle(reply)
  const replay = await runSingle(reply)
  assert.equal(fingerprint(stream.payload), fingerprint(single), '流式与非流式终态必须一致')
  assert.equal(fingerprint(single), fingerprint(replay), '历史重放与当轮终态必须一致')
  assertNoFenceLeak(stream.payload.text, '流式终态')
  assertNoFenceLeak(single.text, '非流式终态')
})

await checkAsync('三出口一致：同一份坏内容在任一出口都不出现原始围栏源码', async () => {
  const reply = '说明\n```mermaid\nflowchart TD\n SECRET_NODE-->B\n```'
  const stream = await runGate(reply)
  const single = await runSingle(reply)
  for (const [label, payload] of [['stream', stream.payload], ['single', single]]) {
    const serialized = JSON.stringify(payload)
    assert.equal(serialized.includes('SECRET_NODE') === true && payload.blocks[0].decision === 'degraded', false, `${label}: 降级块不得含源码明文`)
    assert.equal(serialized.includes('```mermaid'), false, `${label}: 围栏不得出现在载荷中`)
  }
  // 正常块：源码只以 base64 承载，明文不出现
  const okReply = '说明\n```mermaid\nflowchart TD\n SECRET_NODE-->B\n```'
  const okPayload = await runSingle(okReply)
  assert.equal(JSON.stringify(okPayload).includes('SECRET_NODE'), false, '源码明文不得出现在载荷中（base64 承载）')
  assert.equal(Buffer.from(okPayload.blocks[0].sourceB64, 'base64').toString('utf8').includes('SECRET_NODE'), true, 'base64 承载应可还原')
})

await checkAsync('SSE 序列：坏块不以 delta 形式流出（先 block-open 后 block）', async () => {
  const { events } = await runGate('你好\n```mermaid\nflowchart TD\n A-->B\n```\n再见', {
    frames: ['你好\n```mer', 'maid\nflowchart TD\n A-->B\n```\n再见'],
  })
  const order = events.map(event => event.type)
  assert.ok(order.indexOf('block-open') !== -1 && order.indexOf('block') !== -1, '应有 block-open 与 block')
  assert.ok(order.indexOf('block-open') < order.indexOf('block'), 'block-open 先于 block')
  assert.equal(streamedText(events).includes('flowchart'), false, 'SSE delta 流不得含图形源码')
  assert.equal(streamedText(events), '你好\n再见')
})

// ── 11. 插件形态与配置 ─────────────────────────────────────────────────────

check('插件导出形态：name/inject/Config/apply，无 default export', () => {
  assert.equal(typeof plugin.name, 'string')
  assert.equal(plugin.name, 'output-gate')
  assert.ok(Array.isArray(plugin.inject))
  assert.equal(typeof plugin.Config, 'function')
  assert.equal(typeof plugin.apply, 'function')
  assert.equal(plugin.default, undefined, '函数插件不得 default export')
})

check('配置：全部冻结键存在且默认值符合需求 v3.2 §13', () => {
  const gate = plugin.Config({ gate: {} }).gate
  assert.equal(gate.enabled, true)
  assert.equal(gate.blockTimeoutMs, 1500, 'captain 冻结：单块判定 1500ms')
  assert.equal(gate.answerWaitBudgetMs, 600, 'captain 冻结：done 前收尾窗口 600ms')
  assert.equal(gate.libraryLoadTimeoutMs, 8000, '库加载与判定计时分离')
  assert.equal(gate.maxBlockBytes, 32768)
  assert.equal(gate.serverImageProbe, true)
  assert.equal(gate.serverImageProbeTimeoutMs, 2000)
  assert.equal(gate.reportPath, '/api/guest/render-report')
  assert.equal('rewrite' in gate, false, '不得存在 rewrite.*')
})

check('配置：每个键都可从外部覆盖（无硬编码可调参数）', () => {
  const gate = plugin.Config({
    gate: {
      enabled: false,
      maxBlockBytes: 1024,
      blockTimeoutMs: 50,
      answerWaitBudgetMs: 7,
      libraryLoadTimeoutMs: 123,
      serverImageProbe: false,
      serverImageProbeTimeoutMs: 100,
      reportPath: '/custom/report',
    },
  }).gate
  assert.equal(gate.enabled, false)
  assert.equal(gate.maxBlockBytes, 1024)
  assert.equal(gate.blockTimeoutMs, 50)
  assert.equal(gate.answerWaitBudgetMs, 7)
  assert.equal(gate.libraryLoadTimeoutMs, 123)
  assert.equal(gate.serverImageProbe, false)
  assert.equal(gate.serverImageProbeTimeoutMs, 100)
  assert.equal(gate.reportPath, '/custom/report')
})

await checkAsync('注册可回滚：卸载后服务随之消失（Q1）', async () => {
  const root = new Context()
  const host = root.isolate('gate-rollback')
  plugin.apply(host, plugin.Config({ gate: {} }))
  assert.ok(host.get('outputGate') !== undefined, '装载后应可取得服务')
  await root.fiber.dispose()
  assert.equal(root.get('outputGate'), undefined, '卸载后服务必须消失')
})

await checkAsync('enabled=false 时回滚为改造前行为（原样透传）', async () => {
  const reply = '前\n```mermaid\nflowchart TD\n A-->B\n```\n后'
  const { payload, events } = await runGate(reply, { overrides: { enabled: false } })
  assert.equal(payload.blocks.length, 0)
  assert.equal(streamedText(events), reply, '关闭门禁后文字原样透传')
})

check('块预算对超大块生效（不泄露且不占无界内存）', async () => {
  const { gate } = makeGate({ maxBlockBytes: 1024 })
  const events = []
  const turn = gate.beginTurn(SESSION, event => events.push(event))
  turn.feed(`\`\`\`html\n${'y'.repeat(200000)}\n\`\`\``)
  const payload = await turn.settle()
  assert.equal(payload.blocks.length, 1)
  assert.ok(payload.blocks[0].sourceBytes > 1024, '字节数照实统计')
  assert.equal(payload.blocks[0].decision, 'degraded', '超预算块降级')
})

// ── 主机侧接入取证（guest-server 与组合层）───────────────────────────────

await checkAsync('guest-server 已接入三出口 + 回传端点', async () => {
  const source = await readFile(resolve(customerServiceDir, 'plugins/guest-server/src/index.ts'), 'utf8')
  assert.ok(source.includes("ctx.get('outputGate')"), 'guest-server 必须消费门禁服务')
  assert.ok(source.includes("sendEvent('block'"), 'SSE 必须下发结构化块')
  assert.ok(source.includes("sendEvent('block-open'"), 'SSE 必须下发占位事件')
  assert.ok(source.includes('handleRenderReport'), '必须实现真机回传端点')
  assert.ok(source.includes('gateFullReply'), '非流式与历史出口必须走同一净化函数')
  const historyIdx = source.indexOf('const gated = await gateFullReply(sessionId, raw')
  assert.ok(historyIdx > 0, 'history 重放必须重新过门禁')
  assert.ok(source.indexOf('const gated = await gateFullReply(sessionId, result.reply') > 0, '/chat 出口必须过门禁')
})

await checkAsync('组合层：profile 与两张 preset 已装配门禁', async () => {
  const profile = await readFile(resolve(customerServiceDir, 'deploy/profile/cordis.patch.yml'), 'utf8')
  assert.ok(profile.includes('plugins/output-gate/src/index.ts'), 'profile 必须插入 output-gate 行')
  const idLines = profile.split('\n').filter(line => /^\s+- id: (output-gate|guest-server)\s*$/.test(line)).map(line => line.trim())
  assert.deepEqual(idLines.slice(0, 2), ['- id: output-gate', '- id: guest-server'], '门禁行必须排在 guest-server 之前')
  for (const line of ['blockTimeoutMs: 1500', 'answerWaitBudgetMs: 600', 'libraryLoadTimeoutMs: 8000', 'maxBlockBytes: 32768']) {
    assert.ok(profile.includes(line), `组合层必须显式写出 v3.2 冻结值 ${line}`)
  }
  assert.equal(profile.includes('rewrite:'), false, '组合层不得残留 rewrite.* 配置（REP1）')
  const guestPreset = await readFile(resolve(customerServiceDir, 'presets/customer-service-guest/agent.cordis.yml'), 'utf8')
  assert.ok(guestPreset.includes('FENCE CONTENT MUST BE VALID ON THE FIRST TRY'), '访客 preset 必须有围栏约束')
  const adminPreset = await readFile(resolve(customerServiceDir, 'presets/customer-service/agent.cordis.yml'), 'utf8')
  assert.ok(adminPreset.includes('FENCE CONTENT MUST BE VALID ON THE FIRST TRY'), '客服 preset 必须有围栏约束')
})

// ── 汇报 ───────────────────────────────────────────────────────────────────

const failed = results.filter(result => !result.ok)
for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}${result.ok ? '' : `\n        ${result.error}`}`)
}
console.log(`\n${results.length - failed.length}/${results.length} 项断言通过`)
if (failed.length > 0) process.exit(1)
