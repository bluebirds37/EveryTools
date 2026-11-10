const registry = require('../../../tools/registry')
const store = require('../../../utils/store')
const track = require('../../../utils/track')
const error = require('../../../utils/error')
const fin = require('../../utils/fin')

const TOOL_ID = 'calc-discount'

function defaults() {
  return { mode: 'discount', price: 299, zhe: 8.5, threshold: 300, reduce: 50, every: true, priceTax: 11300, taxRate: 13, optionsText: '满1000减120\n满500减60\n满3000减450\n打8折' }
}

function buildSchema() {
  return [
    { key: 'mode', label: '模式', type: 'segment', def: 'discount', options: [{ value: 'discount', label: '打折' }, { value: 'full', label: '满减' }, { value: 'multi', label: '多档对比' }, { value: 'tax', label: '含税反算' }] },
    { key: 'price', label: '原价(元)', type: 'number', def: 299, min: 0, max: 100000000, showIf: { key: 'mode', in: ['discount', 'full', 'multi'] } },
    { key: 'zhe', label: '折扣(几折)', type: 'slider', def: 8.5, min: 0.1, max: 9.9, step: 0.1, unit: '折', showIf: { key: 'mode', in: ['discount'] } },
    { key: 'threshold', label: '满减门槛(满X元)', type: 'number', def: 300, min: 0, max: 100000000, showIf: { key: 'mode', in: ['full'] } },
    { key: 'reduce', label: '减免(减Y元)', type: 'number', def: 50, min: 0, max: 100000000, showIf: { key: 'mode', in: ['full'] } },
    { key: 'every', label: '每满X减Y（循环满减）', type: 'switch', def: true, showIf: { key: 'mode', in: ['full'] } },
    { key: 'optionsText', label: '优惠方案（每行一档：满X减Y 或 N折）', type: 'textarea', def: '满1000减120\n满500减60', showIf: { key: 'mode', in: ['multi'] } },
    { key: 'priceTax', label: '含税价(元)', type: 'number', def: 11300, min: 0, max: 100000000, showIf: { key: 'mode', in: ['tax'] } },
    { key: 'taxRate', label: '税率(%)', type: 'number', def: 13, min: 0, max: 100, precision: 2, showIf: { key: 'mode', in: ['tax'] } }
  ]
}

function validate(v) {
  const num = function (x) { return Number(x) }
  if (v.mode === 'discount' || v.mode === 'full' || v.mode === 'multi') {
    if (!(num(v.price) > 0 && num(v.price) <= 1e8)) return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { reason: '原价需在 0 ~ 1 亿元之间' }) }
  }
  if (v.mode === 'discount' && !(num(v.zhe) >= 0.1 && num(v.zhe) <= 9.9)) return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { reason: '折扣范围 0.1–9.9 折' }) }
  if (v.mode === 'full' && !(num(v.threshold) > 0 && num(v.reduce) >= 0)) return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { reason: '满减门槛需大于 0' }) }
  if (v.mode === 'tax') {
    if (!(num(v.priceTax) > 0)) return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { reason: '含税价需大于 0' }) }
    if (!(num(v.taxRate) >= 0 && num(v.taxRate) <= 100)) return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { reason: '税率范围 0–100%' }) }
  }
  if (v.mode === 'multi' && parseOptions(v.optionsText).length === 0) {
    return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { reason: '每行一档，如「满300减50」或「8.5折」' }) }
  }
  return null
}

function parseOptions(text) {
  const lines = String(text || '').split(/[\n;；]+/)
  const opts = []
  const NUM = '(\\d+(?:\\.\\d+)?)'
  for (let k = 0; k < lines.length && opts.length < 20; k++) {
    const line = lines[k].trim()
    if (!line) continue
    let re = new RegExp('^每\\s*满\\s*' + NUM + '\\s*减\\s*' + NUM + '$')
    let mt = re.exec(line)
    if (mt) { opts.push({ text: line, kind: 'every', threshold: Number(mt[1]), reduce: Number(mt[2]) }); continue }
    re = new RegExp('^满\\s*' + NUM + '\\s*打\\s*' + NUM + '\\s*折$')
    mt = re.exec(line)
    if (mt) { opts.push({ text: line, kind: 'fullZhe', threshold: Number(mt[1]), zhe: Number(mt[2]) }); continue }
    re = new RegExp('^满\\s*' + NUM + '\\s*减\\s*' + NUM + '$')
    mt = re.exec(line)
    if (mt) { opts.push({ text: line, kind: 'full', threshold: Number(mt[1]), reduce: Number(mt[2]) }); continue }
    // 「8折」与「打8折」都接受：本页默认值与提示语用的就是带「打」的写法，
    // 只认一种会让默认示例里的那一行被静默丢弃（少算一档，最优结论就错了）
    re = new RegExp('^打?\\s*' + NUM + '\\s*折$')
    mt = re.exec(line)
    if (mt) { opts.push({ text: line, kind: 'zhe', zhe: Number(mt[1]) }); continue }
  }
  return opts
}

function finalPriceOf(opt, price) {
  if (opt.kind === 'zhe') return Math.max(0, (price * opt.zhe) / 10)
  if (opt.kind === 'every') {
    if (!(opt.threshold > 0)) return price
    return Math.max(0, price - Math.floor(price / opt.threshold) * opt.reduce)
  }
  if (opt.kind === 'fullZhe') return price >= opt.threshold ? Math.max(0, (price * opt.zhe) / 10) : price
  return price >= opt.threshold ? Math.max(0, price - opt.reduce) : price
}

function run(v) {
  const m = function (x) { return fin.fmtMoney(Math.round(x * 100) / 100) }
  if (v.mode === 'discount') {
    const price = Number(v.price)
    const zhe = Number(v.zhe)
    const final = price * zhe / 10
    const kv = [
      { key: '到手价', value: m(final) + ' 元' },
      { key: '优惠', value: m(price - final) + ' 元' },
      { key: '相当于省', value: ((1 - zhe / 10) * 100).toFixed(1) + '%' },
      { key: '公式', value: '到手价 = 原价 × 折扣 ÷ 10 = ' + price + ' × ' + zhe + ' ÷ 10' }
    ]
    return { kv: kv, text: kv.map(function (x) { return x.key + ': ' + x.value }).join('\n'), meta: '打折' }
  }
  if (v.mode === 'full') {
    const price = Number(v.price)
    const th = Number(v.threshold)
    const rd = Number(v.reduce)
    const times = v.every ? Math.floor(price / th) : (price >= th ? 1 : 0)
    const final = Math.max(0, price - times * rd)
    const kv = [
      { key: '满足次数', value: times + ' 次' + (v.every ? '（每满循环）' : '（单档）') },
      { key: '到手价', value: m(final) + ' 元' },
      { key: '共减', value: m(times * rd) + ' 元' },
      { key: '提示', value: final === price ? '未达门槛，不享受优惠' : '实际以电商平台叠加规则为准' }
    ]
    return { kv: kv, text: kv.map(function (x) { return x.key + ': ' + x.value }).join('\n'), meta: '满减' }
  }
  if (v.mode === 'multi') {
    const price = Number(v.price)
    const opts = parseOptions(v.optionsText)
    const scored = opts.map(function (o) { return { o: o, final: finalPriceOf(o, price) } })
    scored.sort(function (a, b) { return a.final - b.final })
    const best = scored[0]
    const kv = scored.map(function (s) {
      return { key: s.o.text, value: '到手 ' + m(s.final) + ' 元' + (s === best ? ' ← 最优' : '') }
    })
    kv.push({ key: '最优结论', value: '选「' + best.o.text + '」到手价最低 ' + m(best.final) + ' 元' })
    return { kv: kv, text: kv.map(function (x) { return x.key + ': ' + x.value }).join('\n'), meta: opts.length + ' 档对比 · 原价 ' + m(price) }
  }
  const priceTax = Number(v.priceTax)
  const rate = Number(v.taxRate) / 100
  const noTax = priceTax / (1 + rate)
  const tax = priceTax - noTax
  const kv = [
    { key: '不含税价', value: m(noTax) + ' 元' },
    { key: '税额', value: m(tax) + ' 元' },
    { key: '验算', value: m(noTax) + ' × (1+' + Number(v.taxRate) + '%) = ' + m(noTax * (1 + rate)) + ' 元' },
    { key: '公式', value: '不含税价 = 含税价 ÷ (1 + 税率)' }
  ]
  return { kv: kv, text: kv.map(function (x) { return x.key + ': ' + x.value }).join('\n'), meta: '含税反算' }
}

Page({
  data: {
    tool: null,
    values: defaults(),
    schema: buildSchema(),
    busy: false,
    result: null,
    error: null,
    tips: [
      '打折：到手价 = 原价 × 折扣 ÷ 10；满减支持「每满循环」开关',
      '多档对比：每行一档（满X减Y / 每满X减Y / N折），自动给出最优档位与到手价（最多 20 档）',
      '含税反算：不含税价 = 含税价 ÷ (1+税率)，并给税额验算闭环',
      '负数或超 1 亿元的金额会被拒绝'
    ],
    samples: [
      { name: '双11对比', v: { mode: 'multi', price: 1000, optionsText: '每满300减50\n满1000打8折\n满1000减120' } },
      { name: '含税1.13万反算13%', v: { mode: 'tax', priceTax: 11300, taxRate: 13 } },
      { name: '8.5折省多少', v: { mode: 'discount', price: 599, zhe: 8.5 } }
    ]
  },

  onLoad(query) {
    const tool = registry.get(TOOL_ID)
    const saved = store.params(TOOL_ID) || {}
    this.setData({ tool: tool, values: Object.assign(defaults(), saved) })
    track.track('tool_open', { toolId: TOOL_ID, from: query.from || 'menu' })
  },

  onParamChange(e) {
    const values = Object.assign({}, this.data.values, { [e.detail.key]: e.detail.value })
    this.setData({ values: values })
    store.saveParams(TOOL_ID, values)
    if (this.data.result) this.setData({ result: null })
  },

  onRun() {
    if (this.data.busy) return
    const v = this.data.values
    const invalid = validate(v)
    if (invalid) return this.setData({ error: invalid, result: null })
    this.setData({ busy: true, error: null })
    track.track('tool_run_start', { toolId: TOOL_ID, mode: v.mode })
    const t0 = Date.now()
    try {
      const result = run(v)
      track.track('tool_run_success', { toolId: TOOL_ID, costMs: Date.now() - t0, engine: 'client' })
      this.setData({ result: result, busy: false })
    } catch (e) {
      track.track('tool_run_fail', { toolId: TOOL_ID, code: e.code || 'TASK_FAILED' })
      this.setData({ error: { code: e.code || 'TASK_FAILED', message: error.message(e.code || 'TASK_FAILED') }, busy: false })
    }
  },

  onSample(e) {
    const idx = Number(e.currentTarget.dataset.index)
    const values = Object.assign(defaults(), this.data.samples[idx].v)
    this.setData({ values: values, result: null, error: null })
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
    return { title: '折扣比价 · 多档优惠最优解', path: '/packageCalc/pages/discount/index?from=share' }
  }
})
