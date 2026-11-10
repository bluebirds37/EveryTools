const registry = require('../../../tools/registry')
const store = require('../../../utils/store')
const track = require('../../../utils/track')
const error = require('../../../utils/error')
const textops = require('../../utils/textops')
const common = require('../../utils/common')

const TOOL_ID = 'text-case'

const MODE_OPTIONS = Object.keys(textops.CASE_MODES).map(function (k) {
  return { value: k, label: textops.CASE_MODES[k].label }
})

const TIPS = [
  '中文、数字与 emoji 在任何大小写模式下保持原样，只有字母受影响',
  '本地安全模式：对 i/İ 类字母使用对应语言环境规则（土耳其语 i 大写为 İ、I 小写为 ı，英语则为 I/i）',
  '同时提供全角⇄半角与常用字繁⇄简字典转换；字典为内置常用对照表，未收录的字保持原样',
  '首字母大写对连字符/空格边界处理正确：mixed-case-word → Mixed-case-word'
]

const SAMPLES = [
  { name: '全部大写', input: 'hello 世界 🌍 World', mode: 'upper', localeSafe: false },
  { name: '土耳其语 i', input: 'istanbul INFO', mode: 'upper', localeSafe: true, locale: 'tr' },
  { name: 'Title Case', input: 'the quick-brown fox jumped', mode: 'title', localeSafe: false },
  { name: '半角化', input: '１２３，ＡＢＣ　全角文本', mode: 'half', localeSafe: false },
  { name: '繁转简', input: '東門車站，時間觀點', mode: 't2s', localeSafe: false }
]

/** 应用一次转换；localeSafe 对 upper/lower 走语言环境规则 */
function applyCase(text, mode, localeSafe, locale) {
  const cm = textops.CASE_MODES[mode]
  if (!cm) {
    const e = new Error('参数错误：未知的转换模式 "' + mode + '"')
    e.code = 'PARAM_INVALID'
    throw e
  }
  if (localeSafe && (mode === 'upper' || mode === 'lower')) {
    const tag = locale === 'tr' ? 'tr-TR' : 'en-US'
    return mode === 'upper' ? String(text).toLocaleUpperCase(tag) : String(text).toLocaleLowerCase(tag)
  }
  return cm.fn(text)
}

function defaults() {
  return { mode: 'upper', localeSafe: false, locale: 'en' }
}

function buildSchema() {
  return [
    { key: 'mode', label: '转换模式', type: 'select', def: 'upper', options: MODE_OPTIONS },
    { key: 'localeSafe', label: '本地安全（i/İ 规则）', type: 'switch', def: false },
    { key: 'locale', label: '语言环境', type: 'segment', def: 'en', options: [{ value: 'en', label: '英语 en' }, { value: 'tr', label: '土耳其语 tr' }], showIf: { key: 'mode', in: ['upper', 'lower'] } }
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
    kv: [],
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

  onClearInput() { this.setData({ input: '', result: null, kv: [], error: null }) },

  onSample(e) {
    const s = SAMPLES[Number(e.currentTarget.dataset.index)]
    if (!s) return
    const values = Object.assign({}, defaults(), { mode: s.mode, localeSafe: !!s.localeSafe, locale: s.locale || 'en' })
    this.setData({ input: s.input, values: values, schema: buildSchema(), result: null, kv: [], error: null })
    this.onRun()
  },

  onRun() {
    if (this.data.busy) return
    const check = common.checkTextInput(this.data.input, '转换文本')
    if (check) {
      return this.setData({ error: { code: this.data.input ? 'PARAM_INVALID' : 'INPUT_EMPTY', message: check }, result: null, kv: [] })
    }
    const v = this.data.values
    this.setData({ busy: true, error: null, result: null, kv: [] })
    track.track('tool_run_start', { toolId: TOOL_ID, mode: v.mode })
    const t0 = Date.now()
    try {
      const out = applyCase(this.data.input, v.mode, !!v.localeSafe, v.locale)
      const label = textops.CASE_MODES[v.mode].label
      const kv = [
        { key: '模式', value: label + (v.localeSafe && (v.mode === 'upper' || v.mode === 'lower') ? '（' + (v.locale === 'tr' ? 'tr-TR' : 'en-US') + '）' : '') },
        { key: '输入/输出字符数', value: Array.from(this.data.input).length + ' / ' + Array.from(out).length }
      ]
      if (v.localeSafe && v.mode === 'upper') kv.push({ key: 'i → ?', value: 'i'.toLocaleUpperCase(v.locale === 'tr' ? 'tr-TR' : 'en-US') + '（' + (v.locale === 'tr' ? '土耳其语' : '英语') + '规则）' })
      const result = {
        text: out,
        meta: '大小写转换 · ' + label + ' · ' + (Date.now() - t0) + 'ms · 端'
      }
      track.track('tool_run_success', { toolId: TOOL_ID, costMs: Date.now() - t0, engine: 'client' })
      this.setData({ result: result, kv: kv, busy: false })
      this.remember(v)
    } catch (e) {
      const code = e.code || 'PARAM_INVALID'
      track.track('tool_run_fail', { toolId: TOOL_ID, code: code })
      this.setData({ busy: false, error: { code: code, message: e.message || error.message(code) } })
    }
  },

  onCopy(e) {
    common.copyText((e.detail && e.detail.text) || '', TOOL_ID, track)
  },

  onShare() {
    track.track('result_share', { toolId: TOOL_ID })
    wx.showToast({ title: '点右上角「…」转发给朋友', icon: 'none' })
  },

  onShareAppMessage() {
    return { title: '大小写转换 · 含本地安全与繁简全半角', path: '/packageText/pages/case/index?toolId=' + TOOL_ID + '&from=share' }
  }
})

module.exports = { applyCase: applyCase }
