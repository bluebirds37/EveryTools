/**
 * utils/icons.js —— 矢量图标表（CONTRACT C7）
 *
 * 约束：
 *  - 只用 path d 字符串（viewBox 0 0 24 24），禁止 emoji / 图片资源 / 外部字体。
 *  - 多段图形用 '|' 分隔，由 grid-icon 拆开渲染，单条 path ≤400 字符。
 *  - 线条风格：stroke 描边（stroke-width 1.8，round 端点）；FILLED 里的 key 用填充。
 * 渲染方式：运行时拼内联 SVG → base64 → `data:image/svg+xml;base64,…` 交给 grid-icon
 * （小程序对 CSS mask / 内联 <svg> 支持不稳定，base64 dataURI 是唯一跨机型可靠的做法；
 *   因此颜色必须是实际色值，不能传 CSS 变量。）
 */

const ICONS = {
  /* ---------- 图片 ---------- */
  compress: 'M4 4h16|M4 20h16|M12 8v8|M9.5 10.5L12 8l2.5 2.5|M9.5 13.5L12 16l2.5-2.5',
  crop: 'M6 2v16a2 2 0 0 0 2 2h16|M2 6h16a2 2 0 0 1 2 2v16',
  convert: 'M4 9h13|M14 5.5L17.5 9 14 12.5|M20 15H7|M10 11.5L6.5 15 10 18.5',
  stitch: 'M4 4h7v7H4z|M13 4h7v7h-7z|M4 13h7v7H4z|M13 13h7v7h-7z',
  watermark: 'M4 4h16v16H4z|M12 7.5c2.4 2.5 3.8 4.1 3.8 5.8a3.8 3.8 0 0 1-7.6 0c0-1.7 1.4-3.3 3.8-5.8z',
  cut: 'M6.5 9.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6z|M6.5 20.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6z|M9.2 12.5L20 5|M9.2 11.5L20 19',
  idphoto: 'M4 3h16v18H4z|M9.5 10.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4z|M6 16.5c.9-2.2 2.1-3.2 3.5-3.2s2.6 1 3.5 3.2|M15.5 8.5h2.5|M15.5 12h2.5',
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z|M12 11v6|M12 7.5h.01',
  colorpick: 'M14 4l6 6-9 9H5v-6z|M16 2l6 6|M7 15L4.5 17.5',

  /* ---------- 视频 / 条码 ---------- */
  video: 'M3 6h13v12H3z|M16 10l5-3v10l-5-3',
  clip: 'M3 8h18v11H3z|M3 8l1.8-4h14.4L21 8|M8.5 4.2L7 8|M14 4.2L12.5 8|M11 8.2L9.5 12',
  gif: 'M3 5h18v14H3z|M7.5 5v14|M16.5 5v14|M3 9.5h4.5|M3 14.5h4.5|M16.5 9.5H21|M16.5 14.5H21',
  frames: 'M4 4h12v12H4z|M8 20h12V8',
  audio: 'M4 10v4|M8 6v12|M12 3v18|M16 7v10|M20 10v4',
  qr: 'M3 3h7v7H3z|M14 3h7v7h-7z|M3 14h7v7H3z|M14 14h3v3h-3z|M19 14h2v2h-2z|M14 19h2v2h-2z|M18 18h3v3h-3z',
  barcode: 'M4 4v16|M7 4v16|M10 4v11|M13 4v16|M16 4v11|M19 4v16|M21.5 4v16',
  parse: 'M4 8V5a1 1 0 0 1 1-1h3|M16 4h3a1 1 0 0 1 1 1v3|M20 16v3a1 1 0 0 1-1 1h-3|M8 20H5a1 1 0 0 1-1-1v-3|M4 12h16',

  /* ---------- 文本 ---------- */
  json: 'M9 4C6 4 6 8 6 12s0 8-3 8|M15 4c3 0 3 4 3 8s0 8 3 8|M10.5 10h1.5v4h-1.5z',
  timestamp: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z|M12 7v5.5l3.5 2',
  base64: 'M8 7l-4 5 4 5|M16 7l4 5-4 5|M13.5 6l-3 12',
  url: 'M10.5 13.5a4 4 0 0 1 0-5.7l2.3-2.3a4 4 0 0 1 5.7 5.7l-1 1|M13.5 10.5a4 4 0 0 1 0 5.7l-2.3 2.3a4 4 0 0 1-5.7-5.7l1-1',
  hash: 'M9 4L7 20|M17 4l-2 16|M4 9h16|M3 15h16',
  uuid: 'M4 10h3v4H4z|M9 10h2v4H9z|M13 10h2v4h-2z|M17 10h3v4h-3z',
  regex: 'M12 4v16|M5.5 7.5l13 9|M18.5 7.5l-13 9|M4 20h.01',
  stats: 'M4 20h16|M7 20v-6|M12 20V7|M17 20v-9',
  diff: 'M11 4v16|M3 9h5|M15 9h6|M18 6v6|M4 16h5|M15 16h5',
  naming: 'M12 2H2v10l9.29 9.29a2.4 2.4 0 0 0 3.42 0l6.58-6.58a2.4 2.4 0 0 0 0-3.42z|M7 7h.01',
  multiline: 'M4 6h16|M4 12h16|M4 18h10',
  radix: 'M6 5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z|M6 14a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z|M15 5h3v14|M13.5 19h6',
  case: 'M3 18L7 5l4 13|M4.7 14h4.6|M20 12v6a3 3 0 0 1-6 0 3 3 0 0 1 6 0|M20 12a3 3 0 0 0-6 0',

  /* ---------- 换算 ---------- */
  unit: 'M3 8h18v8H3z|M7 8v3|M11 8v3.5|M15 8v3|M19 8v4',
  date: 'M4 6h16v14H4z|M4 10h16|M9 4v4|M15 4v4',
  loan: 'M3 6h18v12H3z|M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6|M7 12h.01|M17 12h.01',
  tax: 'M6 3h12v18l-3-2-3 2-3-2-3 2z|M9 8h6|M9 12h6',
  discount: 'M6.5 6.5L17.5 17.5|M8 9a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z|M16 20a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  percent: 'M19 5L5 19|M7.5 9a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z|M16.5 20a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  random: 'M4 4h16v16H4z|M8.5 8.5h.01|M15.5 8.5h.01|M12 12h.01|M8.5 15.5h.01|M15.5 15.5h.01',
  bmi: 'M3.5 17a8.5 8.5 0 0 1 17 0|M12 17l4-5|M12 17h.01',
  compound: 'M3 20c4 0 6.5-3 9-6.5S17 6 21 6|M21 6h-5|M21 6v5',
  calculator: 'M5 3h14v18H5z|M8 7h8|M8 12h.01|M12 12h.01|M16 12h.01|M8 16h.01|M12 16h.01|M16 16h.01',

  /* ---------- 生活 ---------- */
  compass: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z|M15.5 8.5l-2 5-5 2 2-5z',
  level: 'M3 9h18v6H3z|M8 12a4 4 0 1 0 8 0 4 4 0 1 0-8 0',
  timer: 'M12 6a8 8 0 1 0 0 16 8 8 0 0 0 0-16z|M12 10v4l3 2|M9 3h6|M19 7l1.6-1.6',
  nettest: 'M12 19h.01|M8.5 15.5a5 5 0 0 1 7 0|M5 12a9.5 9.5 0 0 1 14 0|M2 8.5a14 14 0 0 1 20 0',
  screen: 'M3.5 5h17v11h-17z|M9 20h6|M12 16v4',

  /* ---------- 开发 ---------- */
  http: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z|M3 12h18|M12 3c3 3.5 3 14.5 0 18|M12 3c-3 3.5-3 14.5 0 18',
  color: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z|M12 3v9h9|M8 14.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2z|M12 17a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
  jwt: 'M12 3l7 3v6c0 4-3 6.5-7 9-4-2.5-7-5-7-9V6z|M12 10v3.5|M10.5 10a1.5 1.5 0 1 1 3 0 1.5 1.5 0 1 1-3 0',
  cron: 'M12 6a8 8 0 1 0 0 16 8 8 0 0 0 0-16z|M12 9.5V12l2.5 2.5|M3.5 8.5L2 10.2l1.5 1.7|M20.5 8.5L22 10.2l-1.5 1.7',
  sql: 'M12 4c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3z|M20 7v10c0 1.7-3.6 3-8 3s-8-1.3-8-3V7|M20 12c0 1.7-3.6 3-8 3s-8-1.3-8-3',
  ua: 'M3 5h18v11H3z|M9 20h6|M12 16v4|M12 8.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 1 0 0 3z|M9.5 13c.6-1.4 1.5-2 2.5-2s1.9.6 2.5 2',

  /* ---------- UI 通用 ---------- */
  star: 'M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.5 2.9 1-6.1L3.1 9.5l6.1-.9z',
  starFill: 'M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.5 2.9 1-6.1L3.1 9.5l6.1-.9z',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z|M16.5 16.5L21 21',
  close: 'M6 6l12 12|M18 6L6 18',
  copy: 'M9 9h11v11H9z|M4 15V4h11',
  save: 'M5 5h11l3 3v11H5z|M8 5v5h7V5|M8 13h8v6H8z',
  share: 'M18 5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z|M6 11.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z|M18 16.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z|M8.2 12.8l7.6 3.4|M15.8 8.2l-7.6 3.4',
  download: 'M4 17v3h16v-3|M12 4v10|M8.5 11.5L12 15l3.5-3.5',
  chevron: 'M9 6l6 6-6 6',
  check: 'M5 13l4 4L19 7',
  alert: 'M12 3l9 17H3z|M12 9v5|M12 17h.01',
  plus: 'M12 5v14|M5 12h14',
  heart: 'M12 19.5C7 15.5 3.5 12.5 3.5 9a4.5 4.5 0 0 1 8.5-2 4.5 4.5 0 0 1 8.5 2c0 3.5-3.5 6.5-8.5 10.5z',
  settings: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z|M12 3v3|M12 18v3|M3 12h3|M18 12h3|M5.6 5.6l2.1 2.1|M16.3 16.3l2.1 2.1|M18.4 5.6l-2.1 2.1|M7.7 16.3l-2.1 2.1',
  cloud: 'M7 18a4 4 0 0 1-.6-8 5.5 5.5 0 0 1 10.4-1.4A3.8 3.8 0 0 1 17 18z',
  lock: 'M5 11h14v9H5z|M8 11V8a4 4 0 0 1 8 0v3|M12 14.5V17'
}

/** 需要填充而不是描边的 key */
const FILLED = { starFill: 1 }

const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const DEFAULT_COLOR = '#6B7280'
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** 图标 key 列表（供校验/AI 生成用） */
function keys() {
  return Object.keys(ICONS)
}

function has(name) {
  return !!ICONS[String(name || '')]
}

/** 未知 key 归一化到 info，保证 UI 不出现空洞 */
function resolveKey(name) {
  const n = String(name || '')
  if (ICONS[n]) return n
  if (n && require('./env').isDev()) console.warn('[icons] 未登记图标：' + n)
  return 'info'
}

function safeColor(c) {
  const s = String(c || '').trim()
  return HEX_RE.test(s) ? s : DEFAULT_COLOR
}

function pathsOf(name) {
  return String(ICONS[resolveKey(name)] || '').split('|').filter(function (d) {
    return d && d.length <= 400
  })
}

/** 内联 SVG（stroke 线条风；FILLED 里的 key 用填充） */
function svgOf(name, opts) {
  const o = opts || {}
  const color = safeColor(o.color)
  const px = Math.max(12, Math.min(512, Math.round(Number(o.size) || 48)))
  const sw = Number(o.strokeWidth) > 0 ? Number(o.strokeWidth) : 1.8
  const filled = !!FILLED[resolveKey(name)]
  const body = pathsOf(name)
    .map(function (d) {
      return '<path d="' + d.trim() + '"/>'
    })
    .join('')
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" width="' +
    px +
    '" height="' +
    px +
    '" viewBox="0 0 24 24" fill="' +
    (filled ? color : 'none') +
    '" stroke="' +
    (filled ? 'none' : color) +
    '" stroke-width="' +
    sw +
    '" stroke-linecap="round" stroke-linejoin="round">' +
    body +
    '</svg>'
  )
}

function utf8Bytes(str) {
  const out = []
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i)
    if (c < 0x80) out.push(c)
    else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 63))
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      const c2 = str.charCodeAt(i + 1)
      const cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00)
      i++
      out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63))
    } else {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
    }
  }
  return out
}

/** 纯 JS base64（小程序无 btoa；也不用 wx 专有 API，方便 node 自测） */
function base64(str) {
  const bytes = utf8Bytes(str)
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0
    out += B64.charAt(b0 >> 2)
    out += B64.charAt(((b0 & 3) << 4) | (b1 >> 4))
    out += i + 1 < bytes.length ? B64.charAt(((b1 & 15) << 2) | (b2 >> 6)) : '='
    out += i + 2 < bytes.length ? B64.charAt(b2 & 63) : '='
  }
  return out
}

/** 给 <image src> 用的 dataURI */
function dataUri(name, opts) {
  return 'data:image/svg+xml;base64,' + base64(svgOf(name, opts))
}

module.exports = {
  ICONS: ICONS,
  FILLED: FILLED,
  DEFAULT_COLOR: DEFAULT_COLOR,
  keys: keys,
  has: has,
  resolveKey: resolveKey,
  pathsOf: pathsOf,
  svgOf: svgOf,
  dataUri: dataUri,
  base64: base64,
  safeColor: safeColor
}
