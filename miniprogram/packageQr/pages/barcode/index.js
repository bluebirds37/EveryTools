// packageQr/pages/barcode —— FR-QR-04 条形码生成（Code128/Code39/EAN13/ITF，自研表驱动编码）
// 所有码制统一输出「模块位串」（'1'=黑条 '0'=白空，1 位 = 1 模块），由同一渲染管线绘制导出。
const registry = require('../../../tools/registry')
const store = require('../../../utils/store')
const track = require('../../../utils/track')
const error = require('../../../utils/error')
const media = require('../../../utils/media')

const TOOL_ID = 'qr-barcode'

/** Code128 全部 107 个符号模式（值 0..106，末位 STOP 含终止条） */
const C128 = [
  '11011001100', '11001101100', '11001100110', '10010011000', '10010001100',
  '10001001100', '10011001000', '10011000100', '10001100100', '11001001000',
  '11001000100', '11000100100', '10110011100', '10011011100', '10011001110',
  '10111001100', '10011101100', '10011100110', '11001110010', '11001011100',
  '11001001110', '11011100100', '11001110100', '11101101110', '11101001100',
  '11100101100', '11100100110', '11101100100', '11100110100', '11100110010',
  '11011011000', '11011000110', '11000110110', '10100011000', '10001011000',
  '10001000110', '10110001000', '10001101000', '10001100010', '11010001000',
  '11000101000', '11000100010', '10110111000', '10110001110', '10001101110',
  '10111011000', '10111000110', '10001110110', '11101110110', '11010001110',
  '11000101110', '11011101000', '11011100010', '11011101110', '11101011000',
  '11101000110', '11100010110', '11101101000', '11101100010', '11100011010',
  '11100101000', '11100100010', '11101001000', '11101000010', '11100001010',
  '11101111010', '11000001010', '10100110000', '10100001100', '10010110000',
  '10010000110', '10000101100', '10000100110', '10110010000', '10110000100',
  '10011010000', '10011000010', '10000110100', '10000110010', '11000110010',
  '11001011010', '11001010010', '11001001110', '11011011110', '11011110110',
  '11110110110', '10101111000', '10100011110', '10001011110', '10111101000',
  '10111100010', '11110101000', '11110100010', '10111011110', '10111101110',
  '11101011110', '11110101110', '11010000100', '11010010000', '11010011100',
  '1100011101011'
]
const C128_START_B = 104
const C128_START_C = 105
const C128_STOP = 106

/** Code39：字符表 + 位模式（模块位串，bar/space 宽窄编码，与工业实现一致） */
const C39_CHARS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z', '-', '.', ' ', '$', '/', '+', '%', '*']
const C39_DEC = [20957, 29783, 23639, 30485, 20951, 29813, 23669, 20855, 29789, 23645, 29975, 23831, 30533, 22295, 30149, 24005, 21623, 29981, 23837, 22301, 30023, 23879, 30545, 22343, 30161, 24017, 21959, 30065, 23921, 22385, 29015, 18263, 29141, 17879, 29045, 18293, 17783, 29021, 18269, 17477, 17489, 17681, 20753, 35770]

/** EAN13：L/G/R 码表 + 首位数字决定的左侧奇偶结构 */
const EAN_L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011']
const EAN_G = ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111']
const EAN_R = ['1110010', '1100110', '1101100', '1000010', '1011100', '1001110', '1010000', '1000100', '1001000', '1110100']
const EAN_STRUCT = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL']

/** ITF：5 元素宽窄掩码（'1'=宽），条空交错 */
const ITF_MASK = ['00110', '10001', '01001', '11000', '00101', '10100', '01100', '00011', '10010', '01010']
const ITF_START = '1010'
const ITF_END = '11101'

function ean13Check(d12) {
  let sum = 0
  for (let i = 0; i < 12; i++) sum += Number(d12.charAt(i)) * (i % 2 === 0 ? 1 : 3)
  return (10 - (sum % 10)) % 10
}

function c39Pattern(ch) {
  const idx = C39_CHARS.indexOf(ch)
  if (idx < 0) return null
  return C39_DEC[idx].toString(2)
}

/** 各码制 → 模块位串；抛 {code:'PARAM_INVALID'/'INPUT_EMPTY'} 由页面统一展示 */
function encodeBarcode(symbology, value) {
  const v = String(value == null ? '' : value).trim()
  if (!v) throw errOf('INPUT_EMPTY')
  if (symbology === 'code128') return encodeCode128(v)
  if (symbology === 'code39') return encodeCode39(v)
  if (symbology === 'ean13') return encodeEan13(v)
  if (symbology === 'itf') return encodeItf(v)
  throw errOf('PARAM_INVALID', { field: '码制', range: 'code128/code39/ean13/itf' })
}

function encodeCode128(v) {
  if (v.length > 80) throw errOf('PARAM_INVALID', { field: '内容长度', range: '≤ 80 字符' })
  const values = []
  let start
  let mode = 'B'
  if (/^\d+$/.test(v) && v.length % 2 === 0) {
    start = C128_START_C
    mode = 'C'
    for (let i = 0; i < v.length; i += 2) values.push(Number(v.substr(i, 2)))
  } else {
    start = C128_START_B
    for (let i = 0; i < v.length; i++) {
      const code = v.charCodeAt(i)
      if (code < 32 || code > 126) throw errOf('PARAM_INVALID', { field: '内容', range: 'Code128B 仅支持 ASCII 可见字符（32–126）' })
      values.push(code - 32)
    }
  }
  let sum = start
  for (let i = 0; i < values.length; i++) sum += values[i] * (i + 1)
  const check = sum % 103
  let bits = C128[start]
  values.forEach(function (x) { bits += C128[x] })
  bits += C128[check] + C128[C128_STOP]
  return { bits: bits, text: v, note: 'Code128 集 ' + mode + ' · 校验值 ' + check, quiet: 10 }
}

function encodeCode39(v) {
  const up = v.toUpperCase()
  if (up.length > 40) throw errOf('PARAM_INVALID', { field: '内容长度', range: '≤ 40 字符' })
  let bits = c39Pattern('*')
  for (let i = 0; i < up.length; i++) {
    const p = c39Pattern(up.charAt(i))
    if (!p) throw errOf('PARAM_INVALID', { field: '内容', range: 'Code39 支持 0-9 A-Z - . 空格 $ / + %' })
    bits += '0' + p
  }
  bits += '0' + c39Pattern('*')
  return { bits: bits, text: '*' + up + '*', note: 'Code39 · 起始/终止符 *', quiet: 10 }
}

function encodeEan13(v) {
  if (!/^\d+$/.test(v)) throw errOf('PARAM_INVALID', { field: '内容', range: 'EAN13 仅数字' })
  let d = v
  let note = 'EAN13'
  if (v.length === 12) {
    d = v + ean13Check(v)
    note = 'EAN13 · 校验位 ' + d.charAt(12) + ' 已自动计算'
  } else if (v.length === 13) {
    if (ean13Check(v.slice(0, 12)) !== Number(v.charAt(12))) throw errOf('PARAM_INVALID', { field: '校验位', range: '第 13 位与算法值不一致' })
    note = 'EAN13 · 校验位验证通过'
  } else {
    throw errOf('PARAM_INVALID', { field: '内容长度', range: '12 位（自动补校验位）或 13 位' })
  }
  const par = EAN_STRUCT[Number(d.charAt(0))]
  let bits = '101'
  for (let i = 1; i <= 6; i++) bits += (par.charAt(i - 1) === 'L' ? EAN_L : EAN_G)[Number(d.charAt(i))]
  bits += '01010'
  for (let i = 7; i <= 12; i++) bits += EAN_R[Number(d.charAt(i))]
  bits += '101'
  const text = d.charAt(0) + ' ' + d.slice(1, 7) + ' ' + d.slice(7) + ' '
  return { bits: bits, text: text, note: note, quiet: 11 }
}

function encodeItf(v) {
  if (!/^\d+$/.test(v)) throw errOf('PARAM_INVALID', { field: '内容', range: 'ITF 仅数字（成对）' })
  let d = v
  let note = 'ITF 交叉二五码'
  if (d.length % 2 === 1) {
    d = '0' + d
    note = 'ITF · 位数为奇，已自动补前导 0'
  }
  if (d.length > 40) throw errOf('PARAM_INVALID', { field: '内容长度', range: '≤ 40 位' })
  let bits = ITF_START
  for (let i = 0; i < d.length; i += 2) {
    const m1 = ITF_MASK[Number(d.charAt(i))]
    const m2 = ITF_MASK[Number(d.charAt(i + 1))]
    for (let e = 0; e < 5; e++) {
      bits += m1.charAt(e) === '1' ? '111' : '1'
      bits += m2.charAt(e) === '1' ? '000' : '0'
    }
  }
  bits += ITF_END
  return { bits: bits, text: d, note: note, quiet: 10 }
}

function errOf(code, extra) {
  const e = new Error(error.message(code, extra))
  e.code = code
  e.extra = extra
  return e
}

function defaults() {
  return { symbology: 'code128', value: '', height: 80, moduleWidth: 2, showText: true, addQuiet: true }
}

const SCHEMA = [
  { key: 'symbology', label: '码制', type: 'segment', def: 'code128', options: [{ value: 'code128', label: 'Code128' }, { value: 'code39', label: 'Code39' }, { value: 'ean13', label: 'EAN13' }, { value: 'itf', label: 'ITF' }] },
  { key: 'value', label: '条码内容', type: 'textarea', def: '', placeholder: 'Code128：ASCII 文本；EAN13：12/13 位数字；ITF：数字成对', hint: 'EAN13 输 12 位会自动算校验位并显示' },
  { key: 'height', label: '条码高度', type: 'slider', def: 80, min: 40, max: 200, step: 4, unit: 'px', precision: 0 },
  { key: 'moduleWidth', label: '模块宽度', type: 'slider', def: 2, min: 1, max: 6, step: 1, unit: 'px', precision: 0 },
  { key: 'showText', label: '显示人类可读文字', type: 'switch', def: true },
  { key: 'addQuiet', label: '两侧留白（静区）', type: 'switch', def: true }
]

const SAMPLES = [
  { name: 'EAN13(12位)', v: { symbology: 'ean13', value: '400638133393' } },
  { name: 'Code128', v: { symbology: 'code128', value: 'TB-2026-000123' } },
  { name: 'ITF', v: { symbology: 'itf', value: '049000000006' } },
  { name: 'Code39', v: { symbology: 'code39', value: 'HELLO-39' } }
]

Page({
  data: {
    toolId: TOOL_ID,
    tool: null,
    values: defaults(),
    schema: SCHEMA,
    tips: [
      'Code128 自动选集：纯偶数位数字走 C 集，其余走 B 集（ASCII 32–126）',
      'EAN13 输入 12 位自动计算校验位；输入 13 位则校验位错误会拒绝生成',
      'ITF 内容为奇数位会自动补前导 0 凑成对',
      '生成后可用线下扫码枪 / wx.scanCode 复核'
    ],
    busy: false,
    result: null,
    error: null,
    samples: SAMPLES
  },

  onLoad(query) {
    const q = query || {}
    const values = Object.assign(defaults(), store.params(TOOL_ID) || {})
    this.setData({ tool: registry.get(q.toolId || TOOL_ID), values: values })
    track.track('tool_open', { toolId: TOOL_ID, from: q.from || 'menu' })
  },

  onParamChange(e) {
    const values = Object.assign({}, this.data.values)
    values[e.detail.key] = e.detail.value
    this.setData({ values: values })
    store.saveParams(TOOL_ID, values)
  },

  onSample(e) {
    const values = Object.assign({}, this.data.values, SAMPLES[Number(e.currentTarget.dataset.index)].v)
    this.setData({ values: values })
    store.saveParams(TOOL_ID, values)
    this.onRun()
  },

  async onRun() {
    if (this.data.busy) return
    const v = this.data.values
    this.setData({ busy: true, error: null })
    track.track('tool_run_start', { toolId: TOOL_ID })
    const t0 = Date.now()
    let canvas = null
    try {
      const enc = encodeBarcode(v.symbology, v.value)
      const mw = Math.max(1, Math.min(6, Math.round(Number(v.moduleWidth) || 2)))
      const quiet = v.addQuiet ? enc.quiet * mw : 0
      const barH = Math.max(40, Math.min(200, Math.round(Number(v.height) || 80)))
      const textH = v.showText ? 34 : 0
      const width = quiet * 2 + enc.bits.length * mw
      const height = barH + textH
      canvas = await media.makeOffscreen()
      const pre = media.prepare(canvas, width, height, '#FFFFFF')
      const ctx = pre.ctx
      ctx.fillStyle = '#000000' // 条码必须纯黑保证对比度（图像内容，非 UI 色）
      for (let i = 0; i < enc.bits.length; i++) {
        if (enc.bits.charAt(i) === '1') ctx.fillRect(quiet + i * mw, 0, mw, barH)
      }
      if (v.showText) {
        ctx.font = '16px Menlo, monospace'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(enc.text, width / 2, barH + textH / 2)
      }
      const out = await media.exportCanvas(canvas, { fileType: 'png', width: width, height: height })
      canvas = null
      const cost = Date.now() - t0
      track.track('tool_run_success', { toolId: TOOL_ID, costMs: cost, engine: 'client' })
      store.bumpUsage(TOOL_ID)
      this.setData({
        busy: false,
        result: {
          images: [{ url: out.path, label: '' }],
          kv: [
            { key: '码制', value: v.symbology.toUpperCase() },
            { key: '规格', value: enc.bits.length + ' 模块 × ' + width + '×' + height + ' px' },
            { key: '说明', value: enc.note },
            { key: '可读文字', value: enc.text }
          ],
          text: enc.text,
          meta: '静区 ' + (v.addQuiet ? enc.quiet * 2 + ' 模块' : '关') + ' · 耗时 ' + cost + 'ms · 引擎 client'
        }
      })
    } catch (e) {
      if (canvas) media.release(canvas)
      const n = error.normalize(e, e && e.code ? undefined : 'TASK_FAILED')
      track.track('tool_run_fail', { toolId: TOOL_ID, code: n.code })
      this.setData({ busy: false, error: { code: n.code, message: n.message } })
    }
  },

  onCopy() {
    const text = (this.data.result && this.data.result.text) || ''
    if (!text) return
    wx.setClipboardData({
      data: text,
      success: function () {
        track.track('result_copy', { toolId: TOOL_ID })
        wx.showToast({ title: '已复制', icon: 'success' })
      }
    })
  },

  onSave() {
    const path = this.data.result && this.data.result.images[0] && this.data.result.images[0].url
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

  onShareAppMessage() {
    return { title: '条形码生成 · Code128/EAN13/ITF/Code39', path: '/packageQr/pages/barcode/index?toolId=' + TOOL_ID + '&from=share' }
  }
})

module.exports = { encodeBarcode: encodeBarcode, ean13Check: ean13Check }
