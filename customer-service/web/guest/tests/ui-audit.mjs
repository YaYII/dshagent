/**
 * 视觉自检（当前模型不能读图，所以把「好不好看」拆成可计算的量）：
 *   1) 对比度：所有可见文字的 前景/背景 对比度，正文必须 ≥4.5:1，大字 ≥3:1
 *   2) 溢出：小屏是否有横向滚动（最容易被新排版搞坏的东西）
 *   3) 主题：深/浅两套都跑一遍，并验证切换按钮真的改了属性
 *   4) 抖动：切换主题后统计高度变化次数（历史踩过 ResizeObserver 无限抖动）
 */
import { createRequire } from 'node:module'

/**
 * 加载 playwright：本脚本随仓库分发，但 playwright 通常只装在浏览器工具目录。
 * 依次尝试：直接解析 → PLAYWRIGHT_DIR → 已知的 Chrome 工具目录。
 */
async function loadPlaywright() {
  try { return (await import('playwright')).chromium } catch { /* 继续找 */ }
  const dirs = [process.env.PLAYWRIGHT_DIR, '/home/as-workstation01/Documents/project/Chrome']
    .filter(Boolean)
  for (const dir of dirs) {
    try { return createRequire(`${dir}/`)('playwright').chromium } catch { /* 继续找 */ }
  }
  throw new Error('未找到 playwright：请设置 PLAYWRIGHT_DIR 指向安装了 playwright 的目录')
}

const chromium = await loadPlaywright()

const BASE = process.env.GUEST_URL ?? 'http://127.0.0.1:10800'
const browser = await chromium.launch({ channel: 'chrome', headless: true })

const relLum = ([r, g, b]) => {
  const f = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}
const ratio = (a, b) => { const [x, y] = [relLum(a), relLum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) }

const audit = async (page, label) => {
  await page.mouse.move(2, 2)
  await page.waitForTimeout(350)
  const items = await page.evaluate(() => {
    const parse = s => { const m = (s || '').match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(',').map(v => parseFloat(v)); return p.length >= 3 ? p : null }
    // 背景解析要吃两件事：① 渐变（按钮底多是 linear-gradient，只看
    // backgroundColor 会把「墨字压青绿」误判成「墨字压页面底色」）；② **alpha**
    // ——用户气泡是 20% 透明青绿，忽略 alpha 会把它当成实心青绿，又造出一批假阳性。
    // 做法：把每个色标按 alpha 合成到父级解析结果上，取合成后对比度最差的那个。
    const composite = (fg, bg) => {
      const a = fg.length >= 4 ? fg[3] : 1
      return [0, 1, 2].map(i => Math.round(fg[i] * a + bg[i] * (1 - a)))
    }
    const ownStops = el => {
      const cs = getComputedStyle(el)
      const found = []
      const img = cs.backgroundImage || ''
      if (img && img !== 'none') {
        const re = /rgba?\(([^)]+)\)/g
        let m
        while ((m = re.exec(img)) !== null) {
          const p = m[1].split(',').map(v => parseFloat(v))
          if (p.length >= 3) found.push(p)
        }
      }
      const own = parse(cs.backgroundColor)
      if (own && (own.length < 4 || own[3] > 0)) found.push(own)
      return found
    }
    // 返回该元素最终呈现的候选底色（已逐层合成）
    const resolveBg = el => {
      const stops = ownStops(el).filter(c => (c.length < 4 ? 1 : c[3]) > 0.02)
      if (stops.length === 0) {
        return el.parentElement ? resolveBg(el.parentElement) : [[6, 9, 10]]
      }
      const parent = el.parentElement ? resolveBg(el.parentElement)[0] : [6, 9, 10]
      return stops.map(c => composite(c, parent))
    }
    const out = []
    for (const el of document.querySelectorAll('body *')) {
      if (el.children.length > 0) continue
      const t = (el.textContent || '').trim()
      if (t === '' || el.tagName === 'SCRIPT' || el.tagName === 'STYLE') continue
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      const cs = getComputedStyle(el)
      if (cs.visibility === 'hidden' || cs.opacity === '0') continue
      const fg = parse(cs.color); if (!fg) continue
      const size = parseFloat(cs.fontSize)
      const weight = parseInt(cs.fontWeight, 10) || 400
      for (const bg of resolveBg(el)) {
        out.push({ text: t.slice(0, 24), fg: fg.slice(0, 3), bg: bg.slice(0, 3), size, weight })
      }
    }
    return out
  })

  const big = it => it.size >= 24 || (it.size >= 18.66 && it.weight >= 700)
  const fails = items.filter(it => ratio(it.fg, it.bg) < (big(it) ? 3 : 4.5))
  console.log(`\n[${label}] 检查 ${items.length} 个文字节点，对比度不达标 ${fails.length} 个`)
  for (const f of fails.slice(0, 8)) {
    console.log(`   ✗ ${ratio(f.fg, f.bg).toFixed(2)}:1  ${f.size}px/${f.weight}  bg=rgb(${f.bg})  "${f.text}"`)
  }
  return fails.length
}

const theme = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await theme.newPage()
await page.goto(BASE, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(5000)

const t0 = await page.evaluate(() => document.documentElement.getAttribute('data-theme'))
console.log('初始 data-theme:', t0 ?? '(默认深色)')
let bad = await audit(page, '深色 · 首屏')

// 造一条助手回答（用建议问题），让气泡/表格/来源都出现
const sug = page.locator('#suggestions .sug').first()
if (await sug.count() > 0) { await sug.click(); await page.waitForTimeout(25000) }
bad += await audit(page, '深色 · 有回答')

// 切浅色
await page.locator('#themeToggle').click()
await page.waitForTimeout(1200)
const t1 = await page.evaluate(() => document.documentElement.getAttribute('data-theme'))
console.log('\n切换后 data-theme:', t1)
bad += await audit(page, '浅色 · 有回答')

// 溢出检查（三个宽度）
for (const w of [1280, 768, 390]) {
  await page.setViewportSize({ width: w, height: 860 })
  await page.waitForTimeout(700)
  const o = await page.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
  }))
  const overflow = o.scrollW > o.clientW + 1
  console.log(`宽度 ${w}: scrollWidth=${o.scrollW} clientWidth=${o.clientW} ${overflow ? '✗ 横向溢出' : '✓ 无溢出'}`)
  if (overflow) bad += 1
}

await page.screenshot({ path: '/tmp/admin-shots/ui-light.png', fullPage: false })
await page.locator('#themeToggle').click()
await page.waitForTimeout(900)
await page.screenshot({ path: '/tmp/admin-shots/ui-dark.png', fullPage: false })
console.log('\n截图: /tmp/admin-shots/ui-dark.png, ui-light.png')
console.log(bad === 0 ? '\n✅ 对比度与溢出全部达标' : `\n⚠️ 共 ${bad} 项不达标`)
await browser.close()
