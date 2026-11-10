const TOOL_ID = 'image-info'
const registry = require('../../../tools/registry')
const store = require('../../../utils/store')
const track = require('../../../utils/track')
const error = require('../../../utils/error')
const task = require('../../../utils/video-task')
const P = require('../../utils/processor')
const jpeg = require('../../utils/jpeg')

const CLOUD_FORMATS = { tiff: 'TIFF', heif: 'HEIF/HEIC', unknown: '未知容器' }

Page({
  data: {
    toolId: TOOL_ID,
    tool: null,
    file: null,
    busy: false,
    error: null,
    result: null,
    rows: [],
    exifRows: [],
    base: null,
    hasExif: false,
    noExif: false,
    gps: null,
    gpsShown: false,
    orientation: 1,
    previewPath: '',
    cloudNeeded: false,
    cloudFormat: '',
    qualityEst: 0,
    taskInfo: null,
    tips: [
      '基础字段（宽高/体积/格式）来自系统解码，一定准确',
      'EXIF 由本机 JPEG 段解析得到，字段缺失表示该相机未写入',
      'GPS 默认脱敏，点击「查看位置」才展开',
      'TIFF / HEIF 本机不支持解析，可提交云端读完整元数据'
    ]
  },

  onLoad(query) {
    const tool = registry.get(TOOL_ID)
    this.setData({ tool })
    track.track('tool_open', { toolId: TOOL_ID, from: query.from || 'menu' })
    if (query.path) this.load({ path: decodeURIComponent(query.path) })
  },

  onFilesChange(e) {
    const f = (e.detail.files || [])[0]
    if (f) this.load(f)
  },

  onFilesError(e) {
    this.setData({ error: { code: e.detail.code || 'FILE_TOO_LARGE', message: e.detail.message } })
  },

  async load(f) {
    this.setData({ busy: true, error: null, result: null, rows: [], exifRows: [], gpsShown: false, previewPath: '' })
    track.track('tool_run_start', { toolId: TOOL_ID })
    const t0 = Date.now()
    try {
      const info = await P.readInfo(f.path)
      const bytes = await jpeg.readHead(f.path, 512 * 1024)
      const an = jpeg.analyze(bytes)
      const sizeText = await this.fileSize(f.path, info.size)
      const orientation = (an.exif && an.exif.orientation) || 1

      const rows = [
        { key: '格式', value: (info.format || an.format || 'unknown').toUpperCase() },
        { key: '像素尺寸', value: info.width + ' × ' + info.height },
        { key: '总像素', value: (Math.round((info.width * info.height) / 1e5) / 10).toFixed(1) + ' MP' },
        { key: '文件大小', value: P.formatBytes(sizeText || info.size || 0) },
        { key: '宽高比', value: this.ratioText(info.width, info.height) },
        { key: '色彩', value: an.format === 'jpeg' ? 'YCbCr 4:2:0（估算）' : 'RGB / RGBA' }
      ]
      if (an.quant) {
        rows.push({ key: 'JPEG 量化表', value: an.quant.tables + ' 张 · 均值 ' + an.quant.avgQuant })
        this.setData({ qualityEst: an.quant.qualityEstimate })
      }
      if (an.segments && an.segments.length) {
        rows.push({ key: 'JPEG 段数', value: an.segments.length + ' 段（含 ' + this.countKind(an.segments) + '）' })
      }

      const cloud = an.format !== 'jpeg' && !!CLOUD_FORMATS[an.format]
      const exifRows = an.exif ? jpeg.formatFields(an.exif) : []

      this.setData({
        file: f,
        busy: false,
        base: info,
        rows,
        exifRows,
        hasExif: !!an.exif,
        noExif: !an.exif,
        gps: an.exif && an.exif.gps ? an.exif.gps : null,
        orientation,
        cloudNeeded: cloud,
        cloudFormat: (an.format || '').toUpperCase(),
        result: {
          kind: 'kv',
          kv: rows,
          meta: (an.format === 'jpeg' ? '本机解析' : '本机基础字段') + ' · ' + ((Date.now() - t0) / 1000).toFixed(1) + 's'
        }
      })

      if (orientation !== 1) this.fixPreview(f.path, orientation, info)
      track.track('tool_run_success', { toolId: TOOL_ID, costMs: Date.now() - t0, engine: 'client' })
    } catch (e) {
      const err = P.asContractError(e, 'UNSUPPORTED_FORMAT')
      track.track('tool_run_fail', { toolId: TOOL_ID, code: err.code })
      this.setData({ busy: false, error: err })
    }
  },

  fileSize(path, fallback) {
    return new Promise((resolve) => {
      wx.getFileInfo({
        filePath: path,
        success: (r) => resolve(r.size),
        fail: () => resolve(fallback || 0)
      })
    })
  },

  ratioText(w, h) {
    if (!w || !h) return '-'
    const g = (a, b) => (b ? g(b, a % b) : a)
    const d = g(w, h) || 1
    const rw = Math.round(w / d)
    const rh = Math.round(h / d)
    if (rw <= 32 && rh <= 32) return rw + ':' + rh
    return (w / h).toFixed(3) + ':1'
  },

  countKind(segs) {
    const names = {}
    segs.forEach((s) => {
      names[s.marker] = (names[s.marker] || 0) + 1
    })
    return Object.keys(names)
      .slice(0, 4)
      .map((k) => k + '×' + names[k])
      .join(', ')
  },

  /** Orientation≠1：按 EXIF 方向重绘预览（验收项） */
  async fixPreview(path, orientation, info) {
    const tr = jpeg.orientationTransform(orientation)
    const odd = tr.rotate === 90 || tr.rotate === 270
    const w = odd ? info.height : info.width
    const h = odd ? info.width : info.height
    const canvas = await P.getCanvas()
    const that = this
    try {
      const res = await P.render({
        canvas,
        srcPath: path,
        width: w,
        height: h,
        maxSide: 1400,
        fit: 'contain',
        rotate: tr.rotate,
        flipH: tr.flipH,
        flipV: tr.flipV,
        fileType: 'jpg',
        quality: 0.9
      })
      that.setData({ previewPath: res.path })
    } catch (e) {
      that.setData({ previewPath: '' })
    } finally {
      P.release(canvas)
    }
  },

  onShowGps() {
    this.setData({ gpsShown: !this.data.gpsShown })
  },

  /** TIFF/HEIF → 云端读完整 EXIF（复用任务通道，type='image-exif'） */
  async onCloudExif() {
    if (!this.data.file) return
    this.setData({ busy: true, error: null, taskInfo: { stage: 'upload', percent: 0, message: '上传中' } })
    const that = this
    try {
      const t = await task.createTask({
        toolId: TOOL_ID,
        type: 'image-exif',
        params: { full: true },
        filePath: this.data.file.path,
        onProgress: (p) => that.setData({ taskInfo: { stage: 'upload', percent: Math.round((p.percent || 0) * 0.5), message: '上传中' } })
      })
      this._taskId = t.taskId
      const res = await task.pollTask(t.taskId, {
        onProgress: (p) => that.setData({ taskInfo: { stage: p.stage || 'process', percent: 50 + Math.round((p.progress || 0) * 0.5), message: '云端解析元数据' } })
      })
      const r = (res && res.result) || {}
      const meta = r.meta || {}
      const rows = Object.keys(meta).map((k) => ({ key: k, value: String(meta[k]) }))
      if (!rows.length) throw { code: 'TASK_FAILED', message: error.message('TASK_FAILED', { reason: '云端未返回元数据' }) }
      this.setData({ busy: false, taskInfo: null, exifRows: rows, hasExif: true, noExif: false })
    } catch (e) {
      const err = P.asContractError(e, 'SERVER_UNREACHABLE')
      this.setData({ busy: false, taskInfo: null, error: err })
    }
  },

  onCancelTask() {
    if (this._taskId) task.cancelTask(this._taskId)
    this._taskId = ''
    this.setData({ busy: false, taskInfo: null })
  },

  onCopyAll() {
    const rows = this.data.rows.concat(this.data.exifRows)
    const text = rows.map((r) => r.key + ': ' + r.value).join('\n')
    const that = this
    P.copy(text)
      .then(() => {
        track.track('result_copy', { toolId: TOOL_ID })
        wx.showToast({ title: '已复制参数', icon: 'none' })
      })
      .catch((e) => that.setData({ error: e }))
  },

  onResultAction(e) {
    const d = e.detail || {}
    if (d.action === 'use-tool' && d.toolId) {
      const entry = registry.entryPath(d.toolId)
      if (entry) wx.navigateTo({ url: entry + '?toolId=' + d.toolId + '&from=info' })
    }
  },

  onPreviewSrc() {
    if (this.data.file) wx.previewImage({ urls: [this.data.file.path] })
  },

  onShareAppMessage() {
    return { title: '图片信息：查看 EXIF 与拍摄参数', path: '/packageImage/pages/info/index?toolId=' + TOOL_ID + '&from=share' }
  },

  onUnload() {
    if (this._canvas) P.release(this._canvas)
  }
})
