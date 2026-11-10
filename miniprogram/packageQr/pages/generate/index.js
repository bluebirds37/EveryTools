// packageQr/pages/generate —— FR-QR-01 二维码生成（自研编码 + 生成后回读自检）
const registry = require('../../../tools/registry')
const store = require('../../../utils/store')
const track = require('../../../utils/track')
const error = require('../../../utils/error')
const media = require('../../../utils/media')
const encoder = require('../../utils/qr-encoder')
const render = require('../../utils/qr-render')
const decoder = require('../../utils/qr-decoder')

const TOOL_ID = 'qr-generate'

function defaults() {
  return {
    type: 'text', content: '',
    ssid: '', password: '', security: 'WPA', hidden: false,
    vName: '', vPhone: '', vEmail: '', vOrg: '', vTitle: '', vAddress: '',
    smsNumber: '', smsBody: '', telNumber: '', lat: 30, lng: 120,
    size: 512, ecc: 'M', fg: '#000000', bg: '#FFFFFF', quiet: 4, label: '', logoRatio: 15
  }
}

const SAMPLES = [
  { name: '链接', v: { type: 'url', content: 'https://example.com/toolbox' } },
  { name: 'WiFi', v: { type: 'wifi', ssid: 'MyHome_5G', password: 'passw0rd!23', security: 'WPA', hidden: false } },
  { name: '名片', v: { type: 'vcard', vName: '张三', vPhone: '+8613800138000', vOrg: '某某科技', vTitle: '工程师', vEmail: 'zhang@example.com' } }
]

const TYPE_OPTIONS = [
  { value: 'text', label: '文本' }, { value: 'url', label: '链接' }, { value: 'wifi', label: 'WiFi' },
  { value: 'vcard', label: '名片' }, { value: 'sms', label: '短信' }, { value: 'tel', label: '电话' }, { value: 'geo', label: '位置' }
]

/** type → 内容输入区 schema（C4 param-form） */
function inputSchema(type) {
  if (type === 'text') return [{ key: 'content', label: '文本内容', type: 'textarea', def: '', placeholder: '输入要编码的文字，支持中文', hint: 'UTF-8 编码；过长内容会自动升版本' }]
  if (type === 'url') return [{ key: 'content', label: '链接', type: 'textarea', def: '', placeholder: 'https://example.com/page?a=1', hint: '必须以 http:// 或 https:// 开头' }]
  if (type === 'wifi') return [
    { key: 'ssid', label: 'WiFi 名称', type: 'textarea', def: '', placeholder: 'SSID' },
    { key: 'password', label: '密码', type: 'textarea', def: '', placeholder: '开放网络可不填' },
    { key: 'security', label: '加密方式', type: 'segment', def: 'WPA', options: [{ value: 'WPA', label: 'WPA/WPA2' }, { value: 'WEP', label: 'WEP' }, { value: 'nopass', label: '开放' }] },
    { key: 'hidden', label: '隐藏网络', type: 'switch', def: false }
  ]
  if (type === 'vcard') return [
    { key: 'vName', label: '姓名', type: 'textarea', def: '', placeholder: '必填（与电话至少填一项）' },
    { key: 'vPhone', label: '电话', type: 'textarea', def: '', placeholder: '+8613800138000' },
    { key: 'vEmail', label: '邮箱', type: 'textarea', def: '' },
    { key: 'vOrg', label: '公司', type: 'textarea', def: '' },
    { key: 'vTitle', label: '职位', type: 'textarea', def: '' },
    { key: 'vAddress', label: '地址', type: 'textarea', def: '' }
  ]
  if (type === 'sms') return [
    { key: 'smsNumber', label: '手机号', type: 'textarea', def: '', placeholder: '13800138000' },
    { key: 'smsBody', label: '短信内容', type: 'textarea', def: '' }
  ]
  if (type === 'tel') return [{ key: 'telNumber', label: '电话号码', type: 'textarea', def: '', placeholder: '+8613800138000' }]
  return [
    { key: 'lat', label: '纬度', type: 'number', def: 30, min: -90, max: 90, precision: 6, unit: '°' },
    { key: 'lng', label: '经度', type: 'number', def: 120, min: -180, max: 180, precision: 6, unit: '°' }
  ]
}

const STYLE_SCHEMA = [
  { key: 'size', label: '输出尺寸', type: 'slider', def: 512, min: 128, max: 2048, step: 64, unit: 'px', precision: 0 },
  { key: 'ecc', label: '纠错等级', type: 'segment', def: 'M', options: [{ value: 'L', label: 'L 7%' }, { value: 'M', label: 'M 15%' }, { value: 'Q', label: 'Q 25%' }, { value: 'H', label: 'H 30%' }], hint: '带 logo 时自动升到 H' },
  { key: 'fg', label: '前景色', type: 'color', def: '#000000' },
  { key: 'bg', label: '背景色', type: 'color', def: '#FFFFFF' },
  { key: 'quiet', label: '留白边距', type: 'slider', def: 4, min: 2, max: 8, step: 1, unit: '模块', precision: 0 },
  { key: 'label', label: '底部标注文字', type: 'textarea', def: '', placeholder: '可选，绘制在码下方' }
]

function wifiEsc(s) {
  return String(s || '').replace(/([\\;:,"])/g, '\\$1')
}
function vLine(s) {
  return String(s || '').replace(/[\r\n]+/g, ' ').trim()
}

/** 按 type 组装最终编码原文 */
function buildContent(v) {
  const t = v.type
  if (t === 'text' || t === 'url') return String(v.content || '').trim()
  if (t === 'wifi') {
    const sec = v.security === 'nopass' ? 'nopass' : v.security === 'WEP' ? 'WEP' : 'WPA'
    let s = 'WIFI:T:' + sec + ';S:' + wifiEsc(v.ssid) + ';'
    if (sec !== 'nopass') s += 'P:' + wifiEsc(v.password) + ';'
    if (v.hidden) s += 'H:true;'
    return s + ';'
  }
  if (t === 'vcard') {
    const lines = ['BEGIN:VCARD', 'VERSION:3.0']
    const name = vLine(v.vName)
    lines.push('FN:' + name)
    lines.push('N:' + name.split(/\s+/).reverse().join(';'))
    if (vLine(v.vPhone)) lines.push('TEL;TYPE=CELL:' + vLine(v.vPhone))
    if (vLine(v.vEmail)) lines.push('EMAIL:' + vLine(v.vEmail))
    if (vLine(v.vOrg)) lines.push('ORG:' + vLine(v.vOrg))
    if (vLine(v.vTitle)) lines.push('TITLE:' + vLine(v.vTitle))
    if (vLine(v.vAddress)) lines.push('ADR:;;' + vLine(v.vAddress).replace(/;/g, ' '))
    lines.push('END:VCARD')
    return lines.join('\r\n')
  }
  if (t === 'sms') return 'SMSTO:' + vLine(v.smsNumber) + ':' + String(v.smsBody || '').replace(/[\r\n]+/g, ' ')
  if (t === 'tel') return 'tel:' + vLine(v.telNumber)
  return 'geo:' + Number(v.lat).toFixed(6) + ',' + Number(v.lng).toFixed(6)
}

function validate(v, logoPath) {
  const content = buildContent(v)
  if (!content || !content.trim()) return { code: 'INPUT_EMPTY', message: error.message('INPUT_EMPTY') }
  if (v.type === 'url' && !/^https?:\/\/[^\s]+$/i.test(content)) {
    return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { field: '链接', range: '以 http:// 或 https:// 开头' }) }
  }
  if (v.type === 'wifi' && !vLine(v.ssid)) return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { field: 'WiFi 名称' }) }
  if (v.type === 'vcard' && !vLine(v.vName) && !vLine(v.vPhone)) {
    return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { field: '姓名/电话', range: '至少填一项' }) }
  }
  if ((v.type === 'sms' || v.type === 'tel') && !/^[+\d][\d\-() ]{2,}$/.test(vLine(v.type === 'sms' ? v.smsNumber : v.telNumber))) {
    return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { field: '号码', range: '数字/+ 开头' }) }
  }
  if (v.type === 'geo' && !(Number(v.lat) >= -90 && Number(v.lat) <= 90 && Number(v.lng) >= -180 && Number(v.lng) <= 180)) {
    return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { field: '经纬度', range: '纬度 -90~90，经度 -180~180' }) }
  }
  if (!render.isScannable(v.fg, v.bg)) {
    return { code: 'PARAM_INVALID', message: '前景色与背景色对比度不足，扫码可能失败，请加深前景/减浅背景' }
  }
  if (logoPath && !(Number(v.logoRatio) >= 5 && Number(v.logoRatio) <= 25)) {
    return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { field: 'logo 占比', range: '5–25%' }) }
  }
  return null
}

Page({
  data: {
    toolId: TOOL_ID,
    tool: null,
    values: defaults(),
    inputSchema: inputSchema('text'),
    styleSchema: STYLE_SCHEMA,
    typeOptions: TYPE_OPTIONS,
    tips: [
      '自研 QR 编码：版本 1–40、掩码 0–7，Byte/Alphanumeric/Numeric 模式自动选择，中文按 UTF-8',
      '生成后自动做「回读自检」，读出的内容与原文不一致会报错而非输出废码',
      '带 logo 时纠错等级自动升到 H，logo 占比超过 20% 扫码成功率下降',
      '前景/背景对比度不足时拒绝生成'
    ],
    logoPath: '',
    busy: false,
    result: null,
    error: null,
    samples: SAMPLES,
    ratioWarn: ''
  },

  onLoad(query) {
    const q = query || {}
    const tool = registry.get(q.toolId || TOOL_ID)
    const values = Object.assign(defaults(), store.params(TOOL_ID) || {})
    this.setData({
      tool: tool,
      values: values,
      inputSchema: inputSchema(values.type)
    })
    this.updateRatioWarn()
    track.track('tool_open', { toolId: TOOL_ID, from: q.from || 'menu' })
  },

  /** 类型快捷 chip（wxml 直接渲染，比 param-form 触控更大） */
  onParamChangeQuick(e) {
    const key = e.currentTarget.dataset.key
    const value = e.currentTarget.dataset.value
    this.onParamChange({ detail: { key: key, value: value } })
  },

  onParamChange(e) {
    const values = Object.assign({}, this.data.values)
    values[e.detail.key] = e.detail.value
    const patch = { values: values }
    if (e.detail.key === 'type') patch.inputSchema = inputSchema(values.type)
    this.setData(patch)
    this.updateRatioWarn()
    store.saveParams(TOOL_ID, values)
  },

  onLogoChange(e) {
    const files = (e.detail && e.detail.files) || []
    this.setData({ logoPath: files.length ? files[0].path : '' })
    this.updateRatioWarn()
  },
  onLogoError(e) {
    const d = e.detail || {}
    this.setData({ error: { code: d.code || 'FILE_TOO_LARGE', message: d.message || error.message('FILE_TOO_LARGE') } })
  },
  updateRatioWarn() {
    const r = Number(this.data.values.logoRatio)
    const warn = this.data.logoPath && r > 20 ? 'logo 占比超过 20%，可能影响扫码，请验证后再使用' : ''
    if (warn !== this.data.ratioWarn) this.setData({ ratioWarn: warn })
  },

  onSample(e) {
    const values = Object.assign(defaults(), store.params(TOOL_ID) || {}, SAMPLES[Number(e.currentTarget.dataset.index)].v)
    this.setData({ values: values, inputSchema: inputSchema(values.type), error: null })
    store.saveParams(TOOL_ID, values)
    this.onRun()
  },

  async onRun() {
    if (this.data.busy) return
    const v = this.data.values
    const invalid = validate(v, this.data.logoPath)
    if (invalid) return this.setData({ error: invalid, result: null })
    this.setData({ busy: true, error: null })
    track.track('tool_run_start', { toolId: TOOL_ID })
    const t0 = Date.now()
    const content = buildContent(v)
    let canvas = null
    try {
      const ecc = this.data.logoPath ? 'H' : v.ecc
      const qr = encoder.encode(content, { ecc: ecc })
      canvas = await media.makeOffscreen()
      let logoNode = null
      if (this.data.logoPath) logoNode = (await media.loadImage(canvas, this.data.logoPath)).node
      const px = Math.round(Number(v.size))
      const quiet = Math.round(Number(v.quiet))
      const labelH = v.label ? Math.round(px * 0.11) + 8 : 0
      const pre = media.prepare(canvas, px, px + labelH, v.bg)
      const drawn = render.drawToContext(pre.ctx, qr, {
        px: px,
        quiet: quiet,
        fg: v.fg,
        bg: v.bg,
        label: v.label,
        logoImage: logoNode,
        logoRatio: Number(v.logoRatio) / 100
      })
      const out = await media.exportCanvas(canvas, { fileType: 'png', width: drawn.width, height: drawn.height })
      canvas = null // exportCanvas 已释放
      this.selfCheck(qr, v)
      const cost = Date.now() - t0
      track.track('tool_run_success', { toolId: TOOL_ID, costMs: cost, engine: 'client' })
      store.bumpUsage(TOOL_ID)
      this.setData({
        busy: false,
        result: {
          path: out.path,
          images: [{ url: out.path, label: '' }],
          content: content,
          kv: [
            { key: '版本', value: 'v' + qr.version + '（' + qr.size + '×' + qr.size + '）' },
            { key: '纠错/模式', value: 'ECC ' + qr.ecc + ' · ' + qr.mode.toUpperCase() },
            { key: '输出', value: drawn.width + '×' + drawn.height + ' px · 回读自检通过' }
          ],
          meta: '耗时 ' + cost + 'ms · 引擎 client'
        }
      })
    } catch (e) {
      if (canvas) media.release(canvas)
      const n = error.normalize(e, 'TASK_FAILED')
      track.track('tool_run_fail', { toolId: TOOL_ID, code: n.code })
      this.setData({ busy: false, error: { code: n.code, message: n.message } })
    }
  },

  /** FR-QR-01 规则：生成后必须回读自检，矩阵像素 → 解码 → 与原文比对 */
  selfCheck(qr, v) {
    const pix = render.toPixels(qr, { moduleSize: 4, quiet: quietOf(v), fg: v.fg, bg: v.bg })
    const gray = render.toGray(pix)
    const r = decoder.decodeSafe({ width: pix.width, height: pix.height, gray: gray }, { tryInverted: false })
    if (!r.ok || r.text !== buildContent(v)) {
      const e = error.make('TASK_FAILED', { reason: '回读自检不一致，已阻止输出' })
      e.extra = { reason: '回读自检不一致' }
      throw e
    }
  },

  onCopy() {
    const text = (this.data.result && this.data.result.content) || ''
    if (!text) return
    wx.setClipboardData({
      data: text,
      success: function () {
        track.track('result_copy', { toolId: TOOL_ID })
        wx.showToast({ title: '已复制码内容', icon: 'success' })
      }
    })
  },

  onSave() {
    const path = this.data.result && this.data.result.path
    if (!path) return
    const self = this
    wx.saveImageToPhotosAlbum({
      filePath: path,
      success: function () {
        track.track('result_save', { toolId: TOOL_ID })
        wx.showToast({ title: '已保存到相册', icon: 'success' })
      },
      fail: function (e) {
        const n = error.normalize(e, 'PERMISSION_DENIED')
        self.setData({ error: { code: n.code, message: n.code === 'CANCELED' ? '已取消保存' : n.message } })
      }
    })
  },

  onPanelShare() {
    track.track('result_share', { toolId: TOOL_ID })
  },

  onShareAppMessage() {
    return { title: '二维码生成 · 文字/链接/WiFi 秒变码', path: '/packageQr/pages/generate/index?toolId=' + TOOL_ID + '&from=share' }
  }
})

function quietOf(v) {
  return Math.min(8, Math.max(2, Math.round(Number(v.quiet) || 4)))
}
