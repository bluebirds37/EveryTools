const registry = require('../../../tools/registry')
const store = require('../../../utils/store')
const track = require('../../../utils/track')
const error = require('../../../utils/error')
const safety = require('../../utils/regex-safety')
const common = require('../../utils/common')

const TOOL_ID = 'text-regex'

const FLAG_LIST = [
  { flag: 'g', label: 'g 全局' },
  { flag: 'i', label: 'i 忽略大小写' },
  { flag: 'm', label: 'm 多行' },
  { flag: 's', label: 's 点号跨行' },
  { flag: 'u', label: 'u Unicode' },
  { flag: 'y', label: 'y 粘性' }
]

const TEMPLATES = [
  { name: '手机号', pattern: '^1[3-9]\\d{9}$' },
  { name: '邮箱', pattern: '[\\w.+-]+@[\\w-]+\\.[\\w.-]+' },
  { name: '身份证', pattern: '\\d{17}[\\dXx]|\\d{15}' },
  { name: 'URL', pattern: 'https?://[\\w.-]+(:\\d+)?(/[^\\s]*)?' },
  { name: 'IPv4', pattern: '\\b(?:\\d{1,3}\\.){3}\\d{1,3}\\b' },
  { name: '邮编', pattern: '[1-9]\\d{5}(?!\\d)' },
  { name: '车牌', pattern: '[\\u4e00-\\u9fa5][A-Z][A-Z0-9]{5,6}' },
  { name: '金额', pattern: '\\d+(?:,\\d{3})*(?:\\.\\d{1,2})? 元' }
]

const TIPS = [
  '表达式先过静态危险分析（(a+)+、(a|aa)+、.*.* 等灾难回溯家族直接拦截），执行带 1 秒超时保护，绝不卡死界面',
  '匹配区高亮显示，点击匹配片段可复制；分组表列出每组值与位置',
  '替换模板支持 $& 整体、$1..$99 位置分组、$<name> 命名分组、$$ 转义',
  '单次最多返回 5000 条匹配，超出会标注截断'
]

const SAMPLES = [
  { name: '提取日期', pattern: '(\\d{4})-(\\d{2})-(\\d{2})', flags: 'g', mode: 'match', replacement: '$1/$2/$3', text: '会议在 2026-10-13，回顾 2025-09-01 的记录' },
  { name: '替换演示', pattern: '(\\w+)@(\\w+)', flags: 'g', mode: 'replace', replacement: '$2 的主号 $1', text: 'zhang@tools li@box' },
  { name: '灾难回溯拦截', pattern: '(a+)+b', flags: '', mode: 'match', replacement: '', text: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaac' },
  { name: '命名分组', pattern: '(?<year>\\d{4})年', flags: 'g', mode: 'replace', replacement: '[$year]', text: '2020年与2026年' }
]

function defaults() {
  return { pattern: '', flags: 'g', mode: 'match', replacement: '$1' }
}

function buildSchema() {
  return [
    { key: 'mode', label: '模式', type: 'segment', def: 'match', options: [{ value: 'match', label: '匹配测试' }, { value: 'replace', label: '替换预览' }] },
    { key: 'replacement', label: '替换模板（$1 / $<name> / $&）', type: 'textarea', def: '$1', rows: 1, showIf: { key: 'mode', in: ['replace'] } }
  ]
}

/** 把文本按匹配区间切成 [普通/高亮] 片段序列（仅展示用，最多 300 段） */
function buildSegments(text, matches) {
  const segs = []
  let last = 0
  const limit = Math.min(matches.length, 150)
  for (let i = 0; i < limit; i++) {
    const m = matches[i]
    if (!m.text) {
      if (last <= m.index) segs.push({ hl: false, text: text.slice(last, m.index + 1) })
      last = m.index + 1
      continue
    }
    if (m.index > last) segs.push({ hl: false, text: text.slice(last, m.index) })
    segs.push({ hl: true, text: m.text })
    last = m.index + m.text.length
  }
  if (last < text.length) segs.push({ hl: false, text: text.slice(last) })
  return segs
}

Page({
  data: {
    tool: null,
    values: defaults(),
    text: '',
    schema: buildSchema(),
    tips: TIPS,
    flagList: FLAG_LIST,
    templates: TEMPLATES,
    busy: false,
    result: null,
    error: null,
    segments: null,
    matchRows: [],
    samples: SAMPLES
  },

  onLoad(query) {
    const tool = registry.get(TOOL_ID)
    const values = Object.assign(defaults(), store.params(TOOL_ID) || {})
    this.setData({ tool: tool, values: values, text: values.__text || '' })
    track.track('tool_open', { toolId: TOOL_ID, from: query.from || 'menu' })
  },

  onParamChange(e) {
    const values = Object.assign({}, this.data.values)
    values[e.detail.key] = e.detail.value
    this.setData({ values: values, schema: buildSchema() })
    this.remember(values)
  },

  remember(values) {
    store.saveParams(TOOL_ID, Object.assign({}, values, { __text: this.data.text, __pattern: undefined }))
  },

  onPattern(e) {
    const values = Object.assign({}, this.data.values, { pattern: e.detail.value })
    this.setData({ values: values })
    this.remember(values)
  },

  onText(e) {
    this.setData({ text: e.detail.value })
    clearTimeout(this._saveTimer)
    this._saveTimer = setTimeout(function () {
      store.saveParams(TOOL_ID, Object.assign({}, this.data.values, { __text: this.data.text }))
    }.bind(this), 500)
  },

  onToggleFlag(e) {
    const f = e.currentTarget.dataset.flag
    let flags = this.data.values.flags
    flags = flags.indexOf(f) >= 0 ? flags.replace(new RegExp(f, 'g'), '') : flags + f
    const values = Object.assign({}, this.data.values, { flags: flags })
    this.setData({ values: values })
    this.remember(values)
  },

  onTemplate(e) {
    const t = TEMPLATES[Number(e.currentTarget.dataset.index)]
    if (!t) return
    const values = Object.assign({}, this.data.values, { pattern: t.pattern })
    this.setData({ values: values })
    this.remember(values)
  },

  onPaste() {
    wx.getClipboardData({
      success: (res) => {
        const v = String((res && res.data) || '')
        if (!v) return wx.showToast({ title: '剪贴板为空', icon: 'none' })
        this.setData({ text: v.slice(0, common.MAX_INPUT_LEN) })
      },
      fail: () => wx.showToast({ title: '无法读取剪贴板', icon: 'none' })
    })
  },

  onClearText() { this.setData({ text: '', result: null, segments: null, matchRows: [], error: null }) },

  onSample(e) {
    const s = SAMPLES[Number(e.currentTarget.dataset.index)]
    if (!s) return
    const values = Object.assign(defaults(), { pattern: s.pattern, flags: s.flags, mode: s.mode, replacement: s.replacement })
    this.setData({ values: values, text: s.text, schema: buildSchema(), result: null, segments: null, matchRows: [], error: null })
    this.remember(values)
    this.onRun()
  },

  onRun() {
    if (this.data.busy) return
    const v = this.data.values
    if (!v.pattern) {
      return this.setData({ error: { code: 'INPUT_EMPTY', message: error.message('INPUT_EMPTY', { reason: '请输入正则表达式' }) }, result: null })
    }
    if (!this.data.text) {
      return this.setData({ error: { code: 'INPUT_EMPTY', message: error.message('INPUT_EMPTY', { reason: '请输入待匹配的样本文本' }) }, result: null })
    }
    if (this.data.text.length > common.MAX_INPUT_LEN) {
      return this.setData({ error: { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { reason: '样本文本超过 1,000,000 字符' }) }, result: null })
    }
    this.setData({ busy: true, error: null, result: null, segments: null, matchRows: [] })
    track.track('tool_run_start', { toolId: TOOL_ID, mode: v.mode })
    const t0 = Date.now()
    try {
      const res = safety.safeMatchAll(v.pattern, v.flags, this.data.text, { timeoutMs: safety.DEFAULT_TIMEOUT_MS })
      if (res.syntaxError) { const e = new Error(res.syntaxError); e.code = 'PARAM_INVALID'; throw e }
      if (res.interrupted) {
        const code = res.reason === 'catastrophic-detected' ? 'PARAM_INVALID' : 'TASK_TIMEOUT'
        const detail = (res.detail || '') + (res.partial && res.partial.length ? '（已保留前 ' + res.partial.length + ' 条）' : '')
        track.track('tool_run_fail', { toolId: TOOL_ID, code: code })
        return this.setData({
          busy: false,
          error: { code: code, message: code === 'TASK_TIMEOUT' ? error.message('TASK_TIMEOUT', { seconds: 1 }) + '：' + detail : detail },
          matchRows: (res.partial || []).slice(0, 50).map(this.toRow)
        })
      }
      const matches = res.matches
      const rows = matches.slice(0, 50).map(this.toRow)
      let outText = null
      if (v.mode === 'replace') {
        const flags = v.flags.indexOf('g') >= 0 ? v.flags : v.flags + 'g'
        const rescan = safety.safeMatchAll(v.pattern, flags, this.data.text, { timeoutMs: safety.DEFAULT_TIMEOUT_MS })
        if (rescan.ok) outText = safety.buildReplacement(this.data.text, rescan.matches, String(v.replacement || ''))
        else outText = this.data.text
      }
      const rowsKv = [
        { key: '匹配数量', value: String(matches.length) + (matches.length >= safety.MAX_MATCHES ? '（截断）' : '') },
        { key: '分组数', value: String(safety.groupLabels(v.pattern).length) },
        { key: '耗时', value: res.elapsedMs + ' ms' }
      ]
      const result = {
        text: v.mode === 'replace' ? outText : matches.map(function (m) { return m.text }).join('\n'),
        kv: rowsKv,
        meta: (v.mode === 'replace' ? '替换预览' : '匹配 /' + v.pattern + '/' + v.flags) + ' · ' + (Date.now() - t0) + 'ms · 端'
      }
      track.track('tool_run_success', { toolId: TOOL_ID, costMs: Date.now() - t0, engine: 'client' })
      this.setData({
        result: result,
        segments: v.mode === 'match' ? buildSegments(this.data.text, matches) : null,
        matchRows: rows,
        busy: false
      })
      this.remember(v)
    } catch (e) {
      const code = e.code || 'PARAM_INVALID'
      track.track('tool_run_fail', { toolId: TOOL_ID, code: code })
      this.setData({ busy: false, error: { code: code, message: e.message || error.message(code) } })
    }
  },

  toRow(m) {
    const groups = (m.groups || []).map(function (g) {
      return g.value === null ? '' : g.value
    }).filter(function (x) { return x !== '' })
    return {
      index: m.index,
      text: m.text || '（空匹配）',
      groupsText: groups.length ? groups.join(' / ') : '无分组',
      namedText: Object.keys(m.named || {}).map(function (k) { return k + '=' + m.named[k] }).join(' / ') || ''
    }
  },

  onCopyMatch(e) {
    common.copyText(e.currentTarget.dataset.text || '', TOOL_ID, track)
  },

  onCopy(e) {
    common.copyText((e.detail && e.detail.text) || '', TOOL_ID, track)
  },

  onShare() {
    track.track('result_share', { toolId: TOOL_ID })
    wx.showToast({ title: '点右上角「…」转发给朋友', icon: 'none' })
  },

  onShareAppMessage() {
    return { title: '正则测试 · 高亮匹配与防卡死', path: '/packageText/pages/regex/index?toolId=' + TOOL_ID + '&from=share' }
  }
})

module.exports = { buildSegments: buildSegments }
