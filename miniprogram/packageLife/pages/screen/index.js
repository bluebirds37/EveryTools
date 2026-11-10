// packageLife/pages/screen —— FR-LIF-10 屏幕检测（全屏纯色/渐变，点击切换、双击退出，不申请任何权限）
const registry = require('../../../tools/registry')
const store = require('../../../utils/store')
const track = require('../../../utils/track')
const error = require('../../../utils/error')

const TOOL_ID = 'life-screen'

const COLORS = {
  white: { label: '纯白（查黑点）', cls: 'sc-white', hint: 'light' },
  black: { label: '纯黑（查亮点/漏光）', cls: 'sc-black', hint: 'dark' },
  red: { label: '纯红（查红子像素）', cls: 'sc-red', hint: 'dark' },
  green: { label: '纯绿（查绿子像素）', cls: 'sc-green', hint: 'dark' },
  blue: { label: '纯蓝（查蓝子像素）', cls: 'sc-blue', hint: 'dark' },
  gray: { label: '中灰（查偏色）', cls: 'sc-gray', hint: 'light' },
  gradient: { label: '灰阶渐变（查色带过渡）', cls: 'sc-grad', hint: 'light' }
}

const SEQUENCES = {
  full: { label: '全序列', keys: ['white', 'black', 'red', 'green', 'blue', 'gray', 'gradient'] },
  dead: { label: '坏点四色', keys: ['white', 'black', 'red', 'green'] },
  bw: { label: '黑白双向', keys: ['white', 'black'] },
  color: { label: 'RGB 三原色', keys: ['red', 'green', 'blue', 'gradient'] }
}

function defaults() {
  return { sequence: 'full', autoNext: false, interval: 2, showHint: true }
}

function buildSchema() {
  return [
    { key: 'sequence', label: '测试色序', type: 'segment', def: 'full', options: Object.keys(SEQUENCES).map(function (k) { return { value: k, label: SEQUENCES[k].label } }) },
    { key: 'autoNext', label: '自动切换颜色', type: 'switch', def: false, hint: '关闭时纯手动单击切换' },
    { key: 'interval', label: '自动切换间隔', type: 'slider', def: 2, min: 1, max: 6, step: 1, unit: 's', showIf: { key: 'autoNext', in: [true] } },
    { key: 'showHint', label: '显示操作提示', type: 'switch', def: true }
  ]
}

function seqKeys(v) {
  const s = SEQUENCES[String(v.sequence)] || SEQUENCES.full
  return s.keys
}

Page({
  data: {
    toolId: TOOL_ID,
    tool: null,
    values: defaults(),
    schema: buildSchema(),
    busy: false,
    result: null,
    error: null,
    fullscreen: false,
    stage: '',
    stageHint: 'light',
    colorClass: '',
    stepNo: 0,
    stepTotal: 0,
    seqLabel: '全序列',
    tips: [
      '纯色全屏检查坏点/漏光：白（黑点）、黑（亮点与边缘漏光）、红绿蓝（失效子像素）、中灰（整体偏色）',
      '单击屏幕切到下一步，双击任意处立即退出；开启自动切换后按间隔推进',
      '渐变档用于观察色带过渡是否均匀、有无明显断层',
      '本页不申请任何权限，不读写文件，退出即恢复原界面'
    ]
  },

  onLoad(query) {
    const q = query || {}
    const tool = registry.get(TOOL_ID)
    const saved = store.params(TOOL_ID) || {}
    const values = Object.assign(defaults(), saved)
    this._keys = seqKeys(values)
    this._idx = 0
    this._lastTap = 0
    this._timer = null
    this._visited = []
    this.setData({
      tool: tool,
      values: values,
      schema: buildSchema(),
      seqLabel: (SEQUENCES[String(values.sequence)] || SEQUENCES.full).label,
      result: this.buildResult()
    })
    track.track('tool_open', { toolId: TOOL_ID, from: q.from || 'menu' })
  },

  onHide() {
    this.closeTimer()
    if (this.data.fullscreen) this.setData({ fullscreen: false, stage: '', colorClass: '' })
  },

  onUnload() {
    this.closeTimer()
  },

  closeTimer() {
    if (this._timer) { clearInterval(this._timer); this._timer = null }
  },

  onParamChange(e) {
    const values = Object.assign({}, this.data.values)
    values[e.detail.key] = e.detail.value
    const seq = SEQUENCES[String(values.sequence)] || SEQUENCES.full
    this.setData({
      values: values,
      seqLabel: seq.label,
      stepTotal: this.data.fullscreen ? seq.keys.length : this.data.stepTotal
    })
    store.saveParams(TOOL_ID, values)
    if (e.detail.key === 'sequence') {
      this._keys = seq.keys.slice()
      if (this.data.fullscreen) {
        this._idx = 0
        this.showAt(0)
      }
    }
    if (e.detail.key === 'autoNext' || e.detail.key === 'interval') {
      if (this.data.fullscreen) this.armTimer()
    }
  },

  onRun() {
    if (this.data.busy) return
    const v = this.data.values
    const keys = seqKeys(v)
    if (!keys.length) {
      return this.setData({ error: { code: error.CODES.PARAM_INVALID, message: error.message(error.CODES.PARAM_INVALID, { field: '测试色序' }) } })
    }
    const interval = Number(v.interval)
    if (v.autoNext && !(interval >= 1 && interval <= 6)) {
      return this.setData({ error: { code: error.CODES.PARAM_INVALID, message: error.message(error.CODES.PARAM_INVALID, { field: '切换间隔', range: '1–6 秒' }) } })
    }
    this.setData({ error: null, busy: true, fullscreen: true, stepTotal: keys.length })
    this._keys = keys
    this._idx = 0
    this._visited = []
    this._startAt = Date.now()
    track.track('tool_run_start', { toolId: TOOL_ID, engine: 'client' })
    this.showAt(0)
  },

  showAt(idx) {
    const key = this._keys[idx]
    if (!key) return this.exit('done')
    const c = COLORS[key]
    if (this._visited.indexOf(key) < 0) this._visited.push(key)
    this.setData({
      stage: c.label,
      stageHint: c.hint,
      colorClass: c.cls,
      stepNo: idx + 1
    })
    this.armTimer()
  },

  armTimer() {
    this.closeTimer()
    if (!this.data.values.autoNext || !this.data.fullscreen) return
    const self = this
    const ms = Math.min(6, Math.max(1, Number(this.data.values.interval) || 2)) * 1000
    this._timer = setInterval(function () {
      if (!self.data.fullscreen) return self.closeTimer()
      self.advance()
    }, ms)
  },

  advance() {
    this._idx++
    if (this._idx >= this._keys.length) return this.exit('done')
    this.showAt(this._idx)
  },

  onScreenTap() {
    const now = Date.now()
    if (now - this._lastTap < 320) {
      this._lastTap = 0
      this.exit('manual')
      return
    }
    this._lastTap = now
    this.advance()
  },

  onExitButton() {
    this.exit('manual')
  },

  exit(reason) {
    this.closeTimer()
    const costMs = Date.now() - (this._startAt || Date.now())
    track.track('tool_run_success', { toolId: TOOL_ID, engine: 'client', costMs: costMs, mode: reason })
    this.setData({ fullscreen: false, stage: '', colorClass: '', busy: false, stepNo: 0, result: this.buildResult() })
  },

  /** 结果出口：本次检测的色序记录（可复制，便于记录验机结论） */
  buildResult() {
    const visited = (this._visited || []).slice()
    if (!visited.length) return null
    const lines = ['屏幕检测 · ' + (SEQUENCES[String(this.data.values.sequence)] || SEQUENCES.full).label]
    visited.forEach(function (k, i) {
      lines.push((i + 1) + '. ' + COLORS[k].label)
    })
    lines.push('时间：' + new Date().toLocaleString())
    return { text: lines.join('\n'), meta: '已查看 ' + visited.length + ' 档纯色' }
  },

  onCopy(e) {
    const text = (e.detail && e.detail.text) || (this.data.result && this.data.result.text) || ''
    if (!text) return
    wx.setClipboardData({
      data: text,
      success: function () {
        wx.showToast({ title: '已复制记录', icon: 'success' })
        track.track('result_copy', { toolId: TOOL_ID })
      }
    })
  },

  onShareAppMessage() {
    return { title: '屏幕测试 · 坏点漏光自查', path: '/packageLife/pages/screen/index?toolId=' + TOOL_ID + '&from=share' }
  }
})
