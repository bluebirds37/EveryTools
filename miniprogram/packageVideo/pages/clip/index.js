// packageVideo/pages/clip —— FR-VID-02 视频截取（自研时间轴：拖动 + 0.1s 数字输入 + ≤6 帧本地预览）
// 换算逻辑全部收敛在 utils/timeline.js（纯函数、可单测）；本文件只做事件接线与状态。
const registry = require('../../../tools/registry')
const store = require('../../../utils/store')
const track = require('../../../utils/track')
const error = require('../../../utils/error')
const vc = require('../../utils/video-common')
const tl = require('../../utils/timeline')

const TOOL_ID = 'video-clip'
const TASK_TYPE = 'video-clip'
const PREVIEW_FRAMES = 6

function defaults() {
  return { startSec: 0, endSec: 15, fastCut: false, thumbnailStrip: true }
}

Page({
  data: {
    toolId: TOOL_ID,
    tool: null,
    tips: [
      '拖动时间轴两端手柄或直接输入 0.1 秒精度的起止点',
      '快速模式吸附关键帧，起止可能有 ±2 秒偏差',
      '片段长度上限 600 秒'
    ],
    video: null,
    values: defaults(),
    schemaCut: [
      { key: 'fastCut', label: '关键帧快速切割', type: 'switch', def: false },
      { key: 'thumbnailStrip', label: '请求雪碧图缩略', type: 'switch', def: true }
    ],
    // 时间轴渲染态
    startPct: 0,
    endPct: 100,
    startText: '0:00.0',
    endText: '0:15.0',
    frames: [],
    ticks: [],
    durationText: '—',
    spanText: '—',
    busy: false,
    stage: '',
    percent: 0,
    progressMsg: '',
    eta: '',
    result: null,
    cmp: null,
    error: null
  },

  onLoad(query) {
    const q = query || {}
    this.setData({ tool: registry.get(q.toolId || TOOL_ID), values: Object.assign(defaults(), store.params(TOOL_ID)) })
    track.track('tool_open', { toolId: TOOL_ID, from: q.from || 'menu' })
  },

  onShow() {
    this.resumeIfAny()
  },

  resumeIfAny() {
    if (this._resuming || this.data.busy || this.data.result) return
    const self = this
    this._resuming = true
    vc.resumePendingTask(TOOL_ID, { onProgress: function (p) { self.onTaskProgress(p) } })
      .then(function (r) {
        self._resuming = false
        if (!r) return
        self.setData({ busy: false, stage: 'done', percent: 100, result: self.mapResult(r), cmp: self.buildCmp(r), error: null })
      })
      .catch(function (e) {
        self._resuming = false
        self.setData({ busy: false, stage: 'failed', error: vc.toPageError(e) })
      })
  },

  onPick(e) {
    const self = this
    const file = e.detail.files && e.detail.files[0]
    if (!file) return
    vc.probeVideo(file).then(function (video) {
      const blocked = vc.precheckLimits(video)
      if (blocked) return self.setData({ video: null, error: blocked, result: null })
      video.sizeText = vc.formatSize(video.size)
      video.durationText = vc.formatDuration(video.duration)
      const d = video.duration || 0
      const saved = self.data.values
      // FR-VID-02 默认 endSec = min(15, duration)；记忆参数越界时夹取回合法区间
      let end = tl.clamp(saved.endSec > 0 && saved.endSec <= d ? saved.endSec : Math.min(15, d), d)
      let start = tl.clamp(saved.startSec, Math.max(0, end - 0.1))
      if (tl.round1(end) - tl.round1(start) < 0.1) start = tl.round1(Math.max(0, end - 0.1))
      self.setData({ video: video, error: null, result: null, stage: '', values: Object.assign({}, saved, { startSec: start, endSec: end }) })
      self.refreshTimeline()
    })
  },

  onPickError(e) {
    const d = e.detail || {}
    this.setData({ error: { code: d.code || 'FILE_TOO_LARGE', message: d.message || error.message(d.code), retryable: false } })
  },

  /* ---------- 时间轴交互（坐标换算见 timeline.js） ---------- */

  refreshTimeline() {
    const v = this.data.values
    const d = (this.data.video && this.data.video.duration) || 0
    const times = tl.keyframeTimes(v.startSec, v.endSec, PREVIEW_FRAMES)
    this.setData({
      startPct: tl.toPercent(v.startSec, d),
      endPct: tl.toPercent(v.endSec, d),
      startText: String(tl.round1(v.startSec)),
      endText: String(tl.round1(v.endSec)),
      durationText: d ? tl.toClockPrecise(d) : '—',
      spanText: tl.round1(Math.max(0, v.endSec - v.startSec)) + 's',
      frames: times.map(function (sec) { return { sec: sec, label: tl.toClockPrecise(sec) } }),
      // 雪碧图不可用（未发起过带 thumbnailStrip 的任务）时降级为刻度条
      ticks: tl.ticks(d, 6)
    })
  },

  onTrackTouchStart(e) {
    const video = this.data.video
    if (!video || !(video.duration > 0) || this.data.busy) return
    const self = this
    const touch = e.touches && e.touches[0]
    if (!touch) return
    wx.createSelectorQuery().select('#tl-track').boundingClientRect(function (rect) {
      if (!rect || !rect.width) return
      self._rect = rect
      const sec = tl.toSec(touch.clientX - rect.left, rect.width, video.duration)
      const v = self.data.values
      // 就近选择手柄：距 start 近拖 start，否则拖 end（保持最小 0.1s 跨度）
      self._drag = Math.abs(sec - v.startSec) <= Math.abs(sec - v.endSec) ? 'start' : 'end'
      self.onTrackTouchMove(e)
    }).exec()
  },

  onTrackTouchMove(e) {
    const video = this.data.video
    if (!video || !this._rect || !this._drag) return
    const touch = e.touches && e.touches[0]
    if (!touch) return
    const now = Date.now()
    if (this._lastMoveAt && now - this._lastMoveAt < 60) return
    this._lastMoveAt = now
    const d = video.duration
    const sec = tl.toSec(touch.clientX - this._rect.left, this._rect.width, d)
    const v = this.data.values
    let values
    if (this._drag === 'start') {
      const start = tl.clamp(Math.min(sec, tl.round1(v.endSec - 0.1)), d)
      values = Object.assign({}, v, { startSec: start })
    } else {
      const end = tl.clamp(Math.max(sec, tl.round1(v.startSec + 0.1)), d)
      values = Object.assign({}, v, { endSec: end })
    }
    this.setData({ values: values })
    this.refreshTimeline()
  },

  onTrackTouchEnd() {
    this._drag = ''
    this._lastMoveAt = 0
    const v = this.data.values
    store.saveParams(TOOL_ID, v)
    this.refreshTimeline()
  },

  /** 0.1s 精度数字输入（支持 m:ss.t 文本） */
  onTimeInput(e) {
    const key = e.currentTarget.dataset.key
    const parsed = tl.fromClock(e.detail.value)
    if (parsed == null) return
    const d = (this.data.video && this.data.video.duration) || 0
    const v = this.data.values
    const values = Object.assign({}, v)
    if (key === 'startSec') values.startSec = tl.clamp(Math.min(parsed, tl.round1(v.endSec - 0.1)), d)
    else values.endSec = tl.clamp(Math.max(parsed, tl.round1(v.startSec + 0.1)), d)
    this.setData({ values: values })
    this.refreshTimeline()
    store.saveParams(TOOL_ID, values)
  },

  onParamChange(e) {
    const next = Object.assign({}, this.data.values)
    if (e.detail.key) next[e.detail.key] = e.detail.value
    this.setData({ values: next })
    store.saveParams(TOOL_ID, next)
    this.refreshTimeline()
  },

  /* ---------- 校验 + 运行 ---------- */

  validate(v) {
    const d = (this.data.video && this.data.video.duration) || 0
    const bad = tl.validateRange(v.startSec, v.endSec, d, { minSpan: 0.1, maxSpan: 600 })
    if (bad) return { code: bad.code, message: error.message(bad.code, bad.extra), retryable: false }
    return null
  },

  serverParams(v) {
    return { startSec: tl.round1(v.startSec), endSec: tl.round1(v.endSec), fastCut: !!v.fastCut, thumbnailStrip: v.thumbnailStrip !== false }
  },

  onRun() {
    if (this.data.busy) return
    const invalid = this.validate(this.data.values) || vc.precheckLimits(this.data.video)
    if (invalid) return this.setData({ error: invalid })
    const self = this
    this._t0 = Date.now()
    this._beforeBytes = this.data.video.size
    this.setData({ busy: true, error: null, result: null, cmp: null, stage: 'upload', percent: 0, progressMsg: '正在准备上传…' })
    track.track('tool_run_start', { toolId: TOOL_ID })
    this._runOpts = {
      toolId: TOOL_ID,
      type: TASK_TYPE,
      params: self.serverParams(self.data.values),
      filePath: self.data.video.path,
      video: self.data.video,
      onProgress: function (p) { self.onTaskProgress(p) }
    }
    vc.runCloudTask(this._runOpts)
      .then(function (r) {
        track.track('tool_run_success', { toolId: TOOL_ID, costMs: Date.now() - self._t0, engine: 'server' })
        self.setData({ busy: false, stage: 'done', percent: 100, result: self.mapResult(r), cmp: self.buildCmp(r), error: null })
        store.bumpUsage(TOOL_ID)
      })
      .catch(function (e) {
        const n = vc.toPageError(e)
        if (n.code === 'CANCELED' || n.code === 'TASK_CANCELED') return self.setData({ busy: false, stage: 'canceled' })
        track.track('tool_run_fail', { toolId: TOOL_ID, code: n.code || 'TASK_FAILED' })
        self.setData({ busy: false, stage: 'failed', error: n })
      })
  },

  onTaskProgress(p) {
    const stage = p.stage || 'process'
    const percent = Number(p.percent) || 0
    let msg = '正在截取 ' + percent + '%'
    if (stage === 'upload') msg = '正在上传 ' + percent + '%'
    else if (stage === 'queue') msg = '排队中' + (p.queue ? '，前方 ' + p.queue + ' 个' : '')
    else if (stage === 'done') msg = '截取完成'
    this.setData({ stage: stage, percent: percent, progressMsg: msg })
  },

  onCancel() {
    const self = this
    const taskId = (this._runOpts && this._runOpts.taskId) || (vc.pendingTask(TOOL_ID) || {}).taskId || ''
    if (!taskId) return this.setData({ busy: false, stage: 'canceled' })
    vc.cancelTaskFlow(taskId).then(function () {
      self.setData({ busy: false, stage: 'canceled', progressMsg: '任务已取消，参数已保留' })
    })
  },

  mapResult(r) {
    const res = (r && r.result) || {}
    return { kind: res.kind || 'video', video: res.url || '', url: res.url || '', meta: vc.buildMeta(this._beforeBytes, res, Date.now() - (this._t0 || Date.now()), 'server') }
  },

  buildCmp(r) {
    const res = (r && r.result) || {}
    const before = this._beforeBytes || 0
    const after = res.sizeMB ? res.sizeMB * 1048576 : 0
    if (!before) return null
    return { beforeText: vc.formatSize(before), afterText: after ? vc.formatSize(after) : '—', saveText: (vc.savePercent(before, after) || 0) + '%' }
  },

  onSave() {
    vc.saveResult(this.data.result, TOOL_ID).then(
      function () { wx.showToast({ title: '已保存到相册', icon: 'success' }) },
      function (e) { wx.showToast({ title: vc.toPageError(e).message, icon: 'none' }) }
    )
  },

  onAgain() {
    this.onRun()
  },

  onResultAction(e) {
    const a = (e.detail && e.detail.action) || ''
    if (a === 'use-tool') track.openTool(e.detail.toolId, TOOL_ID)
  }
})
