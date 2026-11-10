/**
 * 证件照底色替换（FR-IMG-07）：边缘取样 + 从边界泛洪填充 + 色距阈值。
 * 只替换与「边框连通」且颜色接近底色的像素，避免染色主体（衣服/肤色同色系时更安全）。
 * 纯数组计算，可在 node 下自测。
 */

function hexToRgb(hex) {
  const s = String(hex || '').replace('#', '')
  if (s.length === 3) {
    const t = s.split('').map((c) => c + c).join('')
    return [parseInt(t.slice(0, 2), 16), parseInt(t.slice(2, 4), 16), parseInt(t.slice(4, 6), 16)]
  }
  const m = s.match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i)
  if (!m) return null
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)]
}

/** 加权色距（欧氏距离 / 最大 441.7），返回 0–100 */
function colorDistance(r1, g1, b1, r2, g2, b2) {
  const dr = r1 - r2
  const dg = g1 - g2
  const db = b1 - b2
  // 人眼敏感加权（近似 CIE 白化前的简易感知权重）
  const mean = (r1 + r2) / 2
  const wR = 2 + mean / 256
  const wG = 4
  const wB = 2 + (255 - mean) / 256
  const dist = Math.sqrt(wR * dr * dr + wG * dg * dg + wB * db * db)
  return (dist / 765) * 100
}

/** 边界取样：统计上/左/右三条边带的主色（中位数桶） */
function sampleEdgeColor(data, width, height, bandRatio) {
  const band = Math.max(2, Math.round(height * (bandRatio || 0.12)))
  const buckets = {}
  const take = (x, y) => {
    const o = (y * width + x) * 4
    if (data[o + 3] < 20) return
    const r = data[o] >> 3
    const g = data[o + 1] >> 3
    const b = data[o + 2] >> 3
    const key = r + '_' + g + '_' + b
    const bkt = buckets[key] || (buckets[key] = { n: 0, r: 0, g: 0, b: 0 })
    bkt.n++
    bkt.r += data[o]
    bkt.g += data[o + 1]
    bkt.b += data[o + 2]
  }
  for (let y = 0; y < band; y++) {
    for (let x = 0; x < width; x += 1) take(x, y)
  }
  for (let y = 0; y < height; y += 2) {
    take(0, y)
    take(width - 1, y)
  }
  let best = null
  for (const k in buckets) {
    if (!best || buckets[k].n > best.n) best = buckets[k]
  }
  if (!best || !best.n) return null
  return {
    r: Math.round(best.r / best.n),
    g: Math.round(best.g / best.n),
    b: Math.round(best.b / best.n),
    count: best.n
  }
}

/**
 * 执行底色替换。
 * @param {Object} imgData {data:Uint8ClampedArray,width,height}
 * @param {Object} opt {targetHex, threshold(0-40), bandRatio, sampleHex 可选直接指定取样色}
 * @returns {{replaced:number, sampled:{r,g,b}|null, target:[number,number,number]}}
 */
function replaceBackground(imgData, opt) {
  const data = imgData.data
  const w = imgData.width
  const h = imgData.height
  const target = hexToRgb(opt.targetHex || '#FFFFFF') || [255, 255, 255]
  const threshold = Math.max(1, Math.min(40, Number(opt.threshold) || 18))
  const sampled = opt.sampleHex ? toRgbObj(opt.sampleHex) : sampleEdgeColor(data, w, h, opt.bandRatio)
  if (!sampled) return { replaced: 0, sampled: null, target }

  const visited = new Uint8Array(w * h)
  const stack = new Int32Array(w * h)
  let sp = 0
  let replaced = 0

  const match = (idx) => {
    const o = idx * 4
    return colorDistance(data[o], data[o + 1], data[o + 2], sampled.r, sampled.g, sampled.b) <= threshold
  }

  const push = (idx) => {
    if (idx < 0 || idx >= w * h) return
    if (visited[idx] || !match(idx)) return
    visited[idx] = 1
    stack[sp++] = idx
  }

  for (let x = 0; x < w; x++) {
    push(x)
    push((h - 1) * w + x)
  }
  for (let y = 0; y < h; y++) {
    push(y * w)
    push(y * w + w - 1)
  }

  while (sp > 0) {
    const idx = stack[--sp]
    const o = idx * 4
    // 软边：接近阈值时按 0.6 权重混合，减少发丝硬切
    const dist = colorDistance(data[o], data[o + 1], data[o + 2], sampled.r, sampled.g, sampled.b)
    const mix = dist > threshold * 0.75 ? 0.75 : 1
    data[o] = Math.round(data[o] * (1 - mix) + target[0] * mix)
    data[o + 1] = Math.round(data[o + 1] * (1 - mix) + target[1] * mix)
    data[o + 2] = Math.round(data[o + 2] * (1 - mix) + target[2] * mix)
    data[o + 3] = 255
    replaced++
    const x = idx % w
    if (x > 0) push(idx - 1)
    if (x < w - 1) push(idx + 1)
    if (idx >= w) push(idx - w)
    if (idx < w * (h - 1)) push(idx + w)
  }

  return { replaced, sampled, target }
}

function toRgbObj(hex) {
  const t = hexToRgb(hex)
  return t ? { r: t[0], g: t[1], b: t[2], count: 0 } : null
}

module.exports = {
  hexToRgb,
  colorDistance,
  sampleEdgeColor,
  replaceBackground
}
