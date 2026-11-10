const registry = require('../../../tools/registry')
const store = require('../../../utils/store')
const track = require('../../../utils/track')
const error = require('../../../utils/error')
const numsys = require('../../utils/numsys')
const common = require('../../utils/common')

const TOOL_ID = 'text-radix'

const TIPS = [
  '任意 2–36 进制输入（支持负号、空格与下划线分组），十 / 二 / 八 / 十六同屏；二进制按 4 位分组便于读数',
  '32/64 位补码双列展示；有符号模式把超出符号位的无符号值折回负数解释',
  '位运算支持 AND / OR / XOR / NOT / 左移 / 算术右移 / 逻辑右移，按选定字宽截断，操作数 B 与 A 同进制',
  'BigInt 精确计算，2^64 级别也无精度损失；超出位宽时明确提示而不是静默溢出'
]

const SAMPLES = [
  { name: '2^63−1', value: '9223372036854775807', base: '10', width: '64', signed: true },
  { name: '负数补码', value: 'ffffffff', base: '16', width: '32', signed: true, bitB: '', bitOp: 'not' },
  { name: '位与 AND', value: '2a', base: '16', width: '32', signed: false, bitB: 'f0', bitOp: 'and' },
  { name: '超 64 位提示', value: '99999999999999999999999', base: '10', width: '64', signed: false }
]

const BIT_OPS = [
  { value: 'and', label: 'AND' },
  { value: 'or', label: 'OR' },
  { value: 'xor', label: 'XOR' },
  { value: 'not', label: 'NOT' },
  { value: 'shl', label: '<<' },
  { value: 'shrArith', label: '>> 算术' },
  { value: 'shrLogic', label: '>>> 逻辑' }
]

function defaults() {
  return { base: '10', baseCustom: '36', width: '64', signed: false, bitOp: 'and', bitB: '' }
}

function buildSchema() {
  return [
    { key: 'base', label: '输入进制', type: 'segment', def: '10', options: [{ value: '2', label: '二' }, { value: '8', label: '八' }, { value: '10', label: '十' }, { value: '16', label: '十六' }, { value: 'custom', label: '自定义' }] },
    { key: 'baseCustom', label: '自定义进制（2–36）', type: 'number', def: 36, min: 2, max: 36, step: 1, showIf: { key: 'base', in: ['custom'] } },
    { key: 'width', label: '位宽', type: 'segment', def: '64', options: [{ value: '32', label: '32 位' }, { value: '64', label: '64 位' }] },
    { key: 'signed', label: '有符号解释（按位宽补码）', type: 'switch', def: false }
  ]
}

function buildBitSchema() {
  return [
    { key: 'bitOp', label: '位运算（A = 上方输入值）', type: 'segment', def: 'and', options: BIT_OPS },
    { key: 'bitB', label: '操作数 B（与 A 同进制；移位时填位数）', type: 'textarea', def: '', rows: 1, placeholder: '如 f0 或 3', showIf: { key: 'bitOp', in: ['and', 'or', 'xor', 'shl', 'shrArith', 'shrLogic'] } }
  ]
}

/** 有符号解释：0 ≤ value ≤ 2^w−1 且 value > 2^(w−1)−1 时折回负数 */
function effectiveValue(c, width, signed) {
  if (!signed) return c.value
  const w = BigInt(width)
  const mask = (1n << w) - 1n
  if (c.value >= 0n && c.value <= mask && c.value > ((1n << (w - 1n)) - 1n)) {
    return numsys.toSignedWidth(c.value, width)
  }
  return c.value
}

Page({
  data: {
    tool: null,
    values: defaults(),
    input: '',
    schema: buildSchema(),
    bitSchema: buildBitSchema(),
    tips: TIPS,
    busy: false,
    result: null,
    error: null,
    convRows: [],
    bitRows: [],
    bitNote: '',
    samples: SAMPLES
  },

  onLoad(query) {
    const tool = registry.get(TOOL_ID)
    const saved = store.params(TOOL_ID) || {}
    const values = Object.assign(defaults(), saved)
    this.setData({
      tool: tool,
      values: values,
      input: values.__text || '',
      schema: buildSchema(),
      bitSchema: buildBitSchema()
    })
    track.track('tool_open', { toolId: TOOL_ID, from: query.from || 'menu' })
  },

  onParamChange(e) {
    const values = Object.assign({}, this.data.values)
    values[e.detail.key] = e.detail.value
    this.setData({ values: values, schema: buildSchema(), bitSchema: buildBitSchema() })
    this.remember(values)
  },

  remember(values) {
    store.saveParams(TOOL_ID, Object.assign({}, values, { __text: this.data.input }))
  },

  onInput(e) {
    this.setData({ input: e.detail.value })
    clearTimeout(this._saveTimer)
    this._saveTimer = setTimeout(function () {
      store.saveParams(TOOL_ID, Object.assign({}, this.data.values, { __text: this.data.input }))
    }.bind(this), 500)
  },

  onPaste() {
    wx.getClipboardData({
      success: (res) => {
        const v = String((res && res.data) || '')
        if (!v) return wx.showToast({ title: '剪贴板为空', icon: 'none' })
        this.setData({ input: v.slice(0, 512) })
      },
      fail: () => wx.showToast({ title: '无法读取剪贴板', icon: 'none' })
    })
  },

  onClearInput() {
    this.setData({ input: '', result: null, convRows: [], bitRows: [], bitNote: '', error: null })
  },

  onSample(e) {
    const s = SAMPLES[Number(e.currentTarget.dataset.index)]
    if (!s) return
    const values = Object.assign({}, this.data.values, {
      base: s.base,
      width: s.width || '64',
      signed: !!s.signed,
      bitOp: s.bitOp || 'and',
      bitB: s.bitB || ''
    })
    this.setData({
      input: s.value,
      values: values,
      schema: buildSchema(),
      bitSchema: buildBitSchema(),
      result: null, convRows: [], bitRows: [], bitNote: '', error: null
    })
    this.onRun()
  },

  resolveBase() {
    if (this.data.values.base === 'custom') {
      const n = Number(this.data.values.baseCustom)
      if (!(n >= 2 && n <= 36)) return null
      return n
    }
    return Number(this.data.values.base)
  },

  onRun() {
    if (this.data.busy) return
    const check = common.checkTextInput(this.data.input, '数值')
    if (check) {
      return this.setData({ error: { code: this.data.input ? 'PARAM_INVALID' : 'INPUT_EMPTY', message: check }, result: null, convRows: [], bitRows: [] })
    }
    if (this.data.input.length > 512) {
      return this.setData({ error: { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { reason: '数值文本超过 512 字符' }) }, result: null })
    }
    const base = this.resolveBase()
    if (!base) {
      return this.setData({ error: { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { reason: '自定义进制需在 2–36 之间' }) }, result: null })
    }
    const width = Number(this.data.values.width)
    this.setData({ busy: true, error: null, result: null, convRows: [], bitRows: [], bitNote: '' })
    track.track('tool_run_start', { toolId: TOOL_ID, base: String(base) })
    const t0 = Date.now()
    try {
      const c = numsys.convert(this.data.input, base)
      if (!c.ok) { const e = new Error(c.message); e.code = 'UNSUPPORTED_FORMAT'; throw e }
      const eff = effectiveValue(c, width, !!this.data.values.signed)
      const view = eff === c.value ? c : numsys.convert(eff.toString(10), 10)
      if (!view.ok) { const e = new Error(view.message); e.code = 'PARAM_INVALID'; throw e }
      const convRows = [
        { key: '十进制', value: view.decimal },
        { key: '二进制（分组）', value: view.binGrouped },
        { key: '八进制', value: view.octal },
        { key: '十六进制', value: view.hex },
        { key: width + ' 位补码 · 二进制', value: (width === 32 ? view.twos32Bin : view.twos64Bin) || '超出该位宽范围' },
        { key: width + ' 位补码 · 十六进制', value: (width === 32 ? view.twos32Hex : view.twos64Hex) || '超出该位宽范围' },
        { key: '解释方式', value: this.data.values.signed ? '有符号（超 2^' + (width - 1) + '−1 折回负数）' : '无符号 / 原值' }
      ]
      if (view.outOfRange32) convRows.push({ key: '32 位提示', value: '数值超出 32 位范围，仅 64 位列有效' })
      if (view.outOfRange64) convRows.push({ key: '64 位提示', value: '数值超出 64 位范围，补码列不显示（无静默溢出）' })

      const bit = this.runBitOp(base, width)
      const result = {
        text: '十进制: ' + view.decimal + '\n二进制: ' + view.binary + '\n八进制: ' + view.octal + '\n十六进制: ' + view.hex + (bit.rows.length ? '\n' + bit.rows.map(function (r) { return r.key + ': ' + r.value }).join('\n') : ''),
        meta: '进制转换 · ' + base + ' 进制 · ' + (Date.now() - t0) + 'ms · 端' + (view.outOfRange64 ? ' · 超 64 位' : '')
      }
      track.track('tool_run_success', { toolId: TOOL_ID, costMs: Date.now() - t0, engine: 'client' })
      this.setData({ result: result, convRows: convRows, bitRows: bit.rows, bitNote: bit.note, busy: false })
      this.remember(this.data.values)
    } catch (e) {
      const code = e.code || 'PARAM_INVALID'
      track.track('tool_run_fail', { toolId: TOOL_ID, code: code })
      this.setData({ busy: false, error: { code: code, message: e.message || error.message(code) } })
    }
  },

  runBitOp(base, width) {
    const op = this.data.values.bitOp
    const r = numsys.bitOp(this.data.input, base, String(this.data.values.bitB || ''), op, width)
    if (!r.ok) return { rows: [], note: '位运算未执行：' + r.message }
    return {
      note: '',
      rows: [
        { key: '结果 · 有符号', value: r.signed },
        { key: '结果 · 无符号', value: r.unsigned === null ? '—' : r.unsigned },
        { key: '结果 · 十六进制', value: r.hex },
        { key: '结果 · 二进制（分组）', value: r.binary }
      ]
    }
  },

  onCopy(e) {
    common.copyText((e.detail && e.detail.text) || '', TOOL_ID, track)
  },

  onShare() {
    track.track('result_share', { toolId: TOOL_ID })
    wx.showToast({ title: '点右上角「…」转发给朋友', icon: 'none' })
  },

  onShareAppMessage() {
    return { title: '进制转换 · 2–36 进制与位运算', path: '/packageText/pages/radix/index?toolId=' + TOOL_ID + '&from=share' }
  }
})

module.exports = { effectiveValue: effectiveValue }
