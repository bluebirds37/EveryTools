const TOOL_ID = 'image-crop'
const registry = require('../../../tools/registry')
const store = require('../../../utils/store')
const track = require('../../../utils/track')
const error = require('../../../utils/error')
const P = require('../../utils/processor')
const L = require('../../utils/layout')

const PRESETS = [
  { value: 'none', label: '不限尺寸', w: 0, h: 0, ratio: null },
  { value: 'avatar', label: '头像 200', w: 200, h: 200, ratio: 1 },
  { value: 'mp-cover', label: '公众号封面 900×383', w: 900, h: 383, ratio: 900 / 383 },
  { value: 'id-1', label: '一寸 295×413', w: 295, h: 413, ratio: 295 / 413 },
  { value: 'id-2', label: '二寸 413×579', w: 413, h: 579, ratio: 413 / 579 },
  { value: 'custom', label: '自定义', w: -1, h: -1, ratio: null }
]

const RATIO_OPTIONS = [
  { value: 'free', label: '自由' },
  { value: '1:1', label: '1:1' },
  { value: '4:3', label: '4:3' },
  { value: '3:4', label: '3:4' },
  { value: '16:9', label: '16:9' },
  { value: '9:16', label: '9:16' },
  { value: 'original', label: '原图' }
]

function defaults() {
  return {
    ratio: 'free',
    presetSize: 'none',
    customW: 200,
    customH: 200,
    rotate: 0,
    flipH: false,
    flipV: false,
    showGrid: true,
    outputFormat: 'jpg',
    quality: 90
  }
}

function schema() {
  return [
    { key: 'ratio', label: '裁剪比例', type: 'segment', def: 'free', options: RATIO_OPTIONS },
    { key: 'presetSize', label: '尺寸预设', type: 'chip', def: 'none', options: PRESETS.map((p) => ({ value: p.value, label: p.label })) },
    { key: 'customW', label: '自定义宽', type: 'number', unit: 'px', min: 16, max: 8192, def: 200, showIf: { key: 'presetSize', in: ['custom'] } },
    { key: 'customH', label: '自定义高', type: 'number', unit: 'px', min: 16, max: 8192, def: 200, showIf: { key: 'presetSize', in: ['custom'] } },
    { key: 'rotate', label: '旋转', type: 'slider', unit: '°', min: -180, max: 180, step: 1, def: 0 },
    { key: 'flipH', label: '水平翻转', type: 'switch', def: false },
    { key: 'flipV', label: '垂直翻转', type: 'switch', def: false },
    { key: 'showGrid', label: '三分构图网格', type: 'switch', def: true },
    { key: 'outputFormat', label: '输出格式', type: 'segment', def: 'jpg', options: [{ value: 'jpg', label: 'JPG' }, { value: 'png', label: 'PNG' }] },
    { key: 'quality', label: '输出质量', type: 'slider', min: 10, max: 100, step: 1, def: 90, showIf: { key: 'outputFormat', in: ['jpg'] } }
  ]
}

function validate(v, file) {
  if (!file) return { code: 'INPUT_EMPTY', message: error.message('INPUT_EMPTY') }
  if (v.presetSize === 'custom') {
    const w = Number(v.customW)
    const h = Number(v.customH)
    if (!(w >= 16 && w <= 8192) || !(h >= 16 && h <= 8192)) {
      return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { max: '自定义尺寸 16–8192px' }) }
    }
  }
  const r = Number(v.rotate)
  if (!isFinite(r) || r < -180 || r > 180) return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { max: '旋转 -180~180°' }) }
  return null
}

Page({
  data: {
    toolId: TOOL_ID,
    tool: null,
    schema: [],
    ratioOptions: RATIO_OPTIONS,
    values: defaults(),
    file: null,
    busy: false,
    error: null,
    result: null,
    stage: { width: 0, height: 0 },
    img: { width: 0, height: 0 },
    disp: { elW: 0, elH: 0, left: 0, top: 0, transform: '' },
    frame: { x: 0, y: 0, w: 0, h: 0 },
    masks: { top: 0, bottom: 0, left: 0, right: 0, band: 0 },
    zoom: 1,
    panX: 0,
    panY: 0,
    outInfo: '',
    srcInfo: '',
    hint: ''
  },

  onLoad(query) {
    const tool = registry.get(TOOL_ID)
    const saved = store.params(TOOL_ID) || {}
    this.setData({ tool, schema: schema(), values: Object.assign(defaults(), saved) })
    track.track('tool_open', { toolId: TOOL_ID, from: query.from || 'menu' })
  },

  onReady() {
    this.measure()
  },

  measure() {
    const that = this
    wx.createSelectorQuery()
      .in(this)
      .select('#crop-stage')
      .boundingClientRect((rect) => {
        if (!rect || !rect.width) return
        that.setData({ stage: { width: rect.width, height: rect.height } })
        that.rebuild()
      })
      .exec()
  },

  onParamChange(e) {
    const values = Object.assign({}, this.data.values, { [e.detail.key]: e.detail.value })
    this.setData({ values })
    store.saveParams(TOOL_ID, values)
    this.rebuild()
  },

  onFilesChange(e) {
    const f = (e.detail.files || [])[0]
    if (!f) return this.setData({ file: null, result: null })
    this.setData({ file: f, result: null, zoom: 1, panX: 0, panY: 0 })
    if (f.width && f.height) {
      this.setData({ img: { width: f.width, height: f.height } })
      this.rebuild()
    } else {
      const that = this
      P.readInfo(f.path)
        .then((info) => {
          that.setData({ img: { width: info.width, height: info.height } })
          that.rebuild()
        })
        .catch((err) => that.setData({ error: P.asContractError(err, 'IMAGE_TOO_BIG') }))
    }
  },

  onFilesError(e) {
    this.setData({ error: { code: e.detail.code || 'FILE_TOO_LARGE', message: e.detail.message } })
  },

  /** 有效比例：尺寸预设优先，其次比例分段 */
  activeRatio() {
    const v = this.data.values
    const preset = PRESETS.filter((p) => p.value === v.presetSize)[0]
    if (preset && preset.ratio) return preset.ratio
    if (preset && preset.value === 'custom') {
      const w = Number(v.customW) || 1
      const h = Number(v.customH) || 1
      return w / h
    }
    return L.parseRatio(v.ratio, this.data.img.width / this.data.img.height || null)
  },

  /** 重算取景框与图片显示变换 */
  rebuild() {
    const stage = this.data.stage
    const img = this.data.img
    if (!stage.width || !img.width) return
    const ratio = this.activeRatio()
    const maxW = stage.width * 0.86
    const maxH = stage.height * 0.86
    let fw = maxW
    let fh = maxH
    if (ratio) {
      if (maxW / ratio <= maxH) {
        fw = maxW
        fh = Math.round(maxW / ratio)
      } else {
        fh = maxH
        fw = Math.round(maxH * ratio)
      }
    }
    const frame = { x: Math.round((stage.width - fw) / 2), y: Math.round((stage.height - fh) / 2), w: Math.round(fw), h: Math.round(fh) }

    // 图片元素按 contain 铺进取景框（保证初始不越界）
    const base = Math.min(frame.w / img.width, frame.h / img.height)
    const elW = Math.round(img.width * base)
    const elH = Math.round(img.height * base)
    this._base = base
    this.setData({
      frame,
      masks: {
        top: frame.y,
        bottom: Math.max(0, stage.height - frame.y - frame.h),
        left: frame.x,
        right: Math.max(0, stage.width - frame.x - frame.w),
        band: frame.h
      },
      disp: {
        elW,
        elH,
        left: Math.round(frame.x + (frame.w - elW) / 2),
        top: Math.round(frame.y + (frame.h - elH) / 2),
        transform: this.cssTransform()
      }
    })
    this.updateInfo()
  },

  cssTransform() {
    const v = this.data.values
    const z = this.data.zoom
    const sx = (v.flipH ? -z : z)
    const sy = (v.flipV ? -z : z)
    return 'translate(' + this.data.panX + 'px,' + this.data.panY + 'px) rotate(' + (Number(v.rotate) || 0) + 'deg) scale(' + sx + ',' + sy + ')'
  },

  updateInfo() {
    const m = this.matrix()
    if (!m) return this.setData({ srcInfo: '', outInfo: '' })
    const out = this.outputSize()
    const hint = L.coversFrame(this.cropState()) ? '' : '取景框超出图片范围，请双指放大或拖动'
    this.setData({
      srcInfo: '源区域 ' + m.sourceWidth + '×' + m.sourceHeight + ' px',
      outInfo: '输出 ' + out.width + '×' + out.height + ' px',
      hint
    })
  },

  cropState() {
    const v = this.data.values
    const stage = this.data.stage
    return {
      imageWidth: this.data.img.width,
      imageHeight: this.data.img.height,
      baseScale: this._base || 1,
      zoom: this.data.zoom,
      rotate: Number(v.rotate) || 0,
      flipH: !!v.flipH,
      flipV: !!v.flipV,
      panX: this.data.panX,
      panY: this.data.panY,
      viewWidth: stage.width,
      viewHeight: stage.height,
      frame: this.data.frame
    }
  },

  matrix() {
    const out = this.outputSize()
    return L.cropMatrix(this.cropState(), out.width, out.height)
  },

  /** 输出尺寸：预设/自定义为精确值，否则取源区域像素（不放大） */
  outputSize() {
    const v = this.data.values
    const preset = PRESETS.filter((p) => p.value === v.presetSize)[0]
    if (preset && preset.w > 0) return { width: preset.w, height: preset.h }
    if (preset && preset.value === 'custom') {
      return { width: Math.max(16, Math.round(Number(v.customW) || 200)), height: Math.max(16, Math.round(Number(v.customH) || 200)) }
    }
    const st = this.cropState()
    const sU = st.baseScale * st.zoom
    const w = Math.max(1, Math.round(st.frame.w / sU))
    const h = Math.max(1, Math.round(st.frame.h / sU))
    return { width: w, height: h }
  },

  onTouchStart(e) {
    const ts = e.touches || []
    this._start = {
      n: ts.length,
      x: ts[0] ? ts[0].clientX : 0,
      y: ts[0] ? ts[0].clientY : 0,
      panX: this.data.panX,
      panY: this.data.panY,
      dist: ts.length > 1 ? this.pinchDist(ts) : 0,
      zoom: this.data.zoom
    }
  },

  pinchDist(ts) {
    const dx = ts[0].clientX - ts[1].clientX
    const dy = ts[0].clientY - ts[1].clientY
    return Math.max(1, Math.sqrt(dx * dx + dy * dy))
  },

  onTouchMove(e) {
    const ts = e.touches || []
    const s = this._start
    if (!s || s.n !== ts.length) return this.onTouchEnd(e)
    if (ts.length > 1) {
      const k = this.pinchDist(ts) / s.dist
      const zoom = Math.max(0.2, Math.min(8, s.zoom * k))
      this.setData({ zoom, disp: Object.assign({}, this.data.disp, { transform: this.cssTransform() }) })
    } else {
      const panX = s.panX + (ts[0].clientX - s.x)
      const panY = s.panY + (ts[0].clientY - s.y)
      this.setData({ panX, panY, disp: Object.assign({}, this.data.disp, { transform: this.cssTransform() }) })
    }
    this.updateInfo()
  },

  onTouchEnd() {
    this._start = null
    this.updateInfo()
  },

  onReset() {
    this.setData({ zoom: 1, panX: 0, panY: 0 })
    this.rebuild()
  },

  onRotateStep(e) {
    const delta = Number(e.currentTarget.dataset.d) || 90
    const v = Object.assign({}, this.data.values)
    let r = (Number(v.rotate) + delta) % 360
    if (r > 180) r -= 360
    if (r < -180) r += 360
    v.rotate = r
    this.setData({ values: v })
    store.saveParams(TOOL_ID, v)
    this.rebuild()
  },

  onRun() {
    const v = this.data.values
    const invalid = validate(v, this.data.file)
    if (invalid) return this.setData({ error: invalid })
    if (!this.data.frame.w) return this.rebuild()
    if (this.data.busy) return
    if (!L.coversFrame(this.cropState())) {
      return this.setData({ error: { code: 'PARAM_INVALID', message: '取景框超出图片范围，请放大图片或拖动后再裁剪（避免出现黑边）' } })
    }
    this.setData({ busy: true, error: null, result: null })
    track.track('tool_run_start', { toolId: TOOL_ID })
    const t0 = Date.now()
    this.render()
      .then((r) => {
        track.track('tool_run_success', { toolId: TOOL_ID, costMs: Date.now() - t0, engine: 'client' })
        this.setData({
          busy: false,
          result: {
            kind: 'image',
            images: [{ url: r.path, label: r.width + '×' + r.height + ' · ' + P.formatBytes(r.size) }],
            compareBefore: this.data.file.path,
            meta: r.width + '×' + r.height + ' · ' + P.formatBytes(r.size) + ' · ' + ((Date.now() - t0) / 1000).toFixed(1) + 's',
            showSave: true,
            showCopy: false,
            share: true
          },
          outPath: r.path,
          exact: r
        })
      })
      .catch((e) => {
        const err = P.asContractError(e, 'IMAGE_TOO_BIG')
        track.track('tool_run_fail', { toolId: TOOL_ID, code: err.code })
        this.setData({ busy: false, error: err })
      })
  },

  async render() {
    const v = this.data.values
    const out = this.outputSize()
    const plan = P.planSize(out.width, out.height, 8192)
    const canvas = await P.getCanvas()
    try {
      const node = await P.decode(canvas, this.data.file.path)
      canvas.width = plan.width
      canvas.height = plan.height
      const ctx = canvas.getContext('2d')
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, plan.width, plan.height)
      if (v.outputFormat === 'jpg') {
        ctx.fillStyle = '#FFFFFF'
        ctx.fillRect(0, 0, plan.width, plan.height)
      }
      const m = L.cropMatrix(this.cropState(), plan.width, plan.height)
      if (!m) throw { code: 'PARAM_INVALID', message: '取景数据无效，请重新选择图片' }
      ctx.imageSmoothingEnabled = true
      if (typeof ctx.imageSmoothingQuality === 'string') ctx.imageSmoothingQuality = 'high'
      ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f)
      ctx.drawImage(node, 0, 0)
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      const res = await P.exportCanvas(canvas, {
        fileType: v.outputFormat === 'png' ? 'png' : 'jpg',
        quality: (Number(v.quality) || 90) / 100,
        width: plan.width,
        height: plan.height
      })
      return { path: res.path, size: res.size, width: plan.width, height: plan.height }
    } finally {
      P.release(canvas)
    }
  },

  onSave() {
    if (!this.data.outPath) return
    const that = this
    P.saveToAlbum(this.data.outPath, 'image')
      .then(() => track.track('result_save', { toolId: TOOL_ID }))
      .catch((e) => that.setData({ error: e }))
  },

  onResultAction(e) {
    const d = e.detail || {}
    if (d.action === 'use-tool' && d.toolId) {
      const entry = registry.entryPath(d.toolId)
      if (entry) wx.navigateTo({ url: entry + '?toolId=' + d.toolId + '&from=crop' })
    }
  },

  /** 内置示例：常用裁剪组合（C9-6） */
  onSample() {
    const presets = [
      { ratio: '1:1', presetSize: 'avatar', customW: 200, customH: 200, rotate: 0, flipH: false, flipV: false, showGrid: true, outputFormat: 'jpg', quality: 90 },
      { ratio: '3:4', presetSize: 'id-1', customW: 295, customH: 413, rotate: 0, flipH: false, flipV: false, showGrid: true, outputFormat: 'jpg', quality: 92 },
      { ratio: '900:383', presetSize: 'mp-cover', customW: 900, customH: 383, rotate: 90, flipH: true, flipV: false, showGrid: false, outputFormat: 'png', quality: 90 },
      { ratio: 'free', presetSize: 'custom', customW: 640, customH: 480, rotate: -45, flipH: false, flipV: false, showGrid: true, outputFormat: 'jpg', quality: 85 }
    ]
    this._sampleI = this._sampleI || 0
    const values = Object.assign({}, this.data.values, presets[this._sampleI % presets.length])
    this._sampleI++
    this.setData({ values })
    store.saveParams(TOOL_ID, values)
    this.rebuild()
    wx.showToast({ title: '已填入示例：' + values.presetSize, icon: 'none' })
  },

  onShellReady() {
    this.measure()
    if (this.data.file) this.rebuild()
  },

  onPreview() {
    if (this.data.outPath) wx.previewImage({ urls: [this.data.outPath] })
  },

  onShareAppMessage() {
    return { title: '图片裁剪：比例锁定与精确尺寸输出', path: '/packageImage/pages/crop/index?toolId=' + TOOL_ID + '&from=share' }
  },

  onUnload() {
    if (this._canvas) P.release(this._canvas)
  }
})
