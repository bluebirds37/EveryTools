const registry = require('../../../tools/registry')
const store = require('../../../utils/store')
const track = require('../../../utils/track')
const error = require('../../../utils/error')
const fin = require('../../utils/fin')

const TOOL_ID = 'calc-tax'

const SPECIALS = [
  { key: 'child', label: '子女教育(月)', hint: '2000 元/孩' },
  { key: 'edu', label: '继续教育(月)', hint: '300 元' },
  { key: 'homeLoan', label: '住房贷款利息(月)', hint: '1000 元' },
  { key: 'rent', label: '住房租金(月)', hint: '800/1100/1500 元' },
  { key: 'elderly', label: '赡养老人(月)', hint: '3000 元' },
  { key: 'infant', label: '3岁以下婴幼儿(月)', hint: '2000 元/孩' }
]

function defaults() {
  return { mode: 'salary', income: 20000, social: 2000, fund: 2200, child: 0, edu: 0, homeLoan: 1000, rent: 0, elderly: 0, infant: 0, taxableOther: 0, bonus: 36000 }
}

function buildSchema() {
  const schema = [
    { key: 'mode', label: '计算模式', type: 'segment', def: 'salary', options: [{ value: 'salary', label: '工资逐月预扣' }, { value: 'bonus', label: '年终奖方案对比' }] },
    { key: 'income', label: '月收入(元)', type: 'number', def: 20000, min: 0, max: 10000000, showIf: { key: 'mode', in: ['salary'] } },
    { key: 'social', label: '社保个人部分(月)', type: 'number', def: 2000, min: 0, max: 100000, showIf: { key: 'mode', in: ['salary'] } },
    { key: 'fund', label: '公积金个人部分(月)', type: 'number', def: 2200, min: 0, max: 100000, showIf: { key: 'mode', in: ['salary'] } }
  ]
  SPECIALS.forEach(function (s) {
    schema.push({ key: s.key, label: s.label, type: 'number', def: 0, min: 0, max: 100000, showIf: { key: 'mode', in: ['salary'] } })
  })
  schema.push({ key: 'taxableOther', label: '全年应税所得·不含奖金(元)', type: 'number', def: 0, min: 0, max: 20000000, showIf: { key: 'mode', in: ['bonus'] } })
  schema.push({ key: 'bonus', label: '年终奖金额(元)', type: 'number', def: 36000, min: 0, max: 20000000, showIf: { key: 'mode', in: ['bonus'] } })
  return schema
}

function validate(v) {
  if (Number(v.income) < 0 || Number(v.income) > 1e7) return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { reason: '月收入需在 0 ~ 1000 万元之间' }) }
  if (Number(v.bonus) < 0 || Number(v.bonus) > 2e7) return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { reason: '年终奖需在 0 ~ 2000 万元之间' }) }
  if (Number(v.taxableOther) < 0 || Number(v.taxableOther) > 2e7) return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { reason: '全年应税所得需在 0 ~ 2000 万元之间' }) }
  if (v.mode === 'salary') {
    for (let k = 0; k < SPECIALS.length; k++) {
      const x = Number(v[SPECIALS[k].key])
      if (!(x >= 0 && x <= 1e5)) return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { reason: SPECIALS[k].label.replace('(月)', '') + '扣除需在 0 ~ 10 万元之间' }) }
    }
  }
  if (v.mode === 'bonus' && Number(v.bonus) <= 0) {
    return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { reason: '年终奖金额需大于 0' }) }
  }
  return null
}

function run(v) {
  if (v.mode === 'bonus') {
    const c = fin.bonusCompare(Number(v.bonus), Number(v.taxableOther))
    const kv = [
      { key: '单独计税税额', value: fin.fmtMoney(c.separateTax) + ' 元（按 ' + (c.separateRate * 100).toFixed(0) + '% 档）' },
      { key: '并入综合所得增加税额', value: fin.fmtMoney(c.combinedExtraTax) + ' 元' },
      { key: '方案建议', value: c.advice },
      { key: '注意', value: '年终奖单独计税政策现行有效期内；发放额接近 36000/144000/300000 等临界点时会跳档（如 36001 元比 36000 元多缴约 2310 元）' }
    ]
    return { kv: kv, text: kv.map(function (x) { return x.key + ': ' + x.value }).join('\n'), meta: '税率表版本 ' + fin.TAX_TABLE_VERSION }
  }
  const specialTotal = SPECIALS.reduce(function (s, x) { return s + Number(v[x.key] || 0) }, 0)
  const w = fin.withholdingSchedule({
    monthlyIncome: Number(v.income),
    social: Number(v.social),
    housingFund: Number(v.fund),
    specialTotal: specialTotal,
    months: 12
  })
  const rows = w.rows.map(function (r) {
    return {
      month: r.month + ' 月',
      taxableCum: fin.fmtMoney(r.taxableCum),
      rate: (r.rate * 100).toFixed(0) + '%',
      taxMonth: fin.fmtMoney(r.taxMonth),
      taxCum: fin.fmtMoney(r.taxCum)
    }
  })
  const kv = [
    { key: '每月减除费用', value: '5000 元 + 社保 ' + fin.fmtMoney(v.social) + ' + 公积金 ' + fin.fmtMoney(v.fund) + ' + 专项附加 ' + fin.fmtMoney(specialTotal) },
    { key: '12 月累计预扣税额', value: fin.fmtMoney(w.yearTax) + ' 元' },
    { key: '最高预扣档位', value: (Math.max.apply(null, w.rows.map(function (r) { return r.rate })) * 100).toFixed(0) + '%' },
    { key: '算法', value: '累计预扣预缴：逐月累计应税所得 → 套年度税率表 → 减已预扣税额' }
  ]
  const text = kv.map(function (x) { return x.key + ': ' + x.value }).join('\n') +
    '\n\n月份,累计应税,税率,当月预扣,累计预扣\n' +
    w.rows.map(function (r) { return [r.month, r.taxableCum, r.rate, r.taxMonth, r.taxCum].join(', ') }).join('\n')
  return { kv: kv, rows: rows, text: text, meta: '税率表版本 ' + fin.TAX_TABLE_VERSION }
}

Page({
  data: {
    tool: null,
    values: defaults(),
    schema: buildSchema(),
    busy: false,
    result: null,
    rows: [],
    error: null,
    tableVersion: fin.TAX_TABLE_VERSION,
    tips: [
      '内置中国个税 7 级年度税率表（版本号 ' + fin.TAX_TABLE_VERSION + '，支持后端下发更新覆盖）',
      '工资模式按「累计预扣预缴」逐月计算：累计应税所得 = 累计收入 − 累计(5000+三险一金+专项附加)',
      '年终奖模式给出「单独计税 vs 并入综合所得」对比与更省方案；单独计税按月换算税率表（bonus÷12 找档、全额计税）',
      '专项附加扣除月标准参考：子女教育 2000/孩、继续教育 300、住房贷款 1000、租金 800–1500、赡养老人 3000、婴幼儿 2000/孩',
      '输入越界（负数或超大）会被拒绝并提示'
    ],
    samples: [
      { name: '月薪2万含贷1000', v: { mode: 'salary', income: 20000, social: 2000, fund: 2200, homeLoan: 1000 } },
      { name: '月薪5万高收入', v: { mode: 'salary', income: 50000, social: 4000, fund: 4500, child: 2000, elderly: 1500 } },
      { name: '年终奖36000临界点', v: { mode: 'bonus', taxableOther: 100000, bonus: 36000 } }
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
    if (this.data.result) this.setData({ result: null, rows: [] })
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
      this.setData({ result: result, rows: result.rows || [], busy: false })
    } catch (e) {
      track.track('tool_run_fail', { toolId: TOOL_ID, code: e.code || 'TASK_FAILED' })
      this.setData({ error: { code: e.code || 'TASK_FAILED', message: error.message(e.code || 'TASK_FAILED') }, busy: false })
    }
  },

  onSample(e) {
    const idx = Number(e.currentTarget.dataset.index)
    const values = Object.assign(defaults(), this.data.samples[idx].v)
    this.setData({ values: values, result: null, rows: [], error: null })
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
    return { title: '个税计算 · 累计预扣与年终奖对比', path: '/packageCalc/pages/tax/index?from=share' }
  }
})
