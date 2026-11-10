const TOOL_ID = 'image-cut'
const registry = require('../../../tools/registry')
const store = require('../../../utils/store')
const track = require('../../../utils/track')
const error = require('../../../utils/error')
const P = require('../../utils/processor')
const L = require('../../utils/layout')

function defaults() {
  return { cols: 3, rows: 3, fillEdge: true, fileType: 'jpg', quality: 92 }
}

function schema() {
  return [
    { key: 'cols', label: '列数', type: 'number', min: 2, max: 4, def: 3 },
    { key: 'rows', label: '行数', type: 'number', min: 2, max: 4, def: 3 },
    { key: 'fillEdge', label: '居中裁切（子图等尺寸）', type: 'switch', def: true },
    { key: 'fileType', label: '导出格式', type: 'segment', def: 'jpg', options: [{ value: 'jpg', label: 'JPG' }, { value: 'png', label: 'PNG' }] },
    { key: 'quality', label: '导出质量', type: 'slider', min: 10, max: 100, step: 1, def: 92, showIf: { key: 'fileType', in: ['jpg'] } }
  ]
}

function validate(v, file) {
  if (!file) return { code: 'INPUT_EMPTY', message: error.message('INPUT_EMPTY') }
  const c = Number(v.cols)
  const r = Number(v.rows)
  if (!(c >= 2 && c <= 4) || !(r >= 2 && r <= 4)) return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { max: '行列数 2–4' }) }
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
    cells: [],
    planText: '',
    progressText: '',
    saved: 0
  },

  onLoad(query) {
    const tool = registry.get(TOOL_ID)
    this.setData({ tool, schema: schema(), values: Object.assign(defaults(), store.params(TOOL_ID) || {}) })
    track.track('tool_open', { toolId: TOOL_ID, from: query.from || 'menu' })
  },

  onParamChange(e) {
    const values = Object.assign({}, this.data.values, { [e.detail.key]: e.detail.value })
    this.setData({ values })
    store.saveParams(TOOL_ID, values)
    this.updatePlan()
  },

  onFilesChange(e) {
    const f = (e.detail.files || [])[0]
    if (!f) return this.setData({ file: null, cells: [], result: null })
    this.setData({ file: f, result: null, cells: [] })
    const that = this
    if (f.width && f.height) {
      this.setData({ img: { width: f.width, height: f.height } })
      this.updatePlan()
    } else {
      P.readInfo(f.path)
        .then((info) => {
          that.setData({ img: { width: info.width, height: info.height } })
          that.updatePlan()
        })
        .catch((err) => that.setData({ error: P.asContractError(err, 'IMAGE_TOO_BIG') }))
    }
  },

  onFilesError(e) {
    this.setData({ error: { code: e.detail.code || 'FILE_TOO_LARGE', message: e.detail.message } })
  },

  updatePlan() {
    const v = this.data.values
    const img = this.data.img
    if (!img.width) return
    const plan = L.gridPlan(img.width, img.height, v.cols, v.rows, v.fillEdge)
    if (!plan) {
      this._plan = null
      return this.setData({
        planText: '',
        cells: [],
        error: { code: 'PARAM_INVALID', message: '图片太小（' + img.width + '×' + img.height + '），无法切成 ' + v.cols + '×' + v.rows + '，请减少行列数' }
      })
    }
    this._plan = plan
    this.setData({
      planText: plan.cols + '×' + plan.rows + ' = ' + plan.cells.length + ' 张 · 每张 ' + plan.cellWidth + '×' + plan.cellHeight + ' px' + (plan.edgeTrim ? '（居中裁切）' : ''),
      cells: plan.cells.map((c, i) => ({ index: i, label: '第 ' + (i + 1) + ' 张', sx: c.sx, sy: c.sy, sw: c.sw, sh: c.sh }))
    })
  },

  /** 内置示例切分（C9-6） */
  onSample() {
    const presets = [
      { cols: 3, rows: 3, fillEdge: true, fileType: 'jpg', quality: 92 },
      { cols: 2, rows: 2, fillEdge: true, fileType: 'jpg', quality: 90 },
      { cols: 4, rows: 2, fillEdge: false, fileType: 'png', quality: 100 },
      { cols: 3, rows: 2, fillEdge: true, fileType: 'jpg', quality: 85 }
    ]
    this._sampleI = this._sampleI || 0
    const values = Object.assign({}, this.data.values, presets[this._sampleI % presets.length])
    this._sampleI++
    this.setData({ values })
    store.saveParams(TOOL_ID, values)
    this.updatePlan()
    wx.showToast({ title: '已填入示例 ' + values.cols + '×' + values.rows, icon: 'none' })
  },

  onRun() {
    const v = this.data.values
    const invalid = validate(v, this.data.file)
    if (invalid) return this.setData({ error: invalid })
    if (this.data.busy) return
    this.updatePlan()
    if (!this._plan) return
    this.setData({ busy: true, error: null, result: null, saved: 0 })
    track.track('tool_run_start', { toolId: TOOL_ID })
    const t0 = Date.now()
    this.slice()
      .then((items) => {
        track.track('tool_run_success', { toolId: TOOL_ID, costMs: Date.now() - t0, engine: 'client' })
        const uniform = items.every((i) => i.width === items[0].width && i.height === items[0].height)
        this.setData({
          busy: false,
          cells: this.data.cells.map((c, i) => Object.assign({}, c, { path: items[i].path, url: items[i].path })),
          result: {
            kind: 'images',
            images: items.map((i) => ({ url: i.path, label: i.width + '×' + i.height })),
            meta: items.length + ' 张 · 每张 ' + items[0].width + '×' + items[0].height + (uniform ? ' · 尺寸一致' : ' · 尺寸不一致') + ' · ' + ((Date.now() - t0) / 1000).toFixed(1) + 's',
            showSave: true
          }
        })
      })
      .catch((e) => {
        const err = P.asContractError(e, 'IMAGE_TOO_BIG')
        track.track('tool_run_fail', { toolId: TOOL_ID, code: err.code })
        this.setData({ busy: false, error: err })
      })
  },

  /** 逐格 1:1 裁切导出（不缩放，避免二次失真）；行优先顺序 */
  async slice() {
    const v = this.data.values
    const plan = this._plan
    const canvas = await P.getCanvas()
    const out = []
    try {
      const node = await P.decode(canvas, this.data.file.path)
      for (let i = 0; i < plan.cells.length; i++) {
        const c = plan.cells[i]
        canvas.width = c.outWidth
        canvas.height = c.outHeight
        const ctx = canvas.getContext('2d')
        ctx.setTransform(1, 0, 0, 1, 0, 0)
        ctx.clearRect(0, 0, c.outWidth, c.outHeight)
        if (v.fileType === 'jpg') {
          ctx.fillStyle = '#FFFFFF'
          ctx.fillRect(0, 0, c.outWidth, c.outHeight)
        }
        ctx.drawImage(node, -c.sx, -c.sy)
        const res = await P.exportCanvas(canvas, {
          fileType: v.fileType,
          quality: (Number(v.quality) || 92) / 100,
          width: c.outWidth,
          height: c.outHeight
        })
        out.push({ path: res.path, size: res.size, width: c.outWidth, height: c.outHeight, index: i })
        this.setData({ progressText: '切分 ' + (i + 1) + '/' + plan.cells.length })
      }
    } finally {
      P.release(canvas)
    }
    return out
  },

  onSaveAll() {
    const list = (this.data.result && this.data.result.images ? this.data.result.images : []).map((i) => i.url)
    if (!list.length) return
    const that = this
    P.saveMany(list, 'image').then((r) => {
      that.setData({ saved: r.saved })
      track.track('result_save', { toolId: TOOL_ID, count: r.saved })
      wx.showToast({
        title: r.denied ? '授权被拒，已保存 ' + r.saved + '/' + r.total : '已保存 ' + r.saved + ' 张到相册',
        icon: 'none'
      })
      if (r.denied) {
        that.setData({ error: { code: 'PERMISSION_DENIED', message: error.message('PERMISSION_DENIED') + '（已完成 ' + r.saved + ' 张，可点重新授权）' } })
      }
    })
  },

  /** 合成单张长图预览（把格子按原顺序拼回，验证切分正确） */
  onComposeBack() {
    const items = (this.data.cells || []).filter((c) => c.path)
    if (!items.length) return
    wx.previewImage({ urls: items.map((c) => c.path), current: items[0].path })
  },

  onResultAction(e) {
    const d = e.detail || {}
    if (d.action === 'use-tool' && d.toolId) {
      const entry = registry.entryPath(d.toolId)
      if (entry) wx.navigateTo({ url: entry + '?toolId=' + d.toolId + '&from=cut' })
    }
  },

  onShareAppMessage() {
    return { title: '九宫格切图：朋友圈拼图神器', path: '/packageImage/pages/cut/index?toolId=' + TOOL_ID + '&from=share' }
  },

  onUnload() {
    if (this._canvas) P.release(this._canvas)
  }
})
