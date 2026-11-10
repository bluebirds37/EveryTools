const registry = require('../../../tools/registry')
const store = require('../../../utils/store')
const track = require('../../../utils/track')
const error = require('../../../utils/error')
const fin = require('../../utils/fin')

const TOOL_ID = 'calc-loan'
const PAGE_SIZE = 20

function defaults() {
  return { type: 'commercial', principal: 1000000, years: 20, method: 'annuity', rate: 4.35, ratePf: 2.85, providentPart: 0 }
}

function buildSchema(serverRates) {
  return [
    { key: 'type', label: '贷款类型', type: 'segment', def: 'commercial', options: [{ value: 'commercial', label: '商贷' }, { value: 'provident', label: '公积金' }, { value: 'mixed', label: '组合贷' }] },
    { key: 'principal', label: '贷款本金(元)', type: 'number', def: 1000000, min: 10000, max: 100000000 },
    { key: 'years', label: '贷款年限(年)', type: 'slider', def: 20, min: 1, max: 40, step: 1, unit: '年' },
    { key: 'method', label: '还款方式', type: 'segment', def: 'annuity', options: [{ value: 'annuity', label: '等额本息' }, { value: 'principal', label: '等额本金' }] },
    { key: 'rate', label: '年利率(%)', type: 'number', def: serverRates && serverRates.commercial || 4.35, min: 0, max: 20, precision: 4 },
    { key: 'ratePf', label: '公积金年利率(%)', type: 'number', def: 2.85, min: 0, max: 20, precision: 4, showIf: { key: 'type', in: ['mixed'] } },
    { key: 'providentPart', label: '其中公积金部分(元)', type: 'number', def: 0, min: 0, max: 100000000, showIf: { key: 'type', in: ['mixed'] } }
  ]
}

function validate(v) {
  const p = Number(v.principal)
  if (!(p >= 10000 && p <= 1e8)) return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { reason: '贷款本金需在 1 万 ~ 1 亿元之间' }) }
  const y = Number(v.years)
  if (!(y >= 1 && y <= 40)) return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { reason: '贷款年限 1–40 年' }) }
  const r = Number(v.rate)
  if (!(r >= 0 && r <= 20)) return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { reason: '年利率 0–20%' }) }
  if (v.type === 'mixed') {
    const pp = Number(v.providentPart)
    if (!(pp > 0 && pp < p)) return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { reason: '公积金部分需大于 0 且小于贷款总额' }) }
    if (!(Number(v.ratePf) >= 0 && Number(v.ratePf) <= 20)) return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { reason: '公积金年利率 0–20%' }) }
  }
  return null
}

Page({
  data: {
    tool: null,
    values: defaults(),
    schema: [],
    busy: false,
    result: null,
    error: null,
    rows: [],
    rowsShown: 0,
    rowsTotal: 0,
    rateNote: '',
    tips: [
      '等额本息月供 = P·i·(1+i)ⁿ ÷ ((1+i)ⁿ−1)；等额本金第 k 期 = P/n + (P−P(k−1)/n)·i（i 为月利率）',
      '月供误差 <0.01 元；逐期明细本金求和 = 贷款本金',
      '默认商贷利率 4.35%（LPR 参考值）、公积金 2.85%，均可编辑；后端下发 tool_flags.loan 时自动覆盖默认值',
      '明细表分页渲染（每页 20 期），360 期全量不会一次 setData；可复制/导出 CSV 明细'
    ],
    samples: [
      { name: '100万商贷30年', v: { type: 'commercial', principal: 1000000, years: 30, method: 'annuity', rate: 4.35 } },
      { name: '80万公积金25年等额本金', v: { type: 'provident', principal: 800000, years: 25, method: 'principal', rate: 2.85 } },
      { name: '150万组合贷(公积金60万)', v: { type: 'mixed', principal: 1500000, years: 30, method: 'annuity', rate: 4.35, ratePf: 2.85, providentPart: 600000 } }
    ]
  },

  onLoad(query) {
    const tool = registry.get(TOOL_ID)
    const saved = store.params(TOOL_ID) || {}
    const values = Object.assign(defaults(), saved)
    // 后端下发利率覆盖（storage 'tool_flags' → flags.loan.commercial / flags.loan.provident）
    const flags = store.get('tool_flags')
    const resolved = fin.resolveRates(flags)
    let rateNote = '默认 4.35%（LPR 参考）/ 公积金 2.85%'
    if (resolved.fromServer && !saved.__rateEdited) {
      if (values.type !== 'mixed' && !saved.rate) values.rate = resolved.commercial
      if (!saved.ratePf) values.ratePf = resolved.provident
      rateNote = '已由后端下发利率覆盖：商贷 ' + resolved.commercial + '% / 公积金 ' + resolved.provident + '%'
    }
    this._allRows = []
    this.setData({ tool: tool, values: values, rateNote: rateNote })
    this.setData({ schema: buildSchema(resolved) })
    track.track('tool_open', { toolId: TOOL_ID, from: query.from || 'menu' })
  },

  onParamChange(e) {
    const values = Object.assign({}, this.data.values, { [e.detail.key]: e.detail.value })
    if (e.detail.key === 'rate' || e.detail.key === 'ratePf') values.__rateEdited = true
    this.setData({ values: values })
    store.saveParams(TOOL_ID, values)
    if (this.data.result) this.setData({ result: null, rows: [], rowsShown: 0, rowsTotal: 0 })
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
      const p = Number(v.principal)
      const months = Math.round(Number(v.years) * 12)
      const rate = Number(v.rate)
      // 利率一律取可见的「年利率」：ratePf 只在组合贷里显示，
      // 用它当纯公积金贷的利率会让用户改年利率完全没反应
      const effRate = rate
      let calc, extraKv = []
      if (v.type === 'mixed') {
        calc = fin.mixedSchedule(p, rate, Number(v.ratePf), months, Number(v.providentPart))
        extraKv.push({ key: '拆分', value: '公积金 ' + fin.fmtMoney(calc.providentPrincipal) + '（' + v.ratePf + '%）+ 商贷 ' + fin.fmtMoney(calc.commercialPrincipal) + '（' + rate + '%）' })
      } else if (v.method === 'annuity') {
        calc = fin.annuitySchedule(p, effRate, months)
      } else {
        calc = fin.equalPrincipalSchedule(p, effRate, months)
      }
      if (!calc) throw { code: 'PARAM_INVALID' }
      this._allRows = calc.rows
      const kv = extraKv.slice()
      if (v.type === 'mixed' || v.method === 'annuity') {
        kv.unshift({ key: '月供', value: fin.fmtMoney(calc.monthly) + ' 元' })
        kv.push({ key: '首月还款', value: fin.fmtMoney(calc.rows[0].payment) + ' 元' })
      } else {
        kv.unshift({ key: '首月还款', value: fin.fmtMoney(calc.firstPayment) + ' 元' })
        kv.push({ key: '末月还款', value: fin.fmtMoney(calc.lastPayment) + ' 元' })
        kv.push({ key: '每月递减', value: fin.fmtMoney(calc.monthlyDecrease) + ' 元' })
      }
      kv.push({ key: '总利息', value: fin.fmtMoney(calc.totalInterest) + ' 元' })
      kv.push({ key: '总还款', value: fin.fmtMoney(calc.totalPayment) + ' 元' })
      // 两种还款方式对比结论
      let cmp = null
      if (v.type === 'mixed') {
        const a = fin.compareMethods(calc.providentPrincipal, Number(v.ratePf), months)
        const b = fin.compareMethods(calc.commercialPrincipal, rate, months)
        cmp = { interestDiff: Math.round((a.interestDiff + b.interestDiff) * 100) / 100, conclusion: '组合贷整体看：等额本金比等额本息总利息少约 ' + fin.fmtMoney(a.interestDiff + b.interestDiff) + ' 元，但首月压力更大。' }
      } else {
        cmp = fin.compareMethods(p, effRate, months)
      }
      kv.push({ key: '还款方式对比', value: cmp.conclusion })
      const text = kv.map(function (x) { return x.key + ': ' + x.value }).join('\n')
      track.track('tool_run_success', { toolId: TOOL_ID, costMs: Date.now() - t0, engine: 'client' })
      this.setData({
        busy: false,
        result: { kv: kv, text: text, meta: months + ' 期 · ' + (v.method === 'annuity' ? '等额本息' : '等额本金') + (v.type === 'mixed' ? ' · 组合贷(等额本息)' : '') },
        rows: this._allRows.slice(0, PAGE_SIZE),
        rowsShown: Math.min(PAGE_SIZE, this._allRows.length),
        rowsTotal: this._allRows.length
      })
      store.saveParams(TOOL_ID, this.data.values)
    } catch (e) {
      track.track('tool_run_fail', { toolId: TOOL_ID, code: e.code || 'TASK_FAILED' })
      this.setData({ error: { code: e.code || 'TASK_FAILED', message: error.message(e.code || 'TASK_FAILED') }, busy: false })
    }
  },

  onMoreRows() {
    const shown = this.data.rowsShown
    const next = this._allRows.slice(shown, shown + PAGE_SIZE)
    if (!next.length) return
    this.setData({ rows: this.data.rows.concat(next), rowsShown: shown + next.length })
  },

  buildCsv() {
    const lines = ['期数,月供,本金,利息,剩余本金']
    this._allRows.forEach(function (r) {
      lines.push(r.i + ',' + r.payment + ',' + r.principalPart + ',' + r.interest + ',' + r.remain)
    })
    return lines.join('\n')
  },

  onCopy(e) {
    const withSchedule = e && e.currentTarget && e.currentTarget.dataset.withSchedule === '1'
    const text = withSchedule ? this.buildCsv() : (this.data.result && this.data.result.text) || ''
    if (!text) return
    wx.setClipboardData({
      data: text,
      success: function () {
        wx.showToast({ title: '已复制', icon: 'success' })
        track.track('result_copy', { toolId: TOOL_ID, schedule: !!withSchedule })
      }
    })
  },

  onSample(e) {
    const idx = Number(e.currentTarget.dataset.index)
    const values = Object.assign(defaults(), this.data.samples[idx].v)
    this.setData({ values: values, result: null, rows: [], rowsShown: 0, rowsTotal: 0, error: null })
    this.onRun()
  },

  onShareAppMessage() {
    return { title: '房贷计算 · 等额本息/等额本金明细', path: '/packageCalc/pages/loan/index?from=share' }
  }
})
