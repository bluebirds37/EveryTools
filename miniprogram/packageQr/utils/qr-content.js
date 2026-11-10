/**
 * packageQr/utils/qr-content.js
 * 二维码「内容构造 + 前置校验」（FR-QR-01）。纯逻辑，可 node require 自测。
 *
 * 生成的字符串遵循主流扫码器（微信/zxing）约定的私有格式：
 *   WIFI:T:WPA;S:ssid;P:pass;H:false;;
 *   BEGIN:VCARD / VERSION:3.0 ... END:VCARD
 *   SMSTO:号码:正文      TEL:号码      geo:lat,lng[,alt]
 */

const TYPES = [
  { value: 'text', label: '文本' },
  { value: 'url', label: '链接' },
  { value: 'wifi', label: 'WiFi' },
  { value: 'vcard', label: '名片' },
  { value: 'sms', label: '短信' },
  { value: 'tel', label: '电话' },
  { value: 'geo', label: '位置' }
]

const WIFI_ENCRYPTS = [
  { value: 'WPA', label: 'WPA/WPA2' },
  { value: 'WEP', label: 'WEP' },
  { value: 'nopass', label: '开放网络' }
]

/** WIFI 私有格式的分隔符需反斜杠转义；前导空白也会被解析器吞掉（zxing 约定） */
function escapeWifi(raw) {
  const s = String(raw === undefined || raw === null ? '' : raw)
  const esc = s.replace(/([\\;,:"])/g, '\\$1')
  return esc.replace(/^\s+/, function (m) {
    return m.replace(/\s/g, '\\s')
  })
}

/** vCard 3.0：TEXT 值里的分隔符用 \, \; 转义，换行用 \n */
function escapeVcs(raw) {
  return String(raw === undefined || raw === null ? '' : raw)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n')
}

function num(v) {
  return typeof v === 'number' ? v : parseFloat(String(v === undefined ? '' : v).trim())
}

function digitsOnly(v) {
  return String(v === undefined || v === null ? '' : v).replace(/[^\d+*\-]/g, '')
}

/** 电话：国际冠码 + 3~15 位（E.164 上限），或短号 */
function isPhone(v) {
  const s = digitsOnly(v)
  if (!s) return false
  if (s.charAt(0) === '+') return s.length >= 4 && s.length <= 16
  return s.length >= 3 && s.length <= 15
}

function isUrl(v) {
  const s = String(v || '').trim()
  if (!s) return false
  const m = /^(https?|ftp):\/\/([a-z0-9.-]+\.[a-z]{2,}|localhost|\d{1,3}(\.\d{1,3}){3})(:\d{1,5})?(\/[^\s]*)?$/i.exec(s)
  return !!m
}

/** 缺协议时补 https://（不做静默失败：页面需展示最终原文） */
function normalizeUrl(v) {
  const s = String(v || '').trim()
  if (!s) return ''
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s
  if (/^www\./i.test(s)) return 'https://' + s
  if (/^[a-z0-9.-]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(s)) return 'https://' + s
  return s
}

/**
 * 各类型的字段 schema（页面 param-form 直接用）
 * showIf 依赖遵循 C4 组件契约。
 */
const SCHEMA = {
  text: [{ key: 'text', label: '内容', type: 'textarea', def: '' }],
  url: [{ key: 'url', label: '链接', type: 'textarea', def: '', single: true }],
  wifi: [
    { key: 'ssid', label: '网络名称 SSID', type: 'textarea', def: '', single: true },
    { key: 'encrypt', label: '加密方式', type: 'segment', options: WIFI_ENCRYPTS, def: 'WPA' },
    { key: 'password', label: '密码', type: 'textarea', def: '', single: true, showIf: { key: 'encrypt', in: ['WPA', 'WEP'] } },
    { key: 'hidden', label: '隐藏网络', type: 'switch', def: false }
  ],
  vcard: [
    { key: 'lastName', label: '姓', type: 'textarea', def: '', single: true },
    { key: 'firstName', label: '名', type: 'textarea', def: '', single: true },
    { key: 'org', label: '公司', type: 'textarea', def: '', single: true },
    { key: 'title', label: '职位', type: 'textarea', def: '', single: true },
    { key: 'phone', label: '手机', type: 'textarea', def: '', single: true },
    { key: 'workPhone', label: '办公电话', type: 'textarea', def: '', single: true },
    { key: 'email', label: '邮箱', type: 'textarea', def: '', single: true },
    { key: 'address', label: '地址', type: 'textarea', def: '', single: true },
    { key: 'note', label: '备注', type: 'textarea', def: '' }
  ],
  sms: [
    { key: 'phone', label: '号码', type: 'textarea', def: '', single: true },
    { key: 'body', label: '预填正文', type: 'textarea', def: '' }
  ],
  tel: [{ key: 'phone', label: '号码', type: 'textarea', def: '', single: true }],
  geo: [
    { key: 'lat', label: '纬度', type: 'number', def: '', precision: 6 },
    { key: 'lng', label: '经度', type: 'number', def: '', precision: 6 },
    { key: 'alt', label: '海拔（可选）', type: 'number', def: '' }
  ]
}

/** 构造内容字符串；返回 { content } 或抛 err.code=PARAM_INVALID */
function build(type, v) {
  const p = v || {}
  if (type === 'text') {
    const t = String(p.text === undefined ? '' : p.text)
    if (!t.trim()) throw bad('INPUT_EMPTY', '内容为空')
    return t
  }
  if (type === 'url') {
    const u = normalizeUrl(p.url)
    if (!isUrl(u)) throw bad('PARAM_INVALID', '链接格式不正确，需以 http:// 或 https:// 开头的完整域名')
    return u
  }
  if (type === 'wifi') {
    const ssid = String(p.ssid === undefined ? '' : p.ssid)
    if (!ssid.trim()) throw bad('PARAM_INVALID', 'WiFi 名称（SSID）不能为空')
    const enc = WIFI_ENCRYPTS.some((e) => e.value === p.encrypt) ? p.encrypt : 'WPA'
    let out = 'WIFI:T:' + enc + ';S:' + escapeWifi(ssid) + ';'
    if (enc !== 'nopass') {
      const pwd = String(p.password === undefined ? '' : p.password)
      if (!pwd) throw bad('PARAM_INVALID', '该加密方式需要填写密码')
      out += 'P:' + escapeWifi(pwd) + ';'
    }
    if (p.hidden) out += 'H:true;'
    return out + ';'
  }
  if (type === 'vcard') {
    const last = String(p.lastName || '').trim()
    const first = String(p.firstName || '').trim()
    const phone = digitsOnly(p.phone)
    const work = digitsOnly(p.workPhone)
    const email = String(p.email || '').trim()
    if (!last && !first && !phone && !work && !email) {
      throw bad('PARAM_INVALID', '名片至少需要姓名、电话或邮箱中的一项')
    }
    if (email && !/^[\w.%+-]+@[\w-]+(\.[\w-]+)+$/.test(email)) throw bad('PARAM_INVALID', '邮箱格式不正确')
    if (phone && !isPhone(phone)) throw bad('PARAM_INVALID', '手机号/电话号码位数不正确（3~15 位，可带 + 区号）')
    const L = escapeVcs(last)
    const F = escapeVcs(first)
    const lines = ['BEGIN:VCARD', 'VERSION:3.0']
    lines.push('N:' + L + ';' + F + ';;;')
    lines.push('FN:' + escapeVcs((first ? first + ' ' : '') + last || first || last))
    if (p.org || p.title) lines.push('ORG:' + escapeVcs(p.org || '') + (p.title ? ';' + escapeVcs(p.title) : ''))
    if (p.title && !p.org) lines.push('TITLE:' + escapeVcs(p.title))
    if (phone) lines.push('TEL;TYPE=CELL:' + phone)
    if (work) lines.push('TEL;TYPE=WORK:' + work)
    if (email) lines.push('EMAIL;TYPE=INTERNET:' + escapeVcs(email))
    if (String(p.address || '').trim()) lines.push('ADR;TYPE=WORK:;;' + escapeVcs(String(p.address).trim()) + ';;;;')
    if (String(p.note || '').trim()) lines.push('NOTE:' + escapeVcs(String(p.note).trim()))
    lines.push('END:VCARD')
    return lines.join('\r\n')
  }
  if (type === 'sms') {
    const phone = digitsOnly(p.phone)
    if (!isPhone(phone)) throw bad('PARAM_INVALID', '短信接收号码不正确（3~15 位，可带 + 区号）')
    const body = String(p.body === undefined ? '' : p.body)
    return 'SMSTO:' + phone + ':' + body
  }
  if (type === 'tel') {
    const phone = digitsOnly(p.phone)
    if (!isPhone(phone)) throw bad('PARAM_INVALID', '电话号码不正确（3~15 位，可带 + 区号）')
    return 'TEL:' + phone
  }
  if (type === 'geo') {
    const la = num(p.lat)
    const lo = num(p.lng)
    if (isNaN(la) || isNaN(lo)) throw bad('PARAM_INVALID', '经纬度必须是数字')
    if (la < -90 || la > 90) throw bad('PARAM_INVALID', '纬度范围 -90 ~ 90')
    if (lo < -180 || lo > 180) throw bad('PARAM_INVALID', '经度范围 -180 ~ 180')
    const al = num(p.alt)
    let out = 'geo:' + fmtCoord(la) + ',' + fmtCoord(lo)
    if (!isNaN(al) && String(p.alt).trim() !== '') out += ',' + fmtCoord(al)
    return out
  }
  throw bad('PARAM_INVALID', '不支持的二维码类型: ' + type)
}

function fmtCoord(n) {
  const s = String(Math.round(n * 1e6) / 1e6)
  return s
}

function bad(code, message) {
  const e = new Error(message)
  e.code = code
  e.fieldMessage = message
  return e
}

/**
 * 页面前置校验：返回 null 表示通过，否则 { code, message }
 * 不抛异常，方便 setData({ error }) 直接展示。
 */
function validate(type, v) {
  try {
    const content = build(type, v)
    if (!content || !content.trim()) return { code: 'INPUT_EMPTY', message: '请填写内容' }
    return null
  } catch (e) {
    return { code: e.code || 'PARAM_INVALID', message: e.fieldMessage || e.message }
  }
}

/** 供页面展示「将编码的原文」与字节数 */
function preview(type, v) {
  try {
    const content = build(type, v)
    const bytes = byteLen(content)
    return { ok: true, content, chars: content.length, bytes }
  } catch (e) {
    return { ok: false, message: e.fieldMessage || e.message, code: e.code || 'PARAM_INVALID' }
  }
}

function byteLen(s) {
  let n = 0
  const str = String(s)
  for (let i = 0; i < str.length; i++) {
    const c = str.codePointAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c < 0x10000) n += 3
    else { n += 4; i++ }
  }
  return n
}

module.exports = {
  TYPES,
  WIFI_ENCRYPTS,
  SCHEMA,
  build,
  validate,
  preview,
  byteLen,
  escapeWifi,
  escapeVcs,
  normalizeUrl,
  isUrl,
  isPhone,
  digitsOnly
}
