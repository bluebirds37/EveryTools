/**
 * packageQr/utils/qr-parse.js
 * 码内容结构化解析（FR-QR-03）：把扫码得到的原文串拆解成可读字段。
 * 支持 WIFI: / MECARD / vCard 3.0-4.0 / SMSTO / tel: / geo: / otpauth:// / http(s) URL。
 * 未知格式：返回原文 + 字符数 + 编码猜测，绝不静默丢弃。
 */

const KIND_LABEL = {
  wifi: 'WiFi 配置',
  vcard: '名片 vCard',
  mecard: '名片 MECARD',
  sms: '短信',
  tel: '电话',
  mailto: '邮件',
  geo: '地理位置',
  otpauth: '一次性口令 TOTP',
  url: '网址',
  bitcoin: '加密货币地址',
  alipay: '支付宝转账',
  text: '纯文本'
}

const ENCODING_HINT = [
  { name: 'UTF-8（含中日韩等多字节字符）', test: (b, s) => b > s.length },
  { name: 'ASCII（英文数字符号）', test: (b, s, max) => max < 0x80 },
  { name: 'Latin-1 / ISO-8859-1（西欧扩展）', test: (b, s, max) => max >= 0x80 && max <= 0xff && b === s.length },
  { name: 'UTF-8（非 ASCII 扩展）', test: (b, s, max) => max >= 0x80 && b > s.length }
]

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

function maxCode(str) {
  let m = 0
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i)
    if (c > m) m = c
  }
  return m
}

/** 猜测编码：按字符范围给出最可能的编码（不保证，只提示） */
function guessEncoding(s) {
  const b = byteLen(s)
  const mx = maxCode(s)
  for (let i = 0; i < ENCODING_HINT.length; i++) {
    if (ENCODING_HINT[i].test(b, s, mx)) return ENCODING_HINT[i].name
  }
  return '未知'
}

/** WIFI:T:WPA;S:name;P:pass;H:false;;  → 字段 */
function parseWifi(raw) {
  const body = raw.slice(5)
  const fields = []
  const parts = splitUnescaped(body, ';')
  parts.forEach((p) => {
    if (!p) return
    const i = p.indexOf(':')
    if (i < 1) return
    const k = p.slice(0, i).toUpperCase()
    const v = unescapeWifi(p.slice(i + 1))
    if (k === 'T') fields.push({ key: 'encryption', label: '加密方式', value: v === 'nopass' ? '无（开放网络）' : v === 'WPA' ? 'WPA/WPA2' : v === 'WEP' ? 'WEP' : v })
    else if (k === 'S') fields.push({ key: 'ssid', label: '网络名称 SSID', value: v })
    else if (k === 'P') fields.push({ key: 'password', label: '密码', value: v, secret: true })
    else if (k === 'H') fields.push({ key: 'hidden', label: '隐藏网络', value: /^(true|1)$/i.test(v) ? '是' : '否' })
    else fields.push({ key: k.toLowerCase(), label: '扩展字段 ' + k, value: v })
  })
  return { fields, extras: [] }
}

function splitUnescaped(s, sep) {
  const out = []
  let cur = ''
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i)
    if (c === '\\' && i + 1 < s.length) {
      cur += s.charAt(++i)
      continue
    }
    if (c === sep) {
      out.push(cur)
      cur = ''
      continue
    }
    cur += c
  }
  out.push(cur)
  return out
}

function unescapeWifi(v) {
  return String(v).replace(/\\([\\;,:"])/g, '$1').replace(/\\s/g, ' ')
}

/** vCard 3.0/4.0：BEGIN...END，支持参数 TYPE=CELL 与折叠行 */
function parseVcard(raw) {
  const unfolded = raw.replace(/\r?\n[ \t]/g, '')
  const lines = unfolded.split(/\r?\n/)
  const fields = []
  let version = ''
  lines.forEach((line) => {
    if (!line) return
    const u = line.toUpperCase()
    if (u.indexOf('BEGIN:VCARD') === 0) return
    if (u.indexOf('END:VCARD') === 0) return
    const i = line.indexOf(':')
    if (i < 1) {
      fields.push({ key: 'unknown', label: '无法解析的行', value: line })
      return
    }
    const head = line.slice(0, i)
    const value = line.slice(i + 1)
    const bits = head.split(';')
    const name = bits[0].toUpperCase()
    const params = bits.slice(1).join(';')
    if (name === 'VERSION') {
      version = value
      fields.unshift({ key: 'version', label: 'vCard 版本', value })
      return
    }
    const label = ({
      N: '姓名（分号分隔）',
      FN: '显示姓名',
      ORG: '组织/公司',
      TITLE: '职位',
      TEL: '电话',
      EMAIL: '邮箱',
      ADR: '地址',
      URL: '网址',
      NOTE: '备注',
      BDAY: '生日',
      PHOTO: '照片（编码数据）',
      CATEGORIES: '分类',
      UID: 'UID',
      REV: '更新时间',
      LANG: '语言',
      X: '扩展属性',
      KEY: '公钥'
    })[name] || name
    let shown = value
    if (name === 'N' || name === 'ADR' || (name === 'ORG' && value.indexOf(';') >= 0)) shown = value.split(';').filter((x) => x !== '').join(' / ') || '（空）'
    if (name === 'TEL') {
      const t = /TYPE=([A-Z0-9-]+)/i.exec(params)
      shown = value + (t ? '（' + t[1] + '）' : '')
    }
    fields.push({ key: name.toLowerCase() + '_' + fields.length, label, value: shown, rawParams: params })
  })
  return { fields, version }
}

/** MECARD:VERSION:3.01;N:last;first;ORG:x;TEL:13800138000;; */
function parseMecard(raw) {
  const body = raw.replace(/^MECARD:([^A-Za-z]*|)/i, '').replace(/^MECARD:/i, '')
  const fields = []
  splitUnescaped(body, ';').forEach((p) => {
    if (!p) return
    const i = p.indexOf(':')
    if (i < 1) {
      if (p !== 'MECARD') fields.push({ key: 'extra_' + fields.length, label: '续值', value: unescapeWifi(p) })
      return
    }
    const k = p.slice(0, i).toUpperCase()
    const v = unescapeWifi(p.slice(i + 1))
    const label = { N: '姓名', TEL: '电话', EMAIL: '邮箱', ADR: '地址', URL: '网址', ORG: '组织', NOTE: '备注', BDAY: '生日', VERSION: 'MECARD 版本', LANG: '语言', SOUND: '发音' }[k] || k
    fields.push({ key: k.toLowerCase(), label, value: v })
  })
  return { fields }
}

function parseUrl(raw) {
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/.exec(raw)
  if (!m) return null
  const authority = m[2] || ''
  const at = authority.lastIndexOf('@')
  const userinfo = at >= 0 ? authority.slice(0, at) : ''
  const hostpart = at >= 0 ? authority.slice(at + 1) : authority
  let hostname = hostpart
  let port = ''
  const colon = hostpart.lastIndexOf(':')
  if (colon > 0 && /^\d+$/.test(hostpart.slice(colon + 1))) {
    hostname = hostpart.slice(0, colon)
    port = hostpart.slice(colon + 1)
  }
  const qs = (m[4] || '').replace(/^\?/, '')
  const query = []
  qs.split('&').forEach((kvRaw) => {
    if (!kvRaw) return
    const i = kvRaw.indexOf('=')
    const k = i < 0 ? kvRaw : kvRaw.slice(0, i)
    const v = i < 0 ? '' : kvRaw.slice(i + 1)
    query.push({ key: safeDecode(k), value: safeDecode(v), raw: kvRaw })
  })
  const path = m[3] || ''
  return {
    scheme: m[1].toLowerCase(),
    userinfo,
    host: hostname,
    port,
    path,
    segments: path.split('/').filter((x) => x !== ''),
    query,
    fragment: (m[5] || '').replace(/^#/, ''),
    fields: [
      { key: 'scheme', label: '协议 scheme', value: m[1].toLowerCase() },
      userinfo ? { key: 'userinfo', label: '认证信息（已解码）', value: safeDecode(userinfo), secret: true } : null,
      { key: 'host', label: '域名/主机', value: hostname },
      port ? { key: 'port', label: '端口', value: port } : null,
      { key: 'path', label: '路径', value: path || '/' },
      { key: 'segments', label: '路径分段', value: path.split('/').filter((x) => x !== '').join(' → ') || '（无）' },
      query.length ? { key: 'queryCount', label: '查询参数数', value: String(query.length) } : null,
      (m[5] || '') ? { key: 'fragment', label: '锚点 #', value: (m[5] || '').replace(/^#/, '') } : null
    ].filter(Boolean)
  }
}

function safeDecode(s) {
  try {
    return decodeURIComponent(String(s).replace(/\+/g, ' '))
  } catch (e) {
    return String(s) + '（百分号编码不合法）'
  }
}

function parseGeo(raw) {
  const body = raw.replace(/^GEO:/i, '')
  const q = body.indexOf('?')
  const main = q >= 0 ? body.slice(0, q) : body
  const parts = main.split(',')
  const fields = []
  if (parts[0]) fields.push({ key: 'lat', label: '纬度', value: parts[0] })
  if (parts[1]) fields.push({ key: 'lng', label: '经度', value: parts[1] })
  if (parts[2]) fields.push({ key: 'alt', label: '海拔', value: parts[2] })
  if (q >= 0) {
    body.slice(q + 1).split('&').forEach((kv) => {
      const i = kv.indexOf('=')
      const k = i < 0 ? kv : kv.slice(0, i)
      const v = i < 0 ? '' : kv.slice(i + 1)
      const label = k === 'z' ? '缩放级别' : k === 'q' ? '查询关键词' : k === 'll' ? '中心点' : k
      fields.push({ key: k, label, value: safeDecode(v) })
    })
  }
  return { fields }
}

function parseOtpauth(raw) {
  const u = parseUrl(raw)
  const fields = []
  let secret = ''
  if (u) {
    u.query.forEach((q) => {
      if (q.key === 'secret') secret = q.value
      const label = { secret: '密钥 Secret（Base32）', issuer: '发行方', algorithm: '算法', digits: '位数', period: '周期（秒）' }[q.key] || q.key
      fields.push({ key: q.key, label, value: q.value, secret: q.key === 'secret' })
    })
    fields.unshift({ key: 'account', label: '账户（标签）', value: safeDecode((u.path || '').replace(/^\//, '').replace(/%20/g, ' ')) })
    if (!fields.some((f) => f.key === 'period')) fields.push({ key: 'period', label: '周期（默认）', value: '30 秒（RFC 6238 默认）' })
    if (!fields.some((f) => f.key === 'digits')) fields.push({ key: 'digits', label: '位数（默认）', value: '6 位（默认）' })
  }
  return { fields, secret }
}

/**
 * 主入口
 * @param {string} content 扫码原文
 * @returns {{kind, kindLabel, fields, raw, chars, bytes, encoding, notes}}
 */
function parse(content) {
  const raw = String(content === undefined || content === null ? '' : content)
  const trimmed = raw.trim()
  const base = {
    raw,
    chars: raw.length,
    codePoints: Array.from(raw).length,
    bytes: byteLen(raw),
    lines: raw.split(/\r?\n/).length,
    encoding: guessEncoding(raw),
    notes: []
  }
  const up = trimmed.toUpperCase()

  if (/^WIFI:/i.test(trimmed)) {
    const r = parseWifi(trimmed)
    return finish(base, 'wifi', r.fields, ['扫码后系统会自动连接该 WiFi；转义符已还原。'])
  }
  if (/^MECARD:/i.test(trimmed)) {
    const r = parseMecard(trimmed)
    return finish(base, 'mecard', r.fields, ['MECARD 为旧式名片格式，微信/相机可识别。'])
  }
  if (/^BEGIN:VCARD/i.test(trimmed)) {
    const r = parseVcard(trimmed)
    const notes = []
    if (raw.indexOf('\r\n') < 0) notes.push('提示：标准 vCard 行分隔符为 CR+LF，此处按换行解析。')
    if (/^BEGIN:VCARD\r?\nVERSION:4\.0/i.test(trimmed)) notes.push('vCard 4.0（RFC 6350）。')
    return finish(base, 'vcard', r.fields, notes, { version: r.version })
  }
  if (/^SMSTO:/i.test(trimmed) || /^SMS:/i.test(trimmed) || /^smsto:/i.test(trimmed)) {
    const body = trimmed.replace(/^SMSTO:/i, '').replace(/^SMS:/i, '')
    const i = body.indexOf(':')
    const num = i < 0 ? body : body.slice(0, i)
    const text = i < 0 ? '' : body.slice(i + 1)
    return finish(base, 'sms', [
      { key: 'phone', label: '接收号码', value: num },
      { key: 'body', label: '预填正文', value: text || '（空）' }
    ], ['正文按 SMSTO:号码:正文 约定解析。'])
  }
  if (/^TEL:/i.test(trimmed)) {
    const v = trimmed.slice(4)
    return finish(base, 'tel', [{ key: 'phone', label: '电话号码', value: v }, { key: 'international', label: '是否国际格式', value: v.charAt(0) === '+' ? '是（+ 国家码开头）' : '否' }])
  }
  if (/^mailto:/i.test(trimmed)) {
    const v = trimmed.slice(7)
    const q = v.indexOf('?')
    const mail = q < 0 ? v : v.slice(0, q)
    const fields = [{ key: 'email', label: '收件邮箱', value: mail }]
    if (q >= 0) {
      v.slice(q + 1).split('&').forEach((kv) => {
        const i = kv.indexOf('=')
        if (i < 0) return
        fields.push({ key: kv.slice(0, i), label: kv.slice(0, i) === 'subject' ? '主题' : kv.slice(0, i) === 'body' ? '正文' : kv.slice(0, i), value: safeDecode(kv.slice(i + 1)) })
      })
    }
    return finish(base, 'mailto', fields)
  }
  if (/^GEO:/i.test(trimmed)) {
    const r = parseGeo(trimmed)
    return finish(base, 'geo', r.fields, ['格式 geo:纬度,经度[,海拔]，与 ISO 6709 近似。'])
  }
  if (/^otpauth:/i.test(trimmed)) {
    const r = parseOtpauth(trimmed)
    return finish(base, 'otpauth', r.fields, ['该码用于绑定两步验证：请在 Authenticator 类应用录入，切勿外泄密钥。', r.secret ? '密钥为 Base32，共 ' + r.secret.length + ' 字符。' : ''])
  }
  if (/^(bitcoin|xcash|litecoin):/i.test(trimmed)) {
    const i = trimmed.indexOf('?')
    return finish(base, 'bitcoin', [
      { key: 'address', label: '收款地址', value: i < 0 ? trimmed.replace(/^[a-z]+:/i, '') : trimmed.slice(0, i).replace(/^[a-z]+:/i, '') },
      { key: 'params', label: '金额/备注参数', value: i < 0 ? '（无）' : trimmed.slice(i + 1) }
    ], ['加密货币地址，转账前请核对。'])
  }
  if (/^(ALIPAY|alipay|HTTPS?:\/\/qr\.alipay)/i.test(trimmed)) {
    const u = parseUrl(trimmed)
    return finish(base, 'alipay', u ? u.fields : [{ key: 'raw', label: '原文', value: trimmed }], ['支付类二维码涉及资金，请确认收款方。'])
  }
  const u = parseUrl(trimmed)
  if (u && /^https?$/i.test(u.scheme)) {
    const notes = []
    if (u.userinfo) notes.push('⚠ URL 含内嵌认证信息（user:password@），泄露即等于凭据泄露。')
    if (u.query.some((q) => /token|key|secret|passwd|password|auth/i.test(q.key))) notes.push('⚠ 查询参数含敏感字段名，分享前注意。')
    const fields = u.fields.slice()
    u.query.forEach((q) => fields.push({ key: 'q_' + q.key, label: '参数 ' + q.key, value: q.value }))
    return finish(base, 'url', fields, notes, { url: u })
  }
  // 未知格式：明示原文 + 统计 + 编码猜测
  return finish(base, 'text', [
    { key: 'chars', label: '字符数（UTF-16）', value: String(raw.length) },
    { key: 'codePoints', label: '字符数（按码点）', value: String(Array.from(raw).length) },
    { key: 'bytes', label: 'UTF-8 字节数', value: String(byteLen(raw)) },
    { key: 'lines', label: '行数', value: String(raw.split(/\r?\n/).length) },
    { key: 'encoding', label: '编码猜测', value: guessEncoding(raw) },
    { key: 'printable', label: '含控制字符', value: /[\u0000-\u0008\u000b-\u001f\u007f]/.test(raw) ? '是（可能为二进制/自定义协议）' : '否' },
    { key: 'raw', label: '原文', value: raw }
  ], ['未匹配到 WIFI/MECARD/vCard/SMSTO/tel/geo/otpauth/URL 等已知格式，以上为原文与统计信息。'])
}

function finish(base, kind, fields, notes, extra) {
  const out = {
    kind,
    kindLabel: KIND_LABEL[kind] || kind,
    fields,
    raw: base.raw,
    chars: base.chars,
    codePoints: base.codePoints,
    bytes: base.bytes,
    lines: base.lines,
    encoding: base.encoding,
    notes: (notes || []).filter(Boolean).concat(base.notes)
  }
  return Object.assign(out, extra || {})
}

/** 供 UI 生成「复制用」的纯文本摘要 */
function toText(parsed) {
  const lines = ['类型：' + parsed.kindLabel]
  parsed.fields.forEach((f) => lines.push(f.label + ': ' + f.value))
  if (parsed.notes.length) parsed.notes.forEach((n) => lines.push('— ' + n))
  lines.push('原文（' + parsed.chars + ' 字符 / ' + parsed.bytes + ' 字节）：')
  lines.push(parsed.raw)
  return lines.join('\n')
}

module.exports = {
  KIND_LABEL,
  parse,
  parseUrl,
  parseVcard,
  parseWifi,
  parseMecard,
  parseGeo,
  parseOtpauth,
  guessEncoding,
  byteLen,
  unescapeWifi,
  splitUnescaped,
  toText
}
