// packageVideo/pages/gif —— FR-VID-04 视频转 GIF（fps palettegen+paletteuse，≤15s、≤8MB）
const registry = require('../../../tools/registry')
const store = require('../../../utils/store')
const track = require('../../../utils/track')
const error = require('../../../utils/error')
const vc = require('../../utils/video-common')
const tl = require('../../utils/timeline')

const TOOL_ID = 'video-gif'
const TASK_TYPE = 'video-gif'
const MAX_SPAN = 15 // FR-VID-04：GIF 片段时长上限 15s
const MAX_SIZE_MB = 8

function defaults() {
  return { start: 0, end: 5, fps: 12, width: 480, loop: 0, quality: 'standard', maxSizeMB: MAX_SIZE_MB }
}

Page({
  data: {
    toolId: TOOL_ID,
    tool: null,
    tips: [
      '片段最长 15 秒，超过会自动校验拦截',
      '超过 8MB 时服务端会自动降档 fps/宽度并在结果中说明',
      '部分机型保存相册后 GIF 不再循环播放，属系统行为'
    ],
    schema: [
      { key: 'start', label: '开始时间', type: 'number', def: 0, min: 0, max: 600, step: 0.1, unit: 's', precision: 1 },
      { key: 'end', label: '结束时间', type: 'number', def: 5, min: 0.1, max: 600, step: 0.1, unit: 's', precision: 1 },
      { key: 'fps', label: '帧率', type: 'slider', def: 12, min: 5, max: 25, step: 1, unit: 'fps' },
      { key: 'width', label: '输出宽度', type: 'number', def: 480, min: 240, max: 720, step: 10, unit: 'px' },
      { key: 'loop', label: '循环次数', type: 'number', def: 0, min: 0, max: 10, step: 1, unit: '次（0=无限）' },
      { key: 'quality', label: '调色板质量', type: 'segment', def: 'standard', options: [
        { value: 'high', label: '高' }, { value: 'standard', label: '标准' }, { value: 'eco', label: '省体积' }
      ] }
    ],
    video: null,
    values: defaults(),
    busy: false,
    stage: '',
    percent: 0,
    progressMsg: '',
    eta: '',
    result: null,
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
        self.setData({ busy: false, stage: 'done', percent: 100, result: self.mapResult(r), error: null })
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
      // 默认 0~5s（FR-VID-04），记忆参数越界时夹回合法区间
      let end = tl.clamp(saved.end > 0 && saved.end <= d ? saved.end : Math.min(5, d), d)
      const start = tl.clamp(saved.start, Math.max(0, end - 0.1))
      self.setData({ video: video, error: null, result: null, stage: '', values: Object.assign({}, saved, { start: start, end: end }) })
    })
  },

  onPickError(e) {
    const d = e.detail || {}
    this.setData({ error: { code: d.code || 'FILE_TOO_LARGE', message: d.message || error.message(d.code), retryable: false } })
  },

  onParamChange(e) {
    const next = Object.assign({}, this.data.values)
    if (e.detail.key) next[e.detail.key] = e.detail.value
    this.setData({ values: next })
    store.saveParams(TOOL_ID, next)
  },

  /** FR-VID-04 校验：差值 ≤15s（走 timeline.validateRange，返回 PARAM_INVALID 错误对象） */
  validate(raw) {
    const v = {
      start: Number(raw.start), end: Number(raw.end), fps: Number(raw.fps),
      width: Number(raw.width), loop: Number(raw.loop), quality: raw.quality
    }
    const d = (this.data.video && this.data.video.duration) || 0
    const bad = tl.validateRange(v.start, v.end, d, { minSpan: 0.1, maxSpan: MAX_SPAN })
    if (bad) {
      return { code: bad.code, message: bad.code === 'PARAM_INVALID' && bad.extra && bad.extra.field === '片段时长' ? 'GIF 片段不能超过 ' + MAX_SPAN + ' 秒（' + bad.extra.range + '）' : error.message(bad.code, bad.extra), retryable: false }
    }
    if (!(v.fps >= 5 && v.fps <= 25)) return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { field: '帧率', range: '5~25' }), retryable: false }
    if (!(v.width >= 240 && v.width <= 720)) return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { field: '输出宽度', range: '240~720 px' }), retryable: false }
    if (!(v.loop >= 0 && v.loop <= 10)) return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { field: '循环次数', range: '0~10（0=无限）' }), retryable: false }
    return null
  },

  serverParams(v) {
    return { start: tl.round1(Number(v.start)), end: tl.round1(Number(v.end)), fps: Number(v.fps), width: Number(v.width), loop: Number(v.loop), quality: v.quality, maxSizeMB: MAX_SIZE_MB }
  },

  onRun() {
    if (this.data.busy) return
    const invalid = this.validate(this.data.values) || vc.precheckLimits(this.data.video)
    if (invalid) return this.setData({ error: invalid })
    const self = this
    this._t0 = Date.now()
    this._beforeBytes = this.data.video.size
    const span = tl.round1(this.data.values.end - this.data.values.start)
    const eta = vc.estimateEtaText(vc.estimateUploadSec(this.data.video.size), vc.estimateProcessSec(span, 'fast', false))
    this.setData({ busy: true, error: null, result: null, stage: 'upload', percent: 0, progressMsg: '正在准备上传…', eta: eta })
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
        self.setData({ busy: false, stage: 'done', percent: 100, result: self.mapResult(r), error: null })
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
    let msg = '正在生成 GIF ' + percent + '%'
    if (stage === 'upload') msg = '正在上传 ' + percent + '%'
    else if (stage === 'queue') msg = '排队中' + (p.queue ? '，前方 ' + p.queue + ' 个' : '')
    else if (stage === 'done') msg = '生成完成'
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
    return {
      kind: res.kind || 'image',
      // GIF 结果按图片出口保存（resultDownload 内部走 saveImageToPhotosAlbum）
      images: [{ url: res.url || '', label: 'GIF' }],
      video: '',
      url: res.url || '',
      // 服务端自动降档说明必须经 meta 如实展示（buildMeta 透传 result.meta）
      meta: vc.buildMeta(this._beforeBytes, res, Date.now() - (this._t0 || Date.now()), 'server')
    }
  },

  onSave() {
    vc.saveResult(this.data.result, TOOL_ID).then(
      function () { wx.showToast({ title: 'GIF 已保存到相册', icon: 'success' }) },
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
