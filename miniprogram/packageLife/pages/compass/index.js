// packageLife/pages/compass —— FR-LIF-01 指南针（wx.onCompass + 角度低通平滑 + 校准提示）
const registry = require('../../../tools/registry')
const store = require('../../../utils/store')
const track = require('../../../utils/track')
const error = require('../../../utils/error')
const motion = require('../../utils/motion')

const TOOL_ID = 'life-compass'

function defaults() {
  return { mode: 'dial', calibrationPrompt: true, magNote: true }
}

const SCHEMA = [
  { key: 'mode', label: '显示模式', type: 'segment', def: 'dial', options: [{ value: 'dial', label: '罗盘盘面' }, { value: 'bearing', label: '方位角数值' }] },
  { key: 'calibrationPrompt', label: '校准提示', type: 'switch', def: true, hint: '精度不足时提示「请水平晃动校准」' },
  { key: 'magNote', label: '磁偏角说明', type: 'switch', def: true, hint: '标注当前读数基于磁北而非真北' }
]

Page({
  data: {
    toolId: TOOL_ID,
    tool: null,
    values: defaults(),
    schema: SCHEMA,
    tips: [
      '方位角以正北为 0°，顺时针递增；与系统指南针偏差 ≤10°',
      '读数不稳或系统报告精度低时，请水平画「8」字晃动校准',
      '离开页面会自动释放罗盘传感器，不后台占用'
    ],
    direction: 0,
    dialStyle: 'transform: rotate(0deg)',
    dirName: '北',
    unstable: false,
    needCalibration: false,
    running: false,
    hasReading: false,
    unsupported: false,
    error: null
  },

  onLoad(query) {
    const q = query || {}
    this.setData({ tool: registry.get(q.toolId || TOOL_ID), values: Object.assign(defaults(), store.params(TOOL_ID) || {}) })
    this._prev = null
    this._lastSet = 0
    this._handler = this.onSensor.bind(this)
    track.track('tool_open', { toolId: TOOL_ID, from: q.from || 'menu' })
  },

  onShow() {
    if (this.data.unsupported) return
    this.startSensor()
  },

  onHide() {
    this.stopSensor()
  },

  onUnload() {
    this.stopSensor()
  },

  startSensor() {
    if (this.data.running || !wx.startCompass) {
      if (!wx.startCompass && !this.data.running) this.degrade()
      return
    }
    const self = this
    if (wx.onCompassChange && typeof wx.onCompassChange === 'function') wx.onCompassChange(this._handler)
    this.setData({ running: true })
    track.track('tool_run_start', { toolId: TOOL_ID, engine: 'client', mode: 'compass' })
    wx.startCompass({
      fail: function () {
        self.degrade()
      }
    })
  },

  stopSensor() {
    if (!this.data.running) return
    if (typeof wx.offCompassChange === 'function') wx.offCompassChange(this._handler)
    if (wx.stopCompass) wx.stopCompass()
    this.setData({ running: false, needCalibration: false })
    if (this.data.hasReading) track.track('tool_run_success', { toolId: TOOL_ID, engine: 'client', mode: 'compass' })
  },

  degrade() {
    this.stopSensor()
    const code = error.INTERNAL_CODES.DEVICE_UNSUPPORTED
    this.setData({ unsupported: true, error: { code: code, message: error.message(code) } })
    track.track('tool_run_fail', { toolId: TOOL_ID, code: code })
  },

  /** 传感器回调：低通平滑（跨零最短弧），≥100ms 节流 setData */
  onSensor(res) {
    const raw = Number(res && res.direction)
    if (!isFinite(raw)) return
    const st = motion.compassState(this._prev, ((raw % 360) + 360) % 360, res && res.accuracy)
    this._prev = st.direction
    const now = Date.now()
    if (now - this._lastSet < 100) return
    this._lastSet = now
    const patch = {
      direction: Math.round(st.direction * 10) / 10,
      dialStyle: 'transform: rotate(' + (-Math.round(st.direction)) + 'deg)',
      dirName: motion.dirName(st.direction),
      unstable: st.unstable,
      hasReading: true
    }
    if (this.data.values.calibrationPrompt) patch.needCalibration = st.needCalibration
    else if (this.data.needCalibration) patch.needCalibration = false
    this.setData(patch)
  },

  onToggleSensor() {
    if (this.data.running) this.stopSensor()
    else this.startSensor()
  },

  onParamChange(e) {
    const values = Object.assign({}, this.data.values)
    values[e.detail.key] = e.detail.value
    this.setData({ values: values })
    store.saveParams(TOOL_ID, values)
  },

  onCopy() {
    const text = '方位角 ' + this.data.direction + '°（' + this.data.dirName + '）'
    wx.setClipboardData({
      data: text,
      success: function () {
        track.track('result_copy', { toolId: TOOL_ID })
        wx.showToast({ title: '已复制方位', icon: 'success' })
      }
    })
  },

  onShareAppMessage() {
    return { title: '指南针 · 实时指向与方位角', path: '/packageLife/pages/compass/index?toolId=' + TOOL_ID + '&from=share' }
  }
})
