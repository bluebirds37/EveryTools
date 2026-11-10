// packageVideo/pages/frames —— FR-VID-05 提取封面/抽帧（mode at/count/first，结果 kind=images）
const registry = require('../../../tools/registry')
const store = require('../../../utils/store')
const track = require('../../../utils/track')
const error = require('../../../utils/error')
const vc = require('../../utils/video-common')
const tl = require('../../utils/timeline')

const TOOL_ID = 'video-frames'
const TASK_TYPE = 'video-frames'

function defaults() {
  return { mode: 'at', timeSec: 0, count: 6, format: 'jpg', quality: 90, width: 0, contactSheet: false }
}

Page({
  data: {
    toolId: TOOL_ID,
    tool: null,
    tips: [
      '均匀抽帧时间点为 duration*(i+0.5)/N，覆盖全片',
      '索引图 contactSheet 会在每帧标注时间戳',
      '抽出的图片可直接转到「图片压缩」继续处理'
    ],
    schemaMode: [
      { key: 'mode', label: '抽帧方式', type: 'segment', def: 'at', options: [
        { value: 'at', label: '指定时间' }, { value: 'count', label: '均匀 N 帧' }, { value: 'first', label: '首帧封面' }
      ] },
      { key: 'timeSec', label: '时间点', type: 'number', def: 0, min: 0, max: 600, step: 0.1, unit: 's', precision: 1, showIf: { key: 'mode', in: ['at'] } },
      { key: 'count', label: '帧数', type: 'slider', def: 6, min: 1, max: 30, step: 1, unit: '帧', showIf: { key: 'mode', in: ['count'] } }
    ],
    schemaOutput: [
      { key: 'format', label: '图片格式', type: 'segment', def: 'jpg', options: [{ value: 'jpg', label: 'JPG' }, { value: 'png', label: 'PNG' }] },
      { key: 'quality', label: '图片质量', type: 'slider', def: 90, min: 10, max: 100, step: 1, showIf: { key: 'format', in: ['jpg'] } },
      { key: 'width', label: '输出宽度', type: 'number', def: 0, min: 0, max: 3840, unit: 'px（0=保持源）' },
      { key: 'contactSheet', label: '拼合索引图', type: 'switch', def: false }
    ],
    video: null,
    values: defaults(),
    previewTimes: [],
    busy: false,
    stage: '',
    percent: 0,
    progressMsg: '',
    eta: '',
    result: null,
    savedAll: false,
    savingBusy: false,
    error: null
  },

  onLoad(query) {
    const q = query || {}
    this.setData({ tool: registry.get(q.toolId || TOOL_ID), values: Object.assign(defaults(), store.params(TOOL_ID)) })
    this.refreshPreview()
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
      const v = self.data.values
      const time = tl.clamp(v.timeSec, video.duration || 0)
      self.setData({ video: video, error: null, result: null, stage: '', values: Object.assign({}, v, { timeSec: time }) })
      self.refreshPreview()
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
    this.refreshPreview()
  },

  /** 抽帧时间点预览（count 模式与 FR-VID-05 验收公式一致，纯函数来自 timeline.js） */
  refreshPreview() {
    const v = this.data.values
    const d = (this.data.video && this.data.video.duration) || 0
    let times = []
    if (v.mode === 'count' && d > 0) times = tl.keyframeTimes(0, d, Number(v.count) || 6)
    else if (v.mode === 'at') times = [tl.round1(Number(v.timeSec) || 0)]
    else if (v.mode === 'first') times = [0]
    this.setData({ previewTimes: times.map(function (sec) { return tl.toClockPrecise(sec) }) })
  },

  validate(v) {
    const mode = v.mode
    if (mode !== 'at' && mode !== 'count' && mode !== 'first') {
      return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { field: '抽帧方式', range: 'at/count/first' }), retryable: false }
    }
    const d = (this.data.video && this.data.video.duration) || 0
    if (mode === 'at') {
      const t = Number(v.timeSec)
      if (!(t >= 0) || (d > 0 && t > d)) return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { field: '时间点', range: '0 ~ ' + tl.round1(d) + 's' }), retryable: false }
    }
    if (mode === 'count') {
      const c = Number(v.count)
      if (!(c >= 1 && c <= 30)) return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { field: '帧数', range: '1~30' }), retryable: false }
    }
    if (v.format === 'jpg' && !(Number(v.quality) >= 10 && Number(v.quality) <= 100)) {
      return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { field: '图片质量', range: '10~100' }), retryable: false }
    }
    if (Number(v.width) < 0 || Number(v.width) > 3840) {
      return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { field: '输出宽度', range: '0~3840（0=保持源）' }), retryable: false }
    }
    return null
  },

  serverParams(v) {
    const p = { mode: v.mode, format: v.format, contactSheet: !!v.contactSheet }
    if (v.mode === 'at') p.timeSec = tl.round1(Number(v.timeSec) || 0)
    if (v.mode === 'count') p.count = Number(v.count) || 6
    if (v.format === 'jpg') p.quality = Number(v.quality)
    if (Number(v.width) > 0) p.width = Number(v.width)
    return p
  },

  onRun() {
    if (this.data.busy) return
    const invalid = this.validate(this.data.values) || vc.precheckLimits(this.data.video)
    if (invalid) return this.setData({ error: invalid })
    const self = this
    this._t0 = Date.now()
    this._beforeBytes = this.data.video.size
    const eta = vc.estimateEtaText(vc.estimateUploadSec(this.data.video.size), vc.estimateProcessSec(10, 'fast', false))
    this.setData({ busy: true, error: null, result: null, savedAll: false, stage: 'upload', percent: 0, progressMsg: '正在准备上传…', eta: eta })
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
    let msg = '正在抽帧 ' + percent + '%'
    if (stage === 'upload') msg = '正在上传 ' + percent + '%'
    else if (stage === 'queue') msg = '排队中' + (p.queue ? '，前方 ' + p.queue + ' 个' : '')
    else if (stage === 'done') msg = '抽帧完成'
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
    const items = Array.isArray(res.items) ? res.items : []
    const images = items.map(function (it, i) {
      return { url: (it && it.url) || it, label: (it && it.label) || '帧 ' + (i + 1) }
    })
    return {
      kind: 'images',
      images: images,
      url: images.length ? images[0].url : res.url || '',
      meta: vc.buildMeta(this._beforeBytes, res, Date.now() - (this._t0 || Date.now()), 'server')
    }
  },

  /** 保存全部帧（串行防相册并发写冲突；拒绝授权时中断并报告已完成数） */
  onSaveAll() {
    const self = this
    this.setData({ savingBusy: true })
    wx.showLoading({ title: '保存中…', mask: true })
    vc.saveAll(this.data.result.images, TOOL_ID).then(function (r) {
      wx.hideLoading()
      self.setData({ savedAll: r.saved > 0, savingBusy: false })
      wx.showToast({ title: r.failed ? '已存 ' + r.saved + ' 张，' + r.failed + ' 张失败' : '已保存 ' + r.saved + ' 张到相册', icon: 'none' })
    })
  },

  onSave(e) {
    void e
    this.onSaveAll()
  },

  onPreviewImage(e) {
    const urls = (this.data.result && this.data.result.images || []).map(function (x) { return x.url })
    if (!urls.length) return
    wx.previewImage({ current: e.currentTarget.dataset.url, urls: urls })
  },

  /** FR-VID-05 串联：抽出的帧去「图片压缩」继续处理（bind:action use-tool 同源出口） */
  onGoImageCompress() {
    track.openTool('image-compress', TOOL_ID)
  },

  onResultAction(e) {
    const a = (e.detail && e.detail.action) || ''
    if (a === 'use-tool') track.openTool(e.detail.toolId || 'image-compress', TOOL_ID)
  },

  onAgain() {
    this.onRun()
  }
})
