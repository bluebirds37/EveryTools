const registry = require('../../../tools/registry')
const store = require('../../../utils/store')
const track = require('../../../utils/track')
const error = require('../../../utils/error')
const codec = require('../../utils/codec')
const common = require('../../utils/common')

const TOOL_ID = 'text-url'

const TIPS = [
  '组件模式：按 encodeURIComponent 语义做百分号编解码，中文正确往返',
  '整链模式：解析 scheme / host / path / query / hash 成表格，参数可增删改后重建',
  '重复参数保留（不去重）；「保留安全字符」编码时不转义 : / ? & 等保留字符',
  '解码遇非法百分号序列会提示出错位置'
]

const SAMPLES = [
  { name: '中文参数', input: 'a=中文&b=1 2', v: { dir: 'encode', scope: 'component', keepSafe: false } },
  { name: '整链解析', input: 'https://example.com/search?q=%E4%B8%AD%E6%96%87&page=2&tag=a&tag=b#top', v: { dir: 'decode', scope: 'full', keepSafe: false } },
  { name: '组件解码', input: '%E4%BD%A0%E5%A5%BD%20world', v: { dir: 'decode', scope: 'component', keepSafe: false } },
  { name: '非法转义', input: '%E4%A0', v: { dir: 'decode', scope: 'component', keepSafe: false } }
]

function defaults() {
  return { dir: 'encode', scope: 'component', keepSafe: false }
}

/** 解析整链 URL（自研，不依赖 URL 类）；返回 {scheme, host, path, params:[[k,v]], hash} 或 null */
function parseUrl(raw) {
  const s = String(raw).trim()
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?(?:#([\s\S]*))?$/.exec(s)
  if (!m) return null
  const params = []
  const qs = m[4] || ''
  if (qs !== '') {
    qs.split('&').forEach(function (pair) {
      if (pair === '') return
      const eq = pair.indexOf('=')
      const k = eq < 0 ? pair : pair.slice(0, eq)
      const v = eq < 0 ? '' : pair.slice(eq + 1)
      params.push([codec.urlDecode(k, true), codec.urlDecode(v, true)])
    })
  }
  return { scheme: m[1], host: m[2], path: m[3] || '/', params: params, hash: codec.urlDecode(m[5] || '', false) }
}

/** 重建 URL：keepSafe=false 时对键值做组件级编码 */
function buildUrl(u, keepSafe) {
  const enc = keepSafe ? codec.urlEncodeUri : codec.urlEncodeComponent
  const qs = u.params.map(function (p) { return enc(p[0]) + '=' + enc(p[1]) }).join('&')
  return u.scheme + '://' + u.host + u.path + (u.params.length ? (qs ? '?' + qs : '?') : '') + (u.hash ? '#' + enc(u.hash) : '')
}

function buildSchema() {
  return [
    { key: 'scope', label: '模式', type: 'segment', def: 'component', options: [{ value: 'component', label: '组件 component' }, { value: 'full', label: '整链 fullURL' }] },
    { key: 'dir', label: '方向', type: 'segment', def: 'encode', options: [{ value: 'encode', label: '编码' }, { value: 'decode', label: '解码' }], showIf: { key: 'scope', in: ['component'] } },
    { key: 'keepSafe', label: '保留安全字符', type: 'switch', def: false, showIf: { key: 'dir', in: ['encode'] } }
  ]
}

Page({
  data: {
    tool: null,
    values: defaults(),
    input: '',
    schema: buildSchema(),
    tips: TIPS,
    busy: false,
    result: null,
    error: null,
    parsed: null,
    samples: SAMPLES
  },

  onLoad(query) {
    const tool = registry.get(TOOL_ID)
    const values = Object.assign(defaults(), store.params(TOOL_ID) || {})
    this.setData({ tool: tool, values: values, input: values.__input || '' })
    track.track('tool_open', { toolId: TOOL_ID, from: query.from || 'menu' })
  },

  onParamChange(e) {
    const values = Object.assign({}, this.data.values)
    values[e.detail.key] = e.detail.value
    this.setData({ values: values, schema: buildSchema() })
    this.remember(values)
  },

  remember(values) {
    store.saveParams(TOOL_ID, Object.assign({}, values, { __input: this.data.input }))
  },

  onInput(e) { this.setData({ input: e.detail.value }) },
  onPaste() {
    wx.getClipboardData({
      success: (res) => {
        const v = String((res && res.data) || '')
        if (!v) return wx.showToast({ title: '剪贴板为空', icon: 'none' })
        this.setData({ input: v.slice(0, common.MAX_INPUT_LEN) })
      },
      fail: () => wx.showToast({ title: '无法读取剪贴板', icon: 'none' })
    })
  },
  onClearInput() { this.setData({ input: '', result: null, parsed: null, error: null }) },
  onSwap() {
    const values = Object.assign({}, this.data.values, { dir: this.data.values.dir === 'encode' ? 'decode' : 'encode' })
    const outText = this.data.result && this.data.result.text
    this.setData({ values: values, schema: buildSchema(), input: outText ? outText : this.data.input })
    this.remember(values)
  },

  onSample(e) {
    const s = SAMPLES[Number(e.currentTarget.dataset.index)]
    if (!s) return
    const values = Object.assign(defaults(), s.v)
    this.setData({ input: s.input, values: values, schema: buildSchema(), result: null, parsed: null, error: null })
    this.remember(values)
    this.onRun()
  },

  runComponent() {
    const v = this.data.values
    if (v.dir === 'encode') {
      return v.keepSafe ? codec.urlEncodeUri(this.data.input) : codec.urlEncodeComponent(this.data.input)
    }
    return codec.urlDecode(this.data.input, true)
  },

  runFull() {
    const u = parseUrl(this.data.input)
    if (!u) throw { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { reason: '整链模式需形如 scheme://host/path 的链接' }) }
    this.setData({ parsed: u })
    const rows = [
      { key: 'scheme', value: u.scheme },
      { key: 'host', value: u.host },
      { key: 'path', value: u.path },
      { key: 'query 参数', value: u.params.length + ' 项' },
      { key: 'hash', value: u.hash || '（无）' }
    ]
    const rebuilt = buildUrl(u, this.data.values.keepSafe)
    return { text: rebuilt, kv: rows, rebuilt: rebuilt }
  },

  onRun() {
    if (this.data.busy) return
    const emptyMsg = common.checkTextInput(this.data.input)
    if (emptyMsg) return this.setData({ error: { code: 'INPUT_EMPTY', message: error.message('INPUT_EMPTY', { reason: emptyMsg }) }, result: null, parsed: null })
    this.setData({ busy: true, error: null, result: null, parsed: null })
    track.track('tool_run_start', { toolId: TOOL_ID, scope: this.data.values.scope })
    const t0 = Date.now()
    try {
      let result
      if (this.data.values.scope === 'full') {
        const r = this.runFull()
        result = { text: r.text, kv: r.kv, meta: '整链解析 · 参数 ' + this.data.parsed.params.length + ' 项 · ' + (Date.now() - t0) + 'ms · 端' }
      } else {
        const out = this.runComponent()
        const rows = [
          { key: '输入长度', value: String(this.data.input.length) },
          { key: '输出长度', value: String(out.length) }
        ]
        result = { text: out, kv: rows, meta: (this.data.values.dir === 'encode' ? '编码' : '解码') + '（组件）· ' + (Date.now() - t0) + 'ms · 端' }
      }
      track.track('tool_run_success', { toolId: TOOL_ID, costMs: Date.now() - t0, engine: 'client' })
      this.setData({ result: result, busy: false })
      this.remember(this.data.values)
    } catch (e) {
      const code = e.code || 'PARAM_INVALID'
      track.track('tool_run_fail', { toolId: TOOL_ID, code: code })
      this.setData({ busy: false, error: { code: code, message: e.message || error.message(code) } })
    }
  },

  /* ---------- fullURL 参数表编辑 ---------- */
  onParamKey(e) { this.editParam(Number(e.currentTarget.dataset.i), 0, e.detail.value) },
  onParamVal(e) { this.editParam(Number(e.currentTarget.dataset.i), 1, e.detail.value) },
  editParam(i, slot, val) {
    const parsed = this.data.parsed
    if (!parsed || !parsed.params[i]) return
    const params = parsed.params.map(function (p) { return [p[0], p[1]] })
    params[i][slot] = val
    this.setData({ parsed: Object.assign({}, parsed, { params: params }) })
    this.rebuildText()
  },
  onDelParam(e) {
    const parsed = this.data.parsed
    if (!parsed) return
    const params = parsed.params.slice()
    params.splice(Number(e.currentTarget.dataset.i), 1)
    this.setData({ parsed: Object.assign({}, parsed, { params: params }) })
    this.rebuildText()
  },
  onAddParam() {
    const parsed = this.data.parsed || { scheme: 'https', host: 'example.com', path: '/', params: [], hash: '' }
    const params = parsed.params.concat([['key' + (parsed.params.length + 1), '']])
    this.setData({ parsed: Object.assign({}, parsed, { params: params }) })
    this.rebuildText()
  },
  rebuildText() {
    const text = buildUrl(this.data.parsed, this.data.values.keepSafe)
    const kv = [
      { key: 'scheme', value: this.data.parsed.scheme },
      { key: 'host', value: this.data.parsed.host },
      { key: 'path', value: this.data.parsed.path },
      { key: 'query 参数', value: this.data.parsed.params.length + ' 项' },
      { key: 'hash', value: this.data.parsed.hash || '（无）' }
    ]
    this.setData({ result: Object.assign({}, this.data.result, { text: text, kv: kv, meta: '整链重建 · 参数 ' + this.data.parsed.params.length + ' 项 · 端' }) })
  },

  onCopy(e) {
    common.copyText((e.detail && e.detail.text) || '', TOOL_ID, track)
  },

  onShare() {
    track.track('result_share', { toolId: TOOL_ID })
    wx.showToast({ title: '点右上角「…」转发给朋友', icon: 'none' })
  },

  onShareAppMessage() {
    return { title: 'URL 编解码 · 中文参数与整链解析', path: '/packageText/pages/url/index?toolId=' + TOOL_ID + '&from=share' }
  }
})

module.exports = { parseUrl: parseUrl, buildUrl: buildUrl }
