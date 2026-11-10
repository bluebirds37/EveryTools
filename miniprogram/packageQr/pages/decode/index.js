// packageQr/pages/generate 的姊妹页 —— FR-QR-02 相册识码（自研解码，批量 ≤9）
const registry = require('../../../tools/registry')
const store = require('../../../utils/store')
const track = require('../../../utils/track')
const error = require('../../../utils/error')
const media = require('../../../utils/media')
const render = require('../../utils/qr-render')
const decoder = require('../../utils/qr-decoder')

const TOOL_ID = 'qr-decode'
const MAX_SIDE = 1024

function defaults() {
  return { tryInverted: true, downscale: true }
}

const SCHEMA = [
  { key: 'tryInverted', label: '反色尝试', type: 'switch', def: true, hint: '深色底浅色码（反白码）时开启' },
  { key: 'downscale', label: '大图降采样', type: 'switch', def: true, hint: '长边超过 1024px 先缩小，提速明显' }
]

Page({
  data: {
    toolId: TOOL_ID,
    tool: null,
    values: defaults(),
    schema: SCHEMA,
    tips: [
      '支持一次最多 9 张相册截图；识别按图片顺序展示成功/未识别',
      '内置灰度 → 自适应二值化 → 反色多组预处理，反白码也能读',
      '识别出的链接不会自动打开，仅提供复制与「生成二维码」串联'
    ],
    files: [],
    busy: false,
    progressText: '',
    items: [],
    summaryText: '',
    resultMeta: '',
    error: null
  },

  onLoad(query) {
    const q = query || {}
    this.setData({ tool: registry.get(q.toolId || TOOL_ID), values: Object.assign(defaults(), store.params(TOOL_ID) || {}) })
    track.track('tool_open', { toolId: TOOL_ID, from: q.from || 'menu' })
  },

  onParamChange(e) {
    const values = Object.assign({}, this.data.values)
    values[e.detail.key] = e.detail.value
    this.setData({ values: values })
    store.saveParams(TOOL_ID, values)
  },

  onPick(e) {
    this.setData({ files: (e.detail && e.detail.files) || [], error: null })
  },
  onPickError(e) {
    const d = e.detail || {}
    this.setData({ error: { code: d.code || 'FILE_TOO_LARGE', message: d.message || error.message(d.code) } })
  },

  async onRun() {
    if (this.data.busy) return
    const files = this.data.files
    if (!files.length) return this.setData({ error: { code: 'INPUT_EMPTY', message: error.message('INPUT_EMPTY') }, items: [] })
    this.setData({ busy: true, error: null, items: [], progressText: '准备识别…' })
    track.track('tool_run_start', { toolId: TOOL_ID, count: files.length })
    const t0 = Date.now()
    const self = this
    const items = []
    let canvas = null
    try {
      canvas = await media.makeOffscreen()
      for (let i = 0; i < files.length; i++) {
        if (!self.data.busy) break // 用户离开/清空
        self.setData({ progressText: '正在识别 ' + (i + 1) + '/' + files.length })
        items.push(await self.decodeOne(canvas, files[i], i))
        self.setData({ items: items.slice() })
      }
      const okCount = items.filter(function (x) { return x.ok }).length
      const summary = items
        .filter(function (x) { return x.ok })
        .map(function (x, i) { return (i + 1) + '. ' + x.text })
        .join('\n')
      track.track('tool_run_success', { toolId: TOOL_ID, costMs: Date.now() - t0, engine: 'client', ok: okCount })
      store.bumpUsage(TOOL_ID)
      self.setData({
        busy: false,
        progressText: '',
        items: items,
        summaryText: summary,
        resultMeta: '共 ' + items.length + ' 张 · 成功 ' + okCount + ' 张 · 耗时 ' + (Date.now() - t0) + 'ms'
      })
    } catch (e) {
      const n = error.normalize(e, 'TASK_FAILED')
      track.track('tool_run_fail', { toolId: TOOL_ID, code: n.code })
      self.setData({ busy: false, progressText: '', error: { code: n.code, message: n.message } })
    } finally {
      if (canvas) media.release(canvas)
    }
  },

  /** 单张：解码像素 → 降采样绘制 → 灰度 → decoder.decodeSafe */
  async decodeOne(canvas, file, index) {
    const base = { index: index, thumb: file.path, ok: false, text: '', reason: '' }
    try {
      const img = await media.loadImage(canvas, file.path)
      const fit = this.data.values.downscale ? media.fitInside(img.width, img.height, MAX_SIDE) : { width: img.width, height: img.height }
      const scale = media.pixelScale(fit.width, fit.height)
      const w = Math.max(1, Math.round(fit.width * scale))
      const h = Math.max(1, Math.round(fit.height * scale))
      const pre = media.prepare(canvas, w, h)
      pre.ctx.drawImage(img.node, 0, 0, w, h)
      const data = pre.ctx.getImageData(0, 0, w, h).data
      const gray = render.toGray({ width: w, height: h, data: data })
      const r = decoder.decodeSafe({ width: w, height: h, gray: gray }, { tryInverted: !!this.data.values.tryInverted })
      if (r.ok) {
        base.ok = true
        base.text = r.text
        base.meta = 'v' + r.version + ' · ECC ' + r.ecc + ' · ' + r.preprocess
      } else {
        base.reason = r.message || '未识别到二维码'
      }
    } catch (e) {
      const n = error.normalize(e, 'IMAGE_TOO_BIG')
      base.reason = n.message
    }
    return base
  },

  onCopyOne(e) {
    const item = this.data.items[Number(e.currentTarget.dataset.index)]
    if (!item || !item.ok) return
    this.copyText(item.text)
  },

  onCopyAll() {
    const lines = this.data.items
      .filter(function (x) { return x.ok })
      .map(function (x, i) { return (i + 1) + '. ' + x.text })
    if (!lines.length) return
    this.copyText(lines.join('\n'))
  },

  copyText(text) {
    wx.setClipboardData({
      data: text,
      success: function () {
        track.track('result_copy', { toolId: TOOL_ID })
        wx.showToast({ title: '已复制', icon: 'success' })
      }
    })
  },

  /** 串联 FR-QR-01：把识别到的内容带到生成页（经参数记忆通道） */
  onRegen(e) {
    const item = this.data.items[Number(e.currentTarget.dataset.index)]
    if (!item || !item.ok) return
    const saved = store.params('qr-generate') || {}
    store.saveParams('qr-generate', Object.assign(saved, { type: 'text', content: item.text }))
    track.openTool('qr-generate', TOOL_ID)
  },

  onClear() {
    this.setData({ files: [], items: [], summaryText: '', resultMeta: '', error: null, busy: false, progressText: '' })
  },

  onShareAppMessage() {
    return { title: '相册识码 · 截图里的二维码也能扫', path: '/packageQr/pages/decode/index?toolId=' + TOOL_ID + '&from=share' }
  }
})
