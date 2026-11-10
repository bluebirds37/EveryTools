const registry = require('../../../tools/registry')
const store = require('../../../utils/store')
const track = require('../../../utils/track')
const error = require('../../../utils/error')
const fin = require('../../utils/fin')

const TOOL_ID = 'calc-compound'

const FREQS = [
  { value: '1', label: '年' },
  { value: '2', label: '半年' },
  { value: '4', label: '季' },
  { value: '12', label: '月' },
  { value: '365', label: '日' }
]

function defaults() {
  return { mode: 'compound', principal: 100000, rate: 3.5, years: 10, freq: '12', monthlyInvest: 2000, depositType: 'lump', depositAmount: 10000, depositMonthly: 1000 }
}

function buildSchema() {
  return [
    { key: 'mode', label: '模式', type: 'segment', def: 'compound', options: [{ value: 'compound', label: '复利终值' }, { value: 'dca', label: '定投' }, { value: 'deposit', label: '银行存款' }] },
    { key: 'principal', label: '本金(元)', type: 'number', def: 100000, min: 0, max: 100000000000, precision: 2, showIf: { key: 'mode', in: ['compound'] } },
    { key: 'rate', label: '年化收益率(%)', type: 'number', def: 3.5, min: -20, max: 100, precision: 2, showIf: { key: 'mode', in: ['compound', 'dca', 'deposit'] } },
    { key: 'years', label: '年数', type: 'slider', def: 10, min: 1, max: 50, step: 1, unit: '年' },
    { key: 'freq', label: '计息频次', type: 'select', def: '12', options: FREQS, showIf: { key: 'mode', in: ['compound'] } },
    { key: 'monthlyInvest', label: '每月投入(元)', type: 'number', def: 2000, min: 0, max: 100000000, precision: 2, showIf: { key: 'mode', in: ['dca'] } },
    { key: 'depositType', label: '存款类型', type: 'segment', def: 'lump', options: [{ value: 'lump', label: '整存整取' }, { value: 'zero', label: '零存整取' }], showIf: { key: 'mode', in: ['deposit'] } },
    { key: 'depositAmount', label: '一次性存入(元)', type: 'number', def: 10000, min: 0, max: 100000000, precision: 2, showIf: { key: 'depositType', in: ['lump'] } },
    { key: 'depositMonthly', label: '每月存入(元)', type: 'number', def: 1000, min: 0, max: 100000000, precision: 2, showIf: { key: 'depositType', in: ['zero'] } }
  ]
}

function num(x) { return Number(x) }

function validate(v) {
  const invalid = function (reason) { return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { reason: reason }) } }
  if (!(num(v.years) >= 1 && num(v.years) <= 50)) return invalid('年数需在 1–50')
  if (!(num(v.rate) >= -20 && num(v.rate) <= 100)) return invalid('年化需在 −20% ~ 100%')
  if (v.mode === 'compound' && !(num(v.principal) > 0)) return invalid('本金需大于 0')
  if (v.mode === 'dca' && !(num(v.monthlyInvest) > 0)) return invalid('每月投入需大于 0')
  if (v.mode === 'deposit') {
    if (v.depositType === 'lump' && !(num(v.depositAmount) > 0)) return invalid('存入金额需大于 0')
    if (v.depositType === 'zero' && !(num(v.depositMonthly) > 0)) return invalid('每月存入需大于 0')
    if (num(v.years) > 5) return invalid('存款期限展示按 1–5 年（超长请分段）')
  }
  return null
}

function money(x) { return fin.fmtMoney(x) + ' 元' }

function run(v) {
  const kvOf = function (kv, meta) { return { kv: kv, text: kv.map(function (x) { return x.key + ': ' + x.value }).join('\n'), meta: meta } }
  if (v.mode === 'compound') {
    const r = fin.compoundFV(num(v.principal), num(v.rate), num(v.years), num(v.freq))
    const kv = [
      { key: '终值', value: money(r.fv) },
      { key: '利息', value: money(r.interest) },
      { key: '增长倍数', value: r.factor.toFixed(4) + ' 倍' },
      { key: '计息', value: r.periods + ' 期 × 期利率 ' + (r.ratePerPeriod * 100).toFixed(4) + '%' },
      { key: '公式', value: 'FV = P × (1 + r/m)^(m×n)' }
    ]
    return kvOf(kv, '复利 · 本金 ' + money(num(v.principal)))
  }
  if (v.mode === 'dca') {
    const r = fin.dcaFV(num(v.monthlyInvest), num(v.rate), num(v.years))
    const kv = [
      { key: '期末价值', value: money(r.fv) },
      { key: '累计投入', value: money(r.invested) },
      { key: '收益', value: money(r.gain) + '（' + (r.invested > 0 ? (r.gain / r.invested * 100).toFixed(2) : '0.00') + '%）' },
      { key: '期数', value: r.periods + ' 期（月末投入，月利率 ' + (r.monthlyRate * 100).toFixed(4) + '%）' },
      { key: '公式', value: 'FV = A × ((1+i)^n − 1) ÷ i' }
    ]
    return kvOf(kv, '定投 · 每月 ' + money(num(v.monthlyInvest)))
  }
  const d = fin.depositCalc(v.depositType, v.depositType === 'lump' ? num(v.depositAmount) : num(v.depositMonthly), num(v.years), num(v.rate))
  const kv = [
    { key: '类型', value: d.mode },
    { key: '到期本息', value: money(d.total) },
    { key: '利息', value: money(d.interest) }
  ]
  if (d.principal !== undefined) kv.push({ key: '累计本金', value: money(d.principal) })
  kv.push({ key: '提示', value: '存款利率按输入年化单利计，零存整取用累计月积数法；实际以银行挂牌利率为准' })
  return kvOf(kv, '存款 · ' + num(v.years) + ' 年期')
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
      '复利：FV = P×(1+r/m)^(m×n)，计息频次支持年/半年/季/月/日',
      '定投：按月末等额投入，给出期末价值、累计投入与收益对比',
      '存款：整存整取按到期单利；零存整取按累计月积数法 A·n(n+1)/2·i',
      '收益率仅用于模拟，不构成投资建议'
    ],
    samples: [
      { name: '10 万复利 3.5%×10 年', v: { mode: 'compound', principal: 100000, rate: 3.5, years: 10, freq: '12' } },
      { name: '每月定投 2000×20 年', v: { mode: 'dca', monthlyInvest: 2000, rate: 6, years: 20 } },
      { name: '零存整取 1000×3 年', v: { mode: 'deposit', depositType: 'zero', depositMonthly: 1000, rate: 1.65, years: 3 } }
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
    return { title: '复利与存款 · 终值/定投/整零存整取', path: '/packageCalc/pages/compound/index?from=share' }
  }
})
