const registry = require('../../../tools/registry')
const store = require('../../../utils/store')
const track = require('../../../utils/track')
const error = require('../../../utils/error')
const cal = require('../../utils/calendar')

const TOOL_ID = 'calc-date'

const MODES = [
  { value: 'interval', label: '间隔' },
  { value: 'add', label: '加减' },
  { value: 'countdown', label: '倒数日' },
  { value: 'workday', label: '工作日' },
  { value: 'week', label: '周次季度' }
]

function defaults() {
  const today = cal.todayStr()
  return {
    mode: 'interval',
    dateA: today, dateB: today,
    addBase: today, delta: 30, deltaUnit: 'day',
    target: today, repeat: false,
    start: today, end: today, useHolidays: true,
    isoDate: today
  }
}

// param-form 只负责模式/单位/开关（日期用原生 picker）
function buildSchema() {
  return [
    { key: 'mode', label: '模式', type: 'segment', def: 'interval', options: MODES },
    { key: 'deltaUnit', label: '增减单位', type: 'segment', def: 'day', options: [{ value: 'day', label: '天' }, { value: 'week', label: '周' }, { value: 'month', label: '月' }, { value: 'year', label: '年' }], showIf: { key: 'mode', in: ['add'] } },
    { key: 'repeat', label: '每年重复', type: 'switch', def: false, showIf: { key: 'mode', in: ['countdown'] } },
    { key: 'useHolidays', label: '排除法定节假日(含调休)', type: 'switch', def: true, showIf: { key: 'mode', in: ['workday'] } }
  ]
}

function isDateStr(s) {
  return cal.validDate(s) !== null
}

function validate(v) {
  switch (v.mode) {
    case 'interval':
      if (!isDateStr(v.dateA) || !isDateStr(v.dateB)) return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { reason: '日期需为有效 YYYY-MM-DD（如 2026-02-30 非法）' }) }
      return null
    case 'add':
      if (!isDateStr(v.addBase)) return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { reason: '基准日期无效' }) }
      if (!isFinite(Number(v.delta))) return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { reason: '增减量需为数字' }) }
      return null
    case 'countdown':
      if (!isDateStr(v.target)) return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { reason: '目标日期无效' }) }
      return null
    case 'workday':
      if (!isDateStr(v.start) || !isDateStr(v.end)) return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { reason: '起止日期无效' }) }
      return null
    case 'week':
      if (!isDateStr(v.isoDate)) return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { reason: '查询日期无效' }) }
      return null
    default:
      return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { reason: '未知模式' }) }
  }
}

function run(v) {
  if (v.mode === 'interval') {
    const d = cal.diffDates(v.dateA, v.dateB)
    const lA = cal.solarToLunar(v.dateA)
    const lB = cal.solarToLunar(v.dateB)
    const kv = [
      { key: '相差', value: d.ymdText },
      { key: '总天数', value: d.totalDays + ' 天' },
      { key: '总周数', value: d.totalWeeks + ' 周' + (d.weeksRemain ? ' 余 ' + d.weeksRemain + ' 天' : '') }
    ]
    if (lA) kv.push({ key: '开始日农历', value: lA.text })
    if (lB) kv.push({ key: '结束日农历', value: lB.text })
    return { kv: kv, text: kv.map(function (x) { return x.key + ': ' + x.value }).join('\n'), meta: '间隔（含头不含尾，B−A 日序差）' }
  }
  if (v.mode === 'add') {
    const r = cal.addDate(v.addBase, v.delta, v.deltaUnit)
    const l = cal.solarToLunar(r.date)
    const kv = [
      { key: '结果日期', value: r.date },
      { key: '星期', value: '星期' + '日一二三四五六'.charAt(cal.weekdayOf(r.date)) },
      { key: '月末回退', value: r.adjusted ? '已触发' : '未触发' },
      { key: '策略说明', value: r.note }
    ]
    if (l) kv.push({ key: '农历', value: l.text })
    return { kv: kv, text: r.date + '（' + r.note + '）', meta: '日期加减 · 月末回退策略' }
  }
  if (v.mode === 'countdown') {
    const c = cal.countdown(v.target, null, !!v.repeat)
    const kv = [{ key: '状态', value: c.status === 'today' ? '今天' : c.status === 'remaining' ? '还有' : '已过去' }, { key: '结果', value: c.text }]
    if (c.nextDate) kv.push({ key: '下次日期', value: c.nextDate })
    return { kv: kv, text: c.text, meta: '倒数日（以今天为基准）' }
  }
  if (v.mode === 'workday') {
    const w = cal.workdaysBetween(v.start, v.end, !!v.useHolidays)
    const kv = [
      { key: '总天数', value: w.totalDays + ' 天' },
      { key: '工作日', value: w.workdays + ' 天' },
      { key: '休息日', value: w.restdays + ' 天' }
    ]
    if (v.useHolidays) {
      kv.push({ key: '法定假日扣减', value: w.holidayExcluded + ' 天' })
      kv.push({ key: '调休补班计入', value: w.makeUpWorked + ' 天' })
    }
    kv.push({ key: '数据说明', value: w.dataNote })
    return { kv: kv, text: v.start + ' ~ ' + v.end + '：工作日 ' + w.workdays + ' 天，休息 ' + w.restdays + ' 天', meta: '工作日统计' }
  }
  const wk = cal.weekInfo(v.isoDate)
  const l = cal.solarToLunar(v.isoDate)
  const kv = [
    { key: 'ISO 周次', value: wk.isoLabel + '（' + wk.isoYear + ' 年第 ' + wk.isoWeek + ' 周）' },
    { key: '年中第几周', value: '第 ' + wk.weekOfYear + ' 周（周日起始）' },
    { key: '星期', value: wk.weekday },
    { key: '季度', value: wk.quarter + '（' + wk.quarterRange + '）' },
    { key: '本周区间', value: wk.weekStart + ' ~ ' + wk.weekEnd },
    { key: '年内天数', value: wk.dayOfYear + ' / ' + wk.daysInYear }
  ]
  if (l) kv.push({ key: '农历', value: l.text })
  return { kv: kv, text: 'ISO ' + wk.isoLabel + ' · ' + wk.quarter, meta: '周次与季度' }
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
      '间隔：总天数 = 结束 − 开始 的日序差（含头不含尾），并给 X年X月X天 与总周数',
      '加减：单位选月/年时，目标月无该日号按「月末回退」取当月末，并在结果中显式提示',
      '闰日规则：2024-02-29 + 1 年 = 2025-02-28；倒数日每年重复时 2/29 平年钳制为 2/28',
      '工作日：内置中国法定节假日表（2025–2026，依据国务院通知整理），调休补班日计为工作日，可切换为仅排除周末',
      '农历支持 1901–2100（本地数据表，无网络依赖）；非法日期（如 2/30）会被拒绝'
    ],
    samples: [
      { name: '闰日加减', v: { mode: 'add', addBase: '2024-02-29', delta: 1, deltaUnit: 'year' } },
      { name: '全年间隔', v: { mode: 'interval', dateA: '2026-01-01', dateB: '2026-12-31' } },
      { name: '国庆月工作日', v: { mode: 'workday', start: '2026-10-01', end: '2026-10-31', useHolidays: true } }
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

  onDateChange(e) {
    const key = e.currentTarget.dataset.key
    const values = Object.assign({}, this.data.values)
    values[key] = e.detail.value
    this.setData({ values: values })
    store.saveParams(TOOL_ID, values)
    if (this.data.result) this.setData({ result: null })
  },

  onDeltaInput(e) {
    const values = Object.assign({}, this.data.values, { delta: e.detail.value })
    this.setData({ values: values })
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
    return { title: '日期计算 · 间隔/倒数/工作日/周次', path: '/packageCalc/pages/date/index?from=share' }
  }
})
