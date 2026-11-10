// packageVideo/pages/info —— FR-VID-06 视频信息（端 wx.getVideoInfo → 云 ffprobe，hybrid）
//
// 云端探测通道选型说明（任务要求二选一并注释）：
//   采用 videoTask.createTask({type:'video-probe'})，不用 GET /files/probe/:id ——
//   1) C8 后端路径清单没有 /files/probe/:id，只有 /files/init|upload|complete 与 /media/tasks；
//   2) createTask 内部已封装分片上传 + sha256 校验 + 轮询，与其余视频工具同一条 FR-V-00 流程，
//      限额/取消/持久化行为完全一致。
const registry = require('../../../tools/registry')
const store = require('../../../utils/store')
const track = require('../../../utils/track')
const error = require('../../../utils/error')
const vc = require('../../utils/video-common')

const TOOL_ID = 'video-info'
const TASK_TYPE = 'video-probe'

Page({
  data: {
    toolId: TOOL_ID,
    tool: null,
    tips: [
      '先本地探测基础字段；编码/音频流等深度信息需上传后由 ffprobe 解析',
      '云端探测与压缩工具共用上传与限额通道',
      '诊断信息可整体复制，用于反馈问题'
    ],
    video: null,
    kv: [],
    deepDone: false,
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
    this.setData({ tool: registry.get(q.toolId || TOOL_ID) })
    track.track('tool_open', { toolId: TOOL_ID, from: q.from || 'menu' })
  },

  onShow() {
    this.resumeIfAny()
  },

  resumeIfAny() {
    if (this._resuming || this.data.busy || this.data.deepDone) return
    const self = this
    this._resuming = true
    vc.resumePendingTask(TOOL_ID, { onProgress: function (p) { self.onTaskProgress(p) } })
      .then(function (r) {
        self._resuming = false
        if (!r) return
        self.applyProbeResult(r.result)
        self.setData({ busy: false, stage: 'done', percent: 100, deepDone: true, error: null })
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
      video.sizeText = vc.formatSize(video.size)
      video.durationText = vc.formatDuration(video.duration)
      const kv = self.localKv(video)
      self.setData({ video: video, kv: kv, deepDone: false, result: null, error: null, stage: '' })
      // FR-VID-06 规则：本地探测失败（部分安卓）自动转服务端；
      // 探测成功但缺编码/音频流字段时不自动上传，由用户点「云端深度探测」触发（省流量）。
      if (video.partial) self.onRun()
    })
  },

  onPickError(e) {
    const d = e.detail || {}
    this.setData({ error: { code: d.code || 'FILE_TOO_LARGE', message: d.message || error.message(d.code), retryable: false } })
  },

  localKv(video) {
    const rows = [
      { key: '容器格式', value: (video.format || 'mp4').toUpperCase() },
      { key: '时长', value: video.duration ? vc.formatDuration(video.duration) + '（' + video.duration + 's）' : '未探知' },
      { key: '宽高', value: video.width && video.height ? video.width + ' × ' + video.height : '未探知' },
      { key: '帧率', value: video.fps ? video.fps + ' fps' : '未探知（需云端深度探测）' },
      { key: '总码率', value: video.size && video.duration ? Math.round((video.size * 8) / 1024 / video.duration) + ' kbps' : '未探知' },
      { key: '文件体积', value: video.sizeText || '未探知' },
      { key: '视频编码', value: '未探知（需云端深度探测）' },
      { key: '音频流', value: '未探知（需云端深度探测）' },
      { key: '旋转元数据', value: '未探知（需云端深度探测）' },
      { key: 'HDR 元信息', value: '未探知（需云端深度探测）' }
    ]
    return rows
  },

  /** 云端 ffprobe 结果 → kv 行（C8 result：kind=kv 时 items 为 [{key,value}]；兼容 {url,meta}） */
  applyProbeResult(res) {
    const r = res || {}
    let rows = []
    if (Array.isArray(r.items) && r.items.length && r.items[0] && (r.items[0].key || r.items[0].label)) {
      rows = r.items.map(function (it) {
        return { key: it.key || it.label, value: String(it.value != null ? it.value : (it.text || '')) }
      })
    } else if (r.meta) {
      try {
        const meta = typeof r.meta === 'string' ? JSON.parse(r.meta) : r.meta
        rows = Object.keys(meta).map(function (k) { return { key: k, value: String(meta[k]) } })
      } catch (e) {
        rows = [{ key: '探测输出', value: String(r.meta) }]
      }
    }
    if (rows.length) {
      const merged = this.mergeKv(this.data.kv, rows)
      this.setData({ kv: merged, result: { kind: 'kv', kv: merged } })
    }
  },

  mergeKv(base, advanced) {
    const map = {}
    base.forEach(function (x) { map[x.key] = x.value })
    advanced.forEach(function (x) { map[x.key] = x.value })
    const order = ['容器格式', '视频编码', '时长', '宽高', '帧率', '总码率', '文件体积', '音频流', '旋转元数据', 'HDR 元信息']
    const keys = order.filter(function (k) { return map[k] != null })
    Object.keys(map).forEach(function (k) { if (keys.indexOf(k) < 0) keys.push(k) })
    return keys.map(function (k) { return { key: k, value: map[k] } })
  },

  /** 云端深度探测：走统一任务流程（type:'video-probe'） */
  onRun() {
    if (this.data.busy) return
    const video = this.data.video
    const blocked = vc.precheckLimits(video)
    if (blocked) return this.setData({ error: blocked })
    const self = this
    this._t0 = Date.now()
    this.setData({ busy: true, error: null, stage: 'upload', percent: 0, progressMsg: '正在准备上传…', eta: vc.estimateEtaText(vc.estimateUploadSec(video.size), 15) })
    track.track('tool_run_start', { toolId: TOOL_ID })
    this._runOpts = {
      toolId: TOOL_ID,
      type: TASK_TYPE,
      params: { probe: true },
      filePath: video.path,
      video: video,
      onProgress: function (p) { self.onTaskProgress(p) }
    }
    vc.runCloudTask(this._runOpts)
      .then(function (r) {
        track.track('tool_run_success', { toolId: TOOL_ID, costMs: Date.now() - self._t0, engine: 'server' })
        self.applyProbeResult(r.result)
        self.setData({ busy: false, stage: 'done', percent: 100, deepDone: true })
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
    let msg = '云端解析中 ' + percent + '%'
    if (stage === 'upload') msg = '正在上传 ' + percent + '%'
    else if (stage === 'queue') msg = '排队中' + (p.queue ? '，前方 ' + p.queue + ' 个' : '')
    else if (stage === 'done') msg = '解析完成'
    this.setData({ stage: stage, percent: percent, progressMsg: msg })
  },

  onCancel() {
    const self = this
    const taskId = (this._runOpts && this._runOpts.taskId) || (vc.pendingTask(TOOL_ID) || {}).taskId || ''
    if (!taskId) return this.setData({ busy: false, stage: 'canceled' })
    vc.cancelTaskFlow(taskId).then(function () {
      self.setData({ busy: false, stage: 'canceled', progressMsg: '任务已取消' })
    })
  },

  /** FR-VID-06：复制诊断信息（结构化文本，不含文件路径与用户内容） */
  onCopyDiag() {
    const rows = this.data.kv
    if (!rows.length) return
    const lines = ['[视频诊断信息] ' + rows.length + ' 项'].concat(rows.map(function (x) {
      return x.key + ': ' + x.value
    }))
    const text = lines.join('\n')
    wx.setClipboardData({
      data: text,
      success: function () {
        track.track('result_copy', { toolId: TOOL_ID, engine: 'server' })
        wx.showToast({ title: '诊断信息已复制', icon: 'success' })
      },
      fail: function () {
        wx.showToast({ title: error.message('ENGINE_UNAVAILABLE', { reason: '剪贴板不可用' }), icon: 'none' })
      }
    })
  },

  /** 串联 FR-VID-01：按当前分辨率给出压缩目标并透传参数（经参数记忆通道） */
  onGoCompress() {
    const video = this.data.video || {}
    const sizeMB = Math.max(5, Math.round((video.size || 0) / 1048576 * 0.5))
    const h = Number(video.height) || 0
    const resolution = h >= 1080 ? '1080p' : h >= 720 ? '720p' : 'source'
    const params = { mode: 'target', targetMB: Math.min(200, sizeMB), resolution: resolution }
    store.saveParams('video-compress', Object.assign(store.params('video-compress'), params))
    track.openTool('video-compress', TOOL_ID)
  }
})
