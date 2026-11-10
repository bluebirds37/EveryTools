const registry = require('../../../tools/registry')
const store = require('../../../utils/store')
const track = require('../../../utils/track')
const error = require('../../../utils/error')
const textops = require('../../utils/textops')
const common = require('../../utils/common')

const TOOL_ID = 'text-stats'

const TIPS = [
  '按 Unicode 码点计字符：emoji（代理对/ZWJ 组合）计 1 个字符、1 个 emoji 簇',
  '字节数按 UTF-8 计；GBK 字节数需要整份国标码表（约 120KB），未随本分包提供，故不展示，避免给出错误近似值',
  '结果为实时本地计算，文本不上传',
  '输入上限 1,000,000 字符，超限明确报错不截断'
]

const SAMPLES = [
  { name: '中英混排', text: 'Hello World! 你好，世界。\nThis is a ToolBox. 这是一个工具箱。' },
  { name: 'Emoji 计数', text: '🎉🎉 Party 派对 👨‍👩‍👧 一家\n共 2 条消息' },
  { name: '多段长文', text: '第一段：日常工具箱上线了。\n\n第二段：包含 53 个工具，支持 JSON、Base64、diff。\n\n第三段：欢迎转发给朋友。' },
  { name: '数字标点', text: '价格 1,234.56 元（含税 13%）；数量 20 个。' }
]

const EN_WORD_RE = /[A-Za-z]+(?:['’-][A-Za-z]+)*/g
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g

/** 高频统计：英文单词（忽略大小写）+ 汉字单字，各取前 n */
function topWords(text, n) {
  const counts = {}
  const words = String(text).match(EN_WORD_RE) || []
  for (let i = 0; i < words.length; i++) {
    const w = words[i].toLowerCase()
    counts[w] = (counts[w] || 0) + 1
  }
  const chars = String(text).match(CJK_RE) || []
  for (let i = 0; i < chars.length; i++) {
    counts[chars[i]] = (counts[chars[i]] || 0) + 1
  }
  const list = Object.keys(counts).map(function (k) { return { word: k, count: counts[k] } })
  list.sort(function (a, b) { return b.count - a.count || (a.word < b.word ? -1 : 1) })
  return list.slice(0, n)
}

/** 行极值：最长行（含行号，截断展示）与平均行长 */
function lineExtremes(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n')
  let maxLen = 0, maxIdx = 0, sum = 0
  for (let i = 0; i < lines.length; i++) {
    const len = Array.from(lines[i]).length
    sum += len
    if (len > maxLen) { maxLen = len; maxIdx = i }
  }
  const shown = Array.from(lines[maxIdx] || '')
  return {
    count: lines.length,
    maxLen: maxLen,
    maxLineNo: maxIdx + 1,
    maxLine: (shown.length > 40 ? shown.slice(0, 40).join('') + '…' : shown.join('')),
    avgLen: lines.length ? Math.round((sum / lines.length) * 100) / 100 : 0
  }
}

function defaults() {
  return { topN: '0', longLine: true }
}

function buildSchema() {
  return [
    { key: 'topN', label: '高频词/字 Top N', type: 'segment', def: '0', options: [{ value: '0', label: '不统计' }, { value: '5', label: 'Top 5' }, { value: '10', label: 'Top 10' }] },
    { key: 'longLine', label: '展示最长行与平均行长', type: 'switch', def: true }
  ]
}

Page({
  data: {
    tool: null,
    values: defaults(),
    input: '',
    schema: buildSchema(),
    tips: TIPS,
    busy: false,
    result: null,
    kv: [],
    error: null,
    top: [],
    extremes: null,
    samples: SAMPLES
  },

  onLoad(query) {
    const tool = registry.get(TOOL_ID)
    const values = Object.assign(defaults(), store.params(TOOL_ID) || {})
    this.setData({ tool: tool, values: values, input: values.__text || '' })
    track.track('tool_open', { toolId: TOOL_ID, from: query.from || 'menu' })
  },

  onParamChange(e) {
    const values = Object.assign({}, this.data.values)
    values[e.detail.key] = e.detail.value
    this.setData({ values: values, schema: buildSchema() })
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
        this.setData({ input: v.slice(0, common.MAX_INPUT_LEN) })
      },
      fail: () => wx.showToast({ title: '无法读取剪贴板', icon: 'none' })
    })
  },

  onClearInput() { this.setData({ input: '', result: null, top: [], extremes: null, error: null }) },

  onSample(e) {
    const s = SAMPLES[Number(e.currentTarget.dataset.index)]
    if (!s) return
    this.setData({ input: s.text, result: null, top: [], extremes: null, error: null })
    this.onRun()
  },

  onRun() {
    if (this.data.busy) return
    const text = this.data.input
    const check = common.checkTextInput(text, '统计文本')
    if (check) {
      return this.setData({ error: { code: text ? 'PARAM_INVALID' : 'INPUT_EMPTY', message: check }, result: null })
    }
    this.setData({ busy: true, error: null, result: null, top: [], extremes: null })
    track.track('tool_run_start', { toolId: TOOL_ID })
    const t0 = Date.now()
    try {
      const s = textops.countStats(text)
      const kv = [
        { key: '字符数（含空白，码点）', value: String(s.codepoints) },
        { key: '字符数（不含空白）', value: String(s.noWs) },
        { key: '空白字符', value: String(s.whitespace) },
        { key: '中文字数', value: String(s.chinese) },
        { key: '英文单词数', value: String(s.englishWords) },
        { key: '数字串数', value: String(s.digitRuns) },
        { key: '标点符号', value: String(s.punctuation) },
        { key: 'Emoji（组合簇）', value: String(s.emoji) },
        { key: '行数', value: String(s.lines) },
        { key: '段落数', value: String(s.paragraphs) },
        { key: 'UTF-8 字节数', value: String(s.utf8Bytes) }
      ]
      let report = '字数统计报告\n' + kv.map(function (r) { return r.key + '：' + r.value }).join('\n')
      const topN = Number(this.data.values.topN) || 0
      const top = topN > 0 ? topWords(text, topN) : []
      if (top.length) {
        report += '\n高频词/字：' + top.map(function (t) { return t.word + '(' + t.count + ')' }).join('、')
      }
      const extremes = this.data.values.longLine ? lineExtremes(text) : null
      if (extremes) {
        kv.push({ key: '最长行（第 ' + extremes.maxLineNo + ' 行）', value: extremes.maxLen + ' 字符' })
        kv.push({ key: '平均行长', value: String(extremes.avgLen) })
        report += '\n最长行 ' + extremes.maxLen + ' 字符，平均行长 ' + extremes.avgLen
      }
      const result = {
        text: report,
        meta: '字数统计 · ' + (Date.now() - t0) + 'ms · 端'
      }
      track.track('tool_run_success', { toolId: TOOL_ID, costMs: Date.now() - t0, engine: 'client' })
      this.setData({ result: result, kv: kv, top: top, extremes: extremes, busy: false })
      this.remember(this.data.values)
    } catch (e) {
      const code = e.code || 'PARAM_INVALID'
      track.track('tool_run_fail', { toolId: TOOL_ID, code: code })
      this.setData({ busy: false, error: { code: code, message: e.message || error.message(code) } })
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
    return { title: '字数统计 · 字符单词字节全都有', path: '/packageText/pages/stats/index?toolId=' + TOOL_ID + '&from=share' }
  }
})

module.exports = { topWords: topWords, lineExtremes: lineExtremes }
