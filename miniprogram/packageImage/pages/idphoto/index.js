const TOOL_ID = 'image-idphoto'
const registry = require('../../../tools/registry')
const store = require('../../../utils/store')
const track = require('../../../utils/track')
const error = require('../../../utils/error')
const P = require('../../utils/processor')
const L = require('../../utils/layout')
const M = require('../../utils/matte')

const SPEC_OPTIONS = L.ID_SPECS.map((s) => ({ value: s.id, label: s.name + ' ' + s.width + '×' + s.height }))
  .concat([{ value: 'custom', label: '自定义' }])

const BG_OPTIONS = [
  { value: 'white', label: '白底' },
  { value: 'blue', label: '蓝底' },
  { value: 'red', label: '红底' },
  { value: 'custom', label: '自定义' }
]

function defaults() {
  return {
    spec: '1inch',
    customW: 295,
    customH: 413,
    customMmW: 25,
    customMmH: 35,
    dpi: 300,
    bg: 'blue',
    bgCustom: '#438EDB',
    useBg: true,
    threshold: 18,
    quality: 92
  }
}

function schema() {
  return [
    { key: 'spec', label: '规格', type: 'chip', def: '1inch', options: SPEC_OPTIONS },
    { key: 'customW', label: '自定义宽', type: 'number', unit: 'px', min: 100, max: 2000, def: 295, showIf: { key: 'spec', in: ['custom'] } },
    { key: 'customH', label: '自定义高', type: 'number', unit: 'px', min: 100, max: 2000, def: 413, showIf: { key: 'spec', in: ['custom'] } },
    { key: 'customMmW', label: '宽（mm）', type: 'number', unit: 'mm', min: 10, max: 100, def: 25, showIf: { key: 'spec', in: ['custom'] } },
    { key: 'customMmH', label: '高（mm）', type: 'number', unit: 'mm', min: 10, max: 120, def: 35, showIf: { key: 'spec', in: ['custom'] } },
    { key: 'dpi', label: '打印分辨率', type: 'number', unit: 'dpi', min: 72, max: 600, def: 300, showIf: { key: 'spec', in: ['custom'] } },
    { key: 'bg', label: '底色', type: 'segment', def: 'blue', options: BG_OPTIONS, showIf: { key: 'useBg', in: [true] } },
    { key: 'bgCustom', label: '自定义底色', type: 'color', def: '#438EDB', showIf: { key: 'bg', in: ['custom'] } },
    { key: 'useBg', label: '替换底色（边缘取样）', type: 'switch', def: true },
    { key: 'threshold', label: '替换容差', type: 'slider', min: 5, max: 40, step: 1, def: 18, showIf: { key: 'useBg', in: [true] } },
    { key: 'quality', label: '输出质量', type: 'slider', min: 30, max: 100, step: 1, def: 92 }
  ]
}

function validate(v) {
  if (v.spec === 'custom') {
    const w = Number(v.customW)
    const h = Number(v.customH)
    if (!(w >= 100 && w <= 2000) || !(h >= 100 && h <= 2000)) return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { max: '自定义尺寸 100–2000px' }) }
    const d = Number(v.dpi)
    if (!(d >= 72 && d <= 600)) return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { max: 'DPI 72–600' }) }
  }
  if (v.bg === 'custom' && !P.parseHex(v.bgCustom)) return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { max: '底色需为 HEX' }) }
  const t = Number(v.threshold)
  if (!(t >= 5 && t <= 40)) return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { max: '替换容差 5–40' }) }
  return null
}

Page({
  data: {
    toolId: TOOL_ID,
    tool: null,
    schema: [],
    values: defaults(),
    file: null,
    img: { width: 0, height: 0 },
    busy: false,
    error: null,
    result: null,
    outPath: '',
    stage: { width: 0, height: 0 },
    frame: { x: 0, y: 0, w: 0, h: 0 },
    masks: { top: 0, bottom: 0, left: 0, right: 0, band: 0 },
    disp: { elW: 0, elH: 0, left: 0, top: 0, transform: '' },
    zoom: 1,
    panX: 0,
    panY: 0,
    sizeText: '',
    mmText: '',
    replaced: 0,
    hintBg: ''
  },

  onLoad(query) {
    const tool = registry.get(TOOL_ID)
    this.setData({ tool, schema: schema(), values: Object.assign(defaults(), store.params(TOOL_ID) || {}) })
    track.track('tool_open', { toolId: TOOL_ID, from: query.from || 'menu' })
    this.updateSizeText()
  },

  onReady() {
    this.measure()
  },

  measure() {
    const that = this
    wx.createSelectorQuery()
      .in(this)
      .select('#id-stage')
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
    this.updateSizeText()
    this.rebuild()
  },

  onFilesChange(e) {
    const f = (e.detail.files || [])[0]
    if (!f) return this.setData({ file: null })
    this.setData({ file: f, result: null, outPath: '', zoom: 1, panX: 0, panY: 0 })
    const that = this
    if (f.width && f.height) {
      this.setData({ img: { width: f.width, height: f.height } })
      this.rebuild()
    } else {
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

  /** 当前规格（px + mm + dpi） */
  spec() {
    const v = this.data.values
    if (v.spec === 'custom') {
      const dpi = Number(v.dpi) || 300
      const w = Math.max(100, Math.round(Number(v.customW) || 295))
      const h = Math.max(100, Math.round(Number(v.customH) || 413))
      return { id: 'custom', name: '自定义', width: w, height: h, mm: [Number(v.customMmW) || L.pxToMm(w, dpi), Number(v.customMmH) || L.pxToMm(h, dpi)], dpi }
    }
    return L.findSpec(v.spec) || L.findSpec('1inch')
  },

  bgHex() {
    const v = this.data.values
    if (v.bg === 'custom') return v.bgCustom
    return L.ID_BG[v.bg] || '#FFFFFF'
  },

  updateSizeText() {
    const s = this.spec()
    this.setData({
      sizeText: s.width + '×' + s.height + ' px',
      mmText: s.mm[0] + '×' + s.mm[1] + ' mm @' + s.dpi + 'dpi'
    })
  },

  rebuild() {
    const stage = this.data.stage
    const img = this.data.img
    const s = this.spec()
    if (!stage.width || !img.width || !s) return
    const ratio = s.width / s.height
    const maxW = stage.width * 0.72
    const maxH = stage.height * 0.9
    let fw = maxW
    let fh = Math.round(maxW / ratio)
    if (fh > maxH) {
      fh = maxH
      fw = Math.round(maxH * ratio)
    }
    const frame = { x: Math.round((stage.width - fw) / 2), y: Math.round((stage.height - fh) / 2), w: fw, h: fh }
    const base = Math.min(frame.w / img.width, frame.h / img.height)
    this._base = base
    const elW = Math.round(img.width * base)
    const elH = Math.round(img.height * base)
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
  },

  cssTransform() {
    const v = this.data.values
    return 'translate(' + this.data.panX + 'px,' + this.data.panY + 'px) rotate(' + (Number(v.rotate) || 0) + 'deg) scale(' + this.data.zoom + ')'
  },

  cropState() {
    const s = this.spec()
    return {
      imageWidth: this.data.img.width,
      imageHeight: this.data.img.height,
      baseScale: this._base || 1,
      zoom: this.data.zoom,
      rotate: 0,
      flipH: false,
      flipV: false,
      panX: this.data.panX,
      panY: this.data.panY,
      viewWidth: this.data.stage.width,
      viewHeight: this.data.stage.height,
      frame: this.data.frame
    }
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
    if (!s || s.n !== ts.length) return
    if (ts.length > 1) {
      const zoom = Math.max(0.3, Math.min(6, s.zoom * (this.pinchDist(ts) / s.dist)))
      this.setData({ zoom, disp: Object.assign({}, this.data.disp, { transform: this.cssTransform() }) })
    } else {
      const panX = s.panX + (ts[0].clientX - s.x)
      const panY = s.panY + (ts[0].clientY - s.y)
      this.setData({ panX, panY, disp: Object.assign({}, this.data.disp, { transform: this.cssTransform() }) })
    }
  },

  onTouchEnd() {
    this._start = null
  },

  onReset() {
    this.setData({ zoom: 1, panX: 0, panY: 0 })
    this.rebuild()
  },

  /** 内置示例规格（C9-6） */
  onSample() {
    const presets = [
      { spec: '1inch', bg: 'blue', useBg: true, threshold: 18, dpi: 300, quality: 92 },
      { spec: 'big-2inch', bg: 'white', useBg: true, threshold: 14, dpi: 300, quality: 95 },
      { spec: 'passport', bg: 'red', useBg: true, threshold: 20, dpi: 300, quality: 92 },
      { spec: 'usa-visa', bg: 'white', useBg: false, threshold: 18, dpi: 150, quality: 90 }
    ]
    this._sampleI = this._sampleI || 0
    const values = Object.assign({}, this.data.values, presets[this._sampleI % presets.length])
    this._sampleI++
    this.setData({ values })
    store.saveParams(TOOL_ID, values)
    this.updateSizeText()
    this.rebuild()
    wx.showToast({ title: '已填入示例：' + values.spec, icon: 'none' })
  },

  onRun() {
    const v = this.data.values
    if (!this.data.file) return this.setData({ error: { code: 'INPUT_EMPTY', message: error.message('INPUT_EMPTY') } })
    const invalid = validate(v)
    if (invalid) return this.setData({ error: invalid })
    if (this.data.busy) return
    this.setData({ busy: true, error: null, result: null, replaced: 0 })
    track.track('tool_run_start', { toolId: TOOL_ID })
    const t0 = Date.now()
    this.compose()
      .then((r) => {
        track.track('tool_run_success', { toolId: TOOL_ID, costMs: Date.now() - t0, engine: 'client' })
        const s = this.spec()
        this.setData({
          busy: false,
          outPath: r.path,
          replaced: r.replaced,
          result: {
            kind: 'image',
            images: [{ url: r.path, label: s.width + '×' + s.height }],
            compareBefore: this.data.file.path,
            meta: s.width + '×' + s.height + ' px · ' + s.mm[0] + '×' + s.mm[1] + ' mm · ' + P.formatBytes(r.size) + ' · ' + ((Date.now() - t0) / 1000).toFixed(1) + 's'
          }
        })
      })
      .catch((e) => {
        const err = P.asContractError(e, 'IMAGE_TOO_BIG')
        track.track('tool_run_fail', { toolId: TOOL_ID, code: err.code })
        this.setData({ busy: false, error: err })
      })
  },

  async compose() {
    const v = this.data.values
    const s = this.spec()
    const canvas = await P.getCanvas()
    try {
      const node = await P.decode(canvas, this.data.file.path)
      canvas.width = s.width
      canvas.height = s.height
      const ctx = canvas.getContext('2d')
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.fillStyle = this.bgHex()
      ctx.fillRect(0, 0, s.width, s.height)
      const m = L.cropMatrix(this.cropState(), s.width, s.height)
      if (!m) throw { code: 'PARAM_INVALID', message: '取景数据无效，请重新选择图片' }
      ctx.imageSmoothingEnabled = true
      if (typeof ctx.imageSmoothingQuality === 'string') ctx.imageSmoothingQuality = 'high'
      ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f)
      ctx.drawImage(node, 0, 0)
      ctx.setTransform(1, 0, 0, 1, 0, 0)

      let replaced = 0
      if (v.useBg) {
        const box = s.width * s.height
        if (box > 16000000) throw { code: 'IMAGE_TOO_BIG', message: error.message('IMAGE_TOO_BIG') }
        const imgData = ctx.getImageData(0, 0, s.width, s.height)
        const r = M.replaceBackground(imgData, { targetHex: this.bgHex(), threshold: Number(v.threshold) || 18 })
        replaced = r.replaced
        if (!r.sampled) {
          this.setData({ hintBg: '未能取样到边界底色，已保留原背景' })
        } else {
          this.setData({ hintBg: '' })
        }
        ctx.putImageData(imgData, 0, 0)
      }
      const res = await P.exportCanvas(canvas, { fileType: 'jpg', quality: (Number(v.quality) || 92) / 100, width: s.width, height: s.height })
      return { path: res.path, size: res.size, replaced }
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

  onPreview() {
    if (this.data.outPath) wx.previewImage({ urls: [this.data.outPath] })
  },

  onResultAction(e) {
    const d = e.detail || {}
    if (d.action === 'use-tool' && d.toolId) {
      const entry = registry.entryPath(d.toolId)
      if (entry) wx.navigateTo({ url: entry + '?toolId=' + d.toolId + '&from=idphoto' })
    }
  },

  onShareAppMessage() {
    return { title: '证件照尺寸：规格预设与底色替换', path: '/packageImage/pages/idphoto/index?toolId=' + TOOL_ID + '&from=share' }
  },

  onUnload() {
    if (this._canvas) P.release(this._canvas)
  }
})
