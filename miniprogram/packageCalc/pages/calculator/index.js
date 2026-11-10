const registry = require('../../../tools/registry')
const store = require('../../../utils/store')
const track = require('../../../utils/track')
const error = require('../../../utils/error')
const calc = require('../../utils/calc-parser')

const TOOL_ID = 'calc-calculator'
const HIST_MAX = 50
const ERR_TEXT = {
  DIV_ZERO: '除数为 0，无法计算',
  DOMAIN: '参数超出函数定义域',
  RANGE: '数值超出可显示范围',
  SYNTAX: '表达式语法有误',
  UNKNOWN_FUNC: '不支持的函数'
}

const KEYS = [
  [{ k: 'C', t: 'fn' }, { k: '←', t: 'del' }, { k: '(', t: 'op' }, { k: ')', t: 'op' }, { k: '^', t: 'op' }, { k: '÷', t: 'op' }],
  [{ k: '7', t: 'num' }, { k: '8', t: 'num' }, { k: '9', t: 'num' }, { k: '×', t: 'op' }, { k: '%', t: 'op' }, { k: 'sin(', t: 'fn' }],
  [{ k: '4', t: 'num' }, { k: '5', t: 'num' }, { k: '6', t: 'num' }, { k: '-', t: 'op' }, { k: 'π', t: 'const' }, { k: 'cos(', t: 'fn' }],
  [{ k: '1', t: 'num' }, { k: '2', t: 'num' }, { k: '3', t: 'num' }, { k: '+', t: 'op' }, { k: 'e', t: 'const' }, { k: 'tan(', t: 'fn' }],
  [{ k: '0', t: 'num' }, { k: '.', t: 'num' }, { k: 'abs(', t: 'fn' }, { k: '/', t: 'op' }, { k: 'sqrt(', t: 'fn' }, { k: 'log(', t: 'fn' }]
]

function defaults() {
  return { expr: '', angle: 'deg', thousands: true }
}

function buildSchema() {
  return [
    { key: 'angle', label: '角度模式', type: 'segment', def: 'deg', options: [{ value: 'deg', label: '角度 DEG' }, { value: 'rad', label: '弧度 RAD' }] },
    { key: 'thousands', label: '结果千分位', type: 'switch', def: true }
  ]
}

function histOf(saved) {
  return Array.isArray(saved.__hist) ? saved.__hist.slice(0, HIST_MAX) : []
}

Page({
  data: {
    tool: null,
    values: defaults(),
    schema: buildSchema(),
    busy: false,
    result: null,
    error: null,
    keys: KEYS,
    hist: [],
    tips: [
      '自研词法+递归下降解析（不使用 eval），支持 + − × ÷ ( ) ^ % 与 sin/cos/tan/asin/acos/atan/ln/log/sqrt/abs/exp',
      'π、e 可直接点按；数字紧跟括号/常量视为相乘（如 2(3+1)=8、2π）',
      '% 为后缀运算：10% = 0.1',
      '历史最多保留 50 条并自动存储，点按可复用表达式'
    ]
  },

  onLoad(query) {
    const tool = registry.get(TOOL_ID)
    const saved = store.params(TOOL_ID) || {}
    this.setData({ tool: tool, values: Object.assign(defaults(), saved), hist: histOf(saved) })
    track.track('tool_open', { toolId: TOOL_ID, from: query.from || 'menu' })
  },

  save(vals) {
    const saved = store.params(TOOL_ID) || {}
    store.saveParams(TOOL_ID, Object.assign({}, vals, { __hist: saved.__hist || this.data.hist }))
  },

  onParamChange(e) {
    const values = Object.assign({}, this.data.values, { [e.detail.key]: e.detail.value })
    this.setData({ values: values })
    this.save(values)
    if (this.data.result) this.setData({ result: null })
  },

  onKey(e) {
    const key = e.currentTarget.dataset.k
    const type = e.currentTarget.dataset.t
    let expr = this.data.values.expr || ''
    if (type === 'C') expr = ''
    else if (type === 'del') expr = this.smartBackspace(expr)
    else expr = expr + key
    this.setData({ 'values.expr': expr, error: null, result: null })
    this.save(this.data.values)
  },

  smartBackspace(expr) {
    const multi = ['sin(', 'cos(', 'tan(', 'sqrt(', 'log(', 'abs(', 'π']
    for (let i = 0; i < multi.length; i++) {
      if (expr.slice(-multi[i].length) === multi[i]) return expr.slice(0, -multi[i].length)
    }
    return expr.slice(0, -1)
  },

  onExprInput(e) {
    this.setData({ 'values.expr': e.detail.value })
    this.save(this.data.values)
  },  onRun() {
    const v = this.data.values
    const expr = String(v.expr || '').trim()
    if (!expr) {
      return this.setData({ error: { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { reason: '请先输入表达式' }) }, result: null })
    }
    track.track('tool_run_start', { toolId: TOOL_ID, engine: 'client' })
    const t0 = Date.now()
    try {
      const value = calc.evaluate(expr, { angle: v.angle })
      const shown = v.thousands ? calc.formatThousands(value) : String(value)
      const item = { expr: expr, shown: shown, value: value, angle: v.angle, at: Date.now() }
      const hist = [item].concat(this.data.hist).slice(0, HIST_MAX)
      const result = {
        kv: [
          { key: '表达式', value: expr },
          { key: '结果', value: shown },
          { key: '角度模式', value: v.angle === 'deg' ? 'DEG' : 'RAD' }
        ],
        text: expr + ' = ' + shown,
        meta: v.angle === 'deg' ? 'DEG 模式' : 'RAD 模式'
      }
      store.saveParams(TOOL_ID, Object.assign({}, this.data.values, { __hist: hist }))
      track.track('tool_run_success', { toolId: TOOL_ID, costMs: Date.now() - t0, engine: 'client' })
      this.setData({ result: result, hist: hist, error: null })
    } catch (e) {
      track.track('tool_run_fail', { toolId: TOOL_ID, code: e.code || 'SYNTAX' })
      const msg = ERR_TEXT[e.code] || error.message(e.code || 'TASK_FAILED')
      const withPos = e.pos !== undefined && e.pos >= 0 && e.code === 'SYNTAX' ? msg + '（第 ' + (e.pos + 1) + ' 字符附近）' : msg
      this.setData({ error: { code: e.code || 'SYNTAX', message: withPos }, result: null })
    }
  },

  onHistTap(e) {
    const idx = Number(e.currentTarget.dataset.index)
    const item = this.data.hist[idx]
    if (!item) return
    this.setData({ 'values.expr': item.expr, result: null, error: null })
    track.track('tool_open', { toolId: TOOL_ID, from: 'history' })
  },

  onHistClear() {
    this.setData({ hist: [] })
    store.saveParams(TOOL_ID, Object.assign({}, this.data.values, { __hist: [] }))
    wx.showToast({ title: '历史已清空', icon: 'none' })
  },

  onSample(e) {
    const samples = ['2+3*4', '(1+2)^3', 'sin(0)', '10%+0.1', '2π']
    const idx = Number(e.currentTarget.dataset.index)
    this.setData({ 'values.expr': samples[idx] || '', result: null, error: null })
    this.onRun()
  },

  onCopy(e) {
    const text = (e.detail && e.detail.text) || (this.data.result && this.data.result.text) || ''
    if (!text) return
    wx.setClipboardData({
      data: text,
      success: function () {
        wx.showToast({ title: '已复制', icon: 'success' })
        track.track('result_copy', { toolId: TOOL_ID })
      }
    })
  },

  onShareAppMessage() {
    return { title: '表达式计算器 · 自研解析 DEG/RAD', path: '/packageCalc/pages/calculator/index?from=share' }
  }
})
