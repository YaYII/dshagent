/**
 * HTML 预览容器的自适应高度验收（不依赖模型，纯浏览器内构造）。
 *
 * 背景：iframe 高度靠「子文档 postMessage 回传内容高度 → 父页面设高」。
 * 曾经有两个 bug 叠加，把 262px 的卡片拉成 850px（几乎全是空白）：
 *   ① 子文档上报 documentElement.scrollHeight —— 根元素的 scrollHeight **至少等于
 *      iframe 视口高度**，而视口高度正是父页面刚设的值，等于自己量自己；
 *   ② 父页面写 `Math.min(Math.max(content + 2, 120), max)` —— 子文档每轮上报的都是
 *      「当前内容高度」，再叠加 2px 就变成每轮 +2 的棘轮，一路顶到上限才停。
 *
 * 判据：
 *   A. 真实 reporter 源码里不含 documentElement.scrollHeight；量的是 rect；
 *   B. 真实父页面逻辑里不含 `content + 2` 这类累加；
 *   C. 浏览器实测：矮内容 → 设高 ≈ 内容高（不是视口高、不是上限）；
 *   D. 浏览器实测：内容变矮后容器**跟着收缩**（棘轮 bug 在这里必然失败）。
 *
 * 运行：node customer-service/web/guest/tests/html-frame-check.mjs
 * 需要 playwright（PLAYWRIGHT_DIR 或已知工具目录）与在跑的容器。
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

console.log('\nA. 子文档 reporter：必须量内容盒，不能量根 scrollHeight')
// 从源码里取出 reporter 的字符串值（它是一串字符串拼接），交给 JS 求值
const reporterSrc = page.match(/const HTML_HEIGHT_REPORTER = ([\s\S]*?)\n\n/)
ok('能在源码里定位 reporter', reporterSrc !== null)
const reporter = reporterSrc === null ? '' : eval(reporterSrc[1]) // eslint-disable-line no-eval
ok('reporter 不使用 documentElement.scrollHeight', !/documentElement\.scrollHeight/.test(reporter),
  '仍在上报根元素 scrollHeight —— 它会至少等于 iframe 视口高度，永远只增不减')
ok('reporter 使用 getBoundingClientRect 量内容', /getBoundingClientRect\(\)\.height/.test(reporter))
ok('reporter 在对 body 做观察', /observe\(document\.body/.test(reporter))

console.log('\nB. 父页面逻辑：不得对内容高度做累加')
const applySrc = page.match(/function applyHtmlFrameHeight\(frame\) \{([\s\S]*?)\n  \}/)
ok('能在源码里定位 applyHtmlFrameHeight', applySrc !== null)
const applyBody = applySrc === null ? '' : applySrc[1]
// 先剥掉行注释：解释「为什么不能写 content + 2」的注释里会原样出现该表达式，
// 不剥就会把说明文字当成违规代码（这个断言第一次写就误报了自己）。
const applyCode = applyBody.replace(/\/\/[^\n]*/g, '')
ok('不含 `content + N` 累加', !/content\s*\+\s*\d/.test(applyCode),
  '把内容高度再加常数会让高度每轮上报都往上涨（棘轮）')
ok('允许收缩（target 不依赖当前高度）', /Math\.min\(Math\.max\(content,/.test(applyBody))

console.log('\nC/D. 浏览器实测：矮内容贴合 + 变矮后收缩')
async function loadChromium() {
  try { return (await import('playwright')).chromium } catch { /* 继续找 */ }
  for (const dir of [process.env.PLAYWRIGHT_DIR, '/home/as-workstation01/Documents/project/Chrome'].filter(Boolean)) {
    try { return createRequire(`${dir}/`)('playwright').chromium } catch { /* 继续找 */ }
  }
  throw new Error('未找到 playwright：请设置 PLAYWRIGHT_DIR')
}

const chromium = await loadChromium()
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const host = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
let reachable = true
await host.goto(BASE, { waitUntil: 'domcontentloaded' }).catch(() => { reachable = false })
await host.waitForTimeout(3000)
if (!reachable) {
  console.log('  SKIP  容器不可达，跳过浏览器实测')
} else {
  // 用**真实 reporter** 造一个 iframe：先给高内容，再由子文档自己变矮。
  // 注意：sandbox="allow-scripts" **不含 same-origin**，父页面读不到
  // frame.contentWindow.document —— 想改内容只能让子文档自己动手（第一次写这个
  // 测试时我在父页面里改高度，被 try/catch 吞掉，收缩用例假失败）。
  const result = await host.evaluate(async (reporterCode) => {
    const frame = document.createElement('iframe')
    frame.className = 'html-frame'
    frame.setAttribute('sandbox', 'allow-scripts')
    const doc = '<!doctype html><meta charset="utf-8">'
      + '<style>html{height:auto}body{margin:0;padding:12px;min-height:0;background:#fff}</style>'
      + '<div id="box" style="height:300px">内容</div>'
      // 700ms 后自己变矮一半以上，触发 reporter 的 ResizeObserver 再报一次
      + '<script>setTimeout(function(){document.getElementById("box").style.height="30px"},700)<\/script>'
      + `<script>${reporterCode}<\/script>`
    frame.srcdoc = doc
    document.querySelector('#chat').appendChild(frame)
    const wait = ms => new Promise(r => setTimeout(r, ms))
    await wait(500)                       // 首次上报（内容 ~324）
    const applied1 = Number(frame.dataset.appliedHeight || 0)
    const content1 = Number(frame.dataset.contentHeight || 0)
    await wait(1600)                      // 变矮后再次上报
    const applied2 = Number(frame.dataset.appliedHeight || 0)
    const content2 = Number(frame.dataset.contentHeight || 0)
    frame.remove()
    return { content1, applied1, content2, applied2, viewport: window.innerHeight }
  }, reporter)

  console.log(`   实测：内容 ${result.content1}px → 设高 ${result.applied1}px；变矮后内容 ${result.content2}px → 设高 ${result.applied2}px（视口 ${result.viewport}px）`)
  const maxClamp = Math.min(Math.round(result.viewport * 0.85), 900)
  ok('C. 设高贴合内容（差 ≤ 8px，含圆整与下限）', Math.abs(result.applied1 - result.content1) <= 8,
    `差 ${Math.abs(result.applied1 - result.content1)}px`)
  ok('C. 没有被顶到视口上限', result.applied1 < maxClamp - 20,
    `applied=${result.applied1} 接近上限 ${maxClamp}`)
  ok('D. 内容变矮后容器随之收缩', result.applied2 < result.applied1 - 4,
    `applied1=${result.applied1} applied2=${result.applied2}（棘轮实现会保持不降）`)
}
await browser.close()

console.log(`\n${passed}/${passed + failed} 项断言通过`)
if (failed > 0) { console.log(`${failed} 项失败`); process.exit(1) }
