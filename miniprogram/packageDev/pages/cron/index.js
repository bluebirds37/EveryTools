const registry = require('../../../tools/registry')
const store = require('../../../utils/store')
const track = require('../../../utils/track')
const error = require('../../../utils/error')
const cron = require('../../utils/cron')

const TOOL_ID = 'dev-cron'

const ZONES = [
  { value: 'local', label: '本机时区' },
  { value: 'utc', label: 'UTC' },
  { value: 'e8', label: 'UTC+8' },
  { value: 'e0', label: 'UTC+0' }
]

function defaults() {
  return { expr: '0 30 2 * * MON-FRI', zone: 'local', count: 5 }
}

function buildSchema() {
  return [
    { key: 'expr', label: 'Cron 表达式', type: 'textarea', def: defaults().expr, rows: 3, placeholder: '分 时 日 月 周（6 段含秒，7 段含年）', hint: '支持 * ? 列表 区间 步长 月份名 星期名 L #，以及 @daily / @weekly 等宏' },
    { key: 'zone', label: '推算时区', type: 'segment', def: 'local', options: ZONES, hint: '固定偏移时区不含夏令时；「本机时区」跟随系统设置' },
    { key: 'count', label: '推算次数', type: 'slider', def: 5, min: 1, max: 20, step: 1, unit: ' 次' }
  ]
}

function pickZone(kind) {
  if (kind === 'utc') return cron.fixedZone(0, 'UTC')
  if (kind === 'e8') return cron.fixedZone(480, 'UTC+08:00')
  if (kind === 'e0') return cron.fixedZone(0, 'UTC+00:00')
  return cron.localZone()
}

function pad(n) {
  return (n < 10 ? '0' : '') + n
}

function stampIn(zone, ms) {
  const p = zone.parts(ms)
  return p.y + '-' + pad(p.mo) + '-' + pad(p.d) + ' ' + pad(p.h) + ':' + pad(p.mi)
}

function validate(v) {
  const expr = String(v.expr || '').trim()
  if (!expr) return { code: 'INPUT_EMPTY', message: error.message('INPUT_EMPTY') }
  const count = Number(v.count)
  if (!isFinite(count) || count < 1 || count > 20) return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { field: '推算次数', range: '1–20' }) }
  // cron.parse 对非法段是 **throw**（Error 上带 code/reason/token），不是返回 {ok:false}
  try {
    cron.parse(expr)
  } catch (e) {
    return {
      code: 'PARAM_INVALID',
      message: error.message('PARAM_INVALID', { field: '第 ' + (e.fieldIndex || 1) + ' 段「' + (e.token || '') + '」', reason: e.reason || '' })
    }
  }
  return null
}

function run(v, nowMs) {
  // parse() 返回的就是 spec 本身（{expr, style, fields, dayMode}），没有 .spec 这层
  const spec = cron.parse(String(v.expr).trim())
  const zone = pickZone(v.zone)
  const from = typeof nowMs === 'number' ? nowMs : Date.now()
  const res = cron.nextRuns(spec, { zone: zone, fromMs: from, count: Number(v.count) || 5 })
  const summary = cron.summarize(spec)
  const rows = cron.fieldRows(spec)
  const lines = []
  lines.push('表达式：' + spec.expr)
  lines.push('描述：' + summary)
  lines.push('时区：' + zone.label)
  lines.push('')
  lines.push('字段说明：')
  rows.forEach(function (r) {
    lines.push('  ' + r.label + ' [' + r.raw + '] → ' + r.meaning)
  })
  lines.push('')
  lines.push('接下来 ' + res.runs.length + ' 次触发：')
  res.runs.forEach(function (r, i) {
    lines.push('  ' + (i + 1) + '. ' + r.text + ' ' + r.weekday)
  })
  if (res.note) {
    lines.push('')
    lines.push('提示：' + res.note)
  }
  return {
    summary: summary,
    rows: rows,
    runs: res.runs,
    note: res.note,
    zoneLabel: zone.label,
    fromText: stampIn(zone, from),
    expr: spec.expr,
    engineUsed: 'client',
    text: lines.join('\n'),
    meta: ''
  }
}

Page({
  data: {
    tool: null,
    values: defaults(),
    schema: buildSchema(),
    busy: false,
    result: null,
    error: null,
    actions: [
      { toolId: 'text-timestamp', label: '时间戳换算' },
      { toolId: 'calc-date', label: '日期计算' }
    ],
    tips: [
      '段数：5 段=分 时 日 月 周；6 段=秒 + 上述；7 段=再加年。语义对齐 crontab.guru（Vixie cron）',
      '「日」与「星期」同时受限时：5 段按并集（任一命中即触发），6/7 段按交集（Quartz 习惯，通常其中一段写 ?）',
      '扩展写法：日字段 L=当月最后一天；星期字段 5L=当月最后一个周五、5#2=第二个周五；月份/星期可用英文缩写',
      '固定偏移时区（UTC/UTC+8）按分钟偏移计算，不含夏令时；「本机时区」走系统时区，夏令时由系统处理',
      '永不命中的表达式（如 2 月 30 日）会在 50 年搜索上限后给出提示，不会一直转圈'
    ],
    samples: [
      { name: '工作日 09:30', v: { expr: '30 9 * * MON-FRI' } },
      { name: '每 15 分钟', v: { expr: '*/15 * * * *' } },
      { name: '每月最后一天 02:00', v: { expr: '0 0 L * *' } },
      { name: '闰年 2 月 29 日', v: { expr: '0 0 29 2 *' } },
      { name: '每秒轮询（6 段）', v: { expr: '*/10 * * * * *' } },
      { name: '@weekly 宏', v: { expr: '@weekly' } }
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
    track.track('tool_run_start', { toolId: TOOL_ID })
    const t0 = Date.now()
    try {
      const result = run(v)
      result.meta = '耗时 ' + Math.max(1, Date.now() - t0) + ' ms · ' + result.runs.length + ' 次触发 · ' + result.zoneLabel
      track.track('tool_run_success', { toolId: TOOL_ID, costMs: Date.now() - t0, engine: result.engineUsed })
      this.setData({ result: result, busy: false })
    } catch (e) {
      track.track('tool_run_fail', { toolId: TOOL_ID, code: e.code || 'TASK_FAILED' })
      this.setData({ error: { code: e.code || 'TASK_FAILED', message: error.message(e.code || 'TASK_FAILED', e.extra) }, busy: false })
    }
  },

  onSample(e) {
    const idx = Number(e.currentTarget.dataset.index)
    const values = Object.assign({}, this.data.values, this.data.samples[idx].v)
    this.setData({ values: values, result: null, error: null })
    store.saveParams(TOOL_ID, values)
    this.onRun()
  },

  copy(text, done) {
    if (!text) return
    wx.setClipboardData({
      data: text,
      success: function () {
        wx.showToast({ title: '已复制', icon: 'success' })
        track.track('result_copy', { toolId: TOOL_ID })
        if (done) done()
      }
    })
  },

  onCopy(e) {
    this.copy((e.detail && e.detail.text) || (this.data.result && this.data.result.text) || '')
  },

  onCopyRun(e) {
    this.copy(e.currentTarget.dataset.text || '')
  },

  onAction(e) {
    const id = e.detail && e.detail.toolId
    if (id) track.openTool(id, 'dev-cron')
  },

  onShareAppMessage() {
    return { title: 'Cron 表达式 · 解析与下次触发推算', path: '/packageDev/pages/cron/index?toolId=' + TOOL_ID + '&from=share' }
  }
})
