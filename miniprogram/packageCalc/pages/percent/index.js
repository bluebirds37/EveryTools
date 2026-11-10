const registry = require('../../../tools/registry')
const store = require('../../../utils/store')
const track = require('../../../utils/track')
const error = require('../../../utils/error')
const fin = require('../../utils/fin')

const TOOL_ID = 'calc-percent'

function defaults() {
  return { mode: 'percent', a: 45, b: 60, total: 1000, weightsText: '张三:1\n李四:2\n王五:2', decimals: 2 }
}

function buildSchema() {
  return [
    { key: 'mode', label: '模式', type: 'segment', def: 'percent', options: [{ value: 'percent', label: '求百分比' }, { value: 'growth', label: '增长率' }, { value: 'share', label: '比例分配' }, { value: 'multiple', label: '倍数' }] },
    { key: 'a', label: '数值 A', type: 'number', def: 45, min: -1000000000000, max: 1000000000000, showIf: { key: 'mode', in: ['percent', 'growth', 'multiple'] } },
    { key: 'b', label: '数值 B（基准）', type: 'number', def: 60, min: -1000000000000, max: 1000000000000, showIf: { key: 'mode', in: ['percent', 'growth', 'multiple'] } },
    { key: 'total', label: '总量', type: 'number', def: 1000, min: 0, max: 1000000000000, showIf: { key: 'mode', in: ['share'] } },
    { key: 'weightsText', label: '权重（每行「名称:数值」或纯数值）', type: 'textarea', def: '张三:1\n李四:2\n王五:2', showIf: { key: 'mode', in: ['share'] } },
    { key: 'decimals', label: '分配保留小数位', type: 'slider', def: 2, min: 0, max: 6, step: 1, showIf: { key: 'mode', in: ['share'] } }
  ]
}

function parseWeights(text) {
  const lines = String(text || '').split(/[\n;；]+/)
  const items = []
  for (let k = 0; k < lines.length && items.length < 50; k++) {
    const line = lines[k].trim()
    if (!line) continue
    let name = '第 ' + (items.length + 1) + ' 项'
    let numStr = line
    const ci = line.indexOf(':')
    if (ci >= 0) {
      name = line.slice(0, ci).trim() || name
      numStr = line.slice(ci + 1).trim()
    }
    const w = Number(String(numStr).replace(/%/g, '').trim())
    if (!isFinite(w) || w < 0) return null
    items.push({ name: name, w: w })
  }
  return items.length >= 2 ? items : null
}

function validate(v) {
  const num = function (x) { return Number(x) }
  if (v.mode === 'percent' || v.mode === 'multiple') {
    if (!(num(v.b) !== 0)) return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { reason: '基准值 B 不能为 0' }) }
    if (!isFinite(num(v.a)) || !isFinite(num(v.b))) return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { reason: '请输入有限数值' }) }
  }
  if (v.mode === 'growth' && !(num(v.a) !== 0)) {
    return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { reason: '增长率要求起始值 A 不为 0' }) }
  }
  if (v.mode === 'share') {
    if (!(num(v.total) >= 0 && num(v.total) <= 1e12)) return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { reason: '总量需在 0 ~ 1 万亿之间' }) }
    const items = parseWeights(v.weightsText)
    if (!items) return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { reason: '权重至少 2 项，每行「名称:数值」或纯数值' }) }
    let s = 0
    for (let i = 0; i < items.length; i++) s += items[i].w
    if (!(s > 0)) return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { reason: '权重之和需大于 0' }) }
  }
  return null
}

function pct(x) {
  return (Math.round(x * 10000) / 10000).toFixed(4).replace(/0+$/, '').replace(/\.$/, '') + '%'
}

function run(v) {
  if (v.mode === 'percent') {
    const a = Number(v.a)
    const b = Number(v.b)
    const ratio = a / b
    const kv = [
      { key: '占比', value: pct(ratio * 100) },
      { key: '分式', value: a + ' ÷ ' + b + ' = ' + (Math.round(ratio * 1e6) / 1e6) },
      { key: '反向', value: '若取 ' + b + ' 的 ' + pct(ratio * 100) + '，则回到 ' + (Math.round(b * ratio * 1e6) / 1e6) },
      { key: '公式', value: '百分比 = A ÷ B × 100%' }
    ]
    return { kv: kv, text: kv.map(function (x) { return x.key + ': ' + x.value }).join('\n'), meta: '求百分比' }
  }
  if (v.mode === 'growth') {
    const a = Number(v.a)
    const b = Number(v.b)
    const g = (b - a) / a
    const kv = [
      { key: '增长率', value: pct(g * 100) + (g >= 0 ? '（增长）' : '（下降）') },
      { key: '变化量', value: (Math.round((b - a) * 1e6) / 1e6) + '（' + a + ' → ' + b + '）' },
      { key: '终值倍率', value: (Math.round((1 + g) * 1e6) / 1e6) + ' 倍' },
      { key: '公式', value: '增长率 = (B − A) ÷ A × 100%' }
    ]
    return { kv: kv, text: kv.map(function (x) { return x.key + ': ' + x.value }).join('\n'), meta: '增长率' }
  }
  if (v.mode === 'share') {
    const items = parseWeights(v.weightsText)
    const total = Number(v.total)
    const dec = Number(v.decimals)
    const parts = fin.allocateByWeights(total, items.map(function (i) { return i.w }), dec)
    const wSum = items.reduce(function (s, i) { return s + i.w }, 0)
    const kv = []
    let checkSum = 0
    for (let i = 0; i < items.length; i++) {
      checkSum += parts[i]
      kv.push({
        key: items[i].name,
        value: parts[i].toFixed(dec) + '（权重 ' + (items[i].w / wSum * 100).toFixed(2) + '%）'
      })
    }
    const diff = Math.round((checkSum - total) * 1e6) / 1e6
    kv.push({ key: '合计', value: checkSum.toFixed(dec) })
    kv.push({ key: '校验', value: diff === 0 ? 'Σ分配 = 总量，末项已吸收舍入差' : '偏差 ' + diff + '，请反馈' })
    return { kv: kv, text: kv.map(function (x) { return x.key + ': ' + x.value }).join('\n'), meta: items.length + ' 项分配 · 总量 ' + total.toFixed(dec) }
  }
  const a = Number(v.a)
  const b = Number(v.b)
  const m = a / b
  const kv = [
    { key: '倍数', value: (Math.round(m * 1e6) / 1e6) + ' 倍' },
    { key: '整除部分', value: b > 0 ? Math.floor(m) + ' 倍余 ' + (Math.round((a - Math.floor(m) * b) * 1e6) / 1e6) : '—' },
    { key: 'A 比 B', value: pct((m - 1) * 100) + (m >= 1 ? '多' : '少') },
    { key: '公式', value: '倍数 = A ÷ B' }
  ]
  return { kv: kv, text: kv.map(function (x) { return x.key + ': ' + x.value }).join('\n'), meta: '倍数' }
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
      '求百分比：A 是 B 的百分之几；增长率：(B−A)÷A；倍数：A÷B',
      '比例分配：每行「名称:数值」或纯数值，至少 2 项、最多 50 项',
      '分配采用「末项吸收舍入差」策略，保证各项之和与总量完全一致',
      '基准值 / 起始值为 0 会被拒绝'
    ],
    samples: [
      { name: '45 是 60 的几成', v: { mode: 'percent', a: 45, b: 60 } },
      { name: '营收 320→405 增长', v: { mode: 'growth', a: 320, b: 405 } },
      { name: '1000 按 1:1:1 分配', v: { mode: 'share', total: 1000, weightsText: '甲:1\n乙:1\n丙:1', decimals: 2 } }
    ]
  },

  onLoad(query) {
    const tool = registry.get(TOOL_ID)
    const saved = store.params(TOOL_ID) || {}
    this.setData({ tool: tool, values: Object.assign(defaults(), saved) })
    track.track('tool_open', { toolId: TOOL_ID, from: query.from || 'menu' })
  },

  onParamChange(e) {
    const values = Object.assign({}, this.data.values, { [e.detail.key]: e.detail.value })
    this.setData({ values: values })
    store.saveParams(TOOL_ID, values)
    if (this.data.result) this.setData({ result: null })
  },

  onRun() {
    if (this.data.busy) return
    const v = this.data.values
    const invalid = validate(v)
    if (invalid) return this.setData({ error: invalid, result: null })
    this.setData({ busy: true, error: null })
    track.track('tool_run_start', { toolId: TOOL_ID, mode: v.mode })
    const t0 = Date.now()
    try {
      const result = run(v)
      track.track('tool_run_success', { toolId: TOOL_ID, costMs: Date.now() - t0, engine: 'client' })
      this.setData({ result: result, busy: false })
    } catch (e) {
      track.track('tool_run_fail', { toolId: TOOL_ID, code: e.code || 'TASK_FAILED' })
      this.setData({ error: { code: e.code || 'TASK_FAILED', message: error.message(e.code || 'TASK_FAILED') }, busy: false })
    }
  },

  onSample(e) {
    const idx = Number(e.currentTarget.dataset.index)
    const values = Object.assign(defaults(), this.data.samples[idx].v)
    this.setData({ values: values, result: null, error: null })
    this.onRun()
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
    return { title: '百分比与比例分配 · 分配和恒等于总量', path: '/packageCalc/pages/percent/index?from=share' }
  }
})
