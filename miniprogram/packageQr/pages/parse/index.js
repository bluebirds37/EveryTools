// packageQr/pages/parse —— FR-QR-03 码内容解析（纯前端结构化拆解，无网络）
const registry = require('../../../tools/registry')
const store = require('../../../utils/store')
const track = require('../../../utils/track')
const error = require('../../../utils/error')

const TOOL_ID = 'qr-parse'
const MAX_CHARS = 200 * 1024

function defaults() {
  return { raw: '' }
}

const SCHEMA = [
  { key: 'raw', label: '码内容原文', type: 'textarea', def: '', placeholder: '粘贴二维码/条形码读出的原始文本', hint: '支持 URL / WIFI / vCard / MECARD / SMSTO / geo / otpauth' }
]

const SAMPLES = [
  { name: 'WiFi', v: 'WIFI:T:WPA;S:MyHome_5G;P:passw0rd!23;;' },
  { name: '链接', v: 'https://example.com/shop/cart?a=1&b=%E4%B8%AD%E6%96%87#top' },
  { name: '名片', v: 'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:张三\r\nN:张三;;;\r\nTEL;TYPE=CELL:+8613800138000\r\nORG:某某科技\r\nTITLE:工程师\r\nEMAIL:zhang@example.com\r\nEND:VCARD' },
  { name: 'OTP', v: 'otpauth://totp/Mail:me@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Mail&digits=6&period=30' }
]

/* ---------------- 各协议解析（纯函数，可被 node 直接调用自测） ---------------- */

function unescWifi(s) {
  return String(s || '').replace(/\\([\\;:,"'])/g, '$1')
}

function parseWifi(raw) {
  const body = raw.slice(5)
  const out = []
  const re = /(T|S|P|H):((?:[^;\\]|\\.)*)/g
  let m
  while ((m = re.exec(body))) {
    const key = m[1]
    const val = key === 'T' ? m[2] : unescWifi(m[2])
    out.push({ key: { T: '加密方式', S: '网络名称 SSID', P: '密码', H: '隐藏网络' }[key] || key, value: val || '(空)' })
  }
  return { kind: 'WiFi 网络串', kv: out }
}

function parseUrl(raw) {
  const m = /^([a-z][a-z0-9+.\-]*):(?:\/\/(?:([^/?#@]*)@)?([^:/?#\s]*)(?::(\d+))?)?([^?#\s]*)(?:\?([^#\s]*))?(?:#(.*))?$/i.exec(raw)
  if (!m) return null
  const kv = [
    { key: '协议 scheme', value: m[1] },
    { key: '主机 host', value: m[3] || '(无)' },
    { key: '端口 port', value: m[4] || '默认' }
  ]
  if (m[2]) kv.push({ key: '用户信息 userinfo', value: m[2] })
  kv.push({ key: '路径 path', value: m[5] || '/' })
  if (m[6] !== undefined) kv.push({ key: '查询串 query', value: m[6] })
  if (m[7] !== undefined) kv.push({ key: '片段 fragment', value: '#' + m[7] })
  const queryRows = []
  if (m[6]) {
    m[6].split('&').forEach(function (pair) {
      if (!pair) return
      const eq = pair.indexOf('=')
      const k = eq < 0 ? pair : pair.slice(0, eq)
      const v = eq < 0 ? '' : pair.slice(eq + 1)
      queryRows.push({ key: decodeSafeURIComponent(k), value: decodeSafeURIComponent(v) })
    })
    queryRows.forEach(function (q, i) {
      kv.push({ key: '参数 ' + (i + 1), value: q.key + ' = ' + q.value })
    })
  }
  return { kind: 'URL', kv: kv, query: queryRows }
}

function decodeSafeURIComponent(s) {
  try {
    return decodeURIComponent(String(s).replace(/\+/g, ' '))
  } catch (e) {
    return String(s)
  }
}

function parseVcard(raw) {
  const lines = raw.split(/\r?\n/)
  const kv = []
  lines.forEach(function (line) {
    const m = /^([A-Za-z0-9\-]+)((?:;[^:]*)?):(.*)$/.exec(line)
    if (!m) return
    const params = m[2] ? m[2].replace(/^;/, '') : ''
    kv.push({ key: m[1].toUpperCase() + (params ? ' (' + params + ')' : ''), value: m[3].replace(/\r$/, '') })
  })
  return { kind: 'vCard 名片', kv: kv }
}

function parseMecard(raw) {
  const body = raw.slice('MECARD:'.length)
  const kv = []
  body.split(';').forEach(function (item) {
    const eq = item.indexOf(':')
    if (eq <= 0) return
    kv.push({ key: item.slice(0, eq).toUpperCase(), value: unescapeSemiColon(item.slice(eq + 1)) })
  })
  return { kind: 'MECARD 名片', kv: kv }
}
function unescapeSemiColon(s) {
  return String(s).replace(/\\;/g, ';')
}

function parseSmsTo(raw) {
  const m = /^SMSTO:([^:]*):([\s\S]*)$/i.exec(raw)
  if (!m) return null
  return { kind: '短信 SMSTO', kv: [{ key: '号码', value: m[1] || '(空)' }, { key: '正文', value: m[2] || '(空)' }] }
}

function parseGeo(raw) {
  const m = /^geo:([^?,]+)(?:,([^?]*))?(?:\?([^#]*))?(?:#(.*))?$/i.exec(raw)
  if (!m) return null
  const kv = [{ key: '纬度 lat', value: m[1] }]
  if (m[2] !== undefined) kv.push({ key: '经度 lng', value: m[2] })
  if (m[3]) kv.push({ key: '参数', value: m[3] })
  if (m[4]) kv.push({ key: '标签', value: m[4] })
  return { kind: '地理位置 geo', kv: kv }
}

function parseOtpauth(raw) {
  const u = parseUrl(raw)
  if (!u || raw.indexOf('otpauth://') !== 0) return null
  const kv = [{ key: '类型', value: u.kind === 'URL' ? (raw.indexOf('otpauth://totp') === 0 ? 'TOTP（基于时间）' : 'HOTP（基于计数）') : 'otpauth' }]
  const label = /^otpauth:\/\/[^/]+\/([^?]+)/.exec(raw)
  if (label) kv.push({ key: '账户 label', value: decodeSafeURIComponent(label[1]) })
  u.query.forEach(function (q) {
    const names = { secret: '密钥 secret', issuer: '发行方 issuer', algorithm: '算法', digits: '位数', period: '周期(s)', counter: '计数器' }
    kv.push({ key: names[q.key] || q.key, value: q.value })
  })
  return { kind: 'OTP 验证器', kv: kv }
}

function utf8Bytes(s) {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) { n += 4; i++ }
    else n += 3
  }
  return n
}

/** 编码猜测：纯 ASCII → UTF-8/ASCII；含 CJK → UTF-8 为主，提示可能是 GBK 转来的 */
function guessEncoding(s) {
  let cjk = 0
  let high = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c > 127) high++
    if (c >= 0x4e00 && c <= 0x9fff) cjk++
  }
  if (!high) return 'ASCII / UTF-8'
  if (cjk > 0) return 'UTF-8（含中文；若乱码可尝试按 GBK 解读）'
  return 'UTF-8（含非 ASCII 字符）'
}

function parseAny(raw) {
  const s = String(raw || '').trim()
  if (/^WIFI:/i.test(s)) return parseWifi(s)
  if (/^BEGIN:VCARD/i.test(s)) return parseVcard(s)
  if (/^MECARD:/i.test(s)) return parseMecard(s)
  if (/^SMSTO:/i.test(s)) {
    const r = parseSmsTo(s)
    if (r) return r
  }
  if (/^geo:/i.test(s)) {
    const r = parseGeo(s)
    if (r) return r
  }
  if (/^otpauth:\/\//i.test(s)) {
    const r = parseOtpauth(s)
    if (r) return r
  }
  const linkSchemes = ['tel', 'mailto', 'sms', 'callto', 'bitcoin', 'weixin']
  const low = s.toLowerCase()
  for (let i = 0; i < linkSchemes.length; i++) {
    if (low.indexOf(linkSchemes[i] + ':') === 0) {
      return { kind: linkSchemes[i].toUpperCase() + ' 链接', kv: [{ key: 'scheme', value: linkSchemes[i] }, { key: '值', value: s.slice(linkSchemes[i].length + 1) }] }
    }
  }
  if (/^[a-z][a-z0-9+.\-]*:/i.test(s)) {
    const r = parseUrl(s)
    if (r && r.kv.length) return r
  }
  return {
    kind: '未知格式（原文展示）',
    kv: [
      { key: '字符数', value: String(s.length) },
      { key: 'UTF-8 字节数', value: String(utf8Bytes(s)) },
      { key: '编码猜测', value: guessEncoding(s) }
    ]
  }
}

/* ---------------- 页面 ---------------- */

Page({
  data: {
    toolId: TOOL_ID,
    tool: null,
    values: defaults(),
    schema: SCHEMA,
    tips: [
      '自动识别 URL / WIFI / vCard / MECARD / SMSTO / geo / otpauth 等协议格式',
      '未知格式会显示原文 + 字符数 + 编码猜测',
      '解析全部在本机完成，内容不会上传网络'
    ],
    result: null,
    error: null,
    samples: SAMPLES
  },

  onLoad(query) {
    const q = query || {}
    this.setData({ tool: registry.get(q.toolId || TOOL_ID), values: Object.assign(defaults(), store.params(TOOL_ID) || {}) })
    track.track('tool_open', { toolId: TOOL_ID, from: q.from || 'menu' })
  },

  onParamChange(e) {
    const values = Object.assign({}, this.data.values)
    values[e.detail.key] = e.detail.value
    this.setData({ values: values })
    store.saveParams(TOOL_ID, values)
  },

  onSample(e) {
    const values = Object.assign({}, this.data.values, { raw: SAMPLES[Number(e.currentTarget.dataset.index)].v })
    this.setData({ values: values })
    store.saveParams(TOOL_ID, values)
    this.reparse()
  },

  onRun() {
    track.track('tool_run_start', { toolId: TOOL_ID })
    this.reparse()
  },

  reparse() {
    const raw = String(this.data.values.raw || '').trim()
    if (!raw) {
      this.setData({ error: { code: 'INPUT_EMPTY', message: error.message('INPUT_EMPTY') }, result: null })
      track.track('tool_run_fail', { toolId: TOOL_ID, code: 'INPUT_EMPTY' })
      return
    }
    if (raw.length > MAX_CHARS) {
      this.setData({ error: { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { field: '内容长度', range: '≤ 200KB，超长请改用文件类工具' }) }, result: null })
      track.track('tool_run_fail', { toolId: TOOL_ID, code: 'PARAM_INVALID' })
      return
    }
    const t0 = Date.now()
    try {
      const parsed = parseAny(raw)
      const kv = [{ key: '识别格式', value: parsed.kind }].concat(parsed.kv)
      this.setData({
        error: null,
        result: {
          kv: kv,
          text: raw,
          meta: parsed.kind + ' · ' + parsed.kv.length + ' 项 · 耗时 ' + (Date.now() - t0) + 'ms · 引擎 client'
        }
      })
      track.track('tool_run_success', { toolId: TOOL_ID, costMs: Date.now() - t0, engine: 'client' })
      store.bumpUsage(TOOL_ID)
    } catch (e) {
      const n = error.normalize(e, 'TASK_FAILED')
      track.track('tool_run_fail', { toolId: TOOL_ID, code: n.code })
      this.setData({ error: { code: n.code, message: n.message }, result: null })
    }
  },

  onCopy() {
    const text = (this.data.result && this.data.result.text) || ''
    if (!text) return
    wx.setClipboardData({
      data: text,
      success: function () {
        track.track('result_copy', { toolId: TOOL_ID })
        wx.showToast({ title: '已复制原文', icon: 'success' })
      }
    })
  },

  onCopyKv() {
    const rows = (this.data.result && this.data.result.kv) || []
    if (!rows.length) return
    const text = rows.map(function (x) { return x.key + ': ' + x.value }).join('\n')
    wx.setClipboardData({
      data: text,
      success: function () {
        track.track('result_copy', { toolId: TOOL_ID, kind: 'kv' })
        wx.showToast({ title: '已复制解析表', icon: 'success' })
      }
    })
  },

  onShareAppMessage() {
    return { title: '码内容解析 · 拆解 WiFi/名片/链接编码', path: '/packageQr/pages/parse/index?toolId=' + TOOL_ID + '&from=share' }
  },

  /** 供纯逻辑单测直接调用 */
  parseAny: parseAny
})

module.exports = { parseAny: parseAny }
