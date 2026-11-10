const TOOL_ID = 'image-colorpick'
const registry = require('../../../tools/registry')
const store = require('../../../utils/store')
const track = require('../../../utils/track')
const error = require('../../../utils/error')
const P = require('../../utils/processor')
const pal = require('../../utils/palette')
const media = require('../../../utils/media')

const MEMORY_MAX_SIDE = 2000 // 取色精度足够，同时控制内存

function defaults() {
  return { mode: 'pick', zoom: 4, magnifier: true, paletteN: 6 }
}

function schema() {
  return [
    { key: 'mode', label: '模式', type: 'segment', def: 'pick', options: [
      { value: 'pick', label: '取色' },
      { value: 'palette', label: '主色板' },
      { value: 'contrast', label: '对比度' }
    ] },
    { key: 'zoom', label: '放大镜倍率', type: 'segment', def: 4, options: [{ value: 2, label: '2x' }, { value: 4, label: '4x' }, { value: 8, label: '8x' }], showIf: { key: 'mode', in: ['pick'] } },
    { key: 'magnifier', label: '显示放大镜', type: 'switch', def: true, showIf: { key: 'mode', in: ['pick'] } },
    { key: 'paletteN', label: '主色数量', type: 'slider', min: 3, max: 10, step: 1, def: 6, showIf: { key: 'mode', in: ['palette'] } }
  ]
}

function validate(v, file) {
  if (!file) return { code: 'INPUT_EMPTY', message: error.message('INPUT_EMPTY') }
  const n = Number(v.paletteN)
  if (v.mode === 'palette' && !(n >= 3 && n <= 10)) return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { max: '主色数量 3–10' }) }
  return null
}

Page({
  data: {
    toolId: TOOL_ID,
    tool: null,
    schema: [],
    values: defaults(),
    file: null,
    busy: false,
    error: null,
    result: null,
    stage: { width: 0, height: 0 },
    img: { width: 0, height: 0 },
    fit: { w: 0, h: 0, left: 0, top: 0 },
    color: null,
    cross: { x: 0, y: 0, show: false },
    lensPath: '',
    formats: [],
    palette: [],
    shades: [],
    contrastA: '#FFFFFF',
    contrastB: '#000000',
    contrastSetB: false,
    contrast: null,
    wcag: null,
    tips: [
      '取色按原图像素读取，与截图取色一致（±2 通道值）',
      '点击色值行可复制到剪贴板',
      '主色板使用 Median-Cut，按占比排序',
      '对比度为 WCAG 2.1 相对亮度公式'
    ]
  },

  onLoad(query) {
    const tool = registry.get(TOOL_ID)
    this.setData({ tool, schema: schema(), values: Object.assign(defaults(), store.params(TOOL_ID) || {}) })
    track.track('tool_open', { toolId: TOOL_ID, from: query.from || 'menu' })
  },

  onReady() {
    this.measure()
  },

  measure() {
    const that = this
    wx.createSelectorQuery()
      .in(this)
      .select('#cp-stage')
      .boundingClientRect((rect) => {
        if (rect && rect.width) {
          that.setData({ stage: { width: rect.width, height: rect.height } })
          that.layout()
        }
      })
      .exec()
  },

  onParamChange(e) {
    const values = Object.assign({}, this.data.values, { [e.detail.key]: e.detail.value })
    this.setData({ values })
    store.saveParams(TOOL_ID, values)
    if (e.detail.key === 'mode' && values.mode === 'palette') this.buildPalette()
    if (e.detail.key === 'paletteN') this.buildPalette()
  },

  onFilesChange(e) {
    const f = (e.detail.files || [])[0]
    if (!f) return this.setData({ file: null, color: null, palette: [] })
    this.setData({ file: f, color: null, palette: [], formats: [] })
    const that = this
    if (f.width && f.height) {
      this.setData({ img: { width: f.width, height: f.height } })
      this.layout()
      this.prepare()
    } else {
      P.readInfo(f.path)
        .then((info) => {
          that.setData({ img: { width: info.width, height: info.height } })
          that.layout()
          that.prepare()
        })
        .catch((err) => that.setData({ error: P.asContractError(err, 'IMAGE_TOO_BIG') }))
    }
  },

  onFilesError(e) {
    this.setData({ error: { code: e.detail.code || 'FILE_TOO_LARGE', message: e.detail.message } })
  },

  /** 图片在舞台内的 contain 布局（屏幕坐标 → 源像素坐标依赖它） */
  layout() {
    const stage = this.data.stage
    const img = this.data.img
    if (!stage.width || !img.width) return
    const k = Math.min(stage.width / img.width, stage.height / img.height)
    const w = Math.round(img.width * k)
    const h = Math.round(img.height * k)
    this.setData({ fit: { w, h, left: Math.round((stage.width - w) / 2), top: Math.round((stage.height - h) / 2) } })
  },

  /** 把原图按上限尺寸画到离屏画布，留出 getImageData 数据（先绘制再取点，保证精度） */
  async prepare() {
    const canvas = await P.getCanvas()
    const that = this
    this._canvas = canvas
    try {
      const plan = P.planSize(this.data.img.width, this.data.img.height, MEMORY_MAX_SIDE)
      const node = await P.decode(canvas, this.data.file.path)
      canvas.width = plan.width
      canvas.height = plan.height
      const ctx = canvas.getContext('2d')
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, plan.width, plan.height)
      ctx.drawImage(node, 0, 0, plan.width, plan.height)
      this._plan = plan
      this._ctx = ctx
      this._node = node
      if (this.data.values.mode === 'palette') this.buildPalette()
    } catch (e) {
      that.setData({ error: P.asContractError(e, 'IMAGE_TOO_BIG') })
    }
  },

  /** 触点取色：舞台坐标 → 源像素 → getImageData */
  onStageTouch(e) {
    const t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0])
    if (!t || !this._ctx) return
    const fit = this.data.fit
    const px = t.clientX - this._stageLeft
    const py = t.clientY - this._stageTop
    if (px < 0 || py < 0 || px > fit.w || py > fit.h) return
    const sx = Math.min(this._plan.width - 1, Math.floor((px / fit.w) * this._plan.width))
    const sy = Math.min(this._plan.height - 1, Math.floor((py / fit.h) * this._plan.height))
    let d
    try {
      d = this._ctx.getImageData(sx, sy, 1, 1).data
    } catch (err) {
      this.setData({ error: { code: 'IMAGE_TOO_BIG', message: error.message('IMAGE_TOO_BIG') } })
      return
    }
    const c = pal.allFormats(d[0], d[1], d[2])
    this.setData({
      color: c,
      cross: { x: px, y: py, show: true },
      formats: [
        { key: 'HEX', value: c.hex },
        { key: 'RGB', value: c.rgb },
        { key: 'HSL', value: c.hsl },
        { key: 'HSV', value: c.hsv }
      ]
    })
    this.drawLens(sx, sy)
    if (this.data.values.mode === 'contrast') this.applyContrast(c.hex)
    if (!this._stageLeft) this.cacheStage()
  },

  onStageTouchStart(e) {
    this.cacheStage()
    this.onStageTouch(e)
  },

  cacheStage() {
    const that = this
    wx.createSelectorQuery()
      .in(this)
      .select('#cp-stage')
      .boundingClientRect((rect) => {
        if (rect) {
          that._stageLeft = rect.left
          that._stageTop = rect.top
        }
      })
      .exec()
  },

  /** 放大镜：把触点周围 (lens/zoom) 区域放大绘制到 lens 画布 */
  async drawLens(sx, sy) {
    if (!this.data.values.magnifier) return
    const zoom = Number(this.data.values.zoom) || 4
    const size = 48 // CSS px
    const src = Math.max(2, Math.round(size / zoom))
    const lens = await this.ensureLens()
    if (!lens) return
    const c = lens.canvas
    try {
      c.width = size
      c.height = size
      const ctx = c.getContext('2d')
      ctx.clearRect(0, 0, size, size)
      const node = await media.loadImage(c, this.data.file.path)
      const k = this._plan.width / this.data.img.width
      ctx.imageSmoothingEnabled = false
      ctx.drawImage(node, sx - src / 2, sy - src / 2, src, src, 0, 0, size, size)
      this._lensCanvas = c
    } catch (e) {
      /* 放大镜失败不影响取色主流程 */
    }
  },

  ensureLens() {
    const that = this
    return new Promise((resolve) => {
      if (that._lensCanvas) return resolve({ canvas: that._lensCanvas })
      wx.createSelectorQuery()
        .in(this)
        .select('#cp-lens')
        .fields({ node: true, size: true })
        .exec((res) => {
          const node = res && res[0] && res[0].node
          if (!node) return resolve(null)
          that._lensCanvas = node
          resolve({ canvas: node })
        })
    })
  },

  applyContrast(hex) {
    if (this.data.contrastPicking === 'b' || this.data.contrastSetB) {
      this.setData({ contrastB: hex, contrastSetB: false })
    } else {
      this.setData({ contrastA: hex, contrastSetB: true })
    }
    this.computeContrast()
  },

  onContrastInput(e) {
    const which = e.currentTarget.dataset.w
    const hex = String(e.detail.value || '').trim()
    if (!pal.hexToRgb(hex)) return
    const patch = {}
    patch[which === 'b' ? 'contrastB' : 'contrastA'] = hex.toUpperCase()
    this.setData(patch)
    this.computeContrast()
  },

  onSwap() {
    this.setData({ contrastA: this.data.contrastB, contrastB: this.data.contrastA })
    this.computeContrast()
  },

  computeContrast() {
    const ratio = pal.contrastRatio(this.data.contrastA, this.data.contrastB)
    this.setData({ contrast: ratio === null ? null : ratio.toFixed(3), wcag: pal.wcagLevel(ratio) })
  },

  /** Median-Cut 主色板 */
  buildPalette() {
    if (!this._ctx || !this._plan) return
    const n = Number(this.data.values.paletteN) || 6
    let imgData
    try {
      imgData = this._ctx.getImageData(0, 0, this._plan.width, this._plan.height)
    } catch (e) {
      this.setData({ error: { code: 'IMAGE_TOO_BIG', message: '该图片像素过多，请先用压缩或改尺寸后重试' } })
      return
    }
    const pixels = pal.samplePixels(imgData, 4000)
    const colors = pal.medianCut(pixels, n)
    this.setData({ palette: colors, shades: colors.length ? pal.shadeScale(colors[0].hex) : [] })
    track.track('tool_run_success', { toolId: TOOL_ID, engine: 'client', kind: 'palette' })
  },

  /** 内置示例：三组已知对比度（C9-6） */
  onSample() {
    const presets = [
      { contrastA: '#000000', contrastB: '#FFFFFF', note: '黑白 = 21.0（AAA）' },
      { contrastA: '#777777', contrastB: '#FFFFFF', note: '灰白 ≈ 4.48（仅大字 AA）' },
      { contrastA: '#3B5BFE', contrastB: '#FFFFFF', note: '品牌蓝白 ≈ 4.6（正文 AA）' },
      { contrastA: '#F59E0B', contrastB: '#101217', note: '琥珀深灰（大字 AAA）' }
    ]
    this._sampleI = this._sampleI || 0
    const p = presets[this._sampleI % presets.length]
    this._sampleI++
    this.setData({ 'values.mode': 'contrast', mode: 'contrast', contrastA: p.contrastA, contrastB: p.contrastB })
    const values = Object.assign({}, this.data.values, { mode: 'contrast' })
    store.saveParams(TOOL_ID, values)
    this.computeContrast()
    wx.showToast({ title: p.note, icon: 'none' })
  },

  onRun() {
    const v = this.data.values
    const invalid = validate(v, this.data.file)
    if (invalid) return this.setData({ error: invalid })
    if (!this._ctx) return this.prepare()
    if (v.mode === 'palette') return this.buildPalette()
    if (v.mode === 'contrast') return this.computeContrast()
    return this.setData({
      result: {
        kind: 'kv',
        kv: this.data.formats.length ? this.data.formats : [{ key: '提示', value: '点击或拖动图片取色' }],
        meta: '触点取色 · ' + (this._plan ? this._plan.width + '×' + this._plan.height : '')
      }
    })
  },

  onCopy(e) {
    const value = e.currentTarget.dataset.v
    if (!value) return
    const that = this
    P.copy(value)
      .then(() => {
        track.track('result_copy', { toolId: TOOL_ID })
        wx.showToast({ title: '已复制 ' + value, icon: 'none' })
      })
      .catch((err) => that.setData({ error: err }))
  },

  onPickSwatch(e) {
    const hex = e.currentTarget.dataset.hex
    this.setData({ contrastA: hex })
    this.computeContrast()
    wx.showToast({ title: '已作为前景色', icon: 'none' })
  },

  onPreview() {
    if (this.data.file) wx.previewImage({ urls: [this.data.file.path] })
  },

  onResultAction(e) {
    const d = e.detail || {}
    if (d.action === 'use-tool' && d.toolId) {
      const entry = registry.entryPath(d.toolId)
      if (entry) wx.navigateTo({ url: entry + '?toolId=' + d.toolId + '&from=colorpick' })
    }
  },

  onShareAppMessage() {
    return { title: '取色器：触点取色与主色板', path: '/packageImage/pages/colorpick/index?toolId=' + TOOL_ID + '&from=share' }
  },

  onCopyAll() {
    const rows = (this.data.result && this.data.result.kv) || this.data.formats || []
    const text = rows.map((r) => r.key + ': ' + r.value).join('\n')
    const that = this
    P.copy(text || '')
      .then(() => {
        track.track('result_copy', { toolId: TOOL_ID })
        wx.showToast({ title: '已复制', icon: 'none' })
      })
      .catch((err) => that.setData({ error: err }))
  },

  onUnload() {
    if (this._lensCanvas) {
      try {
        this._lensCanvas.width = 1
        this._lensCanvas.height = 1
      } catch (e) {
        /* 已回收 */
      }
    }
    if (this._canvas) P.release(this._canvas)
  }
})
