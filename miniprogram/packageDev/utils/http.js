/* packageDev/utils/http.js —— HTTP 调试的纯逻辑（FR-DEV-01：URL 校验/编码、头体解析、响应度量） */

const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS', 'PATCH']
const NO_BODY = { GET: 1, HEAD: 1, OPTIONS: 1 }
const MAX_BODY_CHARS = 200000 // FR-G-03：文本输入 200KB 上限
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024 // 验收：5MB 响应不 OOM，超出截断展示

function hasBody(method) {
  return !NO_BODY[String(method || 'GET').toUpperCase()]
}

/**
 * 校验并规范化 URL：只允许 http/https，空格与非法字符按 RFC 编码（禁止未编码拼接参数）
 * @returns {{ok:true, url:string, method?:string, host:string, protocol:string} | {ok:false, reason:string, field:string}}
 */
function normalizeUrl(raw) {
  const s = String(raw == null ? '' : raw).trim()
  if (!s) return { ok: false, field: '请求地址', reason: '地址为空' }
  if (/\s/.test(s)) return { ok: false, field: '请求地址', reason: '地址含空格，请先编码或去掉空白' }
  const m = /^(https?):\/\/([^\/?#]+)([^\s]*)$/i.exec(s)
  if (!m) return { ok: false, field: '请求地址', reason: '需要以 http:// 或 https:// 开头的完整地址' }
  const protocol = m[1].toLowerCase()
  const host = m[2]
  if (!/^([a-z0-9\u0080-\uffff.-]+)(:\d{1,5})?$/i.test(host)) return { ok: false, field: '请求地址', reason: '主机名不合法：' + host.slice(0, 40) }
  const rest = m[3] || ''
  let encoded = rest
  try {
    encoded = encodeURI(rest)
  } catch (e) {
    return { ok: false, field: '请求地址', reason: '地址中有无法编码的百分号序列' }
  }
  if (/%(?![0-9a-fA-F]{2})/.test(encoded)) return { ok: false, field: '请求地址', reason: '百分号转义不完整（如 %zz），请检查查询参数' }
  return { ok: true, url: protocol + '://' + host + encoded, protocol: protocol, host: host, method: '' }
}

/** 把 GET query 对象安全编码后附加到 URL（契约禁止未编码拼接） */
function appendQuery(url, queryText) {
  const q = String(queryText || '').trim()
  if (!q) return url
  const base = String(url).split('?')[0]
  const hashParts = String(url).split('#')
  const pathPart = hashParts[0]
  const frag = hashParts.length > 1 ? '#' + hashParts[1] : ''
  const existing = pathPart.indexOf('?') >= 0 ? pathPart.split('?').slice(1).join('?') : ''
  const cleaned = q.replace(/^[?&]+/, '')
  const parts = []
  cleaned.split('&').forEach(function (pair) {
    if (!pair) return
    const kv = pair.split('=')
    const k = decodePiece(kv.shift())
    const v = decodePiece(kv.join('='))
    parts.push(encodeURIComponent(k) + (kv.length || v ? '=' + encodeURIComponent(v) : ''))
  })
  const qs = parts.join('&')
  const joined = existing ? existing.replace(/^[?&]+/, '') + '&' + qs : qs
  return base.split('?')[0] + '?' + joined + frag
}

function decodePiece(text) {
  try {
    return decodeURIComponent(String(text == null ? '' : text).replace(/\+/g, ' '))
  } catch (e) {
    return String(text == null ? '' : text)
  }
}

/**
 * 请求头解析：支持 JSON 对象写法与 `Key: Value` 行写法
 * @returns {{ok:true, headers:object, count:number} | {ok:false, reason:string, field:string}}
 */
function parseHeaders(text) {
  const s = String(text || '').trim()
  if (!s) return { ok: true, headers: {}, count: 0 }
  if (s.charAt(0) === '{') {
    let obj = null
    try {
      obj = JSON.parse(s)
    } catch (e) {
      return { ok: false, field: '请求头', reason: 'JSON 格式错误：' + String((e && e.message) || '').slice(0, 30) }
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, field: '请求头', reason: '需要是 {"Key":"Value"} 对象' }
    return finishHeaders(obj)
  }
  const obj = {}
  const lines = s.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line || line.charAt(0) === '#') continue
    const idx = line.indexOf(':')
    if (idx <= 0) return { ok: false, field: '请求头', reason: '第 ' + (i + 1) + ' 行缺少「:」：' + line.slice(0, 24) }
    obj[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
  }
  return finishHeaders(obj)
}

function finishHeaders(obj) {
  const headers = {}
  let count = 0
  Object.keys(obj).forEach(function (k) {
    const v = obj[k]
    if (v === undefined || v === null) return
    headers[k] = typeof v === 'object' ? JSON.stringify(v) : String(v)
    count++
  })
  return { ok: true, headers: headers, count: count }
}

/** 请求体：Content-Type 为 JSON 时先校验，避免发出明显非法的 body */
function prepareBody(text, headers, method) {
  const s = String(text == null ? '' : text)
  if (!hasBody(method)) return { ok: true, body: undefined, used: false }
  if (s.length > MAX_BODY_CHARS) return { ok: false, field: '请求体', reason: '请求体 ' + s.length + ' 字符，超出 ' + MAX_BODY_CHARS + ' 上限（请改用文件类工具）' }
  if (!s.trim()) return { ok: true, body: undefined, used: false }
  const ct = findHeader(headers, 'content-type')
  if (/application\/json/i.test(ct)) {
    try {
      JSON.parse(s)
    } catch (e) {
      return { ok: false, field: '请求体', reason: 'Content-Type 为 JSON，但请求体不是合法 JSON：' + String((e && e.message) || '').slice(0, 30) }
    }
  }
  return { ok: true, body: s, used: true }
}

function findHeader(headers, key) {
  const want = String(key).toLowerCase()
  const found = Object.keys(headers || {}).filter(function (k) {
    return k.toLowerCase() === want
  })[0]
  return found ? String(headers[found]) : ''
}

/** UTF-8 字节长度（不依赖 Buffer） */
function byteLength(str) {
  const s = String(str == null ? '' : str)
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.codePointAt(i)
    if (c <= 0x7f) n += 1
    else if (c <= 0x7ff) n += 2
    else if (c <= 0xffff) n += 3
    else {
      n += 4
      i++
    }
  }
  return n
}

function formatSize(bytes) {
  const b = Number(bytes) || 0
  if (b < 1024) return b + ' B'
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB'
  return (b / 1048576).toFixed(2) + ' MB'
}

function formatMs(ms) {
  const n = Number(ms) || 0
  return n < 1000 ? Math.round(n) + ' ms' : (n / 1000).toFixed(2) + ' s'
}

function statusTone(status) {
  const s = Number(status) || 0
  if (s >= 200 && s < 300) return 'ok'
  if (s >= 300 && s < 400) return 'redirect'
  if (s >= 400 && s < 500) return 'client'
  if (s >= 500) return 'server'
  return 'unknown'
}

/** 响应头对象化（wx.request 返回 header 为对象） */
function headerRows(header) {
  const h = header || {}
  return Object.keys(h).map(function (k) {
    return { key: k, value: String(h[k]) }
  })
}

/**
 * 响应体处理：JSON 自动美化、超长截断
 * @returns {{text:string, truncated:boolean, isJson:boolean, bytes:number, totalBytes:number}}
 */
function shapeBody(data, rawText) {
  let text = ''
  let isJson = false
  if (data !== undefined && data !== null && typeof data === 'object') {
    isJson = true
    try {
      text = JSON.stringify(data, null, 2)
    } catch (e) {
      text = String(data)
    }
  } else if (rawText != null) {
    text = String(rawText)
    const t = text.trim()
    if (/^[[{]/.test(t)) {
      try {
        text = JSON.stringify(JSON.parse(t), null, 2)
        isJson = true
      } catch (e) {
        isJson = false
      }
    }
  } else text = ''
  const totalBytes = byteLength(text)
  let truncated = false
  if (totalBytes > MAX_RESPONSE_BYTES) {
    text = text.slice(0, 400000)
    truncated = true
  } else if (text.length > 400000) {
    text = text.slice(0, 400000)
    truncated = true
  }
  return { text: text, truncated: truncated, isJson: isJson, bytes: byteLength(text), totalBytes: totalBytes }
}

/** 生成可复制的 cURL 命令（不含用户隐私 header 值之外的内容） */
function toCurl(opt) {
  const method = String(opt.method || 'GET').toUpperCase()
  const parts = ['curl', '-X', method, "'" + opt.url + "'"]
  Object.keys(opt.headers || {}).forEach(function (k) {
    parts.push("-H '" + k + ': ' + String(opt.headers[k]).replace(/'/g, "'\\''") + "'")
  })
  if (opt.body) parts.push("--data-raw '" + String(opt.body).replace(/'/g, "'\\''") + "'")
  return parts.join(' ')
}

module.exports = {
  METHODS: METHODS,
  MAX_BODY_CHARS: MAX_BODY_CHARS,
  MAX_RESPONSE_BYTES: MAX_RESPONSE_BYTES,
  hasBody: hasBody,
  normalizeUrl: normalizeUrl,
  appendQuery: appendQuery,
  parseHeaders: parseHeaders,
  prepareBody: prepareBody,
  findHeader: findHeader,
  byteLength: byteLength,
  formatSize: formatSize,
  formatMs: formatMs,
  statusTone: statusTone,
  headerRows: headerRows,
  shapeBody: shapeBody,
  toCurl: toCurl
}
