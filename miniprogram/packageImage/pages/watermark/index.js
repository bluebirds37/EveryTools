const TOOL_ID = 'image-watermark'
const registry = require('../../../tools/registry')
const store = require('../../../utils/store')
const track = require('../../../utils/track')
const error = require('../../../utils/error')
const request = require('../../../utils/request')
const task = require('../../../utils/video-task')
const P = require('../../utils/processor')
const W = require('../../utils/watermark')

const MAX_BATCH = 50
const SERVER_LONG_SIDE = 8192
const SERVER_BYTES = 15 * 1024 * 1024

const POS_LIST = [
  { value: 'tl', label: '左上' },
  { value: 'tc', label: '上中' },
  { value: 'tr', label: '右上' },
  { value: 'ml', label: '左中' },
  { value: 'mc', label: '居中' },
  { value: 'mr', label: '右中' },
  { value: 'bl', label: '左下' },
  { value: 'bc', label: '下中' },
  { value: 'br', label: '右下' }
]

function defaults() {
  return {
    type: 'text',
    text: '',
    fontSize: 32,
    color: '#FFFFFF',
    opacity: 60,
    stroke: true,
    strokeWidth: 2,
    shadow: false,
    position: 'br',
    margin: 24,
    tile: false,
    tileAngle: -30,
    tileGap: 120,
    logoScale: 20,
    quality: 90
  }
}

function schema() {
  return [
    { key: 'type', label: '水印类型', type: 'segment', def: 'text', options: [{ value: 'text', label: '文字' }, { value: 'logo', label: 'Logo 图片' }] },
    { key: 'text', label: '水印文字（可换行，≤60 字）', type: 'textarea', def: '', showIf: { key: 'type', in: ['text'] } },
    { key: 'fontSize', label: '字号（短边千分比）', type: 'slider', min: 10, max: 200, step: 1, def: 32, showIf: { key: 'type', in: ['text'] } },
    { key: 'logoScale', label: 'Logo 宽度占比', type: 'slider', unit: '%', min: 5, max: 60, step: 1, def: 20, showIf: { key: 'type', in: ['logo'] } },
    { key: 'color', label: '文字颜色', type: 'color', def: '#FFFFFF', showIf: { key: 'type', in: ['text'] } },
    { key: 'opacity', label: '不透明度', type: 'slider', unit: '%', min: 10, max: 100, step: 1, def: 60 },
    { key: 'stroke', label: '描边', type: 'switch', def: true, showIf: { key: 'type', in: ['text'] } },
    { key: 'strokeWidth', label: '描边宽度', type: 'slider', unit: 'px', min: 1, max: 12, step: 1, def: 2, showIf: { key: 'stroke', in: [true] } },
    { key: 'shadow', label: '阴影', type: 'switch', def: false, showIf: { key: 'type', in: ['text'] } },
    { key: 'margin', label: '边距', type: 'slider', unit: 'px', min: 0, max: 200, step: 1, def: 24, showIf: { key: 'tile', in: [false] } },
    { key: 'tile', label: '平铺水印', type: 'switch', def: false },
    { key: 'tileAngle', label: '平铺角度', type: 'slider', unit: '°', min: -90, max: 90, step: 1, def: -30, showIf: { key: 'tile', in: [true] } },
    { key: 'tileGap', label: '平铺间距', type: 'slider', unit: 'px', min: 20, max: 400, step: 1, def: 120, showIf: { key: 'tile', in: [true] } },
    { key: 'quality', label: '输出质量', type: 'slider', min: 10, max: 100, step: 1, def: 90 }
  ]
}

function validate(v, files, logo) {
  if (!files || !files.length) return { code: 'INPUT_EMPTY', message: error.message('INPUT_EMPTY') }
  if (files.length > MAX_BATCH) return { code: 'PARAM_INVALID', message: '批量最多 ' + MAX_BATCH + ' 张' }
  if (v.type === 'text') {
    if (!String(v.text || '').trim()) return { code: 'PARAM_INVALID', message: '请输入水印文字' }
    if (String(v.text).length > 60) return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { max: '文字不超过 60 字' }) }
    if (!P.parseHex(v.color)) return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { max: '颜色需为 HEX' }) }
  }
  if (v.type === 'logo' && !logo) return { code: 'INPUT_EMPTY', message: '请选择 Logo 图片' }
  return null
}

Page({
  data: {
    toolId: TOOL_ID,
    tool: null,
    schema: [],
    values: defaults(),
    files: [],
    logo: null,
    busy: false,
    error: null,
    result: null,
    items: [],
    posList: POS_LIST,
    pickFor: -1,
    progress: { percent: 0, text: '' },
    serverMode: false,
    serverReason: '',
    taskInfo: null
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
    this.refreshEngineHint()
  },

  onFilesChange(e) {
    const files = (e.detail.files || []).slice(0, MAX_BATCH)
    this.setData({ files, items: [], result: null, overrides: {} })
    this.refreshEngineHint()
  },

  onFilesError(e) {
    this.setData({ error: { code: e.detail.code || 'FILE_TOO_LARGE', message: e.detail.message } })
  },

  onLogoChange(e) {
    const f = (e.detail.files || [])[0]
    this.setData({ logo: f || null })
  },

  /** 点缩略图 → 为该张单独选择位置 */
  onPickItem(e) {
    const i = Number(e.currentTarget.dataset.i)
    this.setData({ pickFor: this.data.pickFor === i ? -1 : i })
  },

  onPickPos(e) {
    const pos = e.currentTarget.dataset.pos
    const i = this.data.pickFor
    if (i < 0) return this.setData({ values: Object.assign({}, this.data.values, { position: pos }) })
    const overrides = Object.assign({}, this.data.overrides || {})
    overrides[i] = pos
    this.setData({ overrides, pickFor: -1 })
    wx.showToast({ title: '第 ' + (i + 1) + ' 张已单独设置', icon: 'none' })
  },

  refreshEngineHint() {
    const files = this.data.files
    let server = false
    let reason = ''
    if (files.length > MAX_BATCH) {
      server = true
      reason = '批量超过 ' + MAX_BATCH + ' 张，改用云端'
    } else if (files.some((f) => (f.size || 0) > SERVER_BYTES)) {
      server = true
      reason = '存在超过 15MB 的图片，改用云端'
    } else if (files.some((f) => Math.max(f.width || 0, f.height || 0) > SERVER_LONG_SIDE)) {
      server = true
      reason = '存在超长边图片，改用云端'
    }
    this.setData({ serverMode: server, serverReason: reason })
    if (server) track.track('engine_fallback', { toolId: TOOL_ID, to: 'server' })
  },

  /** 内置示例水印（C9-6） */
  onSample() {
    const presets = [
      { type: 'text', text: '© 通用工具箱', fontSize: 32, color: '#FFFFFF', opacity: 60, stroke: true, strokeWidth: 2, shadow: false, position: 'br', margin: 24, tile: false },
      { type: 'text', text: '机密\nCONFIDENTIAL', fontSize: 24, color: '#FF3B30', opacity: 22, stroke: false, shadow: false, tile: true, tileAngle: -30, tileGap: 120 },
      { type: 'text', text: '@toolbox 2026', fontSize: 44, color: '#22C3D6', opacity: 80, stroke: true, strokeWidth: 4, shadow: true, position: 'tc', margin: 40, tile: false },
      { type: 'text', text: '样张 · 禁止商用', fontSize: 60, color: '#FFFFFF', opacity: 40, stroke: true, strokeWidth: 2, shadow: false, tile: true, tileAngle: 45, tileGap: 60 }
    ]
    this._sampleI = this._sampleI || 0
    const values = Object.assign({}, this.data.values, presets[this._sampleI % presets.length])
    this._sampleI++
    this.setData({ values })
    store.saveParams(TOOL_ID, values)
    wx.showToast({ title: '已填入示例 ' + this._sampleI, icon: 'none' })
  },

  onRun() {
    const v = this.data.values
    const invalid = validate(v, this.data.files, this.data.logo)
    if (invalid) return this.setData({ error: invalid })
    if (this.data.busy) return
    this.setData({ busy: true, error: null, result: null, items: [], progress: { percent: 1, text: '准备中' } })
    track.track('tool_run_start', { toolId: TOOL_ID, batch: this.data.files.length })
    this._t0 = Date.now()
    const job = this.data.serverMode ? this.runServer() : this.runClient()
    job
      .then((r) => {
        track.track('tool_run_success', { toolId: TOOL_ID, costMs: Date.now() - this._t0, engine: r.engine })
        this.present(r)
      })
      .catch((e) => {
        const err = P.asContractError(e, 'IMAGE_TOO_BIG')
        track.track('tool_run_fail', { toolId: TOOL_ID, code: err.code })
        this.setData({ busy: false, error: err })
      })
  },

  /** 单张水印参数（含该张的位置覆盖） */
  optFor(v, index, width, height) {
    const overrides = this.data.overrides || {}
    const short = Math.min(width, height)
    return {
      type: v.type,
      text: v.text,
      fontSize: W.fontSizePx(short, v.fontSize, 10),
      color: v.color,
      opacity: Number(v.opacity),
      stroke: !!v.stroke,
      strokeWidth: Number(v.strokeWidth) || 2,
      shadow: !!v.shadow,
      position: overrides[index] || v.position || 'br',
      margin: Math.round(((Number(v.margin) || 0) * short) / 900),
      tile: !!v.tile,
      tileAngle: Number(v.tileAngle),
      tileGap: Math.round(((Number(v.tileGap) || 120) * short) / 900),
      logoScale: Number(v.logoScale),
      width,
      height
    }
  },

  async runClient() {
    const v = this.data.values
    const canvas = await P.getCanvas()
    const logoNode = v.type === 'logo' ? await P.decode(canvas, this.data.logo.path) : null
    const items = []
    try {
      const results = await P.runSerial(
        this.data.files,
        async (file, index) => {
          const info = file.width ? file : await P.readInfo(file.path)
          const maxSide = Math.max(info.width, info.height) > 6000 ? 6000 : 0
          const opt = this.optFor(v, index, info.width, info.height)
          const res = await P.render({
            canvas,
            srcPath: file.path,
            width: info.width,
            height: info.height,
            maxSide,
            fit: 'cover',
            fileType: 'jpg',
            quality: (Number(v.quality) || 90) / 100,
            extraDraw: (ctx, c, dim) => {
              opt.width = dim.width
              opt.height = dim.height
              opt.fontSize = W.fontSizePx(Math.min(dim.width, dim.height), v.fontSize, 10)
              opt.margin = Math.round(((Number(v.margin) || 0) * Math.min(dim.width, dim.height)) / 900)
              opt.tileGap = Math.round(((Number(v.tileGap) || 120) * Math.min(dim.width, dim.height)) / 900)
              opt.logoNode = logoNode
              W.apply(ctx, opt)
            }
          })
          return {
            index,
            path: res.path,
            url: res.path,
            before: file.path,
            width: res.width,
            height: res.height,
            size: res.size,
            position: opt.position,
            tile: opt.tile,
            label: '第 ' + (index + 1) + ' 张 · ' + (opt.tile ? '平铺' : opt.position)
          }
        },
        ({ index, total }) => this.setData({ progress: { percent: Math.round(((index + 1) / total) * 100), text: '第 ' + (index + 1) + '/' + total + ' 张' } })
      )
      results.forEach((r) => (r.ok ? items.push(r.value) : items.push({ index: r.index, failed: true, code: r.code, message: r.message })))
    } finally {
      P.release(canvas)
    }
    return { engine: 'client', items }
  },

  async runServer() {
    const v = this.data.values
    const items = []
    for (let i = 0; i < this.data.files.length; i++) {
      const f = this.data.files[i]
      const t = await task.createTask({
        toolId: TOOL_ID,
        type: 'image-watermark',
        params: {
          type: v.type,
          text: v.text,
          fontSize: Number(v.fontSize),
          color: v.color,
          opacity: Number(v.opacity),
          position: (this.data.overrides && this.data.overrides[i]) || v.position,
          margin: Number(v.margin),
          tile: !!v.tile,
          tileAngle: Number(v.tileAngle),
          tileGap: Number(v.tileGap),
          logoScale: Number(v.logoScale)
        },
        filePath: f.path,
        onProgress: (p) => this.setData({ taskInfo: { stage: p.stage || 'upload', percent: Math.round((p.percent || 0) * 0.5), message: '第 ' + (i + 1) + ' 张上传' } })
      })
      this._taskId = t.taskId
      const res = await task.pollTask(t.taskId, { onProgress: (p) => this.setData({ taskInfo: { stage: p.stage || 'process', percent: 50 + Math.round((p.progress || 0) * 0.5), message: '云端加水印' } }) })
      const r = (res && res.result) || {}
      const url = r.url || (r.items && r.items[0] && r.items[0].url)
      if (!url) throw { code: 'TASK_FAILED', message: error.message('TASK_FAILED', { reason: '云端未返回结果' }) }
      const dl = await request.downloadToTemp(url)
      items.push({ index: i, path: dl, url: dl, before: f.path, label: '云端 · 第 ' + (i + 1) + ' 张' })
      this.setData({ items: items.slice(), progress: { percent: Math.round(((i + 1) / this.data.files.length) * 100), text: '云端完成 ' + (i + 1) } })
    }
    return { engine: 'server', items }
  },

  present(r) {
    const items = r.items.filter((i) => !i.failed)
    const failed = r.items.filter((i) => i.failed)
    if (!items.length) {
      const f = failed[0] || {}
      return this.setData({ busy: false, error: { code: f.code || 'IMAGE_TOO_BIG', message: f.message || error.message('IMAGE_TOO_BIG') } })
    }
    const single = items.length === 1 ? items[0] : null
    this.setData({
      busy: false,
      items,
      taskInfo: null,
      summary: { count: items.length, failed: failed.length, engine: r.engine, costMs: Date.now() - (this._t0 || Date.now()) },
      result: {
        kind: single ? 'image' : 'images',
        images: items.map((i) => ({ url: i.url || i.path, label: i.label })),
        compareBefore: single ? single.before : '',
        meta: items.length + ' 张 · ' + (r.engine === 'server' ? '云端' : '本机') + ' · ' + ((Date.now() - (this._t0 || Date.now())) / 1000).toFixed(1) + 's'
      }
    })
  },

  onSave() {
    const list = (this.data.items || []).filter((i) => i.path && !i.failed).map((i) => i.path)
    if (!list.length) return
    const that = this
    P.saveMany(list, 'image').then((r) => {
      track.track('result_save', { toolId: TOOL_ID, count: r.saved })
      wx.showToast({ title: r.saved === r.total ? '已保存到相册' : '已保存 ' + r.saved + '/' + r.total, icon: 'none' })
      if (r.denied) that.setData({ error: { code: 'PERMISSION_DENIED', message: error.message('PERMISSION_DENIED') } })
    })
  },

  onCancelTask() {
    if (this._taskId) task.cancelTask(this._taskId)
    this._taskId = ''
    this.setData({ busy: false, taskInfo: null })
  },

  onResultAction(e) {
    const d = e.detail || {}
    if (d.action === 'use-tool' && d.toolId) {
      const entry = registry.entryPath(d.toolId)
      if (entry) wx.navigateTo({ url: entry + '?toolId=' + d.toolId + '&from=watermark' })
    }
  },

  onPreviewBatch(e) {
    const i = Number(e.currentTarget.dataset.i) || 0
    const urls = (this.data.items || []).filter((x) => x.path).map((x) => x.path)
    if (urls.length) wx.previewImage({ urls, current: urls[Math.min(i, urls.length - 1)] })
  },

  onShareAppMessage() {
    return { title: '批量水印：文字与 Logo 平铺', path: '/packageImage/pages/watermark/index?toolId=' + TOOL_ID + '&from=share' }
  },

  onUnload() {
    if (this._canvas) P.release(this._canvas)
  }
})
