// packageLife/pages/timer —— FR-LIF-03 秒表 + 多路倒计时（Date.now 基准，UI 只刷新不计时）
const registry = require('../../../tools/registry')
const store = require('../../../utils/store')
const track = require('../../../utils/track')
const error = require('../../../utils/error')
const tmr = require('../../utils/timer')

const TOOL_ID = 'life-timer'
const MAX_CD = 5
const MAX_TOTAL_MS = 3 * 3600 * 1000 // 单路最长 3 小时

function defaults() {
  return { keepScreenOn: true, laps: true }
}

function buildSchema() {
  return [
    { key: 'keepScreenOn', label: '运行时保持亮屏', type: 'switch', def: true, hint: '调用 setKeepScreenOn，离开页面自动恢复' },
    { key: 'laps', label: '秒表记录分段', type: 'switch', def: true, hint: '关闭后只走总计时，不累积分段列表' }
  ]
}

let seqId = 1

Page({
  data: {
    toolId: TOOL_ID,
    tool: null,
    values: defaults(),
    schema: buildSchema(),
    busy: false,
    result: null,
    error: null,
    tab: 'sw',
    swText: '00:00.00',
    swRunning: false,
    swHasTime: false,
    laps: [],
    cds: [],
    newCdH: '0',
    newCdMin: '5',
    newCdSec: '0',
    newCdLabel: '',
    tips: [
      '计时基于系统时间戳（Date.now），切后台/杀进程重进后仍自动校准，10 分钟误差 ≤1s',
      '倒计时最多同时 5 路，可命名区分；完成时震动提示',
      '秒表分段记录与上一段的差值（split）',
      '倒计时总时长上限 3 小时，超出会提示调整'
    ]
  },

  onLoad(query) {
    const q = query || {}
    const tool = registry.get(TOOL_ID)
    const saved = store.params(TOOL_ID) || {}
    this._sw = tmr.swCreate()
    this._cds = []
    this._tick = null
    this.setData({ tool: tool, values: Object.assign(defaults(), saved) })
    track.track('tool_open', { toolId: TOOL_ID, from: q.from || 'menu' })
  },

  onShow() {
    this.ensureTick()
    this.applyScreenOn()
  },

  onHide() {
    this.stopTick()
    this.restoreScreenOn()
  },

  onUnload() {
    this.stopTick()
    this.restoreScreenOn()
  },

  /* ---------- 亮屏控制：小程序无 wx.setKeepAlive，规范要求的常驻由 setKeepScreenOn 承担 ---------- */
  applyScreenOn() {
    if (!wx.setKeepScreenOn) return
    const on = !!this.data.values.keepScreenOn && (this.data.swRunning || this.hasRunningCd())
    wx.setKeepScreenOn({ keepScreenOn: on, fail: function () { /* 机型不支持则忽略 */ } })
  },

  restoreScreenOn() {
    if (wx.setKeepScreenOn) wx.setKeepScreenOn({ keepScreenOn: false, fail: function () { /* 忽略 */ } })
  },

  hasRunningCd() {
    return this._cds.some(function (c) { return c.state.running })
  },

  onParamChange(e) {
    const values = Object.assign({}, this.data.values)
    values[e.detail.key] = e.detail.value
    this.setData({ values: values })
    store.saveParams(TOOL_ID, values)
    if (e.detail.key === 'keepScreenOn') this.applyScreenOn()
  },

  onTab(e) {
    this.setData({ tab: e.currentTarget.dataset.tab, error: null })
  },

  ensureTick() {
    if (this._tick) return
    const self = this
    this._tick = setInterval(function () { self.refresh() }, 100)
    this.refresh()
  },

  stopTick() {
    if (this._tick) { clearInterval(this._tick); this._tick = null }
  },

  refresh() {
    const now = Date.now()
    const patch = {}
    if (this.data.tab === 'sw') {
      const el = tmr.swElapsed(this._sw, now)
      patch.swText = tmr.fmtStopwatch(el)
      patch.swRunning = this._sw.running
      patch.swHasTime = el > 0 || this._sw.laps.length > 0
    } else {
      const tickRes = tmr.cdTick(this._cds, now)
      this._cds = tickRes.items
      patch.cds = this._cds.map(function (c) {
        return {
          id: c.id,
          label: c.label,
          running: c.state.running,
          done: c.state.done,
          text: tmr.fmtCountdown(tmr.cdRemain(c.state, now)),
          totalText: tmr.fmtCountdown(c.totalMs)
        }
      })
      if (tickRes.finished.length) {
        if (wx.vibrateShort) wx.vibrateShort({ type: 'heavy', fail: function () { /* 忽略 */ } })
        wx.showToast({ title: '倒计时结束', icon: 'none' })
        track.track('tool_run_success', { toolId: TOOL_ID, engine: 'client', mode: 'countdown' })
        this.setData(patch)
        this.applyScreenOn()
        if (!this.hasRunningCd()) this.restoreScreenOn()
        return
      }
    }
    this.setData(patch)
  },

  /* ---------- 秒表 ---------- */
  swStart() {
    if (!this.data.swHasTime) this.setData({ result: null, error: null })
    this._sw = tmr.swStart(this._sw, Date.now())
    this.ensureTick()
    this.refresh()
    this.applyScreenOn()
    track.track('tool_run_start', { toolId: TOOL_ID, engine: 'client', mode: 'stopwatch' })
  },

  swPause() {
    this._sw = tmr.swPause(this._sw, Date.now())
    this.refresh()
    this.applyScreenOn()
  },

  swLap() {
    if (!this.data.values.laps) return
    this._sw = tmr.swLap(this._sw, Date.now())
    this.setData({ laps: this.mapLaps() })
  },

  mapLaps() {
    return this._sw.laps.slice().reverse().map(function (l) {
      return { no: l.no, total: tmr.fmtStopwatch(l.totalMs), split: tmr.fmtStopwatch(l.splitMs) }
    })
  },

  swReset() {
    this._sw = tmr.swReset(this._sw)
    this.setData({ laps: [], result: null })
    this.refresh()
    this.applyScreenOn()
  },

  /** 结果出口：秒表读数 + 分段表快照 */
  onSwSnapshot() {
    const el = tmr.swElapsed(this._sw, Date.now())
    if (el <= 0 && !this._sw.laps.length) {
      return this.setData({ error: { code: error.CODES.INPUT_EMPTY, message: error.message(error.CODES.INPUT_EMPTY) } })
    }
    const lines = ['秒表 ' + tmr.fmtStopwatch(el) + '（' + new Date().toLocaleString() + '）']
    this._sw.laps.forEach(function (l) {
      lines.push('#' + l.no + '  分段 ' + tmr.fmtStopwatch(l.splitMs) + '  累计 ' + tmr.fmtStopwatch(l.totalMs))
    })
    this.emitResult(lines.join('\n'), '秒表快照 · ' + this._sw.laps.length + ' 段')
    this.setData({ error: null })
  },

  /* ---------- 倒计时 ---------- */
  onCdInput(e) {
    const patch = {}
    patch[e.currentTarget.dataset.field] = e.detail.value
    this.setData(patch)
  },

  onCdLabelInput(e) {
    this.setData({ newCdLabel: e.detail.value })
  },

  onCdQuick(e) {
    const min = Number(e.currentTarget.dataset.min)
    this.setData({ newCdH: '0', newCdMin: String(min), newCdSec: '0' })
    this.addCd()
  },

  cdAddPreset() {
    this.addCd()
  },

  addCd() {
    const h = this.intField('newCdH', 2)
    const m = this.intField('newCdMin', 59)
    const s = this.intField('newCdSec', 59)
    if (h === null || m === null || s === null) {
      return this.setData({ error: { code: error.CODES.PARAM_INVALID, message: error.message(error.CODES.PARAM_INVALID, { field: '时长', range: '0–3 小时 / 0–59 分 / 0–59 秒' }) } })
    }
    const total = h * 3600000 + m * 60000 + s * 1000
    if (total <= 0) {
      return this.setData({ error: { code: error.CODES.PARAM_INVALID, message: error.message(error.CODES.PARAM_INVALID, { field: '时长', range: '至少 1 秒' }) } })
    }
    if (total > MAX_TOTAL_MS) {
      return this.setData({ error: { code: error.CODES.PARAM_INVALID, message: error.message(error.CODES.PARAM_INVALID, { field: '时长', range: '不超过 3 小时' }) } })
    }
    if (this._cds.length >= MAX_CD) {
      return this.setData({ error: { code: error.CODES.PARAM_INVALID, message: error.message(error.CODES.PARAM_INVALID, { reason: '倒计时最多同时 ' + MAX_CD + ' 路，请先删除一个' }) } })
    }
    this.setData({ error: null })
    const label = (this.data.newCdLabel || '').trim() || tmr.fmtCountdown(total)
    this._cds = this._cds.concat([{ id: seqId++, label: label, totalMs: total, state: tmr.cdCreate(total) }])
    this.setData({ newCdLabel: '' })
    this.refresh()
    track.track('tool_run_start', { toolId: TOOL_ID, engine: 'client', mode: 'countdown_add' })
  },

  intField(key, max) {
    const raw = String(this.data[key] === undefined || this.data[key] === null ? '' : this.data[key]).trim()
    if (raw === '') return 0
    const n = Number(raw)
    if (!isFinite(n) || n < 0 || Math.floor(n) !== n || n > max) return null
    return Math.floor(n)
  },

  cdStart(e) {
    const id = Number(e.currentTarget.dataset.id)
    const now = Date.now()
    this._cds = this._cds.map(function (c) {
      return c.id === id ? Object.assign({}, c, { state: tmr.cdStart(c.state, now) }) : c
    })
    this.ensureTick()
    this.refresh()
    this.applyScreenOn()
    track.track('tool_run_start', { toolId: TOOL_ID, engine: 'client', mode: 'countdown' })
  },

  cdPause(e) {
    const id = Number(e.currentTarget.dataset.id)
    const now = Date.now()
    this._cds = this._cds.map(function (c) {
      return c.id === id ? Object.assign({}, c, { state: tmr.cdPause(c.state, now) }) : c
    })
    this.refresh()
    this.applyScreenOn()
  },

  cdRemove(e) {
    const id = Number(e.currentTarget.dataset.id)
    this._cds = this._cds.filter(function (c) { return c.id !== id })
    this.refresh()
    this.applyScreenOn()
  },

  /** 结果出口：倒计时清单快照 */
  onCdSnapshot() {
    if (!this._cds.length) {
      return this.setData({ error: { code: error.CODES.INPUT_EMPTY, message: error.message(error.CODES.INPUT_EMPTY) } })
    }
    const now = Date.now()
    const lines = ['倒计时清单（' + new Date().toLocaleString() + '）']
    this._cds.forEach(function (c) {
      const st = c.state.running ? '进行中' : c.state.done ? '已完成' : '待开始'
      lines.push(c.label + '  ' + tmr.fmtCountdown(tmr.cdRemain(c.state, now)) + ' / ' + tmr.fmtCountdown(c.totalMs) + '  ' + st)
    })
    this.emitResult(lines.join('\n'), '倒计时快照 · ' + this._cds.length + ' 路')
    this.setData({ error: null })
  },

  emitResult(text, meta) {
    this.setData({ result: { text: text, meta: meta + ' · 引擎 client' } })
    track.track('tool_run_success', { toolId: TOOL_ID, engine: 'client', mode: 'snapshot' })
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
    return { title: '秒表倒计时 · 5 路并行不漂移', path: '/packageLife/pages/timer/index?toolId=' + TOOL_ID + '&from=share' }
  }
})
