// packageVideo/pages/audio —— FR-VID-07 提取音频（mp3/aac/m4a/wav；NO_AUDIO_STREAM 走 error.message 话术）
const registry = require('../../../tools/registry')
const store = require('../../../utils/store')
const track = require('../../../utils/track')
const error = require('../../../utils/error')
const vc = require('../../utils/video-common')
const tl = require('../../utils/timeline')

const TOOL_ID = 'video-audio'
const TASK_TYPE = 'video-audio'

function defaults() {
  return { format: 'mp3', bitrate: '192k', sampleRate: 'source', startSec: 0, endSec: 0, fade: false }
}

Page({
  data: {
    toolId: TOOL_ID,
    tool: null,
    tips: [
      'endSec 为 0 表示取到视频结尾',
      '无音频流的视频会明确提示，不产生空文件',
      '淡入淡出仅在截取片段时生效'
    ],
    schema: [
      { key: 'format', label: '音频格式', type: 'segment', def: 'mp3', options: [
        { value: 'mp3', label: 'MP3' }, { value: 'aac', label: 'AAC' }, { value: 'm4a', label: 'M4A' }, { value: 'wav', label: 'WAV' }
      ] },
      { key: 'bitrate', label: '比特率', type: 'segment', def: '192k', options: [
        { value: '96k', label: '96k' }, { value: '128k', label: '128k' }, { value: '192k', label: '192k' }, { value: '320k', label: '320k' }
      ], showIf: { key: 'format', in: ['mp3', 'aac', 'm4a'] } },
      { key: 'sampleRate', label: '采样率', type: 'segment', def: 'source', options: [
        { value: 'source', label: '保持源' }, { value: '44100', label: '44.1kHz' }, { value: '48000', label: '48kHz' }
      ] },
      { key: 'startSec', label: '起点', type: 'number', def: 0, min: 0, max: 600, step: 0.1, unit: 's', precision: 1 },
      { key: 'endSec', label: '终点', type: 'number', def: 0, min: 0, max: 600, step: 0.1, unit: 's（0=全片）', precision: 1 },
      { key: 'fade', label: '淡入淡出', type: 'switch', def: false }
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
      const v = self.data.values
      const end = v.endSec > 0 ? tl.clamp(v.endSec, video.duration || 0) : 0
      self.setData({ video: video, error: null, result: null, stage: '', values: Object.assign({}, v, { endSec: end }) })
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

  validate(v) {
    const formats = ['mp3', 'aac', 'm4a', 'wav']
    if (formats.indexOf(v.format) < 0) {
      return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { field: '音频格式', range: 'mp3/aac/m4a/wav' }), retryable: false }
    }
    const start = Number(v.startSec) || 0
    const end = Number(v.endSec) || 0
    const d = (this.data.video && this.data.video.duration) || 0
    if (end !== 0) {
      const bad = tl.validateRange(start, end, d, { minSpan: 0.1, maxSpan: 600 })
      if (bad) return { code: bad.code, message: error.message(bad.code, bad.extra), retryable: false }
    } else if (start < 0 || (d > 0 && start > d)) {
      return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { field: '起点', range: '0 ~ ' + tl.round1(d) + 's' }), retryable: false }
    }
    return null
  },

  serverParams(v) {
    const p = { format: v.format, sampleRate: v.sampleRate === 'source' ? 'source' : Number(v.sampleRate), fade: !!v.fade }
    if (v.format !== 'wav') p.bitrate = v.bitrate
    p.startSec = tl.round1(Number(v.startSec) || 0)
    p.endSec = tl.round1(Number(v.endSec) || 0)
    return p
  },

  onRun() {
    if (this.data.busy) return
    const invalid = this.validate(this.data.values) || vc.precheckLimits(this.data.video)
    if (invalid) return this.setData({ error: invalid })
    const self = this
    this._t0 = Date.now()
    this._beforeBytes = this.data.video.size
    const eta = vc.estimateEtaText(vc.estimateUploadSec(this.data.video.size), vc.estimateProcessSec(5, 'ultrafast', false))
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
        // NO_AUDIO_STREAM 等错误码统一经 error.message 出话术（FR-VID-07 限制）
        self.setData({ busy: false, stage: 'failed', error: n })
      })
  },

  onTaskProgress(p) {
    const stage = p.stage || 'process'
    const percent = Number(p.percent) || 0
    let msg = '正在提取音频 ' + percent + '%'
    if (stage === 'upload') msg = '正在上传 ' + percent + '%'
    else if (stage === 'queue') msg = '排队中' + (p.queue ? '，前方 ' + p.queue + ' 个' : '')
    else if (stage === 'done') msg = '提取完成'
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
    const kv = [
      { key: '导出格式', value: String(this.data.values.format).toUpperCase() },
      { key: '音频地址', value: res.url ? '已生成（一次性签名，24 小时内有效）' : '生成失败' }
    ]
    return {
      // result-panel kind 枚举无 audio：音频文件交给 video 预览壳播放（小程序 video 支持纯音频 URL）
      kind: 'video',
      video: res.url || '',
      url: res.url || '',
      kv: kv,
      meta: vc.buildMeta(this._beforeBytes, res, Date.now() - (this._t0 || Date.now()), 'server')
    }
  },

  onSave() {
    vc.saveResult(this.data.result, TOOL_ID).then(
      function () { wx.showToast({ title: '已保存到相册/文件', icon: 'success' }) },
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
