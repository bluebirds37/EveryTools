const registry = require('../../../tools/registry')
const store = require('../../../utils/store')
const track = require('../../../utils/track')
const error = require('../../../utils/error')
const motion = require('../../utils/motion')

const TOOL_ID = 'life-level'
const LOCK_THRESHOLD = 0.5 // ±0.5° 判定水平
const ALPHA = 0.3 // 低通系数

function defaults() {
  return { axis: 'both', maxDeg: 12, vibrate: true }
}

function buildSchema() {
  return [
    { key: 'axis', label: '检测轴', type: 'segment', def: 'both', options: [{ value: 'both', label: '双轴' }, { value: 'pitch', label: '纵轴' }, { value: 'roll', label: '横轴' }] },
    { key: 'maxDeg', label: '气泡量程(°)', type: 'slider', def: 12, min: 4, max: 30, step: 1, unit: '°' },
    { key: 'vibrate', label: '水平锁定震动', type: 'switch', def: true }
  ]
}

const AXIS_LABELS = { both: '双轴', pitch: '纵轴', roll: '横轴' }

function axisLabel(axis) {
  return AXIS_LABELS[String(axis)] || '双轴'
}

Page({
  data: {
    tool: null,
    values: defaults(),
    schema: buildSchema(),
    busy: false,
    result: null,
    error: null,
    supported: true,
    axisText: '双轴',
    pitch: 0,
    roll: 0,
    bubbleX: 0,
    bubbleY: 0,
    locked: false,
    tips: [
      '气泡位置来自加速度计：量程越小越灵敏，锁定位移即水平',
      '水平判定阈值 ±0.5°，达到后震动提示一次',
      '使用前请移除手机壳并平放校准；离开页面自动释放传感器'
    ]
  },

  onLoad(query) {
    const tool = registry.get(TOOL_ID)
    const saved = store.params(TOOL_ID) || {}
    this._p = null
    this._r = null
    this._lockArmed = true
    this._onAcc = this.handleAcc.bind(this)
    const values = Object.assign(defaults(), saved)
    this.setData({ tool: tool, values: values, axisText: axisLabel(values.axis) })
    track.track('tool_open', { toolId: TOOL_ID, from: query.from || 'menu' })
  },

  onShow() {
    if (!wx.startAccelerometer) {
      this.setData({ supported: false, error: { code: 'DEVICE_UNSUPPORTED', message: error.message('DEVICE_UNSUPPORTED') } })
      return
    }
    const self = this
    wx.startAccelerometer({
      interval: 'game',
      fail: function () {
        self.setData({ supported: false, error: { code: 'DEVICE_UNSUPPORTED', message: error.message('DEVICE_UNSUPPORTED') } })
      }
    })
    if (wx.onAccelerometerChange) wx.onAccelerometerChange(this._onAcc)
    track.track('tool_run_start', { toolId: TOOL_ID, engine: 'sensor' })
  },

  onHide() {
    this.releaseSensor()
  },

  onUnload() {
    this.releaseSensor()
  },

  releaseSensor() {
    if (wx.offAccelerometerChange && this._onAcc) wx.offAccelerometerChange(this._onAcc)
    if (wx.stopAccelerometer) wx.stopAccelerometer({ fail: function () { /* 停止失败可忽略 */ } })
  },

  handleAcc(res) {
    const pr = motion.pitchRollFromAccel(res.x, res.y, res.z)
    this._p = this._p === null ? pr.pitch : motion.lowPass(this._p, pr.pitch, ALPHA)
    this._r = this._r === null ? pr.roll : motion.lowPass(this._r, pr.roll, ALPHA)
    const off = motion.bubbleOffset(this._p, this._r, this.data.values.maxDeg)
    const level = motion.isLevel(this._p, this._r, this.data.values.axis, LOCK_THRESHOLD)
    const patch = {
      pitch: Math.round(this._p * 10) / 10,
      roll: Math.round(this._r * 10) / 10,
      bubbleX: off.x,
      bubbleY: off.y,
      locked: level
    }
    if (level && this._lockArmed) {
      this._lockArmed = false
      if (this.data.values.vibrate && wx.vibrateShort) {
        wx.vibrateShort({ type: 'light', fail: function () { /* 震动失败不影响读数 */ } })
      }
    } else if (!level) {
      this._lockArmed = true
    }
    this.setData(patch)
  },

  onParamChange(e) {
    const values = Object.assign({}, this.data.values, { [e.detail.key]: e.detail.value })
    const patch = { values: values }
    if (e.detail.key === 'axis') patch.axisText = axisLabel(values.axis)
    this.setData(patch)
    store.saveParams(TOOL_ID, values)
  },

  /** 快照当前读数：作为结果出口（可复制 / 可作为「已调平」凭据） */
  onSnapshot() {
    if (!this.data.supported) return
    const v = this.data.values
    const lines = [
      '水平仪读数（' + new Date().toLocaleString() + '）',
      '纵向 pitch：' + this.data.pitch + '°',
      '横向 roll：' + this.data.roll + '°',
      '检测轴：' + axisLabel(v.axis) + ' · 量程 ±' + v.maxDeg + '°',
      '判定：' + (this.data.locked ? '水平（阈值 ±' + LOCK_THRESHOLD + '°）' : '未水平，继续调整')
    ]
    const text = lines.join('\n')
    this.setData({ result: { text: text, kv: [
      { key: '纵向', value: this.data.pitch + '°' },
      { key: '横向', value: this.data.roll + '°' },
      { key: '状态', value: this.data.locked ? '已水平' : '调整中' }
    ] } })
    track.track('tool_run_success', { toolId: TOOL_ID, engine: 'client', mode: 'snapshot' })
  },

  onCopy(e) {
    const text = (e.detail && e.detail.text) || (this.data.result && this.data.result.text) || ''
    if (!text) return
    wx.setClipboardData({
      data: text,
      success: function () {
        wx.showToast({ title: '已复制读数', icon: 'success' })
        track.track('result_copy', { toolId: TOOL_ID })
      }
    })
  },

  /** 清零平滑滤波基准：放下手机重新采样的场景 */
  onRecalibrate() {
    this._p = null
    this._r = null
    this._lockArmed = true
    this.setData({ result: null, locked: false })
    wx.showToast({ title: '已重置采样', icon: 'none' })
    track.track('tool_run_start', { toolId: TOOL_ID, engine: 'client', mode: 'recalibrate' })
  },

  onShareAppMessage() {
    return { title: '水平尺 · 手机秒变气泡水平仪', path: '/packageLife/pages/level/index?from=share' }
  }
})
