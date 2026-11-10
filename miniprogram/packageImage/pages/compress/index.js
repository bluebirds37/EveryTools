const TOOL_ID = 'image-compress'
const registry = require('../../../tools/registry')
const store = require('../../../utils/store')
const track = require('../../../utils/track')
const error = require('../../../utils/error')
const task = require('../../../utils/video-task')
const P = require('../../utils/processor')
const jpeg = require('../../utils/jpeg')

const MAX_MB = 15 // registry.limits.maxBytes / 1048576
const MAX_BATCH = 50
const MEMORY_MAX_SIDE = 4096 // 超此边长强制降采样，防解码失败

function defaults() {
  return {
    mode: 'size',
    targetKB: 200,
    quality: 75,
    maxSide: 0,
    keepExif: false,
    cloudKeepExif: false,
    format: 'jpg'
  }
}

function schema() {
  return [
    { key: 'mode', label: '压缩模式', type: 'segment', def: 'size', options: [
      { value: 'size', label: '目标体积' },
      { value: 'quality', label: '质量优先' },
      { value: 'dimension', label: '限制边长' }
    ] },
    { key: 'targetKB', label: '目标体积', type: 'number', unit: 'KB', min: 20, max: 5120, def: 200, showIf: { key: 'mode', in: ['size'] } },
    { key: 'quality', label: '输出质量', type: 'slider', min: 10, max: 95, step: 1, def: 75, showIf: { key: 'mode', in: ['quality'] } },
    { key: 'maxSide', label: '最长边上限（0 为不变）', type: 'number', unit: 'px', min: 0, max: 8192, def: 0, showIf: { key: 'mode', in: ['dimension'] } }
  ]
}

function validate(v, files) {
  if (!files || !files.length) return { code: 'INPUT_EMPTY', message: error.message('INPUT_EMPTY') }
  if (files.length > MAX_BATCH) return { code: 'PARAM_INVALID', message: '批量最多 ' + MAX_BATCH + ' 张，当前 ' + files.length + ' 张' }
  if (v.mode === 'size') {
    const t = Number(v.targetKB)
    if (!isFinite(t) || t < 20 || t > 5120) return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { max: '目标体积 20–5120KB' }) }
  }
  if (v.mode === 'dimension') {
    const m = Number(v.maxSide)
    if (!isFinite(m) || m < 0 || m > 8192) return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { max: '最长边 0 或 100–8192px' }) }
  }
  if (v.mode === 'quality') {
    const q = Number(v.quality)
    if (!isFinite(q) || q < 10 || q > 95) return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { max: '质量 10–95' }) }
  }
  return null
}

Page({
  data: {
    toolId: TOOL_ID,
    tool: null,
    schema: [],
    values: defaults(),
    files: [],
    busy: false,
    error: null,
    result: null,
    items: [],
    progress: { percent: 0, text: '' },
    summary: null,
    serverMode: false,
    serverReason: '',
    exifState: 'unknown',
    keepExifDisabled: true,
    taskInfo: null
  },

  onLoad(query) {
    const tool = registry.get(TOOL_ID)
    const saved = store.params(TOOL_ID) || {}
    this.setData({
      tool,
      schema: schema(),
      values: Object.assign(defaults(), saved, { keepExif: false, cloudKeepExif: !!saved.cloudKeepExif })
    })
    track.track('tool_open', { toolId: TOOL_ID, from: query.from || 'menu' })
  },

  onParamChange(e) {
    const values = Object.assign({}, this.data.values, { [e.detail.key]: e.detail.value })
    this.setData({ values })
    store.saveParams(TOOL_ID, values)
    this.refreshEngineHint()
  },

  onFilesChange(e) {
    const files = (e.detail.files || []).slice(0, MAX_BATCH)
    this.setData({ files, items: [], result: null })
    this.detectExif(files)
    this.refreshEngineHint()
  },

  onFilesError(e) {
    this.setData({ error: { code: e.detail.code || 'FILE_TOO_LARGE', message: e.detail.message } })
  },

  /** 超阈值自动降级云端（engine: server），用户无感知但需如实展示原因 */
  refreshEngineHint() {
    const files = this.data.files
    const over = files.length > MAX_BATCH
    const bigOne = files.filter((f) => (f.size || 0) > MAX_MB * 1024 * 1024)
    const wantKeepExif = this.data.values.cloudKeepExif
    let server = false
    let reason = ''
    if (over) {
      server = true
      reason = '批量超过 ' + MAX_BATCH + ' 张，改用云端'
    } else if (bigOne.length) {
      server = true
      reason = bigOne.length + ' 张超过 ' + MAX_MB + 'MB，改用云端'
    } else if (wantKeepExif) {
      server = true
      reason = '保留拍摄信息需云端处理'
    }
    this.setData({ serverMode: server, serverReason: reason })
    if (server) track.track('engine_fallback', { toolId: TOOL_ID, to: 'server' })
  },

  /** EXIF 探测：决定「保留拍摄信息」是否置灰（本机 Canvas 重编码必然丢 EXIF，不给假开关） */
  detectExif(files) {
    if (!files.length) return this.setData({ exifState: 'unknown' })
    const first = files[0]
    const that = this
    if (first.format && first.format !== 'jpg' && first.format !== 'jpeg') {
      return this.setData({ exifState: 'none' })
    }
    jpeg
      .readHead(first.path, 256 * 1024)
      .then((bytes) => {
        const info = jpeg.analyze(bytes)
        that.setData({ exifState: info.exif ? (info.exif.hasGps ? 'gps' : 'yes') : 'none' })
      })
      .catch(() => that.setData({ exifState: 'unknown' }))
  },

  onToggleCloudExif() {
    const values = Object.assign({}, this.data.values, { cloudKeepExif: !this.data.values.cloudKeepExif })
    this.setData({ values })
    store.saveParams(TOOL_ID, values)
    this.refreshEngineHint()
  },

  onRun() {
    const v = this.data.values
    const invalid = validate(v, this.data.files)
    if (invalid) return this.setData({ error: invalid })
    if (this.data.busy) return
    this.setData({ busy: true, error: null, result: null, items: [], summary: null, progress: { percent: 1, text: '准备中' } })
    this._overTarget = false
    this._reachedTarget = true
    this._keptCount = 0
    track.track('tool_run_start', { toolId: TOOL_ID, batch: this.data.files.length })
    this._t0 = Date.now()
    const job = this.data.serverMode ? this.runServer() : this.runClient()
    job
      .then((r) => {
        track.track('tool_run_success', { toolId: TOOL_ID, costMs: Date.now() - this._t0, engine: r.engine })
        this.setData({ busy: false })
        this.present(r)
      })
      .catch((e) => {
        const err = P.asContractError(e, 'TASK_FAILED')
        track.track('tool_run_fail', { toolId: TOOL_ID, code: err.code })
        this.setData({ busy: false, error: err })
      })
  },

  /** 本机批量：串行 + 逐张进度 */
  async runClient() {
    const v = this.data.values
    const canvas = await P.getCanvas()
    const files = this.data.files
    const items = []
    try {
      const results = await P.runSerial(
        files,
        (file) => this.compressOne(canvas, file, v),
        ({ index }) => {
          this.setData({
            items: items.slice(),
            progress: { percent: Math.round(((index + 1) / files.length) * 100), text: '第 ' + (index + 1) + '/' + files.length + ' 张' }
          })
        }
      )
      results.forEach((r, i) => {
        if (r.ok) items.push(r.value)
        else items.push({ index: i, failed: true, code: r.code, message: r.message })
        this.setData({ items: items.slice(), progress: { percent: Math.round(((i + 1) / files.length) * 100), text: '完成 ' + (i + 1) + '/' + files.length } })
      })
    } finally {
      P.release(canvas)
    }
    return { engine: 'client', items }
  },

  /**
   * 单张压缩。目标体积的二分搜索交给 utils/media（它自带「降质量 → 降尺寸阶梯」并如实返回
   * reachedTarget），页面不再重复实现一轮搜索 —— 之前这里自己循环 7 次，而每次调用的
   * quality 都被共享层按整数刻度截断成最高质量，等于白跑 7 次同样大的输出。
   */
  async compressOne(canvas, file, v) {
    const info = file.width ? file : await P.readInfo(file.path)
    const originSize = file.size || info.size || 0
    const longSide = Math.max(info.width, info.height)
    let maxSide = v.mode === 'dimension' ? Number(v.maxSide) || 0 : 0
    // 内存安全：超 4096 边长先限边长（iOS 大图解码偶发失败，见 requirements R9）
    if (longSide > MEMORY_MAX_SIDE) maxSide = maxSide ? Math.min(maxSide, MEMORY_MAX_SIDE) : MEMORY_MAX_SIDE

    const opt = { path: file.path, maxSide: maxSide, canvasId: P.ID, fileType: v.format || 'jpg' }
    if (v.mode === 'quality') opt.quality = Number(v.quality)
    else if (v.mode === 'dimension') opt.quality = 85
    else opt.targetBytes = Math.round(Number(v.targetKB) * 1024)

    const encoded = await P.compress(opt)
    // 压缩工具的铁律：结果不得大于原图。原图已比目标更紧凑时（或指定质量下重编码反而更大）
    // 直接保留原文件，而不是静默交付一个更大的「压缩结果」。
    const bigger = originSize > 0 && encoded.size >= originSize
    const best = bigger
      ? { path: file.path, size: originSize, width: info.width, height: info.height, quality: encoded.quality, iterations: encoded.iterations }
      : encoded
    if (bigger) this._keptCount = (this._keptCount || 0) + 1
    const reached = bigger || encoded.reachedTarget !== false
    this._reachedTarget = reached
    if (!reached) this._overTarget = true

    const saved = originSize - best.size
    const ratio = originSize > 0 ? Math.round((saved / originSize) * 1000) / 10 : 0
    return {
      index: file.index,
      path: best.path,
      url: best.path,
      label: (bigger ? '已是更小 · ' : '') + P.formatBytes(best.size) + '（' + best.width + '×' + best.height + '）',
      before: file.path,
      beforeSize: originSize,
      afterSize: best.size,
      savedBytes: saved,
      savedRatio: ratio,
      width: best.width,
      height: best.height,
      quality: best.quality,
      iterations: best.iterations,
      keptOriginal: bigger,
      overTarget: !reached,
      failed: false
    }
  },

  /** 云端降级：复用 media/tasks 任务通道，type='image-compress' */
  async runServer() {
    const v = this.data.values
    const files = this.data.files
    const items = []
    this.setData({ taskInfo: { stage: 'upload', percent: 0, message: '上传中' } })
    for (let i = 0; i < files.length; i++) {
      const f = files[i]
      const out = await task.createTask({
        toolId: TOOL_ID,
        type: 'image-compress',
        params: {
          mode: v.mode,
          targetKB: Number(v.targetKB),
          quality: Number(v.quality),
          maxSide: Number(v.maxSide) || 0,
          keepExif: true,
          format: v.format
        },
        filePath: f.path,
        onProgress: (p) => {
          this.setData({ taskInfo: { stage: p.stage || 'upload', percent: Math.round((p.percent || 0) * 0.6), message: '第 ' + (i + 1) + '/' + files.length + ' 张上传' } })
        }
      })
      const res = await task.pollTask(out.taskId, {
        onProgress: (p) => {
          this.setData({ taskInfo: { stage: p.stage || 'process', percent: 60 + Math.round((p.progress || 0) * 0.4), message: '云端处理中' } })
        }
      })
      const result = (res && res.result) || {}
      const url = result.url || (result.items && result.items[0] && result.items[0].url) || ''
      if (!url) throw { code: 'TASK_FAILED', message: error.message('TASK_FAILED', { reason: '云端未返回结果' }) }
      const dl = await require('../../../utils/request').downloadToTemp(url)
      items.push({
        path: dl,
        url: dl,
        before: f.path,
        beforeSize: f.size,
        afterSize: Math.round((result.sizeMB || 0) * 1024 * 1024),
        savedBytes: f.size - Math.round((result.sizeMB || 0) * 1024 * 1024),
        savedRatio: f.size ? Math.round(((f.size - (result.sizeMB || 0) * 1024 * 1024) / f.size) * 1000) / 10 : 0,
        label: '云端 · ' + P.formatBytes(Math.round((result.sizeMB || 0) * 1024 * 1024)),
        engine: 'server'
      })
      this.setData({ items: items.slice(), progress: { percent: Math.round(((i + 1) / files.length) * 100), text: '云端完成 ' + (i + 1) + '/' + files.length } })
    }
    return { engine: 'server', items }
  },

  present(r) {
    const items = (r.items || []).filter((i) => !i.failed)
    const failed = (r.items || []).filter((i) => i.failed)
    if (!items.length) {
      const f = failed[0]
      this.setData({
        error: { code: (f && f.code) || 'IMAGE_TOO_BIG', message: (f && f.message) || error.message('IMAGE_TOO_BIG') },
        busy: false
      })
      return
    }
    const inTotal = items.reduce((a, i) => a + (i.beforeSize || 0), 0)
    const outTotal = items.reduce((a, i) => a + (i.afterSize || 0), 0)
    const savedPct = inTotal ? Math.round(((inTotal - outTotal) / inTotal) * 1000) / 10 : 0
    const single = items.length === 1 ? items[0] : null
    // 原图已高度压缩时，按较高质量重编码可能反而变大 —— 不能显示「节省 -180%」，
    // 要如实说明并给出可用出口（改目标体积模式 / 降质量）。
    const grew = !items.every((i) => i.keptOriginal) && outTotal > inTotal
    const summary = {
      count: items.length,
      failed: failed.length,
      inText: P.formatBytes(inTotal),
      outText: P.formatBytes(outTotal),
      savedText: (inTotal > outTotal ? P.formatBytes(inTotal - outTotal) : '0 B'),
      savedPct: Math.max(0, savedPct),
      grew: grew,
      kept: items.filter((i) => i.keptOriginal).length,
      engine: r.engine,
      costMs: Date.now() - (this._t0 || Date.now()),
      overTarget: !!(single && this._overTarget),
      reachedTarget: !!this._reachedTarget
    }
    const resultPanel = {
      kind: single ? 'image' : 'images',
      images: items.map((i) => ({ url: i.url || i.path, label: i.label })),
      compareBefore: single ? single.before : '',
      after: single ? single.path : '',
      meta: (grew ? '与原始持平/更大' : '节省 ' + savedPct + '%') + ' · ' + (summary.costMs / 1000).toFixed(1) + 's · ' + (r.engine === 'server' ? '云端' : '本机'),
      showSave: true,
      showShare: !!single
    }
    this.setData({ result: resultPanel, items, summary, taskInfo: null, progress: { percent: 100, text: '完成' } })
  },

  onSaveResult() {
    const list = (this.data.items || []).filter((i) => i.path && !i.failed).map((i) => i.path)
    if (!list.length) return
    P.saveMany(list, 'image').then((r) => {
      track.track('result_save', { toolId: TOOL_ID, count: r.saved })
      wx.showToast({ title: r.saved === r.total ? '已保存到相册' : '已保存 ' + r.saved + '/' + r.total, icon: 'none' })
      if (r.denied) this.setData({ error: { code: 'PERMISSION_DENIED', message: error.message('PERMISSION_DENIED') } })
    })
  },

  onResultAction(e) {
    const d = e.detail || {}
    if (d.action === 'use-tool' && d.toolId) {
      const entry = registry.entryPath(d.toolId)
      if (entry) wx.navigateTo({ url: entry + '?toolId=' + d.toolId + '&from=compress' })
    }
  },

  onShellReady() {
    if (this.data.files.length) this.detectExif(this.data.files)
  },

  onNextTool(e) {
    const id = e.currentTarget.dataset.tool
    this.onResultAction({ detail: { action: 'use-tool', toolId: id } })
  },

  onPreviewThumb(e) {
    const i = Number(e.currentTarget.dataset.i) || 0
    const urls = (this.data.items || []).filter((x) => x.path).map((x) => x.path)
    if (urls.length) wx.previewImage({ urls, current: urls[Math.min(i, urls.length - 1)] })
  },

  onCancelTask() {
    if (this._taskId) task.cancelTask(this._taskId)
    this._taskId = ''
    this.setData({ busy: false, taskInfo: null, error: { code: 'TASK_FAILED', message: '已取消本次云端处理' } })
  },

  /** 内置示例：一键填入常用压缩参数（C9-6） */
  onSample() {
    const presets = [
      { mode: 'size', targetKB: 200, quality: 75, maxSide: 0, cloudKeepExif: false },
      { mode: 'size', targetKB: 100, quality: 75, maxSide: 0, cloudKeepExif: false },
      { mode: 'quality', targetKB: 200, quality: 82, maxSide: 0, cloudKeepExif: false },
      { mode: 'dimension', targetKB: 200, quality: 75, maxSide: 1920, cloudKeepExif: false }
    ]
    this._sampleI = ((this._sampleI || 0) % presets.length)
    const values = Object.assign({}, this.data.values, presets[this._sampleI])
    this._sampleI++
    this.setData({ values })
    store.saveParams(TOOL_ID, values)
    this.refreshEngineHint()
    wx.showToast({ title: '已填入示例：' + values.mode + (values.mode === 'size' ? ' ' + values.targetKB + 'KB' : ''), icon: 'none' })
  },

  onShareAppMessage() {
    return { title: '图片压缩：一键瘦身可控体积', path: '/packageImage/pages/compress/index?toolId=' + TOOL_ID + '&from=share' }
  },

  onUnload() {
    if (this._canvas) P.release(this._canvas)
  }
})
