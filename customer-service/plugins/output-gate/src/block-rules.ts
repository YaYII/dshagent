/**
 * 受控图形块的结构性判定 — 砖块层（需求 v2 §5 C1–C8）。
 *
 * 分工原则（C0/C7，强制）：**能否显示的裁决权归访客浏览器里的真机渲染器**。服务端
 * 因此只做两类判定：
 *
 *   1. **与真机判据完全同构的确定性检查**（图片地址白名单 IMG1、chart 数据结构 C3、
 *      html 非空与字节上限 C4）——两边用同一条规则得出同一结论，服务端不会否决真机
 *      能正常渲染的块；
 *   2. **不依赖渲染的结构性检查**（空块、超出单块预算、流中止未闭合）。
 *
 * 服务端**不做**几何校验、**不做** mermaid 语法/语义复算（C7）：jsdom 下
 * `mermaid.render()` 必然抛 `getBBox is not a function`，用它当判据只会误拒真机能
 * 正常渲染的块，比现状更差。mermaid 的语法与几何结论一律来自真机回传。
 *
 * @module output-gate/block-rules
 */

import type { GraphicsType } from './fence-machine.ts'

/**
 * 降级原因枚举（O2 冻结，逐字对齐 §12）。
 *
 * 主机侧只产出其中**确定性**的几项：`image-path-invalid`（IMG1 白名单，C5）、
 * `render-empty`（空块）、`chart-invalid` / `html-invalid` / `image-path-invalid` 的
 * 结构性形态、`timeout`（未闭合，P6/P8）。其余（`parse-error`、`image-decode-failed`、
 * `render-empty` 的几何形态、`library-unavailable`）由真机回传。
 */
export const GATE_REASONS = Object.freeze({
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

/** 真机回传可接受的原因集合 = O2 冻结枚举（服务端与真机共用同一张表）。 */
export function acceptedReportReasons(): ReadonlySet<string> {
  return new Set<string>(Object.values(GATE_REASONS))
}

/** 图片文件名允许的扩展名（与访客端 IMG1 白名单逐字一致）。 */
const IMAGE_EXTENSIONS = 'png|jpe?g|gif|webp|avif|svg|bmp'

/** 站点图片路径白名单：`/uploads/<文件名>.<图片扩展名>`。 */
const IMAGE_PATH_RE = new RegExp(`^/uploads/([A-Za-z0-9_.-]+)\\.(${IMAGE_EXTENSIONS})$`, 'i')

/** 允许归一化的自家源站主机（IMG6；精确匹配，不做后缀放宽）。 */
const SELF_HOSTS: readonly string[] = Object.freeze(['www.cem-macau.com', 'cem-macau.com'])

/**
 * 自家源站绝对 URL → 站点相对路径（IMG6 归一化边界，在判定**之前**执行）。
 *
 * KB 实测有 4 条 `https://www.cem-macau.com/uploads/<file>` 形态的引用
 * （`car-model.md` / `ev-tip.md`），这类地址允许显示。归一化只接受**精确主机**
 * `www.cem-macau.com` / `cem-macau.com` 且路径以 `/uploads/` 开头；其余任何主机一律
 * 不做归一化（交给 IMG1 拒绝），因此 `https://evil.example.com/uploads/a.png` 不会
 * 因为"长得像自家"而放行（IMG6）。
 * @param src - 原始图片地址
 * @returns 归一化后的站点相对路径；不属于自家源站时原样返回
 */
export function normalizeSelfSiteUrl(src: string): string {
  const match = /^(https?:)\/\/([^/]+)(\/.*)$/i.exec(src)
  if (match === null) return src
  const host = match[2]!.toLowerCase()
  // 去掉端口后精确比对主机名。
  const bareHost = host.split(':')[0]!
  if (!SELF_HOSTS.includes(bareHost)) return src
  return match[3]!
}

/**
 * 判定图片地址是否为「本站 /uploads 下的单个图片文件」（IMG1 硬门禁，安全不变量）。
 *
 * 只接受 `/uploads/<文件名>.<图片扩展名>`，因此天然拒绝：目录穿越（`..`）、嵌套目录、
 * 查询串与锚点、绝对 URL、其它协议、`data:`、以及任何百分号编码（`%2e%2e`/`%2f`
 * 可用来伪装 `..` 与 `/`）。非法地址**不得被下发**，必须降级（D2：不留未通过校验的 src）。
 * @param src - 待判定的图片地址
 * @returns `{ ok, path }`；`path` 为合法时的原样站点相对路径
 */
export function checkImagePath(src: unknown): { ok: boolean; path: string | null } {
  if (typeof src !== 'string') return { ok: false, path: null }
  // IMG6：自家源站绝对 URL 先归一化，判定对象始终是归一化后的站点相对路径。
  const raw = normalizeSelfSiteUrl(src.trim())
  if (raw === '') return { ok: false, path: null }
  if (raw.includes('%')) return { ok: false, path: null }
  if (/\s/.test(raw)) return { ok: false, path: null }
  const match = IMAGE_PATH_RE.exec(raw)
  if (match === null) return { ok: false, path: null }
  const fileName = match[1]!
  // 文件名必须**含**字母或数字：`_6a4f894bad.svg` 是 KB 真实存在的图片（IMG1 明确列为
  // 合法样例），因此不能用"首字符必须是字母数字"——那会误杀它。而 `..` / `.png` /
  // `_..png` 这类纯点号文件名不含字母数字，仍被拒绝。
  if (!/[A-Za-z0-9]/.test(fileName)) return { ok: false, path: null }
  // 目录穿越的第二道闸：文件名里不得出现 `..`（正则已排除 `/`，此处防 `..png` 形态）。
  if (fileName.includes('..')) return { ok: false, path: null }
  return { ok: true, path: raw }
}

/** chart 块的一行数据。 */
export interface ChartRow {
  label: string
  value: number
}

/**
 * 判定 chart 块（C3）：JSON 解析成功、为非空数组，每项 `label|name` 为非空字符串、
 * `value|count` 为有限且非负的数字。规则与访客端逐条同构，因此两层结论一致。
 * @param text - 块体源码
 * @returns `{ ok, rows }`；失败时 `rows` 为 null
 */
export function checkChartData(text: string): { ok: boolean; rows: ChartRow[] | null } {
  const raw = String(text ?? '').trim()
  if (raw === '') return { ok: false, rows: null }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, rows: null }
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return { ok: false, rows: null }
  const rows: ChartRow[] = []
  for (const item of parsed as unknown[]) {
    if (item === null || typeof item !== 'object') return { ok: false, rows: null }
    const record = item as Record<string, unknown>
    const label = typeof record.label === 'string' && record.label.trim() !== ''
      ? record.label
      : (typeof record.name === 'string' && record.name.trim() !== '' ? record.name : null)
    if (label === null) return { ok: false, rows: null }
    const value = record.value === undefined ? record.count : record.value
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return { ok: false, rows: null }
    rows.push({ label, value })
  }
  return { ok: true, rows }
}

/** 一批块体源码的结构性判定结论。 */
export interface StructuralVerdict {
  /** `render` = 交给真机裁决；`degraded` = 服务端已确定不可显示。 */
  decision: 'render' | 'degraded'
  /** 降级原因（O2 枚举）；`render` 时为 null。 */
  reason: string | null
}

/**
 * 按块类型做服务端结构性判定（C1–C4 的服务端同构部分）。
 *
 * 判定顺序即降级顺序：空块 → 超预算 → 类型专属确定性检查。任何一项失败即
 * `degraded`；全部通过则 `render`，把块交给真机做渲染期裁决。
 * @param blockType - 规范块类型
 * @param source - 块体源码（不含围栏行）
 * @param maxBlockBytes - 单块字节预算（`gate.maxBlockBytes`）
 * @param sourceBytes - 已算好的字节数（避免重复计算）
 * @returns 判定结论
 */
export function structuralVerdict(
  blockType: GraphicsType,
  source: string,
  maxBlockBytes: number,
  sourceBytes: number,
): StructuralVerdict {
  const oversize = sourceBytes > maxBlockBytes
  if (blockType === 'chart') {
    const chart = checkChartData(source)
    return chart.ok && !oversize
      ? { decision: 'render', reason: null }
      : { decision: 'degraded', reason: GATE_REASONS.chartInvalid }
  }
  if (blockType === 'image') {
    // C5：路径合法性是服务端唯一允许的图片判定（确定性正则，无网络依赖）；
    // 图片能否真正显示一律交真机 C4（`decode()` + `naturalWidth`）裁决。
    const path = checkImagePath(firstContentLine(source, 'image'))
    if (!path.ok) return { decision: 'degraded', reason: GATE_REASONS.imagePathInvalid }
    return oversize
      ? { decision: 'degraded', reason: GATE_REASONS.imageDecodeFailed }
      : { decision: 'render', reason: null }
  }
  if (blockType === 'html') {
    const ok = source.trim() !== '' && !oversize
    return ok ? { decision: 'render', reason: null } : { decision: 'degraded', reason: GATE_REASONS.htmlInvalid }
  }
  // mermaid：服务端只判「空块」这类不可能渲染的结构性事实，语法与几何交给真机（C0/C7）。
  return source.trim() !== '' && !oversize
    ? { decision: 'render', reason: null }
    : { decision: 'degraded', reason: GATE_REASONS.renderEmpty }
}

/**
 * 取图片块的首个有效行（图片地址行）。
 * 兼容旧写法中路径被反引号包裹的形态（`` `/uploads/x.png` ``），与访客端取值口径一致。
 * @param source - 图片块块体
 * @param blockType - 块类型（保留参数以明确调用语境）
 * @returns 图片地址候选（已去除包裹反引号与首尾空白）
 */
export function firstContentLine(source: string, blockType: GraphicsType): string {
  void blockType
  for (const line of source.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    return trimmed.replace(/^`+|`+$/g, '').trim()
  }
  return ''
}

/**
 * 图片块通过校验后的**下发路径**（IMG3 同源化 + IMG6 归一化）。
 *
 * 必须先归一化再返回：KB 真实引用中含 `https://www.cem-macau.com/uploads/…` 绝对 URL，
 * 载荷只能给站点相对路径 `/uploads/<file>`，否则访客端会向外部主机发请求（IMG3 违规）。
 * @param source - 图片块块体
 * @returns 通过 IMG1 校验的站点相对路径；非法时返回 null（调用方必须降级）
 */
export function imageSrcPath(source: string): string | null {
  const checked = checkImagePath(firstContentLine(source, 'image'))
  return checked.ok ? checked.path : null
}

/** 图片块除地址行以外的说明文字（第二行及之后）。 */
export function imageCaption(source: string): string {
  const lines = source.split('\n')
  let seenPath = false
  const rest: string[] = []
  for (const line of lines) {
    if (!seenPath) {
      if (line.trim() === '') continue
      seenPath = true
      continue
    }
    rest.push(line)
  }
  return rest.join(' ').trim()
}

/**
 * 流中止时未闭合块的降级原因（P6/P8）。
 * 冻结枚举里没有独立成员，按 §10「超出即降级」的语义归入 `timeout`。
 */
export const UNCLOSED_REASON = GATE_REASONS.timeout

/**
 * 应急净化：把正文里的受控图形围栏整段删除（含流尾未闭合的尾巴）。
 *
 * 用途只有一个——状态机自身抛异常时的兜底（C8「任何判据抛异常必须被捕获并转
 * degraded，不得使整轮回答失败」）。因此它必须比状态机更简单、更不可能失败：按行
 * 扫描，遇到受控围栏起始行就丢弃该块（直到闭合行或文件尾），其余行原样保留。
 * 未闭合的尾部同样整段丢弃——宁可少一段文字，也不把围栏源码交给访客。
 * @param text - 原始正文
 * @returns 不含任何受控围栏内容的正文
 */
export function stripGraphicsFences(text: string): string {
  const lines = String(text ?? '').split('\n')
  const out: string[] = []
  let open: { char: string; len: number } | null = null
  for (const line of lines) {
    if (open === null) {
      const match = /^[ \t]{0,3}([`~]{3,})[ \t]*([A-Za-z][\w-]*)/.exec(line)
      const keyword = match === null ? '' : match[2]!.toLowerCase()
      if (match !== null && (keyword === 'mermaid' || keyword === 'chart' || keyword === 'image' || keyword === 'img' || keyword === 'html')) {
        open = { char: match[1]![0]!, len: match[1]!.length }
        continue
      }
      out.push(line)
      continue
    }
    const close = /^[ \t]{0,3}([`~]+)[ \t]*$/.exec(line)
    if (close !== null && close[1]![0] === open.char && close[1]!.length >= open.len) open = null
  }
  return out.join('\n')
}
