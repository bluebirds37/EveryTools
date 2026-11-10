const registry = require('../../../tools/registry')
const store = require('../../../utils/store')
const track = require('../../../utils/track')
const error = require('../../../utils/error')
const units = require('../../utils/units')

const TOOL_ID = 'calc-unit'

function defaults() {
  return { cat: 'length', from: 'm', to: 'cm', value: '1', precision: 6, dataStd: '1024' }
}

const SAMPLES = [
  { name: '温度 0°C→°F', v: { cat: 'temperature', from: 'c', to: 'f', value: '0', precision: 6, dataStd: '1024' } },
  { name: '存储 1MiB→B', v: { cat: 'data', from: 'm', to: 'b', value: '1', precision: 6, dataStd: '1024' } },
  { name: '长度 17in→cm', v: { cat: 'length', from: 'in', to: 'cm', value: '17', precision: 6, dataStd: '1024' } }
]

function validate(v) {
  if (v.value === '' || v.value === null || v.value === undefined) {
    return { code: 'INPUT_EMPTY', message: error.message('INPUT_EMPTY') }
  }
  const n = Number(v.value)
  if (!isFinite(n)) return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { reason: '换算数值不是合法数字' }) }
  if (Math.abs(n) >= 1e18) return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { reason: '数值需在 1e18 以内' }) }
  return null
}

Page({
  data: {
    tool: null,
    values: defaults(),
    schema: [],
    tips: [
      '10 组类别线性换算按国际定义因子，相对误差 ≤1e-9',
      '温度为非线性独立公式（°F = °C×9/5+32），不走倍率',
      '数据存储可切换 1024（KiB/MiB）或 1000（kB/MB）进制，公式提示会标注',
      '结果双向显示，点「交换单位」互换输入输出；最近 10 次输入自动记忆'
    ],
    result: null,
    error: null,
    history: [],
    samples: SAMPLES
  },

  onLoad(query) {
    const tool = registry.get(TOOL_ID)
    const saved = store.params(TOOL_ID) || {}
    const values = Object.assign(defaults(), saved)
    this.setData({ tool: tool, values: values, history: saved.__history || [] })
    this.buildSchema()
    this.recompute()
    track.track('tool_open', { toolId: TOOL_ID, from: query.from || 'menu' })
  },

  buildSchema() {
    const v = this.data.values
    const cats = units.categories().map(function (id) {
      return { value: id, label: units.categoryName(id) }
    })
    const opts = function (cat, std) {
      return units.unitOptions(cat, std).map(function (u) {
        return { value: u.id, label: u.name }
      })
    }
    const schema = [
      { key: 'cat', label: '类别', type: 'select', def: 'length', options: cats },
      { key: 'dataStd', label: '存储进制', type: 'segment', def: '1024', options: [{ value: '1024', label: '1024（KiB）' }, { value: '1000', label: '1000（kB）' }], showIf: { key: 'cat', in: ['data'] } },
      { key: 'from', label: '原单位', type: 'select', def: 'm', options: opts(v.cat, v.dataStd) },
      { key: 'to', label: '目标单位', type: 'select', def: 'cm', options: opts(v.cat, v.dataStd) },
      { key: 'value', label: '数值', type: 'number', def: '1' },
      { key: 'precision', label: '有效位数', type: 'slider', def: 6, min: 0, max: 10, step: 1 }
    ]
    this.setData({ schema: schema })
  },

  onParamChange(e) {
    const key = e.detail.key
    let value = e.detail.value
    const values = Object.assign({}, this.data.values)
    values[key] = value
    if (key === 'cat') {
      const first = units.unitOptions(values.cat, values.dataStd)
      values.from = first[0].id
      values.to = first.length > 1 ? first[1].id : first[0].id
      if (values.cat !== 'data') delete values.dataStd
    }
    if (key === 'dataStd') {
      values.dataStd = value
    }
    this.setData({ values: values })
    this.buildSchema()
    this.recompute()
  },

  onSwap() {
    const values = Object.assign({}, this.data.values)
    const t = values.from
    values.from = values.to
    values.to = t
    this.setData({ values: values })
    this.buildSchema()
    this.recompute()
    track.track('tool_run_start', { toolId: TOOL_ID, action: 'swap' })
  },

  recompute() {
    const v = this.data.values
    const invalid = validate(v)
    if (invalid) {
      this.setData({ error: invalid, result: null })
      return
    }
    const forward = units.convert(v.cat, v.from, v.to, v.value, { dataStd: v.dataStd })
    const backward = units.convert(v.cat, v.to, v.from, v.value, { dataStd: v.dataStd })
    if (!forward || !backward) {
      this.setData({ error: { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { reason: '单位不属于当前类别' }) }, result: null })
      return
    }
    const fromName = units.unitName(v.cat, v.from, v.dataStd)
    const toName = units.unitName(v.cat, v.to, v.dataStd)
    const fv = units.formatValue(Number(v.value), v.precision)
    const tv = units.formatValue(forward.value, v.precision)
    const rv = units.formatValue(backward.value, v.precision)
    const text = v.value + ' ' + fromName + ' = ' + tv + ' ' + toName + '\n反向：' + v.value + ' ' + toName + ' = ' + rv + ' ' + fromName
    this.setData({
      error: null,
      result: {
        text: text,
        kv: [
          { key: fromName + ' → ' + toName, value: tv },
          { key: '反向换算', value: v.value + ' ' + toName + ' = ' + rv + ' ' + fromName },
          { key: '换算公式', value: forward.formula }
        ],
        meta: units.categoryName(v.cat) + ' · 相对误差 ≤1e-9'
      }
    })
    this.remember()
  },

  remember() {
    const v = this.data.values
    const item = v.value + ' ' + units.unitName(v.cat, v.from, v.dataStd) + '→' + units.unitName(v.cat, v.to, v.dataStd)
    let history = this.data.history.slice()
    if (history[0] !== item) {
      history = [item].concat(history.filter(function (h) { return h !== item })).slice(0, 10)
    }
    this.setData({ history: history })
    const saved = store.params(TOOL_ID) || {}
    store.saveParams(TOOL_ID, Object.assign({}, saved, { cat: v.cat, from: v.from, to: v.to, value: v.value, precision: v.precision, dataStd: v.dataStd, __history: history }))
  },

  onUseHistory(e) {
    const idx = Number(e.currentTarget.dataset.index)
    const parts = String(this.data.history[idx] || '').match(/^(-?[\d.e+]+)\s.*?→/)
    if (parts) {
      const values = Object.assign({}, this.data.values, { value: parts[1] })
      this.setData({ values: values })
      this.recompute()
    }
  },

  onSample(e) {
    const idx = Number(e.currentTarget.dataset.index)
    const values = Object.assign(defaults(), SAMPLES[idx].v, { precision: this.data.values.precision })
    this.setData({ values: values })
    this.buildSchema()
    this.recompute()
    track.track('tool_run_start', { toolId: TOOL_ID, action: 'sample' })
  },

  onCopy(e) {
    const text = (e.detail && e.detail.text) || (this.data.result && this.data.result.text) || ''
    if (!text) return
    wx.setClipboardData({
      data: text,
      success: function () {
        wx.showToast({ title: '已复制', icon: 'success' })
        track.track('result_copy', { toolId: TOOL_ID })
      }
    })
  },

  onShareAppMessage() {
    return { title: '单位换算 · 10 组类别实时互算', path: '/packageCalc/pages/unit/index?from=share' }
  }
})
