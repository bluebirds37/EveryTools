/**
 * 色彩工具：Median-Cut 主色提取 + 色彩空间换算 + WCAG 对比度（FR-IMG-11）
 * 纯计算，无平台 API，可在 node 下直接自测。
 */

function pad2(v) {
  const s = Math.max(0, Math.min(255, Math.round(v))).toString(16)
  return s.length === 1 ? '0' + s : s
}

function rgbToHex(r, g, b) {
  return '#' + (pad2(r) + pad2(g) + pad2(b)).toUpperCase()
}

function hexToRgb(hex) {
  const s = String(hex || '').trim().replace('#', '')
  if (!/^([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(s)) return null
  const t = s.length === 3 ? s.split('').map((c) => c + c).join('') : s
  return { r: parseInt(t.slice(0, 2), 16), g: parseInt(t.slice(2, 4), 16), b: parseInt(t.slice(4, 6), 16) }
}

/** HSL：h 0-360, s/l 0-100 */
function rgbToHsl(r, g, b) {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  let h = 0
  let s = 0
  const d = max - min
  if (d > 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60
    else if (max === gn) h = ((bn - rn) / d + 2) * 60
    else h = ((rn - gn) / d + 4) * 60
  }
  return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) }
}

/** HSV：h 0-360, s/v 0-100 */
function rgbToHsv(r, g, b) {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const d = max - min
  let h = 0
  if (d > 0) {
    if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60
    else if (max === gn) h = ((bn - rn) / d + 2) * 60
    else h = ((rn - gn) / d + 4) * 60
  }
  return { h: Math.round(h), s: Math.round((max === 0 ? 0 : d / max) * 100), v: Math.round(max * 100) }
}

function hslToRgb(h, s, l) {
  const sn = s / 100
  const ln = l / 100
  const c = (1 - Math.abs(2 * ln - 1)) * sn
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = ln - c / 2
  let rgb = [0, 0, 0]
  if (h < 60) rgb = [c, x, 0]
  else if (h < 120) rgb = [x, c, 0]
  else if (h < 180) rgb = [0, c, x]
  else if (h < 240) rgb = [0, x, c]
  else if (h < 300) rgb = [x, 0, c]
  else rgb = [c, 0, x]
  return { r: Math.round((rgb[0] + m) * 255), g: Math.round((rgb[1] + m) * 255), b: Math.round((rgb[2] + m) * 255) }
}

function allFormats(r, g, b) {
  const hsl = rgbToHsl(r, g, b)
  const hsv = rgbToHsv(r, g, b)
  return {
    hex: rgbToHex(r, g, b),
    rgb: 'rgb(' + r + ', ' + g + ', ' + b + ')',
    rgbArray: [r, g, b],
    hsl: 'hsl(' + hsl.h + ', ' + hsl.s + '%, ' + hsl.l + '%)',
    hsv: 'hsv(' + hsv.h + ', ' + hsv.s + '%, ' + hsv.v + '%)',
    hslObj: hsl,
    hsvObj: hsv
  }
}

/** WCAG 相对亮度 */
function luminance(r, g, b) {
  const ch = (v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b)
}

/** 对比度（1–21） */
function contrastRatio(hexA, hexB) {
  const a = hexToRgb(hexA)
  const b = hexToRgb(hexB)
  if (!a || !b) return null
  const la = luminance(a.r, a.g, a.b)
  const lb = luminance(b.r, b.g, b.b)
  const hi = Math.max(la, lb)
  const lo = Math.min(la, lb)
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 1000) / 1000
}

/** AA/AAA 判定（正文 + 大字） */
function wcagLevel(ratio) {
  if (ratio === null || !isFinite(ratio)) return null
  return {
    normalAA: ratio >= 4.5,
    normalAAA: ratio >= 7,
    largeAA: ratio >= 3,
    largeAAA: ratio >= 4.5,
    text: ratio >= 7 ? 'AAA 全部通过' : ratio >= 4.5 ? 'AA 通过（大字 AAA）' : ratio >= 3 ? '仅大字 AA' : '不达标'
  }
}

/**
 * Median-Cut 主色。
 * @param {Array<{r:number,g:number,b:number}>} pixels 采样像素（建议 ≤ 20000 个）
 * @param {number} count 目标色数 3–10
 * @returns {Array<{hex,rgb,count,ratio,name}>} 按占比降序
 */
function medianCut(pixels, count) {
  const n = Math.max(1, Math.min(10, Math.round(count || 6)))
  const src = (pixels || []).filter((p) => p && isFinite(p.r) && isFinite(p.g) && isFinite(p.b))
  if (!src.length) return []
  let boxes = [{ list: src }]
  while (boxes.length < n) {
    // 找最长通道且像素数 >1 的盒子
    let target = null
    let targetRange = -1
    let targetCh = 'r'
    for (let i = 0; i < boxes.length; i++) {
      const bx = boxes[i]
      if (bx.list.length < 2) continue
      const rg = rangeOf(bx.list)
      const ch = rg.r >= rg.g && rg.r >= rg.b ? 'r' : rg.g >= rg.b ? 'g' : 'b'
      const score = rg[ch] * Math.log(bx.list.length + 1)
      if (score > targetRange) {
        targetRange = score
        target = bx
        targetCh = ch
      }
    }
    if (!target) break
    const sorted = target.list.slice().sort((a, b) => a[targetCh] - b[targetCh])
    const mid = Math.floor(sorted.length / 2)
    boxes = boxes.filter((b) => b !== target)
    boxes.push({ list: sorted.slice(0, mid) })
    boxes.push({ list: sorted.slice(mid) })
  }

  const total = src.length
  const out = boxes
    .filter((b) => b.list.length)
    .map((b) => {
      let r = 0
      let g = 0
      let bl = 0
      for (let i = 0; i < b.list.length; i++) {
        r += b.list[i].r
        g += b.list[i].g
        bl += b.list[i].b
      }
      const c = b.list.length
      const rr = Math.round(r / c)
      const gg = Math.round(g / c)
      const bb = Math.round(bl / c)
      const pct = Math.round((c / total) * 1000) / 10
      return {
        hex: rgbToHex(rr, gg, bb),
        rgb: 'rgb(' + rr + ', ' + gg + ', ' + bb + ')',
        rgbArray: [rr, gg, bb],
        hsl: rgbToHsl(rr, gg, bb),
        count: c,
        ratio: pct,
        name: colorName(rr, gg, bb)
      }
    })
    .sort((a, b) => b.count - a.count)
  return out.slice(0, n)
}

function rangeOf(list) {
  let minR = 255
  let maxR = 0
  let minG = 255
  let maxG = 0
  let minB = 255
  let maxB = 0
  for (let i = 0; i < list.length; i++) {
    const p = list[i]
    if (p.r < minR) minR = p.r
    if (p.r > maxR) maxR = p.r
    if (p.g < minG) minG = p.g
    if (p.g > maxG) maxG = p.g
    if (p.b < minB) minB = p.b
    if (p.b > maxB) maxB = p.b
  }
  return { r: maxR - minR, g: maxG - minG, b: maxB - minB }
}

function colorName(r, g, b) {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = Math.round(((max + min) / 2 / 255) * 100)
  if (max - min < 16) {
    if (l > 92) return '近白'
    if (l < 10) return '近黑'
    return '灰'
  }
  const h = rgbToHsl(r, g, b).h
  if (h < 15 || h >= 345) return '红'
  if (h < 45) return '橙'
  if (h < 70) return '黄'
  if (h < 160) return '绿'
  if (h < 200) return '青'
  if (h < 255) return '蓝'
  if (h < 300) return '紫'
  return '品红'
}

/**
 * 从 canvas 像素数据采样。
 * @param {Object} data ImageData-like {data,width,height}
 * @param {number} maxSamples 采样上限（内存/耗时保护）
 */
function samplePixels(data, maxSamples) {
  const px = data && data.data
  if (!px || !px.length) return []
  const limit = maxSamples || 4000
  const total = Math.floor(px.length / 4)
  const step = Math.max(1, Math.floor(total / limit))
  const out = []
  for (let i = 0; i < total; i += step) {
    const o = i * 4
    if (px[o + 3] < 24) continue // 跳过全透明
    out.push({ r: px[o], g: px[o + 1], b: px[o + 2] })
  }
  return out
}

/** 生成色阶（用于调色板展示，深浅 5 档） */
function shadeScale(hex) {
  const c = hexToRgb(hex)
  if (!c) return []
  const hsl = rgbToHsl(c.r, c.g, c.b)
  const steps = [15, 30, 50, 70, 88]
  return steps.map((l) => {
    const rgb = hslToRgb(hsl.h, hsl.s, l)
    return { l, hex: rgbToHex(rgb.r, rgb.g, rgb.b) }
  })
}

module.exports = {
  rgbToHex,
  hexToRgb,
  rgbToHsl,
  rgbToHsv,
  hslToRgb,
  allFormats,
  luminance,
  contrastRatio,
  wcagLevel,
  medianCut,
  samplePixels,
  colorName,
  shadeScale
}
