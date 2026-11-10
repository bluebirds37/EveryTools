const registry = require('../../../tools/registry')
const store = require('../../../utils/store')
const track = require('../../../utils/track')
const error = require('../../../utils/error')
const jwt = require('../../utils/jwt')

const TOOL_ID = 'dev-jwt'

const SAMPLE_TOKENS = {
  normal: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNzY3Mjg5NjAwLCJleHAiOjE4NTY4MjU2MDB9.dozjQeqN4M-hK1tSG4jS0LZs2dZvGQvC0xG7Zl7Tz0A',
  unicode: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJuYW1lIjoi5byg5LiJIiwiX2Rhc2hib2FyZCI6dHJ1ZSwiaWF0IjoxNzY3Mjg5NjAwfQ.bXludW5pY29kZXRlc3Q',
  expired: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1XzEwMjQiLCJpYXQiOjE2MDAwMDAwMDAsImV4cCI6MTYwMDAwMzYwMH0.c2FtcGxlc2ln',
  none: 'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiJndWVzdCIsInJvbGUiOiJyZWFkZXIifQ.',
  broken: 'eyJhbGciOiJIUzI1NiJ9.这不是合法JSON.AAAA'
}

function defaults() {
  return { token: '', prettify: true, showAllClaims: true }
}

function buildSchema() {
  return [
    { key: 'token', label: 'JWT / token', type: 'textarea', def: '', rows: 5, placeholder: '粘贴 a.b.c 三段 token（可含 Bearer 前缀，只在本地解码，不会上传）', hint: '仅 base64url 解码 header 与 payload，不做网络请求、不发送 token' },
    { key: 'prettify', label: '缩进展示 JSON', type: 'switch', def: true },
    { key: 'showAllClaims', label: '展示全部声明', type: 'switch', def: true }
  ]
}

function pad(n) {
  return (n < 10 ? '0' : '') + n
}

function validate(v) {
  const token = jwt.cleanToken(v.token)
  if (!token) return { code: 'INPUT_EMPTY', message: error.message('INPUT_EMPTY') }
  if (token.length > 8000) return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { field: 'token 长度', range: '≤ 8000 字符（当前 ' + token.length + '）' }) }
  const parsed = jwt.parseJwt(token)
  if (!parsed.ok) return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { field: parsed.error.field, reason: parsed.error.reason }) }
  return null
}

function durationText(sec) {
  return jwt.humanDuration(sec)
}

function run(v) {
  const parsed = jwt.parseJwt(jwt.cleanToken(v.token))
  if (!parsed.ok) {
    throw error.make('PARAM_INVALID', { field: parsed.error.field, reason: parsed.error.reason })
  }
  const alg = parsed.alg
  const none = String(alg || '').toLowerCase() === 'none'
  const statusTone = parsed.status.state === 'expired' ? 'err' : parsed.status.state === 'valid' ? 'ok' : 'muted'
  const times = parsed.times.map(function (t) {
    return { key: t.label + '（' + t.key + '）', value: t.text + ' · ' + (t.future ? '还剩 ' + durationText(t.diffSec) : '已过去 ' + durationText(t.diffSec)) }
  })
  const claims = (v.showAllClaims === false ? [] : parsed.claims) || []
  const kv = [
    { key: '算法 alg', value: alg ? String(alg) : '未声明' },
    { key: '类型 typ', value: parsed.header.typ ? String(parsed.header.typ) : '未声明' },
    { key: '有效期', value: parsed.status.text },
    { key: '签名段', value: parsed.signature ? String(parsed.signature).slice(0, 48) + (String(parsed.signature).length > 48 ? '…' : '') : '（空）' }
  ].concat(times).concat(claims)

  const report = []
  report.push('== header ==')
  report.push(parsed.headerText)
  report.push('')
  report.push('== payload ==')
  report.push(parsed.payloadText)
  report.push('')
  report.push('== signature (base64url) ==')
  report.push(parsed.signature || '(空)')
  report.push('')
  report.push('== 有效期 ==')
  report.push(parsed.status.text)
  parsed.times.forEach(function (t) {
    report.push(t.label + ': ' + t.text + ' (' + t.raw + ')')
  })
  report.push('')
  report.push('签名：' + parsed.verify.note)

  return {
    kv: kv,
    text: v.prettify === false ? JSON.stringify(parsed.header) + '.' + JSON.stringify(parsed.payload) : report.join('\n'),
    headerText: parsed.headerText,
    payloadText: parsed.payloadText,
    signature: parsed.signature,
    status: parsed.status,
    statusTone: statusTone,
    verifyNote: parsed.verify.note,
    noneWarning: none ? 'alg = none：该 token 根本没有签名，任何人伪造都能通过裸解码，切勿用于鉴权' : '',
    claimsCount: parsed.claims.length,
    engineUsed: 'client',
    meta: ''
  }
}

Page({
  data: {
    tool: null,
    values: defaults(),
    schema: buildSchema(),
    busy: false,
    result: null,
    error: null,
    tips: [
      '只在本地做 base64url 解码：token 不会经过网络上传，也不写入日志或埋点内容字段',
      '工程内没有 HMAC/RSA 实现，因此不提供「验签」能力：结果只说明载荷内容，不能证明 token 未被篡改',
      '自动兼容粘贴：允许带 Bearer 前缀、允许换行、允许签名段为空（alg=none）',
      'exp/iat/nbf 会换算成本机时间并给出「还剩/已过去」相对时长，毫秒与秒级时间戳都能识别',
      '非法 token（段数不对、非 base64url 字符、payload 不是 JSON 对象）会明确指出出错的段'
    ],
    samples: [
      { name: '常规 token', v: { token: SAMPLE_TOKENS.normal } },
      { name: '中文载荷', v: { token: SAMPLE_TOKENS.unicode } },
      { name: '已过期', v: { token: SAMPLE_TOKENS.expired } },
      { name: 'alg=none', v: { token: SAMPLE_TOKENS.none } },
      { name: '非法 token', v: { token: SAMPLE_TOKENS.broken } }
    ]
  },

  onLoad(query) {
    const tool = registry.get(TOOL_ID)
    const saved = store.params(TOOL_ID) || {}
    // token 属于凭证内容，不做参数记忆：只记住展示开关
    const remembered = { prettify: saved.prettify === undefined ? true : saved.prettify, showAllClaims: saved.showAllClaims === undefined ? true : saved.showAllClaims }
    this.setData({ tool: tool, values: Object.assign(defaults(), remembered) })
    track.track('tool_open', { toolId: TOOL_ID, from: query.from || 'menu' })
  },

  onParamChange(e) {
    const values = Object.assign({}, this.data.values, { [e.detail.key]: e.detail.value })
    this.setData({ values: values })
    store.saveParams(TOOL_ID, { prettify: values.prettify, showAllClaims: values.showAllClaims })
    if (this.data.result) this.setData({ result: null })
  },

  onRun() {
    if (this.data.busy) return
    const v = this.data.values
    const invalid = validate(v)
    if (invalid) return this.setData({ error: invalid, result: null })
    this.setData({ busy: true, error: null })
    track.track('tool_run_start', { toolId: TOOL_ID })
    const t0 = Date.now()
    try {
      const result = run(v)
      result.meta = '耗时 ' + Math.max(1, Date.now() - t0) + ' ms · ' + result.claimsCount + ' 条声明 · 引擎 client（未联网）'
      track.track('tool_run_success', { toolId: TOOL_ID, costMs: Date.now() - t0, engine: 'client' })
      store.bumpUsage(TOOL_ID)
      this.setData({ result: result, busy: false })
    } catch (e) {
      track.track('tool_run_fail', { toolId: TOOL_ID, code: e.code || 'TASK_FAILED' })
      this.setData({ error: { code: e.code || 'TASK_FAILED', message: error.message(e.code || 'TASK_FAILED', e.extra) }, busy: false })
    }
  },

  onSample(e) {
    const idx = Number(e.currentTarget.dataset.index)
    const values = Object.assign({}, this.data.values, this.data.samples[idx].v)
    this.setData({ values: values, result: null, error: null })
    this.onRun()
  },

  copy(text, label) {
    if (!text) return
    wx.setClipboardData({
      data: text,
      success: function () {
        wx.showToast({ title: label || '已复制', icon: 'success' })
        track.track('result_copy', { toolId: TOOL_ID })
      }
    })
  },

  onCopy(e) {
    this.copy((e.detail && e.detail.text) || (this.data.result && this.data.result.text) || '')
  },

  onCopyPart(e) {
    const key = e.currentTarget.dataset.key
    const r = this.data.result
    if (!r) return
    this.copy(r[key] || '', '已复制 ' + (key === 'payloadText' ? 'payload' : key === 'headerText' ? 'header' : '签名'))
  },

  onClear() {
    const values = Object.assign({}, this.data.values, { token: '' })
    this.setData({ values: values, result: null, error: null })
  },

  onShareAppMessage() {
    return { title: 'JWT 解析 · 本地解码 header 与载荷', path: '/packageDev/pages/jwt/index?toolId=' + TOOL_ID + '&from=share' }
  }
})
