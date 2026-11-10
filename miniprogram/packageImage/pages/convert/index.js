const TOOL_ID = 'image-convert'
const registry = require('../../../tools/registry')
const store = require('../../../utils/store')
const track = require('../../../utils/track')
const error = require('../../../utils/error')
const request = require('../../../utils/request')
const task = require('../../../utils/video-task')
const P = require('../../utils/processor')
const jpeg = require('../../utils/jpeg')

const MAX_BATCH = 20
const MEMORY_MAX_SIDE = 4096

const FORMATS = [
  { value: 'jpg', label: 'JPG' },
  { value: 'png', label: 'PNG' },
  { value: 'webp', label: 'WebP（需云端）' }
]

function defaults() {
  return { toFormat: 'png', bgColor: '#FFFFFF', quality: 90, cloudWebp: false }
}

function schema() {
  return [
    { key: 'toFormat', label: '目标格式', type: 'segment', def: 'png', options: FORMATS },
    { key: 'bgColor', label: '透明铺底色', type: 'color', def: '#FFFFFF', showIf: { key: 'toFormat', in: ['jpg'] } },
    { key: 'quality', label: '编码质量', type: 'slider', min: 10, max: 100, step: 1, def: 90, showIf: { key: 'toFormat', in: ['jpg', 'webp'] } }
  ]
}

function validate(v, files) {
  if (!files || !files.length) return { code: 'INPUT_EMPTY', message: error.message('INPUT_EMPTY') }
  if (files.length > MAX_BATCH) return { code: 'PARAM_INVALID', message: '单次最多 ' + MAX_BATCH + ' 张' }
  if (v.toFormat === 'webp' && !v.cloudWebp) {
    return { code: 'UNSUPPORTED_FORMAT', message: '本机 Canvas 不支持 WebP 编码，请开启「云端转 WebP」或选择 JPG / PNG' }
  }
  if (!P.parseHex(v.bgColor)) return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { max: '铺底色需为 HEX，如 #FFFFFF' }) }
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
    note: '',
    taskInfo: null
  },

  onLoad(query) {
    const tool = registry.get(TOOL_ID)
    this.setData({ tool, schema: schema(), values: Object.assign(defaults(), store.params(TOOL_ID) || {}) })
    track.track('tool_open', { toolId: TOOL_ID, from: query.from || 'menu' })
  },

  onParamChange(e) {
    const values = Object.assign({}, this.data.values, { [e.detail.key]: e.detail.value })
    if (e.detail.key === 'toFormat' && values.toFormat === 'webp') values.cloudWebp = true
    this.setData({ values })
    store.saveParams(TOOL_ID, values)
    this.updateNote()
  },

  onToggleCloud() {
    const values = Object.assign({}, this.data.values, { cloudWebp: !this.data.values.cloudWebp })
    if (values.toFormat !== 'webp' && !values.cloudWebp) values.toFormat = values.toFormat || 'png'
    this.setData({ values })
    store.saveParams(TOOL_ID, values)
    this.updateNote()
  },

  onFilesChange(e) {
    const files = (e.detail.files || []).slice(0, MAX_BATCH)
    this.setData({ files, items: [], result: null })
    this.updateNote()
  },

  onFilesError(e) {
    this.setData({ error: { code: e.detail.code || 'FILE_TOO_LARGE', message: e.detail.message } })
  },

  updateNote() {
    const v = this.data.values
    const f = this.data.files[0]
    let note = ''
    if (v.toFormat === 'webp') note = 'WebP 编码由云端完成（本机内核不支持导出 WebP）'
    else if (v.toFormat === 'jpg' && f && /png/i.test(f.format || '')) note = '源图可能含透明通道，转 JPG 会按所选底色铺底'
    else if (v.toFormat === 'png' && f && /jpg|jpeg/i.test(f.format || '')) note = 'JPG 转 PNG 体积通常增大（有损转无损），属正常现象'
    this.setData({ note })
  },

  onRun() {
    const v = this.data.values
    const invalid = validate(v, this.data.files)
    if (invalid) return this.setData({ error: invalid })
    if (this.data.busy) return
    this.setData({ busy: true, error: null, result: null, items: [], progress: { percent: 1, text: '准备中' } })
    track.track('tool_run_start', { toolId: TOOL_ID, batch: this.data.files.length })
    this._t0 = Date.now()
    const job = v.toFormat === 'webp' ? this.runServer() : this.runClient()
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

  async runClient() {
    const v = this.data.values
    const canvas = await P.getCanvas()
    const items = []
    try {
      const results = await P.runSerial(
        this.data.files,
        async (file, i) => {
          const info = file.width ? file : await P.readInfo(file.path)
          const long = Math.max(info.width, info.height)
          const maxSide = long > MEMORY_MAX_SIDE ? MEMORY_MAX_SIDE : 0
          const res = await P.render({
            canvas,
            srcPath: file.path,
            width: info.width,
            height: info.height,
            maxSide,
            fit: 'contain',
            bg: v.toFormat === 'jpg' ? v.bgColor : '',
            fileType: v.toFormat,
            quality: (Number(v.quality) || 90) / 100
          })
          const name = this.baseName(file.path) + '.' + (v.toFormat === 'jpg' ? 'jpg' : 'png')
          return {
            index: i,
            path: res.path,
            url: res.path,
            before: file.path,
            name,
            width: res.width,
            height: res.height,
            beforeSize: file.size || info.size || 0,
            afterSize: res.size,
            label: name + ' · ' + P.formatBytes(res.size),
            delta: (file.size || info.size || 0) - res.size,
            deltaKB: Math.round(Math.abs((file.size || info.size || 0) - res.size) / 1024)
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
      this.setData({ taskInfo: { stage: 'upload', percent: 0, message: '第 ' + (i + 1) + ' 张上传中' } })
      const t = await task.createTask({
        toolId: TOOL_ID,
        type: 'image-convert',
        params: { toFormat: 'webp', quality: Number(v.quality) || 90, bgColor: v.bgColor },
        filePath: f.path,
        onProgress: (p) => this.setData({ taskInfo: { stage: 'upload', percent: Math.round((p.percent || 0) * 0.5), message: '第 ' + (i + 1) + ' 张上传中' } })
      })
      this._taskId = t.taskId
      this.setData({ taskInfo: { stage: 'process', percent: 60, message: '云端转 WebP' } })
      const res = await task.pollTask(t.taskId, { onProgress: (p) => this.setData({ taskInfo: { stage: p.stage || 'process', percent: 60 + Math.round((p.progress || 0) * 0.4), message: '云端转换中' } }) })
      const result = (res && res.result) || {}
      const url = result.url || (result.items && result.items[0] && result.items[0].url)
      if (!url) throw { code: 'TASK_FAILED', message: error.message('TASK_FAILED', { reason: '云端未返回文件' }) }
      const dl = await request.downloadToTemp(url)
      items.push({
        index: i,
        path: dl,
        url: dl,
        before: f.path,
        name: this.baseName(f.path) + '.webp',
        beforeSize: f.size || 0,
        afterSize: Math.round((result.sizeMB || 0) * 1024 * 1024),
        label: this.baseName(f.path) + '.webp · ' + P.formatBytes(Math.round((result.sizeMB || 0) * 1024 * 1024)),
        engine: 'server'
      })
      this.setData({ items: items.slice(), progress: { percent: Math.round(((i + 1) / this.data.files.length) * 100), text: '云端完成 ' + (i + 1) } })
    }
    return { engine: 'server', items }
  },

  baseName(path) {
    const seg = String(path).split('/').pop() || 'image'
    return seg.replace(/\.[a-z0-9]+$/i, '') || 'image'
  },

  present(r) {
    const items = r.items.filter((i) => !i.failed)
    const failed = r.items.filter((i) => i.failed)
    if (!items.length) {
      const first = failed[0] || {}
      const code = first.code === 'IMAGE_TOO_BIG' || first.code === 'UNSUPPORTED_FORMAT' ? first.code : 'IMAGE_TOO_BIG'
      return this.setData({
        busy: false,
        error: { code, message: first.message || error.message(code, { format: 'WebP/TIFF/HEIF' }) }
      })
    }
    const inTotal = items.reduce((a, i) => a + (i.beforeSize || 0), 0)
    const outTotal = items.reduce((a, i) => a + (i.afterSize || 0), 0)
    const deltaPct = inTotal ? Math.round(((outTotal - inTotal) / inTotal) * 1000) / 10 : 0
    const single = items.length === 1 ? items[0] : null
    this.setData({
      busy: false,
      items,
      taskInfo: null,
      summary: { count: items.length, failed: failed.length, inText: P.formatBytes(inTotal), outText: P.formatBytes(outTotal), deltaPct, engine: r.engine },
      result: {
        kind: single ? 'image' : 'images',
        images: items.map((i) => ({ url: i.url || i.path, label: i.label })),
        compareBefore: single ? single.before : '',
        meta: (r.engine === 'server' ? '云端' : '本机') + ' · ' + P.formatBytes(inTotal) + ' → ' + P.formatBytes(outTotal)
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
      if (entry) wx.navigateTo({ url: entry + '?toolId=' + d.toolId + '&from=convert' })
    }
  },

  /** 内置示例（C9-6） */
  onSample() {
    const presets = [
      { toFormat: 'png', bgColor: '#FFFFFF', quality: 90, cloudWebp: false },
      { toFormat: 'jpg', bgColor: '#FFFFFF', quality: 85, cloudWebp: false },
      { toFormat: 'jpg', bgColor: '#1E1E24', quality: 95, cloudWebp: false },
      { toFormat: 'webp', bgColor: '#FFFFFF', quality: 80, cloudWebp: true }
    ]
    this._sampleI = this._sampleI || 0
    const values = Object.assign({}, this.data.values, presets[this._sampleI % presets.length])
    this._sampleI++
    this.setData({ values })
    store.saveParams(TOOL_ID, values)
    this.updateNote()
    wx.showToast({ title: '已填入示例：' + values.toFormat, icon: 'none' })
  },

  onShellReady() {
    this.updateNote()
  },

  onCheckHead() {
    // 供「格式确认」入口：读取文件头 magic number，解码失败时给出云端口径
    const f = this.data.files[0]
    if (!f) return
    const that = this
    jpeg
      .readHead(f.path, 64 * 1024)
      .then((bytes) => {
        const info = jpeg.analyze(bytes)
        wx.showModal({
          title: '文件头识别',
          content: '判定格式：' + info.format + (info.size ? '，原始尺寸 ' + info.size.width + '×' + info.size.height : ''),
          showCancel: false
        })
      })
      .catch((e) => that.setData({ error: { code: 'UNSUPPORTED_FORMAT', message: error.message('UNSUPPORTED_FORMAT', { format: '无法读取的文件头' }) } }))
  },

  onShareAppMessage() {
    return { title: '图片格式转换：JPG / PNG / WebP', path: '/packageImage/pages/convert/index?toolId=' + TOOL_ID + '&from=share' }
  },

  onUnload() {
    if (this._canvas) P.release(this._canvas)
  }
})
