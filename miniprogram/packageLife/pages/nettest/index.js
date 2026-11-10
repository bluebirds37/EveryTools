// packageLife/pages/nettest —— FR-LIF-07 网速测试（engine=server：静态采样文件；离线/不可达明确降级）
const registry = require('../../../tools/registry')
const store = require('../../../utils/store')
const track = require('../../../utils/track')
const error = require('../../../utils/error')
const env = require('../../../utils/env')
const media = require('../../../utils/media')
const speed = require('../../utils/speedtest')

const TOOL_ID = 'life-nettest'
const SAMPLES = 3
const SIZES = [1, 5] // 后端仅提供 speedtest-1m/5m，10MB 未投放故不出现在选项里
const SAMPLE_DELAY_MS = 120

function defaults() {
  return { sizeMB: 1 }
}

function buildSchema() {
  return [{
    key: 'sizeMB',
    label: '采样文件大小',
    type: 'segment',
    def: 1,
    options: SIZES.map(function (s) { return { value: s, label: s + ' MB' } }),
    hint: '文件越大越能反映稳定带宽，小文件更贴近真实网页体验'
  }]
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
    netType: '',
    sizeLabel: '1 MB',
    stage: '',
    percent: 0,
    progressMessage: '',
    tips: [
      '测量下载带宽：连续 ' + SAMPLES + ' 次采样取平均，并给出极差（抖动）',
      'TTFB 为测试文件首包请求耗时（含排队与 TLS 握手）',
      '测试文件走后端 /static/speedtest-Nm.bin，服务器不可达会明确提示并可重试',
      '结果受运营商与 Wi-Fi 拥塞影响，仅供参考'
    ]
  },

  onLoad(query) {
    const q = query || {}
    const tool = registry.get(TOOL_ID)
    const saved = store.params(TOOL_ID) || {}
    this._canceled = false
    this._task = null
    const values = Object.assign(defaults(), saved)
    this.setData({ tool: tool, values: values, sizeLabel: Number(values.sizeMB) + ' MB' })
    track.track('tool_open', { toolId: TOOL_ID, from: q.from || 'menu' })
    const self = this
    if (wx.getNetworkType) {
      wx.getNetworkType({
        success: function (res) { self.setData({ netType: res.networkType || '' }) }
      })
    }
    if (wx.onNetworkStatusChange) {
      this._netHandler = function (r) { self.setData({ netType: r.isConnected ? (r.networkType || '') : 'none' }) }
      wx.onNetworkStatusChange(this._netHandler)
    }
  },

  onUnload() {
    this._canceled = true
    this.abortTask()
    if (this._netHandler && typeof wx.offNetworkStatusChange === 'function') wx.offNetworkStatusChange(this._netHandler)
  },

  abortTask() {
    if (this._task && this._task.abort) {
      try { this._task.abort() } catch (e) { /* 已结束 */ }
    }
    this._task = null
  },

  onParamChange(e) {
    const values = Object.assign({}, this.data.values)
    values[e.detail.key] = e.detail.value
    this.setData({ values: values, sizeLabel: Number(values.sizeMB) + ' MB', result: null, error: null })
    store.saveParams(TOOL_ID, values)
  },

  fileUrl() {
    return env.BASE_URL + '/static/speedtest-' + Number(this.data.values.sizeMB) + 'm.bin'
  },

  nodeLabel() {
    return String(env.BASE_URL || '').replace(/^https?:\/\//, '')
  },

  onRun() {
    if (this.data.busy) return
    if (this.data.netType === 'none') {
      return this.setData({ error: { code: error.CODES.NETWORK_OFFLINE, message: error.message(error.CODES.NETWORK_OFFLINE) }, result: null })
    }
    if (!wx.downloadFile) {
      return this.setData({ error: { code: error.CODES.ENGINE_UNAVAILABLE, message: error.message(error.CODES.ENGINE_UNAVAILABLE, { reason: '下载接口不可用' }) }, result: null })
    }
    this._canceled = false
    this.setData({ busy: true, error: null, result: null, stage: 'process', percent: 4, progressMessage: '测延迟 TTFB…' })
    track.track('tool_run_start', { toolId: TOOL_ID, engine: 'server' })
    const self = this
    this.measureTtfb(function (ttfbMs) {
      if (self._canceled) return
      self.runSamples(ttfbMs)
    })
  },

  /** TTFB：HEAD 失败不阻塞测速（静态文件可能不允许 HEAD），仅记为未测得 */
  measureTtfb(done) {
    const self = this
    const t0 = Date.now()
    if (!wx.request) return done(null)
    try {
      wx.request({
        url: this.fileUrl() + '?t=' + t0,
        method: 'HEAD',
        timeout: 10000,
        success: function () { done(Date.now() - t0) },
        fail: function () { done(null) }
      })
    } catch (e) {
      done(null)
    }
  },

  runSamples(ttfbMs) {
    const self = this
    const t0 = Date.now()
    const samples = []
    let i = 0
    const one = function () {
      if (self._canceled) return
      const start = Date.now()
      self.setData({ stage: 'process', percent: 10 + i * 28, progressMessage: '采样 ' + (i + 1) + '/' + SAMPLES + '（' + self.data.values.sizeMB + 'MB）…' })
      const task = wx.downloadFile({
        url: self.fileUrl() + '?t=' + start,
        timeout: 30000,
        success: function (res) {
          if (self._canceled) return
          if (res.statusCode !== 200 || !res.tempFilePath) {
            return self.fail({ errMsg: 'downloadFile:fail HTTP ' + res.statusCode })
          }
          media.fileSize(res.tempFilePath).then(function (bytes) {
            if (self._canceled) return
            if (!(bytes > 0)) return self.fail({ errMsg: 'downloadFile:fail empty' })
            samples.push(speed.mbps(bytes, Date.now() - start))
            i++
            if (i < SAMPLES) {
              setTimeout(one, SAMPLE_DELAY_MS)
            } else {
              self.finish(t0, ttfbMs, samples)
            }
          })
        },
        fail: function (err) { self.fail(err) }
      })
      self._task = task
      if (task && task.onProgressUpdate) {
        task.onProgressUpdate(function (p) {
          if (self._canceled || !self.data.busy) return
          const base = 10 + i * 28
          self.setData({ percent: Math.min(96, base + Math.round((p.progress || 0) * 0.26)) })
        })
      }
    }
    one()
  },

  finish(t0, ttfbMs, samples) {
    const avg = samples.reduce(function (s, v) { return s + v }, 0) / samples.length
    const r = {
      mbps: avg,
      ttfbMs: ttfbMs,
      jitterMbps: speed.jitter(samples),
      samples: samples.map(function (v) { return Math.round(v * 10) / 10 }),
      sizeMB: Number(this.data.values.sizeMB),
      node: this.nodeLabel(),
      at: new Date().toLocaleString()
    }
    track.track('tool_run_success', { toolId: TOOL_ID, costMs: Date.now() - t0, engine: 'server' })
    this._task = null
    this.setData({
      busy: false,
      stage: 'done',
      percent: 100,
      progressMessage: '',
      result: { kv: speed.toKv(r), text: speed.buildText(r), meta: speed.fmtMbps(avg) + ' Mbps · ' + speed.grade(avg) }
    })
  },

  fail(err) {
    const offline = this.data.netType === 'none'
    const n = error.normalize(err, offline ? error.CODES.NETWORK_OFFLINE : error.CODES.SERVER_UNREACHABLE)
    track.track('tool_run_fail', { toolId: TOOL_ID, engine: 'server', code: n.code })
    this._task = null
    this.setData({
      busy: false,
      stage: 'failed',
      percent: 0,
      progressMessage: '',
      error: { code: n.code, message: n.message }
    })
  },

  onCancel() {
    this._canceled = true
    this.abortTask()
    track.track('tool_run_fail', { toolId: TOOL_ID, engine: 'server', code: error.INTERNAL_CODES.CANCELED })
    this.setData({
      busy: false,
      stage: 'canceled',
      percent: 0,
      progressMessage: '',
      error: { code: error.INTERNAL_CODES.CANCELED, message: error.message(error.INTERNAL_CODES.CANCELED) }
    })
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

  /** 串联：把结果文本换成图片分享的能力不存在，故只提供「再测一次」类出口之外的复制 */
  onShareAppMessage() {
    return { title: '网速测试 · 带宽延迟抖动', path: '/packageLife/pages/nettest/index?toolId=' + TOOL_ID + '&from=share' }
  }
})
