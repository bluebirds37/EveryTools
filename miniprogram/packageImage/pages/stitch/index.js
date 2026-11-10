const TOOL_ID = 'image-stitch'
const registry = require('../../../tools/registry')
const store = require('../../../utils/store')
const track = require('../../../utils/track')
const error = require('../../../utils/error')
const P = require('../../utils/processor')
const L = require('../../utils/layout')

const MAX_COUNT = 20

function defaults() {
  return { layout: 'vertical', gridCols: 2, gap: 10, padding: 0, bgColor: '#FFFFFF', align: 'center', maxSide: 4096 }
}

function schema() {
  return [
    { key: 'layout', label: '排列方式', type: 'segment', def: 'vertical', options: [
      { value: 'vertical', label: '纵向' },
      { value: 'horizontal', label: '横向' },
      { value: 'grid', label: '网格' },
      { value: 'nine', label: '九宫格' }
    ] },
    { key: 'gridCols', label: '网格列数', type: 'number', min: 1, max: 4, def: 2, showIf: { key: 'layout', in: ['grid'] } },
    { key: 'gap', label: '图片间距', type: 'slider', unit: 'px', min: 0, max: 100, step: 1, def: 10 },
    { key: 'padding', label: '外边距', type: 'slider', unit: 'px', min: 0, max: 100, step: 1, def: 0 },
    { key: 'align', label: '对齐', type: 'segment', def: 'center', options: [
      { value: 'start', label: '前对齐' },
      { value: 'center', label: '居中' },
      { value: 'end', label: '后对齐' }
    ] },
    { key: 'bgColor', label: '背景色', type: 'color', def: '#FFFFFF' },
    { key: 'maxSide', label: '输出长边上限', type: 'number', unit: 'px', min: 512, max: 8192, def: 4096 }
  ]
}

function validate(v, files) {
  if (!files || files.length < 2) return { code: 'INPUT_EMPTY', message: '请至少选择 2 张图片' }
  if (files.length > MAX_COUNT) return { code: 'PARAM_INVALID', message: '拼接最多 ' + MAX_COUNT + ' 张' }
  if (v.layout === 'nine' && files.length !== 9) return { code: 'PARAM_INVALID', message: '九宫格需要正好 9 张图片，当前 ' + files.length + ' 张' }
  const cols = Number(v.gridCols)
  if (v.layout === 'grid' && !(cols >= 1 && cols <= 4)) return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { max: '列数 1–4' }) }
  const ms = Number(v.maxSide)
  if (!(ms >= 512 && ms <= 8192)) return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { max: '长边上限 512–8192px' }) }
  if (!P.parseHex(v.bgColor)) return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { max: '背景色需为 HEX' }) }
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
    outPath: '',
    planInfo: '',
    hint: ''
  },

  onLoad(query) {
    const tool = registry.get(TOOL_ID)
    this.setData({ tool, schema: schema(), values: Object.assign(defaults(), store.params(TOOL_ID) || {}) })
    track.track('tool_open', { toolId: TOOL_ID, from: query.from || 'menu' })
  },

  onParamChange(e) {
    const values = Object.assign({}, this.data.values, { [e.detail.key]: e.detail.value })
    if (e.detail.key === 'layout' && values.layout === 'nine') values.gridCols = 3
    this.setData({ values })
    store.saveParams(TOOL_ID, values)
    this.previewPlan()
  },

  onFilesChange(e) {
    const files = (e.detail.files || []).slice(0, MAX_COUNT)
    this.setData({ files, result: null, outPath: '' })
    this.previewPlan()
  },

  onFilesError(e) {
    this.setData({ error: { code: e.detail.code || 'FILE_TOO_LARGE', message: e.detail.message } })
  },

  /** 点击缩略图把该图前移一位（顺序即拼接顺序） */
  onMove(e) {
    const i = Number(e.currentTarget.dataset.i)
    if (i <= 0) return
    const files = this.data.files.slice()
    const t = files.splice(i, 1)[0]
    files.splice(i - 1, 0, t)
    this.setData({ files })
    this.previewPlan()
  },

  onRemove(e) {
    const i = Number(e.currentTarget.dataset.i)
    const files = this.data.files.slice()
    files.splice(i, 1)
    this.setData({ files, result: null, outPath: '' })
    this.previewPlan()
  },

  async previewPlan() {
    const v = this.data.values
    if (this.data.files.length < 2) return this.setData({ planInfo: '', hint: '' })
    const that = this
    try {
      const infos = await this.readAll(this.data.files)
      const plan = L.stitchPlan(infos, this.planOpt(v))
      if (!plan) return
      that.setData({
        planInfo: plan.canvasWidth + '×' + plan.canvasHeight + ' px · ' + (plan.pixels / 1e6).toFixed(1) + 'M 像素',
        hint: plan.reduced ? '超出长边/像素上限，已自动降低缩放比例（maxSide 生效为 ' + plan.maxSideUsed + 'px）' : ''
      })
    } catch (e) {
      that.setData({ planInfo: '' })
    }
  },

  planOpt(v) {
    return {
      layout: v.layout,
      gridCols: v.layout === 'nine' ? 3 : Number(v.gridCols) || 2,
      gap: Number(v.gap) || 0,
      padding: Number(v.padding) || 0,
      align: v.align || 'center',
      maxSide: Number(v.maxSide) || 4096
    }
  },

  async readAll(files) {
    const out = []
    for (let i = 0; i < files.length; i++) {
      const f = files[i]
      if (f.width && f.height) out.push({ width: f.width, height: f.height })
      else {
        const info = await P.readInfo(f.path)
        out.push({ width: info.width, height: info.height })
      }
    }
    return out
  },

  /** 内置示例排版（C9-6） */
  onSample() {
    const presets = [
      { layout: 'vertical', gridCols: 2, gap: 10, padding: 20, bgColor: '#FFFFFF', align: 'center', maxSide: 4096 },
      { layout: 'grid', gridCols: 2, gap: 24, padding: 40, bgColor: '#0E1116', align: 'center', maxSide: 2048 },
      { layout: 'horizontal', gridCols: 3, gap: 0, padding: 0, bgColor: '#FFFFFF', align: 'end', maxSide: 4096 },
      { layout: 'nine', gridCols: 3, gap: 4, padding: 12, bgColor: '#FFFFFF', align: 'center', maxSide: 1080 }
    ]
    this._sampleI = this._sampleI || 0
    const values = Object.assign({}, this.data.values, presets[this._sampleI % presets.length])
    this._sampleI++
    this.setData({ values })
    store.saveParams(TOOL_ID, values)
    this.previewPlan()
    wx.showToast({ title: '已填入示例：' + values.layout, icon: 'none' })
  },

  onRun() {
    const v = this.data.values
    const invalid = validate(v, this.data.files)
    if (invalid) return this.setData({ error: invalid })
    if (this.data.busy) return
    this.setData({ busy: true, error: null, result: null, outPath: '' })
    track.track('tool_run_start', { toolId: TOOL_ID, batch: this.data.files.length })
    const t0 = Date.now()
    this.compose(v)
      .then((r) => {
        track.track('tool_run_success', { toolId: TOOL_ID, costMs: Date.now() - t0, engine: 'client' })
        this.setData({
          busy: false,
          outPath: r.path,
          hint: r.reduced ? '画布超出上限，已自动按 ' + r.maxSideUsed + 'px 重排' : '',
          result: {
            kind: 'image',
            images: [{ url: r.path, label: r.width + '×' + r.height }],
            meta: r.width + '×' + r.height + ' · ' + P.formatBytes(r.size) + ' · ' + this.data.files.length + ' 张 · ' + ((Date.now() - t0) / 1000).toFixed(1) + 's'
          }
        })
      })
      .catch((e) => {
        const err = P.asContractError(e, 'IMAGE_TOO_BIG')
        track.track('tool_run_fail', { toolId: TOOL_ID, code: err.code })
        this.setData({ busy: false, error: err })
      })
  },

  async compose(v) {
    const infos = await this.readAll(this.data.files)
    const opt = this.planOpt(v)
    const plan = L.stitchPlan(infos, opt)
    if (!plan) throw { code: 'PARAM_INVALID', message: '无法计算排版，请减少图片数量' }
    const canvas = await P.getCanvas()
    try {
      const sized = P.planSize(plan.canvasWidth, plan.canvasHeight, 0)
      canvas.width = sized.width
      canvas.height = sized.height
      const ctx = canvas.getContext('2d')
      const k = sized.width / plan.canvasWidth // 若再触发像素上限保护，整体等比缩放
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, sized.width, sized.height)
      ctx.fillStyle = v.bgColor || '#FFFFFF'
      ctx.fillRect(0, 0, sized.width, sized.height)
      if (typeof ctx.imageSmoothingQuality === 'string') ctx.imageSmoothingQuality = 'high'

      for (let i = 0; i < plan.cells.length; i++) {
        const cell = plan.cells[i]
        const file = this.data.files[cell.index]
        const node = await P.decode(canvas, file.path)
        // cover 填充单元格，等比不拉伸（cell 宽高已由同短边归一，比例与源图一致）
        const dw = cell.width * k
        const dh = cell.height * k
        ctx.drawImage(node, cell.x * k, cell.y * k, dw, dh)
      }
      const res = await P.exportCanvas(canvas, { fileType: 'jpg', quality: 0.92, width: sized.width, height: sized.height })
      return {
        path: res.path,
        size: res.size,
        width: sized.width,
        height: sized.height,
        reduced: plan.reduced || sized.width < plan.canvasWidth,
        maxSideUsed: plan.maxSideUsed
      }
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
      if (entry) wx.navigateTo({ url: entry + '?toolId=' + d.toolId + '&from=stitch' })
    }
  },

  onShareAppMessage() {
    return { title: '图片拼接：纵排横排网格九宫格', path: '/packageImage/pages/stitch/index?toolId=' + TOOL_ID + '&from=share' }
  },

  onUnload() {
    if (this._canvas) P.release(this._canvas)
  }
})
