/* packageDev/utils/jwt.js —— JWT 本地解码（FR-DEV-03 纯逻辑，无 wx 依赖）
 * 只做 base64url 解码与声明展示，不做任何签名校验（工程内无 HMAC/RSA 实现，禁止假装「已验签」）。 */

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function lookup(ch) {
  return B64.indexOf(ch)
}

/** base64url → 字节数组；返回 { bytes } 或 { error } */
function b64urlToBytes(input) {
  let s = String(input == null ? '' : input).replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/')
  s = s.replace(/=+$/, '')
  if (!s) return { error: '内容为空' }
  for (let i = 0; i < s.length; i++) {
    if (lookup(s.charAt(i)) < 0) return { error: '含非 base64url 字符：' + s.charAt(i) }
  }
  if (s.length % 4 === 1) return { error: 'base64 长度非法' }
  const bytes = []
  let buffer = 0,
    bits = 0
  for (let i = 0; i < s.length; i++) {
    buffer = (buffer << 6) | lookup(s.charAt(i))
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes.push((buffer >> bits) & 0xff)
    }
  }
  return { bytes: bytes }
}

/** UTF-8 字节 → 字符串（手写解码，不依赖 Buffer） */
function bytesToUtf8(bytes) {
  let out = ''
  let i = 0
  while (i < bytes.length) {
    const b0 = bytes[i]
    let cp, size
    if (b0 < 0x80) {
      cp = b0
      size = 1
    } else if (b0 >= 0xc2 && b0 <= 0xdf) {
      cp = b0 & 0x1f
      size = 2
    } else if (b0 >= 0xe0 && b0 <= 0xef) {
      cp = b0 & 0x0f
      size = 3
    } else if (b0 >= 0xf0 && b0 <= 0xf4) {
      cp = b0 & 0x07
      size = 4
    } else {
      return { error: '载荷不是合法 UTF-8' }
    }
    if (i + size > bytes.length) return { error: 'UTF-8 序列被截断' }
    for (let j = 1; j < size; j++) {
      const b = bytes[i + j]
      if (b < 0x80 || b > 0xbf) return { error: 'UTF-8 序列非法' }
      cp = (cp << 6) | (b & 0x3f)
    }
    if (size === 2 && cp < 0x80) return { error: 'UTF-8 序列非法' }
    if (size === 3 && cp < 0x800) return { error: 'UTF-8 序列非法' }
    if (size === 4 && (cp < 0x10000 || cp > 0x10ffff)) return { error: 'UTF-8 序列非法' }
    if (cp > 0xd7ff && cp < 0xe000) return { error: 'UTF-8 序列非法（代理区）' }
    if (cp < 0x10000) out += String.fromCharCode(cp)
    else {
      const v = cp - 0x10000
      out += String.fromCharCode(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff))
    }
    i += size
  }
  return { text: out }
}

function decodeJsonSegment(text) {
  const dec = b64urlToBytes(text)
  if (dec.error) return { error: dec.error }
  const u = bytesToUtf8(dec.bytes)
  if (u.error) return { error: u.error }
  let obj = null
  try {
    obj = JSON.parse(u.text)
  } catch (e) {
    return { error: 'JSON 解析失败：' + String((e && e.message) || '').slice(0, 30) }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { error: '段内容不是 JSON 对象' }
  return { value: obj, text: u.text, pretty: safeStringify(obj) }
}

function safeStringify(obj) {
  try {
    return JSON.stringify(obj, null, 2)
  } catch (e) {
    return String(obj)
  }
}

/** 去掉粘贴时常见的 Bearer 前缀与换行 */
function cleanToken(raw) {
  return String(raw == null ? '' : raw).trim().replace(/^bearer[\s:@-]+/i, '').replace(/\s+/g, '')
}

function pad(n) {
  return (n < 10 ? '0' : '') + n
}

function stamp(ms) {
  const d = new Date(ms)
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
}

function humanDuration(seconds) {
  const abs = Math.abs(seconds)
  if (abs < 60) return abs + ' 秒'
  if (abs < 3600) return round(abs / 60, 1) + ' 分钟'
  if (abs < 86400) return round(abs / 3600, 1) + ' 小时'
  if (abs < 2592000) return round(abs / 86400, 1) + ' 天'
  return round(abs / 2592000, 1) + ' 个月'
}

function round(n, p) {
  const f = Math.pow(10, p || 0)
  return Math.round(n * f) / f
}

const TIME_CLAIMS = { exp: '过期时间', iat: '签发时间', nbf: '生效时间(notBefore)', auth_time: '认证时间' }

/** exp/iat/nbf 等时间声明 → 可读文本 + 状态 */
function timeClaim(key, value, nowMs) {
  const sec = Number(value)
  if (!isFinite(sec)) return null
  const ms = sec > 4102444800 * 2 ? sec : sec * 1000 // 毫秒/秒自适应
  const diffSec = Math.round((ms - nowMs) / 1000)
  return {
    key: key,
    label: TIME_CLAIMS[key] || key,
    raw: String(value),
    text: stamp(ms),
    diffSec: diffSec,
    future: diffSec >= 0,
    diffText: (diffSec >= 0 ? '还有 ' : '已于 ') + humanDuration(diffSec) + (diffSec >= 0 ? ' 后到期' : ' 过期')
  }
}

/**
 * 解析 JWT
 * @returns {{ok:boolean, error?:{field:string, reason:string}, header?:object, payload?:object,
 *            signature?:string, headerText?:string, payloadText?:string, alg?:string, times?:object[],
 *            status?:object, claims?:object[]}}
 */
function parseJwt(rawToken, nowMs) {
  const now = typeof nowMs === 'number' ? nowMs : Date.now()
  const token = cleanToken(rawToken)
  if (!token) return { ok: false, error: { field: 'token', reason: '未输入 token' } }
  const parts = token.split('.')
  if (parts.length !== 3) {
    return { ok: false, error: { field: 'token 段数', reason: 'JWT 应为 header.payload.signature 三段，当前 ' + parts.length + ' 段' } }
  }
  if (!parts[0] || !parts[1]) {
    return { ok: false, error: { field: 'token 段内容', reason: 'header 或 payload 段为空' } }
  }
  const header = decodeJsonSegment(parts[0])
  if (header.error) return { ok: false, error: { field: 'header 段', reason: header.error } }
  const payload = decodeJsonSegment(parts[1])
  if (payload.error) return { ok: false, error: { field: 'payload 段', reason: payload.error } }

  const alg = header.value.alg
  const times = []
  Object.keys(payload.value).forEach(function (k) {
    if (!TIME_CLAIMS[k]) return
    const t = timeClaim(k, payload.value[k], now)
    if (t) times.push(t)
  })

  const exp = times.filter(function (t) {
    return t.key === 'exp'
  })[0]
  let status
  if (!exp) status = { state: 'none', text: '未设置 exp，无法判断有效期' }
  else if (exp.diffSec <= 0) status = { state: 'expired', text: '已过期 ' + humanDuration(exp.diffSec), expired: true }
  else {
    status = { state: 'valid', text: '未过期，' + exp.diffText }
    if (exp.diffSec < 3600) status.warning = '有效期不足 1 小时'
  }
  const nbf = times.filter(function (t) {
    return t.key === 'nbf'
  })[0]
  if (nbf && nbf.diffSec > 0) status = { state: 'notYet', text: '尚未生效，' + nbf.diffText }

  const claims = Object.keys(payload.value).map(function (k) {
    const v = payload.value[k]
    const text = typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)
    return { key: k, value: text.length > 120 ? text.slice(0, 117) + '…' : text }
  })

  return {
    ok: true,
    header: header.value,
    payload: payload.value,
    headerText: header.pretty,
    payloadText: payload.pretty,
    signature: parts[2],
    signatureBytes: parts[2] ? 'base64url，' + String(parts[2]).length + ' 字符' : '空签名',
    alg: alg,
    times: times,
    status: status,
    claims: claims,
    verify: {
      supported: false,
      note: '未验证签名：本工具只做本地 base64url 解码，未实现 ' + (alg || '未知') + ' 算法，不能确认 token 未被篡改'
    }
  }
}

module.exports = {
  b64urlToBytes: b64urlToBytes,
  bytesToUtf8: bytesToUtf8,
  cleanToken: cleanToken,
  parseJwt: parseJwt,
  timeClaim: timeClaim,
  humanDuration: humanDuration,
  stamp: stamp
}
