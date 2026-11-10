const registry = require('../../../tools/registry')
const store = require('../../../utils/store')
const track = require('../../../utils/track')
const error = require('../../../utils/error')
const hash = require('../../utils/hash')
const codec = require('../../utils/codec')
const common = require('../../utils/common')

const TOOL_ID = 'text-hash'

const MAX_TEXT_BYTES = 2 * 1024 * 1024 // 主线程上限（tools-spec FR-TXT-05）

const TIPS = [
  'MD5/SHA-1/SHA-256/SHA-512 为纯 JS 端实现，与 md5sum / openssl 对照一致（内置自测样例可验证）',
  '填了密钥则同时输出 HMAC（RFC 2104），HMAC-SHA256 与 RFC 4231 用例一致',
  '文本按 UTF-8 字节计算，最大 2MB；更大内容请拆分后分段计算',
  '全部离线完成，内容不会上传'
]

const SAMPLES = [
  { name: 'abc 的 sha256', input: 'abc', v: { algo: 'sha256', upper: false, key: '' } },
  { name: '空串 md5', input: '', specialEmpty: true, v: { algo: 'md5', upper: false, key: '' } },
  { name: 'HMAC 标准用例', input: 'Hi There', specialKey: true, v: { algo: 'sha256', upper: false, key: '' } },
  { name: '中文 md5 大写', input: '日常工具箱', v: { algo: 'md5', upper: true, key: '' } }
]

/* RFC 4231 Test Case 1：20 字节 0x0b 作密钥，"Hi There" 的 HMAC-SHA256 */
function rfcKey() {
  let s = ''
  for (let i = 0; i < 20; i++) s += String.fromCharCode(0x0b)
  return s
}

function defaults() {
  return { algo: 'md5', upper: false, key: '' }
}

function buildSchema() {
  return [
    { key: 'algo', label: '算法', type: 'segment', def: 'md5', options: [{ value: 'md5', label: 'MD5' }, { value: 'sha1', label: 'SHA-1' }, { value: 'sha256', label: 'SHA-256' }, { value: 'sha512', label: 'SHA-512' }] },
    { key: 'upper', label: '大写输出', type: 'switch', def: false },
    { key: 'key', label: 'HMAC 密钥（可空）', type: 'textarea', def: '', rows: 1, placeholder: '留空则只计算普通摘要' }
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
    this.setData({ values: values })
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
        this.setData({ input: v.slice(0, 200000) })
      },
      fail: () => wx.showToast({ title: '无法读取剪贴板', icon: 'none' })
    })
  },
  onClearInput() { this.setData({ input: '', result: null, error: null }) },

  onSample(e) {
    const s = SAMPLES[Number(e.currentTarget.dataset.index)]
    if (!s) return
    const values = Object.assign(defaults(), s.v)
    this.setData({ input: s.input, values: values, result: null, error: null })
    this.remember(values)
    this._allowEmpty = !!s.specialEmpty
    this._sampleKey = s.specialKey ? rfcKey() : null
    this.onRun()
  },

  onRun() {
    if (this.data.busy) return
    const v = this.data.values
    const allowEmpty = this._allowEmpty === true
    this._allowEmpty = false
    if (this.data.input === '' && !allowEmpty) {
      return this.setData({ error: { code: 'INPUT_EMPTY', message: error.message('INPUT_EMPTY', { reason: '请输入待摘要的文本' }) }, result: null })
    }
    let bytes
    try {
      bytes = codec.utf8ToBytes(this.data.input)
    } catch (e) {
      this._sampleKey = null
      return this.setData({ error: { code: 'PARAM_INVALID', message: e.message }, result: null })
    }
    if (bytes.length > MAX_TEXT_BYTES) {
      this._sampleKey = null
      return this.setData({ error: { code: 'FILE_TOO_LARGE', message: error.message('FILE_TOO_LARGE', { max: MAX_TEXT_BYTES }) + '，请拆分文本后分段计算' }, result: null })
    }
    this.setData({ busy: true, error: null, result: null })
    track.track('tool_run_start', { toolId: TOOL_ID, algo: v.algo })
    const t0 = Date.now()
    try {
      const rows = []
      const digest = hash[v.algo](this.data.input)
      const final = v.upper ? digest.toUpperCase() : digest
      rows.push({ key: v.algo.toUpperCase() + ' 摘要', value: final })
      let text = final
      const key = this._sampleKey !== null && this._sampleKey !== undefined ? this._sampleKey : String(v.key || '')
      this._sampleKey = null
      if (key) {
        const hm = hash.hmac(v.algo, key, this.data.input)
        const hmFinal = v.upper ? hm.toUpperCase() : hm
        rows.push({ key: 'HMAC-' + v.algo.toUpperCase(), value: hmFinal })
        text += '\n' + hmFinal
      }
      rows.push({ key: '输入字节数(UTF-8)', value: String(bytes.length) })
      rows.push({ key: '摘要长度', value: digest.length * 4 + ' bit' })
      const result = {
        text: text,
        kv: rows,
        meta: v.algo + (key ? ' + HMAC' : '') + ' · ' + (Date.now() - t0) + 'ms · 端'
      }
      track.track('tool_run_success', { toolId: TOOL_ID, costMs: Date.now() - t0, engine: 'client' })
      this.setData({ result: result, busy: false })
      this.remember(v)
    } catch (e) {
      track.track('tool_run_fail', { toolId: TOOL_ID, code: 'PARAM_INVALID' })
      this.setData({ busy: false, error: { code: 'PARAM_INVALID', message: e.message || error.message('PARAM_INVALID') } })
    }
  },

  onCopy(e) {
    const payload = e.detail || {}
    common.copyText(payload.text || (this.data.result && this.data.result.text) || '', TOOL_ID, track)
  },

  onShare() {
    track.track('result_share', { toolId: TOOL_ID })
    wx.showToast({ title: '点右上角「…」转发给朋友', icon: 'none' })
  },

  onShareAppMessage() {
    return { title: '哈希计算 · MD5/SHA 家族与 HMAC', path: '/packageText/pages/hash/index?toolId=' + TOOL_ID + '&from=share' }
  }
})

module.exports = { MAX_TEXT_BYTES: MAX_TEXT_BYTES }
