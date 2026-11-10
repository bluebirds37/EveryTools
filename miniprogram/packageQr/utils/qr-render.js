/**
 * QR 码渲染：矩阵 -> 像素缓冲（node 自测用）/ Canvas 2D 绘制（小程序用）
 * 依赖：无 wx 全局，Canvas 相关方法只操作传入的 ctx。
 */

const HEX = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

function parseColor(hex) {
  let s = String(hex || '').replace(/^#/, '')
  if (s.length === 3) s = s.split('').map((c) => c + c).join('')
  if (!/^[0-9a-fA-F]{6}$/.test(s)) throw new Error('[qr] 非法颜色: ' + hex)
  return {
    r: parseInt(s.substring(0, 2), 16),
    g: parseInt(s.substring(2, 4), 16),
    b: parseInt(s.substring(4, 6), 16)
  }
}

function normalizeHex(hex) {
  const c = parseColor(hex)
  const p = (n) => (n < 16 ? '0' : '') + n.toString(16)
  return ('#' + p(c.r) + p(c.g) + p(c.b)).toUpperCase()
}

function toHex(c) {
  return '#' + c.replace(/^#/, '')
}

/** 相对亮度（WCAG / sRGB） */
function relativeLuminance(rgb) {
  const f = (v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * f(rgb.r) + 0.7152 * f(rgb.g) + 0.0722 * f(rgb.b)
}

/** 对比度 1~21 */
function contrastRatio(hexA, hexB) {
  const la = relativeLuminance(parseColor(hexA))
  const lb = relativeLuminance(parseColor(hexB))
  const hi = Math.max(la, lb)
  const lo = Math.min(la, lb)
  return (hi + 0.05) / (lo + 0.05)
}

/** 二维码可读性所需的「前景/背景亮度差」，规范要求对比度 ≥ 1.5（此处取更严格阈值） */
function isScannable(fg, bg) {
  return contrastRatio(fg, bg) >= 3.0
}

/**
 * 矩阵 -> RGBA 像素缓冲
 * @param {{size:number,modules:Uint8Array}} qr
 * @param {object} opts {moduleSize, quiet, fg, bg, reserve}
 * @returns {{width,height,data:Uint8Array}} data 为 RGBA
 */
function toPixels(qr, opts) {
  opts = opts || {}
  const ms = Math.max(1, opts.moduleSize || 4)
  const quiet = opts.quiet === undefined ? 4 : opts.quiet
  const fg = parseColor(opts.fg || '#000000')
  const bg = parseColor(opts.bg || '#FFFFFF')
  const qrPx = qr.size * ms
  const width = qrPx + quiet * 2 * ms
  const height = width + (opts.reserve ? (opts.reservePx || 0) : 0)
  const data = new Uint8Array(width * height * 4)

  const put = (x, y, c) => {
    const i = (y * width + x) * 4
    data[i] = c.r
    data[i + 1] = c.g
    data[i + 2] = c.b
    data[i + 3] = 255
  }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) put(x, y, bg)
  for (let r = 0; r < qr.size; r++) {
    for (let c = 0; c < qr.size; c++) {
      if (!qr.modules[r * qr.size + c]) continue
      const ox = quiet * ms + c * ms
      const oy = quiet * ms + r * ms
      for (let dy = 0; dy < ms; dy++) for (let dx = 0; dx < ms; dx++) put(ox + dx, oy + dy, fg)
    }
  }
  return { width, height, data, qrOffset: quiet * ms, moduleSize: ms }
}

/** 灰度版（解码器输入）：0..255 */
function toGray(pix) {
  const g = new Uint8Array(pix.width * pix.height)
  for (let i = 0, j = 0; i < pix.data.length; i += 4, j++) {
    g[j] = (pix.data[i] * 77 + pix.data[i + 1] * 150 + pix.data[i + 2] * 29) >> 8
  }
  return g
}

/**
 * 用 Canvas 2D 绘制（小程序 / node canvas 通用：只要 ctx 有 fillRect/fillText 等）
 * @param {object} ctx CanvasRenderingContext2D
 * @param {object} qr encode() 结果
 * @param {object} opts {px 输出边长, moduleSize 覆盖, quiet, fg, bg, label, labelSize, labelColor, logoImage, logoRatio}
 */
function drawToContext(ctx, qr, opts) {
  opts = opts || {}
  const quiet = opts.quiet === undefined ? 4 : opts.quiet
  const target = opts.px || (qr.size + quiet * 2) * (opts.moduleSize || 6)
  const total = qr.size + quiet * 2
  const ms = target / total
  const labelH = opts.label ? Math.round(target * 0.11) + 8 : 0
  const outH = target + labelH

  ctx.save()
  ctx.fillStyle = opts.bg || '#FFFFFF'
  ctx.fillRect(0, 0, target, outH)
  ctx.fillStyle = opts.fg || '#000000'
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (!qr.modules[y * qr.size + x]) continue
      ctx.fillRect(Math.round((quiet + x) * ms), Math.round((quiet + y) * ms), Math.ceil(ms), Math.ceil(ms))
    }
  }

  // 中心 logo：默认 15%，硬上限 25%（超出则裁到 25% 并由调用方提示风险）
  if (opts.logoImage && opts.logoImage.width !== undefined) {
    const ratio = Math.min(0.25, Math.max(0.05, opts.logoRatio === undefined ? 0.15 : opts.logoRatio))
    const box = Math.round(target * ratio)
    const pad = Math.max(2, Math.round(box * 0.08))
    ctx.fillStyle = opts.bg || '#FFFFFF'
    ctx.fillRect(Math.round((target - box) / 2) - pad, Math.round((target - box) / 2) - pad, box + pad * 2, box + pad * 2)
    let dw = box
    let dh = box
    const ar = opts.logoImage.width / (opts.logoImage.height || opts.logoImage.width)
    if (ar > 1) dh = Math.round(box / ar)
    else dw = Math.round(box * ar)
    ctx.drawImage(opts.logoImage, Math.round((target - dw) / 2), Math.round((target - dh) / 2), dw, dh)
  }

  if (opts.label) {
    ctx.fillStyle = opts.labelColor || '#333333'
    ctx.font = (opts.labelSize || Math.round(target / 14)) + 'px sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(String(opts.label), Math.round(target / 2), target + Math.round(labelH / 2))
  }
  ctx.restore()
  return { width: target, height: outH }
}

module.exports = {
  HEX,
  parseColor,
  normalizeHex,
  relativeLuminance,
  contrastRatio,
  isScannable,
  toPixels,
  toGray,
  drawToContext
}
