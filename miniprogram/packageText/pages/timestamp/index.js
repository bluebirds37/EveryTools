const registry = require('../../../tools/registry')
const store = require('../../../utils/store')
const track = require('../../../utils/track')
const error = require('../../../utils/error')
const common = require('../../utils/common')

const TOOL_ID = 'text-timestamp'

const TIPS = [
  '自动识别 10 位（秒）与 13 位（毫秒）时间戳；输入日期文本则反向得到时间戳',
  '时区支持本地 / UTC / 固定偏移（-14 ~ +14 小时），跨时区结果与系统换算一致',
  '非法日期（如 2026-02-30）会明确报错而不是静默顺延',
  '「区间计算」开启后可对时间戳 ±N 天得到新日期'
]

const SAMPLES = [
  { name: '秒级 17e8', input: '1700000000', v: { tz: 'local', offset: 8, format: 'datetime', rangeCalc: false, rangeDays: 1 } },
  { name: '毫秒 13 位', input: '1755052800123', v: { tz: 'utc', offset: 8, format: 'datetime', rangeCalc: false, rangeDays: 1 } },
  { name: '日期转戳', input: '2026-10-13 18:00:00', v: { tz: 'local', offset: 8, format: 'datetime', rangeCalc: false, rangeDays: 1 } },
  { name: '+30 天', input: '1700000000', v: { tz: 'local', offset: 8, format: 'date', rangeCalc: true, rangeDays: 30 } }
]

function defaults() {
  return { tz: 'local', offset: 8, format: 'datetime', rangeCalc: false, rangeDays: 1 }
}

const DAY_MS = 86400000
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

function pad(n, w) {
  return String(Math.abs(n)).padStart(w || 2, '0')
}

/** 判定输入类型：sec(10位)/ms(13位)/date(含 - : T 或斜杠日期)/empty/invalid */
function detectKind(raw) {
  const s = String(raw === null || raw === undefined ? '' : raw).trim()
  if (!s) return 'empty'
  if (/^-?\d{10}$/.test(s)) return 'sec'
  if (/^-?\d{13}$/.test(s)) return 'ms'
  if (/^-?\d+$/.test(s)) return 'invalid'
  if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}([ T]\d{1,2}:\d{1,2}(:\d{1,2})?(\.\d{1,3})?)?$/.test(s)) return 'date'
  return 'invalid'
}

/** 解析日期文本 → epoch ms；非法日期（2026-02-30）返回 { error } */
function parseDateText(raw) {
  const s = String(raw).trim().replace(/\//g, '-')
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?(?:\.(\d{1,3}))?)?$/.exec(s)
  if (!m) return { error: '无法识别的日期，支持 2026-10-13、2026-10-13 18:00:00 等格式' }
  const y = +m[1], mo = +m[2], d = +m[3]
  const h = m[4] ? +m[4] : 0, mi = m[5] ? +m[5] : 0, se = m[6] ? +m[6] : 0
  const ms = m[7] ? +String(m[7]).padEnd(3, '0') : 0
  if (mo < 1 || mo > 12) return { error: '月份需在 1–12 之间' }
  const probe = new Date(y, mo - 1, d, h, mi, se, ms)
  if (probe.getFullYear() !== y || probe.getMonth() !== mo - 1 || probe.getDate() !== d) {
    return { error: '非法日期：' + y + '-' + pad(mo) + '-' + pad(d) + ' 不存在（注意当月天数与闰年）' }
  }
  return { ms: probe.getTime() }
}

/** 取某时区下的年月日时分秒；tzMode: local | utc | offset(+offsetH) */
function partsOf(ms, tzMode, offsetH) {
  const d = tzMode === 'offset' ? new Date(ms + offsetH * 3600000) : new Date(ms)
  const useUtc = tzMode !== 'local'
  return {
    y: useUtc ? d.getUTCFullYear() : d.getFullYear(),
    mo: (useUtc ? d.getUTCMonth() : d.getMonth()) + 1,
    d: useUtc ? d.getUTCDate() : d.getDate(),
    h: useUtc ? d.getUTCHours() : d.getHours(),
    mi: useUtc ? d.getUTCMinutes() : d.getMinutes(),
    se: useUtc ? d.getUTCSeconds() : d.getSeconds(),
    ms: useUtc ? d.getUTCMilliseconds() : d.getMilliseconds(),
    day: useUtc ? d.getUTCDay() : d.getDay()
  }
}

function formatDate(ms, format, tzMode, offsetH) {
  const p = partsOf(ms, tzMode, offsetH)
  const date = p.y + '-' + pad(p.mo) + '-' + pad(p.d)
  const time = pad(p.h) + ':' + pad(p.mi) + ':' + pad(p.se)
  if (format === 'date') return date
  if (format === 'time') return time
  if (format === 'iso') {
    const zone = tzMode === 'utc' ? 'Z' : tzMode === 'local' ? tzLabel(ms) : (offsetH >= 0 ? '+' : '-') + pad(Math.floor(Math.abs(offsetH))) + ':' + pad(Math.round(Math.abs(offsetH) % 1 * 60))
    return date + 'T' + time + '.' + pad(p.ms, 3) + zone
  }
  return date + ' ' + time
}

function tzLabel(ms) {
  const off = -new Date(ms).getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const a = Math.abs(off)
  return 'UTC' + sign + pad(Math.floor(a / 60)) + ':' + pad(a % 60)
}

/** 相对时间：3 天前 / 2 小时后 */
function relativeTime(ms, nowMs) {
  const diff = nowMs - ms
  const abs = Math.abs(diff)
  const suffix = diff >= 0 ? '前' : '后'
  if (abs < 5000) return '刚刚'
  if (abs < 60000) return Math.floor(abs / 1000) + ' 秒' + suffix
  if (abs < 3600000) return Math.floor(abs / 60000) + ' 分钟' + suffix
  if (abs < DAY_MS) return Math.floor(abs / 3600000) + ' 小时' + suffix
  if (abs < DAY_MS * 30) return Math.floor(abs / DAY_MS) + ' 天' + suffix
  if (abs < DAY_MS * 365) return Math.floor(abs / (DAY_MS * 30.44)) + ' 个月' + suffix
  return Math.floor(abs / (DAY_MS * 365.25)) + ' 年' + suffix
}

Page({
  data: {
    tool: null,
    values: defaults(),
    input: '',
    schema: [],
    tips: TIPS,
    busy: false,
    result: null,
    error: null,
    samples: SAMPLES,
    clock: ''
  },

  onLoad(query) {
    const tool = registry.get(TOOL_ID)
    const values = Object.assign(defaults(), store.params(TOOL_ID) || {})
    this.setData({ tool: tool, values: values, input: values.__input || '', schema: this.buildSchema() })
    this.startClock()
    track.track('tool_open', { toolId: TOOL_ID, from: query.from || 'menu' })
  },

  onUnload() {
    if (this._timer) clearInterval(this._timer)
  },

  startClock() {
    this._tick = () => this.setData({ clock: formatDate(Date.now(), 'datetime', 'local') })
    this._tick()
    this._timer = setInterval(this._tick, 1000)
  },

  buildSchema() {
    return [
      { key: 'format', label: '显示格式', type: 'segment', def: 'datetime', options: [{ value: 'datetime', label: '日期时间' }, { value: 'date', label: '仅日期' }, { value: 'time', label: '仅时间' }, { value: 'iso', label: 'ISO' }] },
      { key: 'tz', label: '时区', type: 'segment', def: 'local', options: [{ value: 'local', label: '本地' }, { value: 'utc', label: 'UTC' }, { value: 'offset', label: '指定偏移' }] },
      { key: 'offset', label: '偏移小时', type: 'number', def: 8, min: -14, max: 14, step: 1, unit: 'h', showIf: { key: 'tz', in: ['offset'] } },
      { key: 'rangeCalc', label: '区间计算（±天）', type: 'switch', def: false },
      { key: 'rangeDays', label: '天数（可负）', type: 'number', def: 1, min: -36500, max: 36500, step: 1, unit: '天', showIf: { key: 'rangeCalc', in: [true] } }
    ]
  },

  onParamChange(e) {
    const values = Object.assign({}, this.data.values)
    values[e.detail.key] = e.detail.value
    this.setData({ values: values })
    this.remember(values)
    if (this.data.result) this.onRun()
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
        this.setData({ input: v.slice(0, 64) })
      },
      fail: () => wx.showToast({ title: '无法读取剪贴板', icon: 'none' })
    })
  },
  onClearInput() { this.setData({ input: '', result: null, error: null }) },
  onNow() { this.setData({ input: String(Date.now()), result: null, error: null }); this.onRun() },
  onTodayZero() {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    this.setData({ input: String(d.getTime()), result: null, error: null })
    this.onRun()
  },

  onSample(e) {
    const s = SAMPLES[Number(e.currentTarget.dataset.index)]
    if (!s) return
    const values = Object.assign(defaults(), s.v)
    this.setData({ input: s.input, values: values, result: null, error: null })
    this.remember(values)
    this.onRun()
  },

  onRun() {
    if (this.data.busy) return
    const v = this.data.values
    const emptyMsg = common.checkTextInput(this.data.input)
    if (emptyMsg) return this.setData({ error: { code: 'INPUT_EMPTY', message: error.message('INPUT_EMPTY', { reason: emptyMsg }) }, result: null })
    this.setData({ busy: true, error: null, result: null })
    track.track('tool_run_start', { toolId: TOOL_ID })
    const t0 = Date.now()
    try {
      const kind = detectKind(this.data.input)
      if (kind === 'invalid') {
        const e = new Error('参数错误：无法识别的输入，支持 10/13 位时间戳或 2026-10-13 18:00:00 形式日期')
        e.code = 'PARAM_INVALID'
        throw e
      }
      let ms
      if (kind === 'sec') ms = Number(String(this.data.input).trim()) * 1000
      else if (kind === 'ms') ms = Number(String(this.data.input).trim())
      else {
        const p = parseDateText(this.data.input)
        if (p.error) { const e = new Error('参数错误：' + p.error); e.code = 'PARAM_INVALID'; throw e }
        ms = p.ms
      }
      if (!isFinite(ms) || Math.abs(ms) > 8.64e15) {
        const e = new Error('参数错误：时间超出可表示范围（公元 1900–9999 附近）')
        e.code = 'PARAM_INVALID'
        throw e
      }
      const off = Number(v.offset) || 0
      const tzMode = v.tz === 'offset' ? 'offset' : v.tz
      const main = formatDate(ms, v.format, tzMode, off)
      const rows = [
        { key: '秒级时间戳', value: String(Math.floor(ms / 1000)) },
        { key: '毫秒时间戳', value: String(ms) },
        { key: tzMode === 'local' ? '本地时间（' + tzLabel(ms) + '）' : tzMode === 'utc' ? 'UTC 时间' : '偏移 UTC' + (off >= 0 ? '+' : '') + off + ' 时间', value: main },
        { key: '另一时区', value: formatDate(ms, 'datetime', tzMode === 'utc' ? 'local' : 'utc', off) },
        { key: '星期', value: WEEKDAYS[partsOf(ms, tzMode, off).day] },
        { key: '相对时间', value: relativeTime(ms, Date.now()) }
      ]
      let text = '秒：' + rows[0].value + '\n毫秒：' + rows[1].value + '\n' + main
      if (v.rangeCalc) {
        const days = Number(v.rangeDays) || 0
        const target = ms + days * DAY_MS
        if (Math.abs(target) > 8.64e15) { const e = new Error('参数错误：加减后超出可表示范围'); e.code = 'PARAM_INVALID'; throw e }
        rows.push({ key: (days >= 0 ? '+' : '') + days + ' 天后', value: formatDate(target, 'datetime', tzMode, off) })
        text += '\n' + (days >= 0 ? '+' : '') + days + ' 天：' + formatDate(target, 'datetime', tzMode, off)
      }
      const result = {
        text: text,
        kv: rows,
        meta: (kind === 'date' ? '日期 → 时间戳' : kind === 'sec' ? '秒 → 日期' : '毫秒 → 日期') + ' · ' + (Date.now() - t0) + 'ms · 端'
      }
      track.track('tool_run_success', { toolId: TOOL_ID, costMs: Date.now() - t0, engine: 'client' })
      this.setData({ result: result, busy: false })
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
    return { title: '时间戳 · 秒/毫秒与日期双向转换', path: '/packageText/pages/timestamp/index?toolId=' + TOOL_ID + '&from=share' }
  }
})

module.exports = { detectKind: detectKind, parseDateText: parseDateText, formatDate: formatDate, relativeTime: relativeTime, partsOf: partsOf }
