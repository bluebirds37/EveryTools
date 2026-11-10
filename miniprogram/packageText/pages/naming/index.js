const registry = require('../../../tools/registry')
const store = require('../../../utils/store')
const track = require('../../../utils/track')
const error = require('../../../utils/error')
const textops = require('../../utils/textops')
const common = require('../../utils/common')

const TOOL_ID = 'text-naming'

const TIPS = [
  '自动模式按分隔符与驼峰边界拆词，可识别 user_nameHTTPCode 这类混合输入',
  '指定来源风格时只按该风格的边界拆词（如 snake 只拆下划线），便于保留特殊词形',
  '多行输入按行处理，输出保持行序；单行时可同屏展示 6 种风格',
  '往返转换幂等：snake→camel→snake 结果稳定'
]

const FROM_OPTIONS = [
  { value: 'auto', label: '自动识别' },
  { value: 'snake', label: 'snake_case' },
  { value: 'kebab', label: 'kebab-case' },
  { value: 'camel', label: 'camelCase' },
  { value: 'pascal', label: 'PascalCase' },
  { value: 'constant', label: 'CONSTANT' },
  { value: 'sentence', label: 'Sentence' }
]

const TO_OPTIONS = [
  { value: 'camel', label: 'camelCase' },
  { value: 'pascal', label: 'PascalCase' },
  { value: 'snake', label: 'snake_case' },
  { value: 'kebab', label: 'kebab-case' },
  { value: 'constant', label: 'CONSTANT_CASE' },
  { value: 'title', label: 'Title Case' }
]

const SAMPLES = [
  { name: '混合边界', input: 'user_nameHTTPCode', from: 'auto', to: 'camel' },
  { name: 'snake → camel', input: 'order_detail_page_url', from: 'snake', to: 'camel' },
  { name: '多行批量', input: 'get_user_id\nmax-size_kb\nHttpRetryCount', from: 'auto', to: 'constant' },
  { name: '短语命名', input: 'the quick brown fox', from: 'sentence', to: 'pascal' }
]

/** 按指定来源风格拆词（auto 走 textops.tokenize） */
function splitFrom(line, from) {
  const s = String(line)
  if (from === 'auto' || !from) return textops.tokenize(s)
  let parts = []
  if (from === 'snake' || from === 'constant') parts = s.split(/_+/)
  else if (from === 'kebab') parts = s.split(/-+/)
  else if (from === 'camel' || from === 'pascal') {
    parts = s
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .split(/\s+/)
  } else parts = s.split(/\s+/)
  const out = []
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i].trim()
    if (p.length) out.push(p)
  }
  return out
}

/** 猜测一行文本的风格（仅提示用） */
function detectStyle(s) {
  if (/_/.test(s)) return s === s.toUpperCase() && /[A-Z]/.test(s) ? 'constant' : 'snake'
  if (/^\d+$/.test(s)) return 'number'
  if (/\s/.test(s.trim())) return 'sentence'
  if (/-/.test(s)) return 'kebab'
  if (/^[A-Z]/.test(s) && /[a-z]/.test(s)) return 'pascal'
  if (/[A-Z]/.test(s)) return 'camel'
  return 'lower'
}

function defaults() {
  return { from: 'auto', to: 'camel', showAll: true }
}

function buildSchema() {
  return [
    { key: 'from', label: '来源风格', type: 'segment', def: 'auto', options: FROM_OPTIONS },
    { key: 'to', label: '目标风格', type: 'segment', def: 'camel', options: TO_OPTIONS },
    { key: 'showAll', label: '单行时同屏展示 6 种风格', type: 'switch', def: true }
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
    styleRows: [],
    tokensText: '',
    detected: '',
    samples: SAMPLES
  },

  onLoad(query) {
    const tool = registry.get(TOOL_ID)
    const values = Object.assign(defaults(), store.params(TOOL_ID) || {})
    this.setData({ tool: tool, values: values, input: values.__text || '' })
    track.track('tool_open', { toolId: TOOL_ID, from: query.from || 'menu' })
  },

  onParamChange(e) {
    const values = Object.assign({}, this.data.values)
    values[e.detail.key] = e.detail.value
    this.setData({ values: values, schema: buildSchema() })
    this.remember(values)
  },

  remember(values) {
    store.saveParams(TOOL_ID, Object.assign({}, values, { __text: this.data.input }))
  },

  onInput(e) {
    this.setData({ input: e.detail.value })
    clearTimeout(this._saveTimer)
    this._saveTimer = setTimeout(function () {
      store.saveParams(TOOL_ID, Object.assign({}, this.data.values, { __text: this.data.input }))
    }.bind(this), 500)
  },

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

  onClearInput() { this.setData({ input: '', result: null, styleRows: [], tokensText: '', detected: '', error: null }) },

  onSample(e) {
    const s = SAMPLES[Number(e.currentTarget.dataset.index)]
    if (!s) return
    const values = Object.assign({}, this.data.values, { from: s.from, to: s.to })
    this.setData({ input: s.input, values: values, schema: buildSchema(), result: null, styleRows: [], error: null })
    this.onRun()
  },

  onRun() {
    if (this.data.busy) return
    const check = common.checkTextInput(this.data.input, '命名文本')
    if (check) {
      return this.setData({ error: { code: this.data.input ? 'PARAM_INVALID' : 'INPUT_EMPTY', message: check }, result: null, styleRows: [] })
    }
    if (this.data.input.length > common.MAX_INPUT_LEN) {
      return this.setData({ error: { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { reason: '文本超过 1,000,000 字符上限' }) }, result: null })
    }
    const v = this.data.values
    this.setData({ busy: true, error: null, result: null, styleRows: [], tokensText: '', detected: '' })
    track.track('tool_run_start', { toolId: TOOL_ID, to: v.to })
    const t0 = Date.now()
    try {
      const lines = this.data.input.replace(/\r\n?/g, '\n').split('\n')
      const single = lines.length === 1
      const style = textops.STYLES[v.to] || textops.STYLES.camel
      const outputs = []
      const allEmpty = []
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i]
        if (!l.trim()) { outputs.push(l); continue }
        const tokens = splitFrom(l, v.from)
        if (!tokens.length) { allEmpty.push(i + 1); outputs.push(l); continue }
        outputs.push(style(tokens))
      }
      if (outputs.every(function (x) { return !x.trim() })) {
        const e = new Error('未能从输入中提取到任何单词（只含分隔符？）')
        e.code = 'PARAM_INVALID'
        throw e
      }
      const styleRows = []
      let tokensText = ''
      let detected = ''
      if (single) {
        const tokens = splitFrom(lines[0], v.from)
        tokensText = tokens.join(' · ')
        detected = detectStyle(lines[0])
        if (v.showAll) {
          const labels = textops.STYLE_LABELS
          for (let k = 0; k < labels.length; k++) {
            styleRows.push({ key: labels[k][0], label: labels[k][1], value: textops.STYLES[labels[k][0]](tokens), active: labels[k][0] === v.to })
          }
        }
      }
      const outText = outputs.join('\n')
      const result = {
        text: outText,
        meta: '命名转换 · ' + v.from + '→' + v.to + ' · ' + lines.length + ' 行 · ' + (Date.now() - t0) + 'ms · 端' + (allEmpty.length ? ' · 第 ' + allEmpty.join(',') + ' 行无有效词已原样保留' : '')
      }
      track.track('tool_run_success', { toolId: TOOL_ID, costMs: Date.now() - t0, engine: 'client' })
      this.setData({ result: result, styleRows: styleRows, tokensText: tokensText, detected: detected, busy: false })
      this.remember(v)
    } catch (e) {
      const code = e.code || 'PARAM_INVALID'
      track.track('tool_run_fail', { toolId: TOOL_ID, code: code })
      this.setData({ busy: false, error: { code: code, message: e.message || error.message(code) } })
    }
  },

  onCopyStyle(e) {
    common.copyText(e.currentTarget.dataset.value || '', TOOL_ID, track)
  },

  onCopy(e) {
    common.copyText((e.detail && e.detail.text) || '', TOOL_ID, track)
  },

  onShare() {
    track.track('result_share', { toolId: TOOL_ID })
    wx.showToast({ title: '点右上角「…」转发给朋友', icon: 'none' })
  },

  onShareAppMessage() {
    return { title: '命名转换 · 驼峰下划线一键互转', path: '/packageText/pages/naming/index?toolId=' + TOOL_ID + '&from=share' }
  }
})

module.exports = { splitFrom: splitFrom, detectStyle: detectStyle }
