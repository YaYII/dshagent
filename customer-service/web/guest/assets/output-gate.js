/**
 * 访客端「输出前自我审核」门禁 — 纯决策砖块（不碰 DOM、不依赖任何库）。
 *
 * 定位（需求 v2 §4/§5/§10）：把「块能不能显示」的判断逻辑与页面 DOM 组合彻底
 * 分开。页面只做两件事：把结构化 block 喂进来、按本模块给的结论创建元素。因此
 * 本文件能在 Node 里直接单测（`node:assert`），也能被浏览器 `<script>` 加载。
 *
 * 加载形态：同一份源码同时支持 `import`（Node ESM 得到具名导出）与
 * `<script src>`（浏览器挂到 `window.DshOutputGate`）。刻意不写 `export` 语句：
 * index.html 是单文件页面，改成 `type="module"` 会改变整页脚本的作用域与执行
 * 时机，风险大于收益。Node 的 CJS 加载器会为 `module.exports.<name> =` 形式额外
 * 生成同名 ESM 具名导出，因此两种加载方式拿到同一组函数。
 *
 * 状态机（P3，含 v3 P5 的 loading 阶段）：
 *
 *     absent ──起始围栏──▶ pending ──闭合围栏──▶ loading ──渲染器就绪──▶ validating
 *                             │                 │                      │
 *                             └──────── 超时 / 判据失败 / 流中止 ───────┴──▶ degraded
 *
 * `passed` 与 `degraded` 都是终态，不允许回退（P6/REP5）。判定期内块内容（含原始
 * 围栏源码）不得进入访客 DOM（P4/V1），本模块因此只产出「状态 + 文案键」，源码仅
 * 在回传摘要里以短哈希形式出现。
 *
 * @module output-gate
 */

'use strict'

// ── 冻结常量 ────────────────────────────────────────────────────────────────

/**
 * 块状态枚举（P3）。页面按它决定创建占位还是渲染结果，测试按它断言转移。
 * @type {Readonly<Record<string, string>>}
 */
const GATE_STATES = Object.freeze({
  absent: 'absent',
  pending: 'pending',
  loading: 'loading',
  validating: 'validating',
  passed: 'passed',
  degraded: 'degraded',
})

/** 终态集合（REP5）：此二者之外的任何状态都还可能变化。 */
const TERMINAL_STATES = Object.freeze([GATE_STATES.passed, GATE_STATES.degraded])

/**
 * 降级原因枚举（O2 冻结，逐字对齐）。该表同时是**回传白名单**：服务端只接受这
 * 几个值，因此任何内部判据都不允许自造新原因，只能落到这里的一项。
 * @type {Readonly<Record<string, string>>}
 */
const GATE_REASONS = Object.freeze({
  parseError: 'parse-error',
  renderEmpty: 'render-empty',
  imagePathInvalid: 'image-path-invalid',
  imageUnreachable: 'image-unreachable',
  imageDecodeFailed: 'image-decode-failed',
  chartInvalid: 'chart-invalid',
  htmlInvalid: 'html-invalid',
  timeout: 'timeout',
  libraryUnavailable: 'library-unavailable',
})

/** 每类块的降级文案 i18n 键（D3 冻结清单）。 */
const DEGRADE_KEYS = Object.freeze({
  mermaid: 'gateDiagramUnavailable',
  chart: 'gateChartUnavailable',
  image: 'gateImageUnavailable',
  html: 'gateRichContentUnavailable',
})

/** 判定期占位文案的 i18n 键（P4）。 */
const PENDING_KEY = 'gatePreparing'

/** 回传端点兜底路径（真实取值由服务端 Config `gate.reportPath` 决定）。 */
const DEFAULT_REPORT_PATH = '/api/guest/render-report'

/** 异常宽高比阈值（C5 补充判据）。 */
const DEFAULT_MAX_ASPECT_RATIO = 40

/** 图片文件名允许的扩展名（IMG5：KB 实测只有这些是图片）。 */
const IMAGE_EXTENSIONS = 'png|jpe?g|gif|webp|avif|svg|bmp'

/** 四类规范块类型。 */
const BLOCK_TYPES = Object.freeze(['mermaid', 'chart', 'image', 'html'])

// ── 图片地址白名单（IMG1 硬门禁；安全不变量，不进配置）─────────────────────

/**
 * KB 里自家源站主机白名单（IMG6）。只接受这两个精确主机名——不做后缀匹配，
 * 因此 `evil-cem-macau.com`、`cem-macau.com.evil.test` 都不会被误判为自家。
 */
const OWN_HOSTS = Object.freeze(['www.cem-macau.com', 'cem-macau.com'])

/**
 * 把「自家源站绝对 URL」归一化为站点相对路径（IMG6）。
 *
 * 依据：KB 实测存在 4 条 `https://www.cem-macau.com/uploads/<file>` 形态引用
 * （car-model.md / ev-tip.md）。这类地址允许，但**必须先归一化再走 IMG1 判定**
 * （判定对象是归一化后的路径）；其余任何主机一律不归一化，直接落到白名单拒绝。
 * @param src - 原图地址
 * @returns `/uploads/<file>`（命中自家主机）或原值（其它一切情况）
 */
function normalizeOwnUploadUrl(src) {
  if (typeof src !== 'string') return src
  const match = /^https?:\/\/([^/?#]+)(\/uploads\/[^\s)]*)$/i.exec(src)
  if (!match) return src
  // 主机名可能带端口/大写，先规范化再精确比对
  const host = match[1].toLowerCase().replace(/:(80|443)$/, '')
  if (OWN_HOSTS.indexOf(host) === -1) return src
  return match[2]
}

/**
 * 判定图片地址是否为「本站 /uploads 下的单个图片文件」（IMG1 硬门禁）。
 * 只接受 `/uploads/<文件名>.<图片扩展名>`（IMG1 冻结正则）：拒绝目录穿越、嵌套
 * 目录、查询串与锚点、**协议相对 `//host/...`**、外部绝对 URL、其它协议、`data:`
 * （IMG8），以及任何百分号编码（`%2e%2e`/`%2f` 可伪装 `..` 与 `/`）。
 * 唯一放行的绝对形式是自家源站（IMG6），且先归一化再判定。
 * 非法地址**不得发起任何请求**（IMG2）。
 * @param src - 待判定的图片地址
 * @returns `{ ok, path, reason }`；ok 为 true 时 path 是归一化后的站点相对路径
 */
function checkImagePath(src) {
  const reject = () => ({ ok: false, path: null, reason: GATE_REASONS.imagePathInvalid })
  if (typeof src !== 'string') return reject()
  // 刻意不做 trim：带空白/换行的值说明围栏内容本身畸形，宁可降级也不"顺手修好"
  // 一个可能是拼接错误的地址（调用方负责先规范化自己的那一行）。
  const raw = normalizeOwnUploadUrl(src)
  if (raw === '') return reject()
  if (raw.indexOf('%') !== -1) return reject()
  if (/\s/.test(raw)) return reject()
  // 协议相对 `//host/...` 在页面上会落到外部主机：显式拒绝（归一化之后仍以 // 开头的
  // 必然是外部，因为自家绝对 URL 已被归一化为 /uploads/...）
  if (raw.startsWith('//')) return reject()
  // 文件名部分不含 `/`，因此 `..` 与嵌套目录都无法通过：穿越必须带 `/`
  if (!new RegExp(`^/uploads/[A-Za-z0-9_.-]+\\.(${IMAGE_EXTENSIONS})$`, 'i').test(raw)) return reject()
  return { ok: true, path: raw, reason: null }
}

/**
 * 把合法路径拼成页面可直接加载的同源地址（IMG3）。
 * @param path - `checkImagePath` 认可的站点相对路径
 * @param apiBase - 页面算出的 API 前缀（可为空字符串）
 * @returns 同源地址；路径非法时返回 null（调用方必须降级且不得发请求）
 */
function toImageSrc(path, apiBase) {
  const checked = checkImagePath(path)
  if (!checked.ok) return null
  const base = typeof apiBase === 'string' ? apiBase.replace(/\/+$/, '') : ''
  return base + checked.path
}

// ── 渲染前裁决（P3/C8：只渲染已通过的块）────────────────────────────────────

/**
 * 把任意输入收敛到四类块之一。
 * @param value - 载荷里的块类型
 * @returns 规范类型；不认识返回 null（→ 不渲染）
 */
function normalizeBlockType(value) {
  if (value === 'img') return 'image'
  return BLOCK_TYPES.indexOf(value) === -1 ? null : value
}

/**
 * 决定「本轮由谁提供图形块」——**唯一**的块来源裁决点。
 *
 * 存在的理由：访客端有两条可能的块来源（主机侧 block 事件 / 正文围栏扫描），
 * 若两条同时活跃就会变成"两个事实源"，块可能被渲染两次、或互相覆盖。这里把
 * 优先级收敛成一条可测规则，DOM 组合层只照结论执行：
 *
 * - 本轮收到过任何 block 事件 → 由 **block 事件**提供（主机侧权威，口径 B）；
 *   此刻正文里再出现受控围栏属协议异常，忽略围栏来源以免重复渲染。
 * - 整轮未收到任何 block 事件 → 回落到 **围栏扫描**（旧后端/事件缺失时的兜底）。
 *
 * 单向不可逆：一旦切到 `block-events` 就不回退（避免同一轮内块来源反复切换）。
 * @param input - `{ sawBlockEvent }`：本轮是否已收到 block 事件
 * @returns `'block-events'`（主机侧权威）或 `'fence-fallback'`（兜底）
 */
function chooseBlockSource(input) {
  const spec = input && typeof input === 'object' ? input : {}
  return spec.sawBlockEvent === true ? 'block-events' : 'fence-fallback'
}

/**
 * 解码主机侧下发的单个 block 事件（口径 B 的落地入口）。
 *
 * 契约（`plugins/output-gate/src/engine.ts` 的 `BlockPayload`）：
 * - `decision: 'render'` → `sourceB64` 带块体源码（base64），交真机裁决；
 * - `decision: 'degraded'` → **无源码**，直接降级（reason 为 O2 枚举）；
 * - 图片块额外带 `imagePath`（已归一化的站点相对路径）与 `imageCaption`，
 *   因此图片**无需解码源码**即可显示。
 *
 * 载荷异常（缺字段、base64 坏掉、类型不认识）一律返回 `ok:false`，调用方必须
 * 降级——绝不允许「解析不出来就照渲染」。
 * @param payload - SSE `block` 事件的数据体
 * @returns `{ ok, block }`；ok 为 false 时 block 携带可降级的最小信息
 */
function decodeBlockPayload(payload) {
  const reject = (blockId, blockType, reason) => ({
    ok: false,
    block: { blockId: blockId || '', blockType, source: '', sourceBytes: 0, decision: 'degraded', reason },
  })
  if (!payload || typeof payload !== 'object') return reject('', null, GATE_REASONS.renderEmpty)
  const blockId = typeof payload.blockId === 'string' ? payload.blockId : ''
  const blockType = normalizeBlockType(payload.blockType)
  if (blockId === '' || blockType === null) return reject(blockId, blockType, GATE_REASONS.renderEmpty)
  if (payload.decision === 'degraded') {
    return { ok: false, block: { blockId, blockType, source: '', sourceBytes: 0, decision: 'degraded', reason: payload.reason } }
  }
  // 图片块：主机侧已给归一化路径，无需源码
  const imagePath = typeof payload.imagePath === 'string' ? payload.imagePath : ''
  const imageCaption = typeof payload.imageCaption === 'string' ? payload.imageCaption : ''
  let source = ''
  if (blockType !== 'image') {
    if (typeof payload.sourceB64 !== 'string' || payload.sourceB64 === '') {
      return reject(blockId, blockType, GATE_REASONS.renderEmpty)
    }
    try { source = base64Decode(payload.sourceB64) } catch {
      return reject(blockId, blockType, GATE_REASONS.parseError)
    }
    if (source === '') return reject(blockId, blockType, GATE_REASONS.renderEmpty)
  }
  return {
    ok: true,
    block: {
      blockId,
      blockType,
      source,
      sourceBytes: Number.isFinite(payload.sourceBytes) ? payload.sourceBytes : byteLength(source),
      decision: 'render',
      imagePath,
      imageCaption,
    },
  }
}

/**
 * 按 UTF-8 解码 base64（不依赖 atob/Buffer，浏览器与 Node 都能跑）。
 * @param input - base64 字符串
 * @returns 解码后的文本
 */
function base64Decode(input) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const clean = String(input).replace(/[\s=]/g, '')
  const bytes = []
  let buffer = 0
  let bits = 0
  for (let i = 0; i < clean.length; i++) {
    const value = alphabet.indexOf(clean[i])
    if (value === -1) throw new Error('invalid base64')
    buffer = (buffer << 6) | value
    bits += 6
    if (bits >= 8) { bits -= 8; bytes.push((buffer >> bits) & 0xff) }
  }
  // UTF-8 → 字符串（块体含中文时不能按码元直读）
  let text = ''
  let i = 0
  while (i < bytes.length) {
    const byte = bytes[i]
    if (byte < 0x80) { text += String.fromCharCode(byte); i += 1 }
    else if (byte >= 0xc0 && byte < 0xe0) { text += String.fromCharCode(((byte & 0x1f) << 6) | (bytes[i + 1] & 0x3f)); i += 2 }
    else if (byte >= 0xe0 && byte < 0xf0) {
      text += String.fromCharCode(((byte & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f)); i += 3
    } else {
      const code = ((byte & 0x07) << 18) | ((bytes[i + 1] & 0x3f) << 12) | ((bytes[i + 2] & 0x3f) << 6) | (bytes[i + 3] & 0x3f)
      const offset = code - 0x10000
      text += String.fromCharCode(0xd800 + (offset >> 10), 0xdc00 + (offset & 0x3ff))
      i += 4
    }
  }
  return text
}

/**
 * 依据主机侧下发的结构化块决定「进渲染队列」还是「直接降级」。
 *
 * 入参兼容两种形态：
 * - **主机侧 `BlockPayload`**（口径 B 实际下发的形状）：源码在 `sourceB64`（base64），
 *   图片块用 `imagePath`/`imageCaption`。必须走 `decodeBlockPayload` 解码——
 *   只读 `source` 会对真实载荷得到 0 字节，块静默丢失。
 * - 已解码形态：直接给 `source`（本模块内部使用）。
 *
 * 载荷缺失或字段不全一律视为不可渲染（安全降级，绝不渲染未校验的块）。
 * @param input - `{ blocks, blockResults, degradedIds }`
 * @returns `{ blocks, degradedIds }`；blocks 规范化为 `{ blockId, blockType, source, sourceBytes, imagePath, imageCaption }`
 */
function planBlocks(input) {
  const payload = input && typeof input === 'object' ? input : {}
  const raw = Array.isArray(payload.blocks) ? payload.blocks : []
  const results = payload.blockResults && typeof payload.blockResults === 'object' ? payload.blockResults : {}
  const degraded = Array.isArray(payload.degradedIds) ? payload.degradedIds.slice() : []
  const blocks = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const blockId = typeof item.blockId === 'string' ? item.blockId : ''
    if (blockId === '') continue
    const blockType = normalizeBlockType(item.blockType)
    const verdict = results[blockId]
    if (blockType === null || verdict === 'degraded' || item.decision === 'degraded') {
      if (degraded.indexOf(blockId) === -1) degraded.push(blockId)
      continue
    }
    // 主机侧形状（带 sourceB64 / imagePath）先解码；已解码形状直接用 source
    const needsDecode = typeof item.sourceB64 === 'string'
      || (blockType === 'image' && typeof item.imagePath === 'string')
    if (needsDecode) {
      const decoded = decodeBlockPayload(item)
      if (!decoded.ok) {
        if (degraded.indexOf(blockId) === -1) degraded.push(blockId)
        continue
      }
      blocks.push({
        blockId,
        blockType: decoded.block.blockType,
        source: decoded.block.source,
        sourceBytes: decoded.block.sourceBytes,
        imagePath: decoded.block.imagePath || '',
        imageCaption: decoded.block.imageCaption || '',
      })
      continue
    }
    const source = typeof item.source === 'string' ? item.source : ''
    blocks.push({ blockId, blockType, source, sourceBytes: byteLength(source) })
  }
  return { blocks, degradedIds: degraded }
}

// ── 渲染后实测判据（C1–C4）──────────────────────────────────────────────────

/**
 * 判断渲染结果是否「无可见几何」（C1/C5）：没有子节点、没有有效尺寸、或边界盒
 * 宽高为 0 都算空图。尺寸既接受属性值也接受真机 bbox——两者都无效才判失败。
 * @param metrics - `{ childNodeCount, hasGeometry, viewBox, width, height, bboxWidth, bboxHeight }`
 * @returns `{ ok, reason }`
 */
function checkGeometry(metrics) {
  const m = metrics && typeof metrics === 'object' ? metrics : {}
  const childCount = Number.isFinite(m.childNodeCount) ? m.childNodeCount : 0
  if (childCount <= 0) return { ok: false, reason: GATE_REASONS.renderEmpty }
  if (m.hasGeometry === false) return { ok: false, reason: GATE_REASONS.renderEmpty }
  const positive = value => Number.isFinite(value) && value > 0
  const viewBox = typeof m.viewBox === 'string' ? m.viewBox.trim().split(/\s+/) : []
  const viewBoxOk = viewBox.length === 4 && positive(Number(viewBox[2])) && positive(Number(viewBox[3]))
  const sizeOk = positive(m.width) || positive(m.height) || positive(m.bboxWidth) || positive(m.bboxHeight)
  if (!viewBoxOk && !sizeOk) return { ok: false, reason: GATE_REASONS.renderEmpty }
  return { ok: true, reason: null }
}

/**
 * 异常宽高比判据（C5 补充）：极扁/极长的图形基本是布局崩坏而不是正常图。
 * 归到 `render-empty`（O2 枚举内），比值放在 detail 里供留痕。
 *
 * 尺寸按 bbox → 属性 → viewBox 依次取值：只有 viewBox 的 SVG（mermaid 常见）也是
 * 合法图，取不到比值时判为「无从判断」而不是「不通过」——尺寸是否有效由
 * `checkGeometry` 负责，这里只负责比值这一条补充判据。
 * @param metrics - 同 `checkGeometry`
 * @param maxRatio - 允许的最大宽高比（默认 40）
 * @returns `{ ok, ratio, reason }`；ratio 为 null 表示拿不到比值（不判失败）
 */
function checkAspectRatio(metrics, maxRatio) {
  const m = metrics && typeof metrics === 'object' ? metrics : {}
  const limit = Number.isFinite(maxRatio) && maxRatio > 0 ? maxRatio : DEFAULT_MAX_ASPECT_RATIO
  const viewBox = typeof m.viewBox === 'string' ? m.viewBox.trim().split(/\s+/) : []
  const fromViewBox = viewBox.length === 4 ? [Number(viewBox[2]), Number(viewBox[3])] : null
  const width = firstPositive(m.bboxWidth, m.width, fromViewBox ? fromViewBox[0] : undefined)
  const height = firstPositive(m.bboxHeight, m.height, fromViewBox ? fromViewBox[1] : undefined)
  if (width === null || height === null) return { ok: true, ratio: null, reason: null }
  const ratio = Math.max(width / height, height / width)
  return ratio > limit
    ? { ok: false, ratio, reason: GATE_REASONS.renderEmpty }
    : { ok: true, ratio, reason: null }
}

/** 返回第一个有限正数，都没有则返回 null（比值判据的取值顺序）。 */
function firstPositive(...values) {
  for (const value of values) {
    const num = Number(value)
    if (Number.isFinite(num) && num > 0) return num
  }
  return null
}

/**
 * 图片完整性判据（C4）：只认**自然尺寸**。
 * 页面上的 `<img>` 硬编码 `width="1000" height="560"`，布局尺寸恒有效，拿它当判据
 * 等于没判——所以这里只接受解码后回传的 `naturalWidth/naturalHeight`。
 * @param metrics - `{ naturalWidth, naturalHeight, decodeFailed }`
 * @returns `{ ok, reason }`
 */
function checkImageMetrics(metrics) {
  const m = metrics && typeof metrics === 'object' ? metrics : {}
  if (m.decodeFailed === true) return { ok: false, reason: GATE_REASONS.imageDecodeFailed }
  const width = Number(m.naturalWidth)
  const height = Number(m.naturalHeight)
  if (!Number.isFinite(width) || !Number.isFinite(height) || !(width > 0) || !(height > 0)) {
    return { ok: false, reason: GATE_REASONS.imageDecodeFailed }
  }
  return { ok: true, reason: null }
}

/**
 * 图表数据判据（C2）：合法 JSON、非空数组、每项标签非空且数值为有限非负数。
 * @param text - chart 块的原始文本
 * @returns `{ ok, rows, reason }`；ok 为 true 时 rows 是渲染所需的最小数据
 */
function checkChartData(text) {
  const raw = String(text === null || text === undefined ? '' : text).trim()
  if (raw === '') return { ok: false, rows: null, reason: GATE_REASONS.chartInvalid }
  let parsed
  try { parsed = JSON.parse(raw) } catch { return { ok: false, rows: null, reason: GATE_REASONS.chartInvalid } }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return { ok: false, rows: null, reason: GATE_REASONS.chartInvalid }
  }
  const rows = []
  for (const item of parsed) {
    if (!item || typeof item !== 'object') return { ok: false, rows: null, reason: GATE_REASONS.chartInvalid }
    const label = typeof item.label === 'string' && item.label.trim() !== ''
      ? item.label
      : (typeof item.name === 'string' && item.name.trim() !== '' ? item.name : null)
    if (label === null) return { ok: false, rows: null, reason: GATE_REASONS.chartInvalid }
    const value = item.value === undefined ? item.count : item.value
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      return { ok: false, rows: null, reason: GATE_REASONS.chartInvalid }
    }
    rows.push({ label, value })
  }
  return { ok: true, rows, reason: null }
}

/**
 * HTML 块判据（C3）：非空白且不超单块字节上限。
 * @param text - html 块的原始文本
 * @param maxBytes - 单块字节上限（服务端 Config `gate.maxBlockBytes`）
 * @returns `{ ok, reason }`
 */
function checkHtmlBlock(text, maxBytes) {
  const raw = String(text === null || text === undefined ? '' : text)
  if (raw.trim() === '') return { ok: false, reason: GATE_REASONS.htmlInvalid }
  const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : 32768
  return byteLength(raw) > limit
    ? { ok: false, reason: GATE_REASONS.htmlInvalid }
    : { ok: true, reason: null }
}

/**
 * 渲染后统一完整性判据：块类型决定用哪条判据（C1–C4 的汇合点）。
 * 返回的 reason 一定在 O2 枚举内，可直接进回传载荷。
 * @param blockType - 四类块之一
 * @param metrics - 真机实测数据（mermaid: 几何；image: naturalWidth 等）
 * @param options - `{ source, maxBytes, maxAspectRatio }`
 * @returns `{ ok, reason, detail }`
 */
function checkRendered(blockType, metrics, options) {
  const opts = options && typeof options === 'object' ? options : {}
  const type = normalizeBlockType(blockType)
  if (type === null) return { ok: false, reason: GATE_REASONS.renderEmpty, detail: { check: 'unknown-type' } }
  if (type === 'mermaid') {
    const geometry = checkGeometry(metrics)
    if (!geometry.ok) return { ok: false, reason: geometry.reason, detail: { check: 'geometry' } }
    const aspect = checkAspectRatio(metrics, opts.maxAspectRatio)
    if (!aspect.ok) return { ok: false, reason: aspect.reason, detail: { check: 'aspect', ratio: aspect.ratio } }
    return { ok: true, reason: null, detail: { check: 'geometry', ratio: aspect.ratio } }
  }
  if (type === 'chart') {
    const chart = checkChartData(opts.source)
    if (!chart.ok) return { ok: false, reason: chart.reason, detail: { check: 'chart-data' } }
    return { ok: true, reason: null, detail: { check: 'chart-data', rows: chart.rows } }
  }
  if (type === 'image') {
    const image = checkImageMetrics(metrics)
    if (!image.ok) return { ok: false, reason: image.reason, detail: { check: 'natural-size' } }
    return {
      ok: true,
      reason: null,
      detail: { check: 'natural-size', naturalWidth: Number(metrics.naturalWidth), naturalHeight: Number(metrics.naturalHeight) },
    }
  }
  const html = checkHtmlBlock(opts.source, opts.maxBytes)
  if (!html.ok) return { ok: false, reason: html.reason, detail: { check: 'html-content' } }
  return { ok: true, reason: null, detail: { check: 'html-content' } }
}

/**
 * 按 UTF-8 计算字节数（不经 Buffer/TextEncoder，两种加载环境都可用）。
 * @param text - 待计数字符串
 * @returns 字节数
 */
function byteLength(text) {
  let bytes = 0
  const value = String(text === null || text === undefined ? '' : text)
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) { bytes += 4; i++ }
    else bytes += 3
  }
  return bytes
}

// ── 回传载荷（O2/O3）───────────────────────────────────────────────────────

/**
 * 无加密依赖的短摘要（FNV-1a 双种子，16 位十六进制）。
 * O2 要求 `sourceDigest` 可复算，但页面不能引第三方哈希库；本摘要只用于日志聚合
 * 与幂等去重，不承担完整性证明，因此固定 16 位输出即可。
 * @param text - 源码
 * @returns 16 位十六进制摘要
 */
function shortDigest(text) {
  const value = String(text === null || text === undefined ? '' : text)
  let a = 0x811c9dc5
  let b = 0x01000193
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    a = Math.imul(a ^ code, 0x01000193) >>> 0
    b = Math.imul(b ^ (code + i), 0x85ebca6b) >>> 0
  }
  return (a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0')).slice(0, 16)
}

/**
 * 创建幂等回传闸门（O3：按 `(blockId, sourceDigest)` 去重，不产生重复请求与噪音日志）。
 * @returns `{ shouldSend, key, reset }`
 */
function createReportDeduper() {
  const seen = new Set()
  return {
    /**
     * @param blockId - 块 id
     * @param digest - 源码摘要
     * @returns 首次为 true，重复为 false
     */
    shouldSend(blockId, digest) {
      const key = `${blockId}|${digest}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    },
    /** 组合幂等键，与服务端 `(sessionId, blockId, sourceDigest)` 归并口径一致。 */
    key(blockId, digest) { return `${blockId}|${digest}` },
    /** 清空去重集合（新一轮回答）。 */
    reset() { seen.clear() },
  }
}

/** O2 允许回传的 reason 白名单（内部判据不得自造原因）。 */
function usableReasons() {
  const map = {}
  for (const key of Object.keys(GATE_REASONS)) map[GATE_REASONS[key]] = true
  return map
}

/**
 * 组装一条几何回传载荷（O2 最小字段 + O3 幂等键）。
 * 载荷只含类型、原因、摘要与字节数——**没有任何源码**，因此回传不构成新的泄漏面。
 * @param input - `{ sessionId, blockId, blockType, reason, source, outcome, occurredAt }`
 * @returns 可直接 `JSON.stringify` 的对象；字段不足或原因不在枚举内时返回 null
 */
function buildReport(input) {
  const spec = input && typeof input === 'object' ? input : {}
  const blockId = typeof spec.blockId === 'string' ? spec.blockId : ''
  const blockType = normalizeBlockType(spec.blockType)
  const outcome = spec.outcome === 'passed' ? 'passed' : 'degraded'
  const reason = typeof spec.reason === 'string' ? spec.reason : ''
  // 成功回传**没有失败原因**（F-4）：reason 必须为空；失败回传的 reason 必须落在
  // O2 冻结枚举内。此前实现无条件要求 reason 非空，导致成功回传恒被丢弃
  // （实测 render-report 请求数 = 0），主机侧因此永远看不到「图确实显示成功」。
  if (blockId === '' || blockType === null) return null
  if (outcome === 'degraded') {
    if (reason === '') return null
    if (Object.prototype.hasOwnProperty.call(usableReasons(), reason) === false) return null
  } else if (reason !== '') {
    return null
  }
  const source = typeof spec.source === 'string' ? spec.source : ''
  return {
    sessionId: typeof spec.sessionId === 'string' ? spec.sessionId : '',
    blockId,
    blockType,
    reason,
    sourceDigest: shortDigest(source),
    sourceBytes: byteLength(source),
    occurredAt: Number.isFinite(spec.occurredAt) ? spec.occurredAt : Date.now(),
    outcome,
  }
}

// ── 文案（D3：逻辑层只给键，语言由页面字典决定）─────────────────────────────

/**
 * 把状态 + 块类型映射到 i18n 键。
 * @param state - 块状态
 * @param blockType - 四类块之一（`passed` 无文案）
 * @returns 文案键；无需文案时返回 null
 */
function textKeyFor(state, blockType) {
  if (state === GATE_STATES.degraded) {
    const type = normalizeBlockType(blockType)
    if (type === null) return DEGRADE_KEYS.html
    return DEGRADE_KEYS[type]
  }
  if (state === GATE_STATES.pending || state === GATE_STATES.loading || state === GATE_STATES.validating) {
    return PENDING_KEY
  }
  return null
}

/**
 * 校验一句降级文案是否可读（D1）：不得出现技术词、英文报错或未渲染的标记。
 *
 * 刻意**不**禁用 chart / diagram / image 这类普通名词——D3 的英文参考值本身就写作
 * "The chart is temporarily unavailable"，它们对访客是正常口语，不属于技术术语；
 * D1 禁的是 mermaid / 栅栏 / 语法 / 校验 / 代码块 这一类实现词，以及英文错误信息。
 * @param text - 待校验文案
 * @returns `{ ok, pattern }`；ok 为 false 时 pattern 是命中的禁用模式
 */
function assertReadable(text) {
  const value = String(text === null || text === undefined ? '' : text)
  const banned = [
    /mermaid/i, /fence/i, /\bparse\b/i, /\bsyntax\b/i, /\btoken\b/i, /NaN/,
    /\bundefined\b/i, /\bnull\b/i, /\berror\b/i, /\bexception\b/i, /```/, /<\/?[a-z]/i,
  ]
  for (const pattern of banned) {
    if (pattern.test(value)) return { ok: false, pattern: String(pattern) }
  }
  return { ok: true, pattern: null }
}

// ── 导出 ────────────────────────────────────────────────────────────────────

const api = {
  GATE_STATES,
  TERMINAL_STATES,
  GATE_REASONS,
  DEGRADE_KEYS,
  PENDING_KEY,
  DEFAULT_REPORT_PATH,
  DEFAULT_MAX_ASPECT_RATIO,
  IMAGE_EXTENSIONS,
  BLOCK_TYPES,
  checkImagePath,
  toImageSrc,
  normalizeOwnUploadUrl,
  OWN_HOSTS,
  normalizeBlockType,
  chooseBlockSource,
  decodeBlockPayload,
  base64Decode,
  planBlocks,
  checkGeometry,
  checkAspectRatio,
  checkImageMetrics,
  checkChartData,
  checkHtmlBlock,
  checkRendered,
  shortDigest,
  byteLength,
  createReportDeduper,
  buildReport,
  textKeyFor,
  assertReadable,
}

// 浏览器 <script> 加载：挂到全局供页面 IIFE 取用（页面里没有模块系统）。
if (typeof window !== 'undefined' && window !== null) window.DshOutputGate = api

// Node 加载：require 与 import 都能拿到同一组具名导出。逐项赋值是刻意的——CJS
// 加载器只为 `module.exports.<name> =` 生成 ESM 具名导出。
if (typeof module !== 'undefined' && module !== null && module.exports) {
  module.exports.GATE_STATES = GATE_STATES
  module.exports.TERMINAL_STATES = TERMINAL_STATES
  module.exports.GATE_REASONS = GATE_REASONS
  module.exports.DEGRADE_KEYS = DEGRADE_KEYS
  module.exports.PENDING_KEY = PENDING_KEY
  module.exports.DEFAULT_REPORT_PATH = DEFAULT_REPORT_PATH
  module.exports.DEFAULT_MAX_ASPECT_RATIO = DEFAULT_MAX_ASPECT_RATIO
  module.exports.IMAGE_EXTENSIONS = IMAGE_EXTENSIONS
  module.exports.BLOCK_TYPES = BLOCK_TYPES
  module.exports.checkImagePath = checkImagePath
  module.exports.toImageSrc = toImageSrc
  module.exports.normalizeOwnUploadUrl = normalizeOwnUploadUrl
  module.exports.OWN_HOSTS = OWN_HOSTS
  module.exports.normalizeBlockType = normalizeBlockType
  module.exports.chooseBlockSource = chooseBlockSource
  module.exports.decodeBlockPayload = decodeBlockPayload
  module.exports.base64Decode = base64Decode
  module.exports.planBlocks = planBlocks
  module.exports.checkGeometry = checkGeometry
  module.exports.checkAspectRatio = checkAspectRatio
  module.exports.checkImageMetrics = checkImageMetrics
  module.exports.checkChartData = checkChartData
  module.exports.checkHtmlBlock = checkHtmlBlock
  module.exports.checkRendered = checkRendered
  module.exports.shortDigest = shortDigest
  module.exports.byteLength = byteLength
  module.exports.createReportDeduper = createReportDeduper
  module.exports.buildReport = buildReport
  module.exports.textKeyFor = textKeyFor
  module.exports.assertReadable = assertReadable
}
