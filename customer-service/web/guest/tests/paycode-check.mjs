/**
 * 付款码二维码验收。
 *
 * 场景：账单查询（level=5）会带回付款码 `barcode`（30 位数字）。访客界面把它渲染成
 * **一张二维码**，用「澳電 CEM」App 扫码缴费。只出二维码、不出条码，正文里那串数字
 * 也隐去（二维码已含同一串数字，重摆一遍会让访客以为要手动输；数字仍可一键复制）。
 *
 * 为什么判据是「真的解一次」而不是「图出来了」：码图编错不会报错，只会让访客扫出
 * **错误的数字**去缴错费，比不显示更糟。而「与另一个实现的模块矩阵逐格比对」也是错的
 * 判据——二维码掩码由编码器自行择优，实测 qrcode-generator 与 Python `qrcode` 在同一串
 * 内容/纠错级下掩码不同（差 116 格）却都能扫。所以这里把渲染出的 SVG 读回模块矩阵、
 * 合成像素、交给独立解码器（jsQR）真解一次，再与**业务系统接口当前返回的**付款码比。
 *
 * 判据：
 *   A. 二维码库是随页面部署的本地资产（qrcode-generator 2.0.4，MIT），页面不引 CDN，
 *      也没有自己手写一套条码/二维码实现（没有死代码）；
 *   B. 编码器能力自检：库能给这个 30 位付款码出二维码（合法版本 + 三个定位图形）；
 *   C. 浏览器实测：真实回答 → 二维码解码回原始付款码（端到端，含静区与模块宽度）；
 *   D. 扫码硬要求：静区 ≥4 模块、模块 ≥4px、纯黑码纯白底；
 *   E. 只显示二维码：卡片里没有条码、正文里看不到那串数字、标签指向 CEM App；
 *   F. 刷新重放（/history 路径）与当轮一致；
 *   G. 卡片自身不引入可读性/布局问题（标签对比度、窄屏不溢出）。
 *
 * 运行：node customer-service/web/guest/tests/paycode-check.mjs
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { decodeQrSvg } from './qr-decode.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const INDEX = join(HERE, '..', 'index.html')
const QR_ASSET = join(HERE, '..', 'assets', 'qrcode-2.0.4.js')
const BASE = process.env.GUEST_URL ?? 'http://127.0.0.1:10800'

let passed = 0
let failed = 0
const ok = (label, cond, detail = '') => {
  if (cond) { passed += 1; console.log(`  PASS  ${label}`) }
  else { failed += 1; console.log(`  FAIL  ${label}${detail === '' ? '' : ` — ${detail}`}`) }
}

const page = readFileSync(INDEX, 'utf8')
const qrAsset = readFileSync(QR_ASSET, 'utf8')

console.log('\nA. 二维码来自随页面部署的本地库（不是 CDN，也不是自己手写的）')
ok('assets/qrcode-2.0.4.js 在位且带出处抬头（版本/许可/上游）',
  /qrcode-generator@2\.0\.4/.test(qrAsset) && /MIT/.test(qrAsset) &&
  /kazuhikoarase\/qrcode-generator/.test(qrAsset))
ok('页面只引本地资产（相对路径），不引任何 http(s) 脚本', !/<script[^>]*src="https?:/.test(page))
ok('页面没有手写的 Code128 实现（已随「只出二维码」删除，不留死代码）',
  !/CODE128|code128Bits|barcodeSvg/.test(page))
ok('页面仍是懒加载二维码库（不阻塞首屏，库挂了只是少一张图）',
  /function loadQrLib\(/.test(page) && /QRCODE_ASSET/.test(page))

console.log('\nB. 编码器能力自检（用页面同一份本地库）')
const require = createRequire(QR_ASSET)
const qrcode = require(QR_ASSET)
function qrMatrix(text) {
  const model = qrcode(0, 'M')
  model.addData(text, /^[0-9]+$/.test(text) ? 'Numeric' : 'Byte')
  model.make()
  const count = model.getModuleCount()
  const rows = []
  for (let r = 0; r < count; r++) {
    let row = ''
    for (let c = 0; c < count; c++) row += model.isDark(r, c) ? '1' : '0'
    rows.push(row)
  }
  return { count, rows }
}
const SAMPLE_OFFLINE = '720070878510260417000000300002'
const probe = qrMatrix(SAMPLE_OFFLINE)
ok('库能给出合法版本（21 + 4k）', probe.count >= 21 && (probe.count - 21) % 4 === 0, `count=${probe.count}`)
ok('三个定位图形都在（首行两端与末行左侧各有 7 模块实心）',
  probe.rows[0].startsWith('1111111') && probe.rows[0].endsWith('1111111') &&
  probe.rows[probe.count - 1].startsWith('1111111'))

console.log('\nC/D/E/F/G. 浏览器实测：真实回答 → 解码还原 + 只显示二维码')
async function loadChromium() {
  try { return (await import('playwright')).chromium } catch { /* 继续找 */ }
  for (const dir of [process.env.PLAYWRIGHT_DIR, '/home/as-workstation01/Documents/project/Chrome'].filter(Boolean)) {
    try { return createRequire(`${dir}/`)('playwright').chromium } catch { /* 继续找 */ }
  }
  throw new Error('未找到 playwright：请设置 PLAYWRIGHT_DIR')
}

// 期望值取自业务系统**当前**的账单接口，而不是写死历史字符串：账单换了月份付款码就会变，
// 写死会在业务数据变化时误报失败（那是数据的错，不是渲染的错）。取不到才退回已知样例。
const CONTRACT = '0070878510'
const API = `https://te-service-api2.cem-macau.com/api/bill/${CONTRACT}/ai/zh?level=5`
let SAMPLE = SAMPLE_OFFLINE
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

const chromium = await loadChromium()
const browser = await chromium.launch({ channel: 'chrome', headless: true })
// 固定界面语言：界面语言决定助手用哪种语言回答，也决定标签文案。
// 不固定的话，无头 Chrome 默认 en-US，断言会随环境漂移。
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' })
const host = await ctx.newPage()
let reachable = true
await host.goto(BASE, { waitUntil: 'domcontentloaded' }).catch(() => { reachable = false })
await host.waitForTimeout(3500)

// 卡片取样口径（当轮与刷新后共用）。在浏览器里执行，因此不能引用外层变量。
const SAMPLE_DOM = () => {
  const card = document.querySelector('.paycode')
  const bubble = card?.closest('.bubble')
  const src = card?.previousElementSibling
  return {
    cards: document.querySelectorAll('.paycode').length,
    qr: card ? (card.querySelector('.paycode-qr svg')?.outerHTML ?? '') : '',
    caption: card ? (card.querySelector('.paycode-caption')?.textContent ?? '') : '',
    copyLabel: card ? (card.querySelector('.paycode-copy')?.textContent ?? '') : '',
    // 「只显示二维码」的反向判据：卡片里不应有任何条码容器
    bars: card ? card.querySelectorAll('.paycode-bars').length : 0,
    // 正文里那串数字必须看不见。判据量的是**渲染盒**而不是 innerText：视觉隐藏
    // （1px + clip + opacity:0）在 innerText 里未必消失，靠它判会得到假结论。
    srcBox: src ? (() => {
      const r = src.getBoundingClientRect()
      return `${Math.round(r.width)}x${Math.round(r.height)} opacity=${getComputedStyle(src).opacity}`
    })() : 'no-sibling',
    srcHidden: src ? (() => {
      const rect = src.getBoundingClientRect()
      const cs = getComputedStyle(src)
      return src.classList.contains('paycode-src') && rect.width <= 2 && rect.height <= 2 &&
        Number(cs.opacity === '' ? 1 : cs.opacity) < 0.05
    })() : false,
    // 「可见正文」= 不在隐藏容器里的文本节点拼起来。不直接用 innerText：视觉隐藏的
    // 节点在 innerText 里未必消失，靠它判会得到假结论。
    visibleText: bubble ? (() => {
      const w = document.createTreeWalker(bubble, NodeFilter.SHOW_TEXT)
      let out = ''
      while (w.nextNode()) {
        const node = w.currentNode
        if (node.parentElement && node.parentElement.closest('.paycode-src')) continue
        out += node.nodeValue || ''
      }
      return out
    })() : '',
  }
}

if (!reachable) {
  console.log('  SKIP  容器不可达，跳过浏览器实测')
} else {
  // 走真实对话：问账单（level=5 会带回付款码），模型把它放进 ```barcode 围栏
  await host.locator('#input').fill('我的合約號 0070878510，今期要交幾錢？順便給我付款碼')
  await host.locator('#input').press('Enter')
  // 等二维码就位再断言，而不是睡一个固定秒数：模型快慢不该决定测试成败
  await host.waitForSelector('.paycode .paycode-qr svg', { timeout: 120000 }).catch(() => { /* 超时后按缺失断言 */ })
  await host.waitForTimeout(1200)

  const dom = await host.evaluate(SAMPLE_DOM)
  console.log(`   真实回答里：.paycode 卡片 ${dom.cards} 个，标签 "${dom.caption}"，复制按钮 "${dom.copyLabel}"`)
  console.log(`   正文里是否还看得到那串数字：${dom.visibleText.includes(SAMPLE) ? '看得到（不符合预期）' : '看不到'}`)
  console.log(`   承载数字的节点渲染盒：${dom.srcBox}`)

  ok('E. 付款码被渲染成卡片', dom.cards === 1, `cards=${dom.cards}`)
  ok('E. 卡片里只有二维码，没有条码容器', dom.bars === 0 && dom.qr !== '', `bars=${dom.bars} qr=${dom.qr.length} 字节`)
  ok('E. 标签指向 CEM App（不是微信／支付宝）',
    /CEM/i.test(dom.caption) && !/微信|支付寶|支付宝|WeChat|Alipay/i.test(dom.caption), `"${dom.caption}"`)
  ok('E. 正文里看不到那串数字（二维码已承载，不重复显示）',
    !dom.visibleText.includes(SAMPLE), `正文仍含 "${SAMPLE}"`)
  ok('E. 原代码块被隐藏而不是删除（复制按钮仍拿得到数字）', dom.srcHidden, '承载数字的节点仍有可见尺寸')
  ok('E. 复制按钮存在且有文案', /複製|复制|Copy|Copiar/i.test(dom.copyLabel), `"${dom.copyLabel}"`)

  if (dom.qr !== '') {
    const qr = decodeQrSvg(dom.qr)
    console.log(`   二维码解码：${qr.error ? '失败 ' + qr.error : `"${qr.text}" ${qr.count}×${qr.count} 模块 ${qr.module}px 静区 ${qr.quiet}`}`)
    ok('C. 二维码解码回原始付款码', qr.text === SAMPLE, `解出 "${qr.text}"`)
    ok('D. 二维码静区 ≥4 模块（规范要求，否则扫不到）', (qr.quiet ?? 0) >= 4, `quiet=${qr.quiet}`)
    ok('D. 二维码模块 ≥4px（截图后可扫）', (qr.module ?? 0) >= 4, `${qr.module}px`)
    ok('D. 纯黑码纯白底（不是灰底或彩码）',
      /fill="#ffffff"/.test(dom.qr) && /fill="#000000"/.test(dom.qr))
    ok('C. 二维码内容 == 业务系统接口当前返回的付款码', qr.text === SAMPLE,
      `解出 "${qr.text}"，接口给的是 "${SAMPLE}"`)
  }

  // ── G. 卡片自身不能引入可读性/布局问题（我新加的组件，得自己举证）───────────
  const cardAudit = await host.evaluate(() => {
    const card = document.querySelector('.paycode')
    if (!card) return { error: '没有卡片' }
    const caption = card.querySelector('.paycode-caption')
    const cs = getComputedStyle(caption)
    const nums = v => (v.match(/[\d.]+/g) || []).map(Number)
    const over = (fg, bg, a) => fg.map((c, i) => Math.round(c * a + bg[i] * (1 - a)))
    const ink = nums(cs.color).slice(0, 3)
    const cardBg = nums(getComputedStyle(card).backgroundColor)
    const paper = cardBg[3] !== undefined && cardBg[3] < 1
      ? over(cardBg.slice(0, 3), [255, 255, 255], cardBg[3])
      : cardBg.slice(0, 3)
    const composited = over(ink, paper, Number(cs.opacity === '' ? 1 : cs.opacity))
    const lin = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4) }
    const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
    const [hi, lo] = [lum(composited), lum(paper)].sort((x, y) => y - x)
    return { contrast: (hi + 0.05) / (lo + 0.05), caption: (caption.textContent || '').trim() }
  })
  console.log(`   标签 "${cardAudit.caption}" 对比度 ${cardAudit.contrast?.toFixed(2)}:1`)
  ok('G. 标签对比度 ≥4.5:1（半透明小字最容易不达标）', (cardAudit.contrast ?? 0) >= 4.5,
    `${cardAudit.contrast?.toFixed(2)}:1`)

  await host.setViewportSize({ width: 390, height: 900 })
  await host.waitForTimeout(600)
  const narrow = await host.evaluate(() => {
    const card = document.querySelector('.paycode')
    const bubble = card?.closest('.bubble')
    if (!card || !bubble) return { error: '没有卡片' }
    return {
      cardOverflow: card.scrollWidth - card.clientWidth,
      bubbleOverflow: bubble.scrollWidth - bubble.clientWidth,
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }
  })
  console.log(`   390px 窄屏：卡片溢出 ${narrow.cardOverflow}px，气泡溢出 ${narrow.bubbleOverflow}px，页面溢出 ${narrow.pageOverflow}px`)
  ok('G. 390px 窄屏下卡片与页面都不横向溢出',
    (narrow.cardOverflow ?? 99) <= 1 && (narrow.bubbleOverflow ?? 99) <= 1 && (narrow.pageOverflow ?? 99) <= 1,
    JSON.stringify(narrow))
  await host.setViewportSize({ width: 1440, height: 1000 })

  // ── F. 刷新重放：/history 是另一条代码路径，访客恰恰常在缴费前刷新 ──────────
  await host.reload({ waitUntil: 'domcontentloaded' })
  await host.waitForSelector('.paycode .paycode-qr svg', { timeout: 30000 }).catch(() => { /* 按缺失断言 */ })
  await host.waitForTimeout(1200)
  const after = await host.evaluate(SAMPLE_DOM)
  const assistantBubbles = await host.evaluate(() => document.querySelectorAll('.msg.assistant .bubble').length)
  console.log(`   刷新后：.paycode 卡片 ${after.cards} 个，助手气泡 ${assistantBubbles} 个`)
  ok('F. 刷新后二维码卡片仍在（历史路径也做卡片化）', after.cards === 1, `cards=${after.cards}`)
  ok('F. 刷新后一问一答：只有一个含答案的气泡（不出现过渡语气泡）', assistantBubbles === 1,
    `气泡 ${assistantBubbles} 个`)
  ok('F. 刷新后正文里同样看不到那串数字', !after.visibleText.includes(SAMPLE))
  if (after.qr !== '') {
    const qrAgain = decodeQrSvg(after.qr)
    ok('F. 刷新后二维码解码仍等于接口付款码（重放没有换一份内容）', qrAgain.text === SAMPLE,
      `解出 "${qrAgain.text}"`)
  }
}
await browser.close()
console.log(`\n${passed}/${passed + failed} 项断言通过`)
if (failed > 0) { console.log(`${failed} 项失败`); process.exit(1) }
