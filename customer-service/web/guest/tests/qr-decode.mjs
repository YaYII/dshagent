/**
 * 二维码解码判据（测试专用，访客页面不加载）。
 *
 * 为什么需要它：二维码的**掩码由编码器自行择优**，不同实现可以合法地选出不同掩码，
 * 因此「与另一个实现的模块矩阵逐格比对」是错的判据——实测 qrcode-generator 与
 * Python qrcode 在同样的字符串/纠错级/模式下掩码不同（差 116 格），但两者都能扫出
 * 正确内容。唯一可信的判据是**真的解一次**：把页面渲染出的 SVG 读回模块矩阵、
 * 合成像素、交给独立解码器 jsQR，断言解出的就是业务系统的付款码。
 *
 * 用法：
 *   import { decodeQrSvg } from './qr-decode.mjs'
 *   const r = decodeQrSvg(svgOuterHTML)   // { text, count, module, quiet } | { error }
 */

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const jsQR = require('./jsqr-1.4.0.js')

/**
 * 从二维码 SVG 的 `path` 还原模块矩阵。
 *
 * 页面用一条 path 画所有深色模块，每格一个 `M{x} {y}h{m}v{m}h-{m}z` 子路径，
 * 因此模块边长就是 `h` 的取值（同一张图内恒定），静区 = 最小 x 除以模块边长。
 * @param svg - SVG 源码（浏览器 outerHTML 或字符串）
 * @returns `{ count, module, quiet, dark: Set<'r,c'> }`；解析不出来时 `{ error }`
 */
export function matrixFromQrSvg(svg) {
  const width = Number((svg.match(/width="(\d+)"/) ?? [])[1])
  const path = (svg.match(/<path d="([^"]*)"/) ?? [])[1]
  if (!width || path === undefined) return { error: 'SVG 里没有二维码 path' }
  const cells = [...path.matchAll(/M(\d+) (\d+)h(\d+)v(\d+)h-(\d+)z/g)]
    .map(m => ({ x: Number(m[1]), y: Number(m[2]), w: Number(m[3]) }))
  if (cells.length === 0) return { error: 'path 里没有模块' }
  const module = Math.min(...cells.map(c => c.w))
  if (module <= 0) return { error: '模块边长非正' }
  const quiet = Math.min(...cells.map(c => c.x)) / module
  const count = width / module - quiet * 2
  if (!Number.isInteger(count) || !Number.isInteger(quiet)) {
    return { error: `几何不自洽：width=${width} module=${module} quiet=${quiet}` }
  }
  const dark = new Set()
  for (const cell of cells) {
    const c = cell.x / module - quiet
    const r = cell.y / module - quiet
    if (!Number.isInteger(c) || !Number.isInteger(r)) return { error: '模块坐标不是整数' }
    dark.add(`${r},${c}`)
  }
  return { count, module, quiet, dark }
}

/**
 * 解码二维码 SVG：矩阵 → RGBA 像素 → jsQR。
 *
 * 刻意给足够的模块像素与静区（4 模块），避免「因为采样太稀而解不出」被误报成
 * 「图是错的」——那会迫使实现把模块画得很大，属于判据反过来绑架实现。
 * @param svg - SVG 源码
 * @returns `{ text, count, module, quiet }` 或 `{ error }`
 */
export function decodeQrSvg(svg) {
  const matrix = matrixFromQrSvg(svg)
  if (matrix.error !== undefined) return matrix
  const { count, module, quiet, dark } = matrix
  const scale = 4
  const margin = 4
  const size = (count + margin * 2) * scale
  const data = new Uint8ClampedArray(size * size * 4).fill(255)
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (!dark.has(`${r},${c}`)) continue
      for (let y = 0; y < scale; y++) {
        for (let x = 0; x < scale; x++) {
          const px = (c + margin) * scale + x
          const py = (r + margin) * scale + y
          const i = (py * size + px) * 4
          data[i] = 0
          data[i + 1] = 0
          data[i + 2] = 0
          data[i + 3] = 255
        }
      }
    }
  }
  const result = jsQR(data, size, size)
  if (result === null) return { error: `jsQR 解不出（${count}×${count}，模块 ${module}px）` }
  return { text: result.data, count, module, quiet }
}
