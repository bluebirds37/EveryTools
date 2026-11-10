// packageVideo/pages/compress —— FR-VID-01 视频压缩（云端 ffmpeg，target/crf/bitrate 三态）
const registry = require('../../../tools/registry')
const store = require('../../../utils/store')
const track = require('../../../utils/track')
const error = require('../../../utils/error')
const vc = require('../../utils/video-common')

const TOOL_ID = 'video-compress'
const TASK_TYPE = 'video-compress'

// 经验估算：x264 每 +6 CRF 体积约减半（以源 crf≈23 为锚，仅作执行前参考，标注「约」）
function crfPredictedMB(sizeBytes, crf) {
  const mb = sizeBytes / 1048576
  if (!(mb > 0)) return 0
  const factor = Math.pow(2, (23 - Number(crf) || 0) / 6)
  return Math.round(mb * factor * 10) / 10
}

function defaults() {
  return {
    mode: 'target',
    targetMB: 20,
    crf: 26,
    maxBitrateKbps: 2000,
    resolution: '720p',
    customWidth: 1280,
    fps: 'source',
    customFps: 30,
    preset: 'medium',
    audioBitrate: '128k',
    keepAudio: true
  }
}

Page({
  data: {
    toolId: TOOL_ID,
    tool: null,
    tips: [
      '目标体积模式由服务端两遍编码（2pass）精确逼近',
      '支持源 ≤200MB、时长 ≤600s、分辨率 ≤4K',
      '任务在本地保留 24 小时，可在「历史任务」继续下载'
    ],
    schemaMode: [
      { key: 'mode', label: '压缩模式', type: 'segment', def: 'target', options: [
        { value: 'target', label: '目标体积' }, { value: 'crf', label: '画质档位' }, { value: 'bitrate', label: '指定码率' }
      ] },
      { key: 'targetMB', label: '目标体积', type: 'number', def: 20, min: 5, max: 200, unit: 'MB', showIf: { key: 'mode', in: ['target'] } },
      { key: 'crf', label: '画质 CRF', type: 'slider', def: 26, min: 18, max: 36, step: 1, showIf: { key: 'mode', in: ['crf'] } },
      { key: 'maxBitrateKbps', label: '视频码率', type: 'number', def: 2000, min: 300, max: 10000, step: 100, unit: 'kbps', showIf: { key: 'mode', in: ['bitrate'] } }
    ],
    schemaOutput: [
      { key: 'resolution', label: '分辨率', type: 'select', def: '720p', options: [
        { value: 'source', label: '保持源' }, { value: '1080p', label: '1080p' }, { value: '720p', label: '720p' },
        { value: '480p', label: '480p' }, { value: '360p', label: '360p' }, { value: 'custom', label: '自定义宽' }
      ] },
      { key: 'customWidth', label: '自定义宽度', type: 'number', def: 1280, min: 100, max: 3840, unit: 'px', showIf: { key: 'resolution', in: ['custom'] } },
      { key: 'fps', label: '帧率', type: 'select', def: 'source', options: [
        { value: 'source', label: '保持源' }, { value: '24', label: '24' }, { value: '30', label: '30' },
        { value: '60', label: '60' }, { value: 'custom', label: '自定义' }
      ] },
      { key: 'customFps', label: '自定义帧率', type: 'number', def: 30, min: 1, max: 60, unit: 'fps', showIf: { key: 'fps', in: ['custom'] } }
    ],
    schemaAudio: [
      { key: 'preset', label: '编码速度', type: 'select', def: 'medium', options: [
        { value: 'ultrafast', label: '最快' }, { value: 'superfast', label: '很快' }, { value: 'fast', label: '快' },
        { value: 'medium', label: '标准' }, { value: 'slow', label: '慢' }, { value: 'slower', label: '更慢' }, { value: 'veryslow', label: '最慢' }
      ] },
      { key: 'keepAudio', label: '保留音频', type: 'switch', def: true },
      { key: 'audioBitrate', label: '音频码率', type: 'segment', def: '128k', options: [
        { value: '64k', label: '64k' }, { value: '96k', label: '96k' }, { value: '128k', label: '128k' }, { value: '192k', label: '192k' }
      ], showIf: { key: 'keepAudio', in: [true] } }
    ],
    video: null,
    values: defaults(),
    estimate: null,
    busy: false,
    stage: '',
    percent: 0,
    progressMsg: '',
    eta: '',
    result: null,
    cmp: null,
    error: null,
    historyOn: false,
    history: [],
    historyCount: 0
  },

  onLoad(query) {
    const q = query || {}
    const tool = registry.get(q.toolId || TOOL_ID)
    // 「去云端压缩」串联：URL 上透传 targetMB/resolution，优先于记忆参数
    const remembered = Object.assign(defaults(), store.params(TOOL_ID))
    if (q.targetMB) remembered.targetMB = Number(q.targetMB) || remembered.targetMB
    if (q.resolution) remembered.resolution = String(q.resolution)
    if (q.mode) remembered.mode = String(q.mode)
    this.setData({ tool, values: remembered, history: vc.history(vc.HISTORY_SHOW, TOOL_ID), historyCount: 0 })
    this.setData({ historyCount: this.data.history.length })
    this.refreshEstimate()
    track.track('tool_open', { toolId: TOOL_ID, from: q.from || 'menu' })
  },

  onShow() {
    this.setData({ history: vc.history(vc.HISTORY_SHOW, TOOL_ID) })
    this.setData({ historyCount: this.data.history.length })
    this.resumeIfAny()
  },

  /** FR-V-00.4：退出重进后恢复未完成任务继续轮询 */
  resumeIfAny() {
    if (this._resuming || this.data.busy || this.data.result) return
    const self = this
    this._resuming = true
    vc.resumePendingTask(TOOL_ID, {
      onProgress: function (p) { self.onTaskProgress(p) }
    })
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

  onParamChange(e) {
    const next = Object.assign({}, this.data.values)
    if (e.detail.key) next[e.detail.key] = e.detail.value
    this.setData({ values: next })
    store.saveParams(TOOL_ID, next)
    this.refreshEstimate()
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
      self.setData({ video: video, error: null, result: null, stage: '' })
      self.refreshEstimate()
    })
  },

  onPickError(e) {
    const d = e.detail || {}
    this.setData({ error: { code: d.code || 'FILE_TOO_LARGE', message: d.message || error.message(d.code), retryable: false } })
  },

  /** 执行前预估（FR-VID-01：按原体积与目标反算，含 5% 安全余量说明） */
  refreshEstimate() {
    const v = this.data.values
    const video = this.data.video
    const out = { predictedMB: 0, videoKbps: 0, eta: '', note: '', rough: false }
    if (video && video.duration > 0 && video.size > 0) {
      if (v.mode === 'target') {
        const est = vc.estimateTargetBitrate({ targetMB: v.targetMB, durationSec: video.duration, audioBitrate: v.audioBitrate, keepAudio: v.keepAudio })
        if (est) {
          out.predictedMB = est.predictedMB
          out.videoKbps = est.videoKbps
          out.note = '反算视频码率约 ' + est.videoKbps + 'kbps（已向下预留 5% 安全余量）。目标体积模式使用服务端两遍编码，耗时更长。'
        }
      } else if (v.mode === 'bitrate') {
        const audioK = v.keepAudio ? { '64k': 64, '96k': 96, '128k': 128, '192k': 192 }[v.audioBitrate] || 128 : 0
        out.predictedMB = vc.kbpsSecToMB(Number(v.maxBitrateKbps) + audioK, video.duration)
        out.note = '按固定码率线性折算，实际体积基本一致。'
      } else {
        out.predictedMB = crfPredictedMB(video.size, v.crf)
        out.rough = true
        out.note = 'CRF 为画质优先，体积随画面复杂度波动，此处为经验估算（±40%）。'
      }
      out.eta = vc.estimateEtaText(vc.estimateUploadSec(video.size), vc.estimateProcessSec(video.duration, v.preset, v.mode === 'target'))
    } else {
      out.eta = ''
      out.note = '选定视频后展示预估体积与耗时。'
    }
    this.setData({ estimate: out.predictedMB || out.eta ? out : null, eta: out.eta })
  },

  validate(v) {
    const num = function (x) { return Number(x) }
    if (v.mode === 'target' && !(num(v.targetMB) >= 5 && num(v.targetMB) <= 200)) {
      return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { field: '目标体积', range: '5~200 MB' }), retryable: false }
    }
    if (v.mode === 'crf' && !(num(v.crf) >= 18 && num(v.crf) <= 36)) {
      return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { field: 'CRF', range: '18~36' }), retryable: false }
    }
    if (v.mode === 'bitrate' && !(num(v.maxBitrateKbps) >= 300 && num(v.maxBitrateKbps) <= 10000)) {
      return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { field: '视频码率', range: '300~10000 kbps' }), retryable: false }
    }
    if (v.resolution === 'custom' && !(num(v.customWidth) >= 100 && num(v.customWidth) <= 3840)) {
      return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { field: '自定义宽度', range: '100~3840 px' }), retryable: false }
    }
    if (v.fps === 'custom' && !(num(v.customFps) >= 1 && num(v.customFps) <= 60)) {
      return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { field: '帧率', range: '1~60' }), retryable: false }
    }
    return null
  },

  serverParams(v) {
    const p = { mode: v.mode, resolution: v.resolution, fps: v.fps, preset: v.preset, keepAudio: v.keepAudio }
    if (v.mode === 'target') p.targetMB = Number(v.targetMB)
    if (v.mode === 'crf') p.crf = Number(v.crf)
    if (v.mode === 'bitrate') p.maxBitrateKbps = Number(v.maxBitrateKbps)
    if (v.resolution === 'custom') p.customWidth = Number(v.customWidth)
    if (v.fps === 'custom') p.customFps = Number(v.customFps)
    if (v.keepAudio) p.audioBitrate = v.audioBitrate
    return p
  },

  onRun() {
    if (this.data.busy) return
    const v = this.data.values
    const invalid = this.validate(v) || vc.precheckLimits(this.data.video)
    if (invalid) return this.setData({ error: invalid })
    const self = this
    this._t0 = Date.now()
    this._beforeBytes = this.data.video.size
    this.setData({ busy: true, error: null, result: null, cmp: null, stage: 'upload', percent: 0, progressMsg: '正在准备上传…', eta: this.data.estimate ? this.data.estimate.eta : '' })
    track.track('tool_run_start', { toolId: TOOL_ID })
    this._runOpts = {
      toolId: TOOL_ID,
      type: TASK_TYPE,
      params: self.serverParams(v),
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
        if (n.code === 'CANCELED' || n.code === 'TASK_CANCELED') {
          self.setData({ busy: false, stage: 'canceled', error: null })
          return
        }
        track.track('tool_run_fail', { toolId: TOOL_ID, code: n.code || 'TASK_FAILED' })
        self.setData({ busy: false, stage: 'failed', error: n })
      })
  },

  /** FR-V-00.3 三段式进度：upload → queue → process */
  onTaskProgress(p) {
    const stage = p.stage || 'process'
    const percent = Number(p.percent) || 0
    let msg = '正在处理 ' + percent + '%'
    if (stage === 'upload') msg = '正在上传 ' + percent + '%'
    else if (stage === 'queue') msg = '排队中' + (p.queue ? '，前方 ' + p.queue + ' 个' : '')
    else if (stage === 'done') msg = '处理完成'
    this.setData({ stage: p.resumed ? 'queue' : stage, percent: percent, progressMsg: msg })
  },

  onCancel() {
    const self = this
    const taskId = (this._runOpts && this._runOpts.taskId) || (this._taskIdForCancel())
    if (!taskId) return this.setData({ busy: false, stage: 'canceled' })
    vc.cancelTaskFlow(taskId).then(function () {
      self.setData({ busy: false, stage: 'canceled', percent: 0, progressMsg: '任务已取消，参数已保留' })
    })
  },

  _taskIdForCancel() {
    const t = vc.pendingTask(TOOL_ID)
    return t ? t.taskId : ''
  },

  mapResult(r) {
    const res = (r && r.result) || {}
    return {
      kind: res.kind || 'video',
      video: res.url || '',
      url: res.url || '',
      meta: vc.buildMeta(this._beforeBytes, res, Date.now() - (this._t0 || Date.now()), 'server')
    }
  },

  buildCmp(r) {
    const res = (r && r.result) || {}
    const before = this._beforeBytes || 0
    const after = res.sizeMB ? res.sizeMB * 1048576 : 0
    if (!before) return null
    return {
      beforeText: vc.formatSize(before),
      afterText: after ? vc.formatSize(after) : '—',
      saveText: (vc.savePercent(before, after) || 0) + '%'
    }
  },

  onSave() {
    const self = this
    vc.saveResult(this.data.result, TOOL_ID).then(
      function () { wx.showToast({ title: '已保存到相册', icon: 'success' }) },
      function (e) { wx.showToast({ title: vc.toPageError(e).message, icon: 'none' }) }
    )
  },

  /** 「再处理一次」：参数完整保留，直接重跑 */
  onAgain() {
    this.onRun()
  },

  onResultAction(e) {
    const a = (e.detail && e.detail.action) || ''
    if (a === 'use-tool') track.openTool(e.detail.toolId, TOOL_ID)
  },

  /* ---------- 历史任务抽屉 ---------- */
  onHistoryOpen() {
    this.setData({ historyOn: true, history: vc.history(vc.HISTORY_SHOW, TOOL_ID) })
  },
  onHistoryClose() {
    this.setData({ historyOn: false })
  },
  onHistoryPreview(e) {
    const task = e.detail.task
    vc.previewResult(task).catch(function (err) {
      wx.showToast({ title: vc.toPageError(err).message, icon: 'none' })
    })
  },
  onHistoryDownload(e) {
    vc.saveResult(e.detail.task.result, TOOL_ID).then(
      function () { wx.showToast({ title: '已保存到相册', icon: 'success' }) },
      function (err) { wx.showToast({ title: vc.toPageError(err).message, icon: 'none' }) }
    )
  },
  onHistoryDelete(e) {
    vc.removeTask(e.detail.task.taskId)
    const list = vc.history(vc.HISTORY_SHOW, TOOL_ID)
    this.setData({ history: list, historyCount: list.length })
  },
  onHistoryRerun(e) {
    const snap = e.detail.task.params || {}
    const values = Object.assign({}, this.data.values, snap)
    this.setData({ values: values, historyOn: false })
    store.saveParams(TOOL_ID, values)
    this.refreshEstimate()
    wx.showToast({ title: '参数已回填，点击开始压缩', icon: 'none' })
  }
})
