const registry = require('../../../tools/registry')
const store = require('../../../utils/store')
const track = require('../../../utils/track')
const error = require('../../../utils/error')
const color = require('../../utils/color')

const TOOL_ID = 'dev-color'

const MODES = [
  { value: 'convert', label: '互转' },
  { value: 'contrast', label: '对比度' },
  { value: 'scale', label: '色阶' }
]

function defaults() {
  return { mode: 'convert', color: '#14B8A6', base2: '#FFFFFF', steps: 5, hexAlpha: false }
}

function buildSchema() {
  return [
    { key: 'mode', label: '功能', type: 'segment', def: 'convert', options: MODES },
    { key: 'base2', label: '背景色（对比对象）', type: 'color', def: '#FFFFFF', showIf: { key: 'mode', in: ['contrast'] } },
    { key: 'steps', label: '色阶档数（每侧）', type: 'slider', def: 5, min: 2, max: 9, step: 1, unit: ' 档', showIf: { key: 'mode', in: ['scale'] } },
    { key: 'hexAlpha', label: '十六进制带透明度', type: 'switch', def: false, showIf: { key: 'mode', in: ['convert'] } }
  ]
}

function pad(n) {
  return (n < 10 ? '0' : '') + n
}

function parseInput(text) {
  const c = color.parseColor(text)
  return c || null
}

/** 实时预览数据（输入即算，不点按钮也能看到四格式） */
function live(v) {
  const c = parseInput(v.color)
  if (!c) return { ok: false, hint: '无法识别的颜色，支持 #RGB / #RRGGBB / rgb() / rgba() / hsl() / hsv() / 16 个常见色名' }
  const f = color.formats(c)
  return {
    ok: true,
    swatch: v.hexAlpha ? f.hex8 : f.hex,
    rows: [
      { key: 'HEX', value: v.hexAlpha ? f.hex8 : f.hex },
      { key: 'RGB', value: f.rgb },
      { key: 'RGBA', value: f.rgba },
      { key: 'HSL', value: f.hsl },
      { key: 'HSV', value: f.hsv }
    ],
    hsl: f.hslObj,
    formats: f
  }
}

function validate(v) {
  if (!String(v.color || '').trim()) return { code: 'INPUT_EMPTY', message: error.message('INPUT_EMPTY') }
  if (!parseInput(v.color)) return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { field: '颜色', reason: '无法识别，支持 HEX / RGB / HSL / HSV / 色名' }) }
  if (v.mode === 'contrast') {
    if (!parseInput(v.base2)) return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { field: '背景色', reason: '无法识别' }) }
  }
  if (v.mode === 'scale') {
    const n = Number(v.steps)
    if (!isFinite(n) || n < 2 || n > 9) return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { field: '色阶档数', range: '2–9' }) }
  }
  return null
}

function contrastBlock(a, b) {
  const ratio = color.contrast(a, b)
  const w = color.wcag(ratio)
  const best = color.bestTextOn(a)
  const judge = [
    { key: '对比度', value: ratio + ' : 1' },
    { key: '正文 AA（≥4.5）', value: w.aaNormal ? '通过' : '不通过' },
    { key: '正文 AAA（≥7）', value: w.aaaNormal ? '通过' : '不通过' },
    { key: '大号文字 AA（≥3）', value: w.aaLarge ? '通过' : '不通过' },
    { key: '大号文字 AAA（≥4.5）', value: w.aaaLarge ? '通过' : '不通过' },
    { key: 'UI 组件（≥3）', value: w.uiComponent ? '通过' : '不通过' },
    { key: '前景建议', value: best.suggest === '#FFFFFF' ? '白字（对比 ' + best.white + '）' : '黑字（对比 ' + best.black + '）' }
  ]
  const lines = judge.map(function (x) {
    return x.key + ': ' + x.value
  })
  return {
    kv: judge,
    rows: [
      { key: '前景', value: color.toHex(color.parseColor(a), false), swatch: color.toHex(color.parseColor(a), false) },
      { key: '背景', value: color.toHex(color.parseColor(b), false), swatch: color.toHex(color.parseColor(b), false) }
    ],
    ratio: ratio,
    wcag: w,
    text: '颜色对比度 ' + color.toHex(color.parseColor(a), false) + ' vs ' + color.toHex(color.parseColor(b), false) + '\n' + lines.join('\n'),
    demoText: best.suggest
  }
}

function scaleBlock(v) {
  const c = parseInput(v.color)
  const mixScale = color.scale(c, Number(v.steps) || 5)
  const ramp = color.ramp(c, Math.min(9, Math.max(3, (Number(v.steps) || 5) + 3)))
  const harmony = color.harmony(c)
  const lines = ['基准色：' + color.toHex(c, false) + ' / ' + color.toHslText(c), '', '明暗色阶（与白/黑混合）：']
  mixScale.forEach(function (x) {
    lines.push('  ' + x.label + '\t' + x.hex)
  })
  lines.push('', 'HSL 明度阶梯：')
  ramp.forEach(function (x) {
    lines.push('  ' + x.label + '\t' + x.hex)
  })
  lines.push('', '配色关系：')
  harmony.forEach(function (x) {
    lines.push('  ' + x.name + '\t' + x.tone.hex)
  })
  return {
    mixScale: mixScale,
    ramp: ramp,
    harmony: harmony,
    text: lines.join('\n'),
    kv: [{ key: '基准', value: color.toHex(c, false) }, { key: '色阶总数', value: mixScale.length + ramp.length + harmony.length + ' 个' }]
  }
}

function run(v) {
  const l = live(v)
  if (!l.ok) throw error.make('PARAM_INVALID', { field: '颜色', reason: '无法识别' })
  const base = { swatch: l.swatch, formats: l.rows }
  if (v.mode === 'contrast') {
    const c = contrastBlock(l.formats.hex, v.base2)
    return Object.assign(base, { mode: 'contrast', kv: c.kv, text: c.text, demo: c.rows, demoText: c.demoText, ratio: c.ratio, engineUsed: 'client' })
  }
  if (v.mode === 'scale') {
    const s = scaleBlock(v)
    return Object.assign(base, { mode: 'scale', kv: s.kv, text: s.text, mixScale: s.mixScale, ramp: s.ramp, harmony: s.harmony, engineUsed: 'client' })
  }
  const lines = l.rows.map(function (x) {
    return x.key + ': ' + x.value
  })
  lines.push('')
  lines.push('HSL 分量：H ' + l.hsl.h + '° / S ' + l.hsl.s + '% / L ' + l.hsl.l + '%')
  lines.push('相对亮度：' + color.luminance(l.formats.color).toFixed(4))
  lines.push('与纯黑对比：' + color.contrast(l.formats.color, '#000000') + ' · 与纯白对比：' + color.contrast(l.formats.color, '#FFFFFF'))
  return Object.assign(base, { mode: 'convert', kv: l.rows, text: lines.join('\n'), engineUsed: 'client' })
}

Page({
  data: {
    tool: null,
    values: defaults(),
    schema: buildSchema(),
    busy: false,
    live: null,
    result: null,
    error: null,
    tips: [
      '输入支持 #RGB / #RRGGBB / #RRGGBBAA、rgb()、rgba()、hsl()、hsv() 以及 16 个常用英文色名',
      '对比度按 WCAG 2.1 相对亮度公式计算，阈值：正文 AA 4.5、AAA 7；大号文字（≥18pt 或 14pt 粗体）AA 3、AAA 4.5',
      '色阶分两套：与白/黑线性混合的明暗色阶，以及固定色相饱和度、按明度等分的 HSL 阶梯',
      '点击结果里的任一色值或色块可直接复制该值',
      '本工具纯本地计算，不涉及网络，也不读取屏幕像素取色（小程序不支持任意网页取色）'
    ],
    samples: [
      { name: '十六进制', v: { color: '#3B5BFE', mode: 'convert' } },
      { name: 'HSL 输入', v: { color: 'hsl(174, 72%, 40%)', mode: 'convert' } },
      { name: '白字对比检查', v: { color: 'rgba(20, 184, 166, 1)', base2: '#FFFFFF', mode: 'contrast' } },
      { name: '深浅色阶', v: { color: '#F97316', mode: 'scale', steps: 5 } }
    ]
  },

  onLoad(query) {
    const tool = registry.get(TOOL_ID)
    const saved = store.params(TOOL_ID) || {}
    const values = Object.assign(defaults(), saved)
    this.setData({ tool: tool, values: values, live: live(values) })
    track.track('tool_open', { toolId: TOOL_ID, from: query.from || 'menu' })
  },

  onParamChange(e) {
    const values = Object.assign({}, this.data.values, { [e.detail.key]: e.detail.value })
    this.setData({ values: values, live: live(values), result: null, error: null })
    store.saveParams(TOOL_ID, values)
  },

  onColorInput(e) {
    const values = Object.assign({}, this.data.values, { color: e.detail.value })
    this.setData({ values: values, live: live(values), result: null })
    store.saveParams(TOOL_ID, values)
  },

  onPaste() {
    wx.getClipboardData({
      success: (res) => {
        const values = Object.assign({}, this.data.values, { color: String((res && res.data) || '') })
        this.setData({ values: values, live: live(values), result: null, error: null })
        store.saveParams(TOOL_ID, values)
      },
      fail: () => {
        this.setData({ error: { code: 'PERMISSION_DENIED', message: error.message('PERMISSION_DENIED', { scope: 'clipboard' }) } })
      }
    })
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
      result.meta = '耗时 ' + Math.max(1, Date.now() - t0) + ' ms · ' + (v.mode === 'contrast' ? 'WCAG 判定' : v.mode === 'scale' ? '色阶生成' : '四格式互转') + ' · 引擎 client'
      track.track('tool_run_success', { toolId: TOOL_ID, costMs: Date.now() - t0, engine: 'client' })
      store.bumpUsage(TOOL_ID)
      this.setData({ result: result, busy: false })
    } catch (e) {
      track.track('tool_run_fail', { toolId: TOOL_ID, code: e.code || 'TASK_FAILED' })
      this.setData({ error: { code: e.code || 'TASK_FAILED', message: error.message(e.code || 'TASK_FAILED', e.extra) }, busy: false })
    }
  },

  onSample(e) {
    const idx = Number(e.currentTarget.dataset.index)
    const values = Object.assign({}, this.data.values, this.data.samples[idx].v)
    this.setData({ values: values, live: live(values), result: null, error: null })
    store.saveParams(TOOL_ID, values)
    this.onRun()
  },

  onCopyValue(e) {
    const text = e.currentTarget.dataset.value
    if (!text) return
    this.copy(String(text))
  },

  copy(text) {
    wx.setClipboardData({
      data: text,
      success: function () {
        wx.showToast({ title: '已复制', icon: 'success' })
        track.track('result_copy', { toolId: TOOL_ID })
      },
      fail: function () {
        wx.showToast({ title: '复制失败', icon: 'none' })
      }
    })
  },

  onCopy(e) {
    this.copy((e.detail && e.detail.text) || (this.data.result && this.data.result.text) || '')
  },

  onShareAppMessage() {
    return { title: '颜色工具 · HEX/RGB/HSL 互转与对比度', path: '/packageDev/pages/color/index?toolId=' + TOOL_ID + '&from=share' }
  }
})
