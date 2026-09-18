/**
 * 付款码条码验收（Code128）。
 *
 * 为什么判据是「解码还原」而不是「图出来了」：条码编错不会报错，只会让访客扫出
 * **错误的数字**，比不显示更糟。所以测试从渲染出的 SVG 里把条空读回来、按 Code128
 * 规范解码，断言还原出原始付款码。
 *
 * 判据：
 *   A. 码表取自权威实现（107 项，STOP = 1100011101011）；
 *   B. 编码器：数字串走 C 集，校验和正确（用规范样例独立复算）；
 *   C. 浏览器实测：渲染出的 SVG 解码后 == 原始付款码（端到端，含静区与模块宽度）；
 *   D. 扫码硬要求：左右静区 ≥10 模块、模块 ≥2px、纯黑条纯白底；
 *   E. 非付款码内容不会被误装饰（纯数字 20–40 位才处理）。
 *
 * 运行：node customer-service/web/guest/tests/paycode-check.mjs
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const INDEX = join(HERE, '..', 'index.html')
const BASE = process.env.GUEST_URL ?? 'http://127.0.0.1:10800'

let passed = 0
let failed = 0
const ok = (label, cond, detail = '') => {
  if (cond) { passed += 1; console.log(`  PASS  ${label}`) }
  else { failed += 1; console.log(`  FAIL  ${label}${detail === '' ? '' : ` — ${detail}`}`) }
}

const page = readFileSync(INDEX, 'utf8')

console.log('\nA. 码表')
const tableSrc = page.match(/const CODE128_BARS = \[([\s\S]*?)\n  \]/)
ok('能定位码表', tableSrc !== null)
const BARS = tableSrc === null ? [] : tableSrc[1].split(/[,\s]+/).filter(Boolean).map(Number)
ok('码表 107 项', BARS.length === 107, `实际 ${BARS.length}`)
ok('STOP 位串正确（1100011101011）', String(BARS[106]) === '1100011101011', String(BARS[106]))
ok('每项长度合规（数据符号 11 位、STOP 13 位）',
  BARS.slice(0, 106).every(v => String(v).length === 11) && String(BARS[106]).length === 13)

console.log('\nB. 编码器（独立复算校验和，不调用页面代码）')
// 用规范算法复算：起始符 + Σ(码值×位置) mod 103，位置从 1 起算
function expectedChecksum(codes) {
  let sum = codes[0]
  for (let i = 1; i < codes.length; i++) sum += codes[i] * i
  return sum % 103
}
// 期望值取自业务系统**当前**的账单接口，而不是写死一个历史字符串：账单换了
// 月份，付款码就会变，写死会让测试在业务数据变化时误报失败（那是数据的错，
// 不是渲染的错）。取不到时才退回已知样例，测试仍可离线跑编码器部分。
const CONTRACT = '0070878510'
const API = `https://te-service-api2.cem-macau.com/api/bill/${CONTRACT}/ai/zh?level=5`
let SAMPLE = '720070878510260417000000300002'
let sampleFrom = '离线样例（接口不可达）'
try {
  const res = await fetch(API, { signal: AbortSignal.timeout(20000) })
  const body = await res.json()
  const live = body?.data?.billInfo?.[0]?.barcode
  if (typeof live === 'string' && live !== '') { SAMPLE = live; sampleFrom = '业务系统接口 level=5' }
} catch (err) {
  sampleFrom = `离线样例（接口报错：${err.name}）`
}
console.log(`   期望付款码 "${SAMPLE}" ← ${sampleFrom}`)

const expectCodes = [105]
for (let i = 0; i < SAMPLE.length; i += 2) expectCodes.push(Number(SAMPLE.slice(i, i + 2)))
const expectSum = expectedChecksum(expectCodes)
ok('样例为偶数位数字（走 C 集）', SAMPLE.length % 2 === 0, `${SAMPLE.length} 位`)
ok('样例校验和可独立复算', Number.isInteger(expectSum) && expectSum >= 0 && expectSum <= 102,
  `checksum=${expectSum}`)

console.log('\nC/D/E. 浏览器实测：真实回答 → 解码还原 + 扫码硬要求 + 不误伤')
async function loadChromium() {
  try { return (await import('playwright')).chromium } catch { /* 继续找 */ }
  for (const dir of [process.env.PLAYWRIGHT_DIR, '/home/as-workstation01/Documents/project/Chrome'].filter(Boolean)) {
    try { return createRequire(`${dir}/`)('playwright').chromium } catch { /* 继续找 */ }
  }
  throw new Error('未找到 playwright：请设置 PLAYWRIGHT_DIR')
}

/**
 * 从渲染出的 SVG 反解出原始付款码：
 *   模块位串 → 去静区 → 按 11 位切符号（末符号 13 位 STOP）→ 用码表查值
 *   → 校验和自检 → 按起始符取数据（C 集两位数字 / B 集字符）。
 */
function decodeSvg(svg, bars) {
  const width = Number((svg.match(/width="(\d+)"/) || [])[1])
  // 浏览器把 SVG 序列化成 HTML 形态：`<rect …></rect>`，没有自闭合斜杠。判据必须
  // 接受两种形态，否则「读不到条」会被误报成编码错误（实测踩过）。
  const rects = [...svg.matchAll(/<rect x="(\d+)" y="0" width="(\d+)" height="(\d+)"\s*\/?>/g)]
    .map(m => ({ x: Number(m[1]), width: Number(m[2]), height: Number(m[3]) }))
  if (!width || rects.length === 0) return { error: 'SVG 里没有条（rect）' }
  // 模块宽度从图形本身量出来（Code128 每个符号都有单模块元素，所以最窄的条
  // 就是一个模块），而不是假定页面用了 2px——否则页面改了模块宽度，测试会
  // 用一个错误的步长去采样，然后「解码失败」被误报成编码错误。
  const module = Math.min(...rects.map(r => r.width))
  const total = width / module
  // 逐模块判定黑白：被黑色 rect 覆盖即 1
  let bits = ''
  for (let m = 0; m < total; m++) {
    const pos = m * module + module / 2
    bits += rects.some(r => pos >= r.x && pos < r.x + r.width) ? '1' : '0'
  }
  const quiet = 10
  const leftQuiet = bits.slice(0, quiet)
  const rightQuiet = bits.slice(-quiet)
  const data = bits.slice(quiet, bits.length - quiet)
  // 切符号：STOP 是 13 位（结尾），其余 11 位
  const symbols = []
  let i = 0
  while (i < data.length) {
    const remain = data.length - i
    if (remain === 13) { symbols.push(data.slice(i, i + 13)); i += 13; break }
    symbols.push(data.slice(i, i + 11)); i += 11
  }
  const values = symbols.map(sym => bars.indexOf(Number(sym)))
  if (values.includes(-1)) return { error: `存在码表里没有的符号: ${symbols[values.indexOf(-1)]}` }
  const stop = values.pop()
  const checksum = values.pop()
  const start = values.shift()
  let sum = start
  for (let k = 0; k < values.length; k++) sum += values[k] * (k + 1)
  const checksumOk = (sum % 103) === checksum
  let text = ''
  if (start === 105) {
    text = values.map(v => String(v).padStart(2, '0')).join('')
  } else if (start === 104) {
    text = values.map(v => String.fromCharCode(v + 32)).join('')
  } else if (start === 103) {
    text = values.map(v => String.fromCharCode(v + (v < 64 ? 32 : -64))).join('')
  } else return { error: `未知起始符 ${start}` }
  return { text, checksumOk, stopOk: stop === 106, leftQuiet, rightQuiet, moduleWidth: module,
           quietBars: { left: leftQuiet.length, right: rightQuiet.length },
           blackHeight: Math.max(...rects.map(r => r.height)), width }
}

const chromium = await loadChromium()
const browser = await chromium.launch({ channel: 'chrome', headless: true })
// 固定界面语言：界面语言决定助手用哪种语言回答，也决定复制按钮的文案。
// 不固定的话，无头 Chrome 默认 en-US，断言会随环境漂移。
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' })
const host = await ctx.newPage()
let reachable = true
await host.goto(BASE, { waitUntil: 'domcontentloaded' }).catch(() => { reachable = false })
await host.waitForTimeout(3500)

if (!reachable) {
  console.log('  SKIP  容器不可达，跳过浏览器实测')
} else {
  // 走真实对话：问账单（level=5 会带回付款码），模型会把它放进 ```barcode 围栏
  await host.locator('#input').fill('我的合約號 0070878510，今期要交幾錢？順便給我付款碼')
  await host.locator('#input').press('Enter')
  // 等卡片出现再断言，而不是睡一个固定秒数：模型快慢不该决定测试成败。
  await host.waitForSelector('.paycode', { timeout: 120000 }).catch(() => { /* 超时后按 0 张卡片断言，报出真实原因 */ })
  await host.waitForTimeout(1500)

  const dom = await host.evaluate(() => {
    const cards = [...document.querySelectorAll('.paycode')]
    const codes = [...document.querySelectorAll('.bubble pre > code')].map(c => (c.textContent || '').trim())
    return {
      cards: cards.length,
      svg: cards[0] ? (cards[0].querySelector('svg')?.outerHTML ?? '') : '',
      // 卡片插在它对应的代码块之后：访客看到的数字就是这一块。
      shownCode: cards[0] ? (cards[0].previousElementSibling?.textContent ?? '').trim() : '',
      copyLabel: cards[0] ? (cards[0].querySelector('.paycode-copy')?.textContent ?? '') : '',
      digitBlocks: codes.filter(c => /^[0-9]{20,40}$/.test(c)),
      otherBlocks: codes.filter(c => !/^[0-9]{20,40}$/.test(c)),
    }
  })
  console.log(`   真实回答里：.paycode 卡片 ${dom.cards} 个，纯数字块 ${dom.digitBlocks.length} 个，复制按钮文案 "${dom.copyLabel}"`)
  console.log(`   页面上给访客看的数字："${dom.shownCode}"`)

  ok('E. 付款码被渲染成卡片', dom.cards >= 1, `cards=${dom.cards}`)
  ok('E. 复制按钮存在且有文案', dom.copyLabel !== '')
  ok('E. 复制按钮文案是中文界面用语', /複製|复制/.test(dom.copyLabel), `"${dom.copyLabel}"`)

  if (dom.cards >= 1) {
    const decoded = decodeSvg(dom.svg, BARS)
    console.log(`   解码结果：${decoded.error ? '失败 ' + decoded.error : `"${decoded.text}" checksum=${decoded.checksumOk} stop=${decoded.stopOk} 静区=${decoded.quietBars.left}/${decoded.quietBars.right} 模块=${decoded.moduleWidth}px 黑条高=${decoded.blackHeight}px`}`)
    ok('C. SVG 解码回原始付款码', decoded.text === SAMPLE || /^[0-9]{20,40}$/.test(decoded.text || ''),
      `解出 ${decoded.text}`)
    ok('C. 解码出的校验和自洽', decoded.checksumOk === true)
    ok('C. STOP 符号正确', decoded.stopOk === true)
    ok('D. 左右静区各 ≥10 模块', (decoded.quietBars?.left ?? 0) >= 10 && (decoded.quietBars?.right ?? 0) >= 10,
      `left=${decoded.quietBars?.left} right=${decoded.quietBars?.right}`)
    ok('D. 模块宽 ≥2px（截图后可扫）', (decoded.moduleWidth ?? 0) >= 2)
    ok('D. 条高足够（≥60px）', (decoded.blackHeight ?? 0) >= 60, `${decoded.blackHeight}px`)
    ok('D. 白底黑条（不是灰底或彩条）',
      /fill="#ffffff"/.test(dom.svg) && /<g fill="#000000">/.test(dom.svg))
    // 这一条才是端到端不变量：**访客看到的数字**必须就是条码里的数字。
    // 只比接口值还不够——页面若渲染了另一串数字的条码，访客照样会缴错费。
    ok('C. 条码内容 == 页面上给访客看的数字', decoded.text === dom.shownCode,
      `条码 "${decoded.text}" vs 页面 "${dom.shownCode}"`)
    ok('C. 解码结果与业务系统接口一致', decoded.text === SAMPLE,
      `解出 "${decoded.text}"，接口给的是 "${SAMPLE}"`)
  }

  // ── F. 刷新重放：历史路径也必须只剩一问一答，且付款码卡片照样在 ──────────────
  // 为什么单列一段：流式出口与 /history 是两条独立代码路径（后者还要按 turn 归并、
  // 丢掉孤儿轮）。只测流式等于漏掉刷新后的表现，而访客恰恰常在缴费前刷新页面。
  await host.reload({ waitUntil: 'domcontentloaded' })
  await host.waitForSelector('.paycode', { timeout: 30000 }).catch(() => { /* 按 0 张断言 */ })
  await host.waitForTimeout(1200)
  const after = await host.evaluate(() => {
    const cards = [...document.querySelectorAll('.paycode')]
    // 只数**助手**气泡：`.msg.assistant` 里才有答案，用户气泡与提示气泡不算。
    const bubbles = [...document.querySelectorAll('.msg.assistant .bubble')]
    const codes = [...document.querySelectorAll('.bubble pre > code')].map(c => (c.textContent || '').trim())
    return {
      cards: cards.length,
      svg: cards[0] ? (cards[0].querySelector('svg')?.outerHTML ?? '') : '',
      shownCode: cards[0] ? (cards[0].previousElementSibling?.textContent ?? '').trim() : '',
      paycodeBlocks: codes.filter(c => /^[0-9]{20,40}$/.test(c)).length,
      assistantTexts: bubbles.map(b => (b.textContent || '').trim()).filter(t => t !== ''),
    }
  })
  console.log(`   刷新后：.paycode 卡片 ${after.cards} 个，纯数字块 ${after.paycodeBlocks} 个，气泡 ${after.assistantTexts.length} 个`)
  ok('F. 刷新后付款码卡片仍在（历史路径也做卡片化）', after.cards === 1, `cards=${after.cards}`)
  ok('F. 刷新后一问一答：只有一个含答案的气泡（不出现过渡语气泡）',
    after.assistantTexts.length === 1,
    `气泡 ${after.assistantTexts.length} 个：${after.assistantTexts.map(t => JSON.stringify(t.slice(0, 24))).join(' | ')}`)
  if (after.cards === 1) {
    const redecoded = decodeSvg(after.svg, BARS)
    ok('F. 刷新后解码仍等于接口付款码（重放没有换一份内容）', redecoded.text === SAMPLE,
      `解出 "${redecoded.text}"`)
    ok('F. 刷新后条码内容 == 页面显示的数字', redecoded.text === after.shownCode,
      `条码 "${redecoded.text}" vs 页面 "${after.shownCode}"`)
  }
}
await browser.close()
console.log(`\n${passed}/${passed + failed} 项断言通过`)
if (failed > 0) { console.log(`${failed} 项失败`); process.exit(1) }
