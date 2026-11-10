/* packageDev/utils/color.js —— 颜色解析 / 互转 / WCAG 对比度 / 色阶（FR-DEV-02 纯逻辑，无 wx 依赖） */

const NAMED = {
  black: '#000000',
  white: '#ffffff',
  red: '#ff0000',
  green: '#008000',
  blue: '#0000ff',
  yellow: '#ffff00',
  cyan: '#00ffff',
  magenta: '#ff00ff',
  gray: '#808080',
  grey: '#808080',
  orange: '#ffa500',
  purple: '#800080',
  lime: '#00ff00',
  teal: '#008080',
  navy: '#000080',
  maroon: '#800000'
}

function clamp(n, min, max) {
  return n < min ? min : n > max ? max : n
}

function round(n, p) {
  const f = Math.pow(10, p == null ? 2 : p)
  return Math.round(n * f) / f
}

function pad2(n) {
  return (n < 10 ? '0' : '') + n
}

function hex2(n) {
  return pad2(clamp(Math.round(n), 0, 255).toString(16))
}

/* ---------------- 解析 ---------------- */

function fromHex(text) {
  let s = String(text).trim().replace(/^#/, '')
  if (!/^[0-9a-fA-F]+$/.test(s)) return null
  if (s.length === 3 || s.length === 4) s = s.split('').map((c) => c + c).join('')
  if (s.length !== 6 && s.length !== 8) return null
  const c = {
    r: parseInt(s.slice(0, 2), 16),
    g: parseInt(s.slice(2, 4), 16),
    b: parseInt(s.slice(4, 6), 16),
    a: s.length === 8 ? parseInt(s.slice(6, 8), 16) / 255 : 1
  }
  return c
}

function num(text, scale) {
  const s = String(text).trim()
  const isPct = /%$/.test(s)
  const n = parseFloat(s.replace(/%|deg|rad|turn/gi, ''))
  if (!isFinite(n)) return null
  return isPct ? (n / 100) * scale : n
}

function splitChannels(inner) {
  const parts = String(inner).trim().split(/[\s,\/]+/).filter(function (x) {
    return x.length
  })
  return parts
}

function fromFunction(text) {
  const m = /^([a-z]+)\s*\(([^)]*)\)$/i.exec(String(text).trim())
  if (!m) return null
  const fn = m[1].toLowerCase()
  const ch = splitChannels(m[2])
  if (fn === 'rgb' || fn === 'rgba') {
    if (ch.length < 3) return null
    const c = { r: num(ch[0], 255), g: num(ch[1], 255), b: num(ch[2], 255), a: ch.length > 3 ? num(ch[3], 1) : 1 }
    if (c.r == null || c.g == null || c.b == null) return null
    c.r = clamp(Math.round(c.r), 0, 255)
    c.g = clamp(Math.round(c.g), 0, 255)
    c.b = clamp(Math.round(c.b), 0, 255)
    c.a = clamp(c.a == null ? 1 : c.a, 0, 1)
    return c
  }
  if (fn === 'hsl' || fn === 'hsla') {
    if (ch.length < 3) return null
    const h = num(ch[0], 360)
    const s = num(ch[1], 100)
    const l = num(ch[2], 100)
    const a = ch.length > 3 ? num(ch[3], 1) : 1
    if (h == null || s == null || l == null) return null
    return normalize(hslToRgb(h, s, l), a == null ? 1 : a)
  }
  if (fn === 'hsv' || fn === 'hsb' || fn === 'hsva') {
    if (ch.length < 3) return null
    const h = num(ch[0], 360)
    const s = num(ch[1], 100)
    const v = num(ch[2], 100)
    if (h == null || s == null || v == null) return null
    return normalize(hsvToRgb(h, s, v), ch.length > 3 ? num(ch[3], 1) || 1 : 1)
  }
  return null
}

function parseColor(input) {
  const s = String(input == null ? '' : input).trim().toLowerCase()
  if (!s) return null
  if (NAMED[s]) return fromHex(NAMED[s])
  if (s.charAt(0) === '#' || /^[0-9a-f]{3,8}$/.test(s)) return fromHex(s)
  if (/\(/.test(s)) return fromFunction(s)
  const parts = splitChannels(s)
  if (parts.length >= 3) return fromFunction('rgb(' + parts.join(' ') + ')')
  return null
}

/* ---------------- 空间互转 ---------------- */

function normalize(rgb, alpha) {
  return {
    r: clamp(Math.round(rgb.r), 0, 255),
    g: clamp(Math.round(rgb.g), 0, 255),
    b: clamp(Math.round(rgb.b), 0, 255),
    a: round(alpha == null ? 1 : alpha, 3)
  }
}

function rgbToHsl(c) {
  const r = c.r / 255,
    g = c.g / 255,
    b = c.b / 255
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b)
  const l = (max + min) / 2
  let h = 0,
    s = 0
  const d = max - min
  if (d > 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60
    else if (max === g) h = ((b - r) / d + 2) * 60
    else h = ((r - g) / d + 4) * 60
  }
  return { h: round(h, 1), s: round(s * 100, 1), l: round(l * 100, 1) }
}

function rgbToHsv(c) {
  const r = c.r / 255,
    g = c.g / 255,
    b = c.b / 255
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b)
  const d = max - min
  let h = 0
  if (d > 0) {
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60
    else if (max === g) h = ((b - r) / d + 2) * 60
    else h = ((r - g) / d + 4) * 60
  }
  return { h: round(h, 1), s: round((max === 0 ? 0 : d / max) * 100, 1), v: round(max * 100, 1) }
}

function hslToRgb(h, s, l) {
  const H = ((h % 360) + 360) % 360,
    S = clamp(s, 0, 100) / 100,
    L = clamp(l, 0, 100) / 100
  const c = (1 - Math.abs(2 * L - 1)) * S
  const x = c * (1 - Math.abs(((H / 60) % 2) - 1))
  const m = L - c / 2
  let rp = 0,
    gp = 0,
    bp = 0
  if (H < 60) {
    rp = c
    gp = x
  } else if (H < 120) {
    rp = x
    gp = c
  } else if (H < 180) {
    gp = c
    bp = x
  } else if (H < 240) {
    gp = x
    bp = c
  } else if (H < 300) {
    rp = x
    bp = c
  } else {
    rp = c
    bp = x
  }
  return { r: (rp + m) * 255, g: (gp + m) * 255, b: (bp + m) * 255 }
}

function hsvToRgb(h, s, v) {
  const H = ((h % 360) + 360) % 360,
    S = clamp(s, 0, 100) / 100,
    V = clamp(v, 0, 100) / 100
  const c = V * S
  const x = c * (1 - Math.abs(((H / 60) % 2) - 1))
  const m = V - c
  let rp = 0,
    gp = 0,
    bp = 0
  if (H < 60) {
    rp = c
    gp = x
  } else if (H < 120) {
    rp = x
    gp = c
  } else if (H < 180) {
    gp = c
    bp = x
  } else if (H < 240) {
    gp = x
    bp = c
  } else if (H < 300) {
    rp = x
    bp = c
  } else {
    rp = c
    bp = x
  }
  return { r: (rp + m) * 255, g: (gp + m) * 255, b: (bp + m) * 255 }
}

/* ---------------- 格式化 ---------------- */

function toHex(c, withAlpha) {
  const base = '#' + hex2(c.r) + hex2(c.g) + hex2(c.b)
  return withAlpha && c.a < 1 ? base + hex2(c.a * 255) : base
}

function toRgbText(c) {
  return 'rgb(' + c.r + ', ' + c.g + ', ' + c.b + ')'
}

function toRgbaText(c) {
  return 'rgba(' + c.r + ', ' + c.g + ', ' + c.b + ', ' + round(c.a, 2) + ')'
}

function toHslText(c) {
  const h = rgbToHsl(c)
  return 'hsl(' + h.h + ', ' + h.s + '%, ' + h.l + '%)'
}

function toHsvText(c) {
  const v = rgbToHsv(c)
  return 'hsv(' + v.h + ', ' + v.s + '%, ' + v.v + '%)'
}

/** 全格式结果：{ hex, hex8, rgb, rgba, hsl, hsv, hslObj, hsvObj } */
function formats(input) {
  const c = typeof input === 'string' ? parseColor(input) : input
  if (!c) return null
  return {
    color: c,
    hex: toHex(c, false),
    hex8: toHex(c, true),
    rgb: toRgbText(c),
    rgba: toRgbaText(c),
    hsl: toHslText(c),
    hsv: toHsvText(c),
    hslObj: rgbToHsl(c),
    hsvObj: rgbToHsv(c),
    alpha: round(c.a, 3)
  }
}

/* ---------------- WCAG 对比度 ---------------- */

function channelLinear(v) {
  const s = v / 255
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
}

/** WCAG 2.1 相对亮度 */
function luminance(c) {
  return 0.2126 * channelLinear(c.r) + 0.7152 * channelLinear(c.g) + 0.0722 * channelLinear(c.b)
}

/** 对比度（1–21），保留两位小数 */
function contrast(a, b) {
  const c1 = typeof a === 'string' ? parseColor(a) : a
  const c2 = typeof b === 'string' ? parseColor(b) : b
  if (!c1 || !c2) return null
  const l1 = luminance(c1),
    l2 = luminance(c2)
  const hi = Math.max(l1, l2),
    lo = Math.min(l1, l2)
  return round((hi + 0.05) / (lo + 0.05), 2)
}

/** WCAG 判定：正文 AA 4.5 / AAA 7；大号文字 AA 3 / AAA 4.5 */
function wcag(ratio) {
  const r = Number(ratio) || 0
  return {
    ratio: r,
    aaNormal: r >= 4.5,
    aaLarge: r >= 3,
    aaaNormal: r >= 7,
    aaaLarge: r >= 4.5,
    uiComponent: r >= 3
  }
}

/* ---------------- 色阶 / 配色 ---------------- */

function mix(c, target, t) {
  return normalize({ r: c.r + (target.r - c.r) * t, g: c.g + (target.g - c.g) * t, b: c.b + (target.b - c.b) * t }, c.a)
}

const WHITE = { r: 255, g: 255, b: 255, a: 1 }
const BLACK = { r: 0, g: 0, b: 0, a: 1 }

/** 以 base 为中心生成明暗色阶（等比混合白/黑），steps 为每侧档数 */
function scale(input, steps) {
  const c = typeof input === 'string' ? parseColor(input) : input
  if (!c) return []
  const n = clamp(Math.round(Number(steps) || 5), 2, 9)
  const list = []
  for (let i = n; i >= 1; i--) {
    const t = i / (n + 1)
    const s = mix(c, WHITE, t)
    list.push({ label: Math.round(t * 100) + '% 浅', hex: toHex(s, false), color: s })
  }
  list.push({ label: '基准', hex: toHex(c, false), color: c, base: true })
  for (let i = 1; i <= n; i++) {
    const t = i / (n + 1)
    const s = mix(c, BLACK, t)
    list.push({ label: Math.round(t * 100) + '% 深', hex: toHex(s, false), color: s })
  }
  return list
}

/** 色阶（HSL 明度阶梯，白→base→黑）：level 档数 */
function ramp(input, level) {
  const c = typeof input === 'string' ? parseColor(input) : input
  if (!c) return []
  const h = rgbToHsl(c)
  const n = clamp(Math.round(Number(level) || 9), 3, 15)
  const out = []
  for (let i = 1; i <= n; i++) {
    const l = round((i / (n + 1)) * 100, 1)
    const s = h.s === 0 ? 0 : clamp(h.s, 8, 100)
    const rgb = normalize(hslToRgb(h.h, s, l), 1)
    out.push({ label: 'L' + Math.round(l), hex: toHex(rgb, false), rgb: toRgbText(rgb), color: rgb })
  }
  return out
}

/** 常用配色关系（同色相/互补/三角/相邻） */
function harmony(input) {
  const c = typeof input === 'string' ? parseColor(input) : input
  if (!c) return []
  const h = rgbToHsl(c)
  const at = function (hue, sat, light) {
    const rgb = normalize(hslToRgb(hue, sat == null ? h.s : sat, light == null ? h.l : light), 1)
    return { hex: toHex(rgb, false), rgb: toRgbText(rgb), hsl: toHslText(rgb), color: rgb }
  }
  return [
    { name: '同色相 · 深', tone: at(h.h, h.s, clamp(h.l - 22, 4, 96)) },
    { name: '同色相 · 浅', tone: at(h.h, clamp(h.s - 12, 0, 100), clamp(h.l + 22, 4, 96)) },
    { name: '互补', tone: at(h.h + 180, h.s, h.l) },
    { name: '分裂互补 A', tone: at(h.h + 150, h.s, h.l) },
    { name: '分裂互补 B', tone: at(h.h + 210, h.s, h.l) },
    { name: '三角 A', tone: at(h.h + 120, h.s, h.l) },
    { name: '三角 B', tone: at(h.h + 240, h.s, h.l) }
  ]
}

/** 前景建议：在白/黑之间选对比度更高的一个 */
function bestTextOn(input) {
  const c = typeof input === 'string' ? parseColor(input) : input
  if (!c) return null
  const w = contrast(c, WHITE),
    b = contrast(c, BLACK)
  return { white: w, black: b, suggest: w >= b ? '#FFFFFF' : '#000000', ratio: Math.max(w || 0, b || 0) }
}

module.exports = {
  NAMED: NAMED,
  parseColor: parseColor,
  formats: formats,
  rgbToHsl: rgbToHsl,
  rgbToHsv: rgbToHsv,
  hslToRgb: hslToRgb,
  hsvToRgb: hsvToRgb,
  toHex: toHex,
  toRgbText: toRgbText,
  toHslText: toHslText,
  toHsvText: toHsvText,
  luminance: luminance,
  contrast: contrast,
  wcag: wcag,
  scale: scale,
  ramp: ramp,
  harmony: harmony,
  bestTextOn: bestTextOn,
  mix: mix
}
