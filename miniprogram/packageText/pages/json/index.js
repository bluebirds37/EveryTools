const registry = require('../../../tools/registry')
const store = require('../../../utils/store')
const track = require('../../../utils/track')
const error = require('../../../utils/error')
const json = require('../../utils/json')
const common = require('../../utils/common')

const TOOL_ID = 'text-json'

const SAMPLES = [
  { name: '对象美化', input: '{"b":1,"a":{"d":[3,2,1],"c":"中文"},"z":true}', v: { mode: 'pretty', indent: 2, sortKeys: false, ensureAscii: false, lenient: false } },
  { name: '键排序', input: '{"name":"日常工具箱","version":"1.0","tools":92,"tags":["b","a"]}', v: { mode: 'pretty', indent: 2, sortKeys: true, ensureAscii: false, lenient: false } },
  { name: 'JSON5 宽松', input: '{ // 行注释\n  "id": 7,\n  "list": [1,2,3,], /* 块注释 */ }', v: { mode: 'pretty', indent: 2, sortKeys: false, ensureAscii: false, lenient: true } },
  { name: '错误定位', input: '{"a": 1,, "b": }', v: { mode: 'validate', indent: 2, sortKeys: false, ensureAscii: false, lenient: false } }
]

const TIPS = [
  '解析失败会给出「行:列 + 期望符号 + 出错上下文」，定位与主流编辑器一致',
  '宽松模式支持 JSON5 的 // 与 /* */ 注释、尾逗号（不做完整 JSON5 语法）',
  '树视图最多展开 20000 个节点，点击行折叠/展开，点击路径复制 JSON Pointer',
  '全部计算在本机离线完成，输入内容不会上传'
]

function defaults() {
  return { mode: 'pretty', indent: 2, sortKeys: false, ensureAscii: false, lenient: false }
}

/* 递归键排序：seen 链防循环引用（parse 结果不可能循环，但 AI 接力对象可能） */
function sortDeep(value, seen) {
  const stack = seen || []
  if (value === null || typeof value !== 'object') return value
  if (stack.indexOf(value) >= 0) {
    const e = new Error('参数错误：对象含循环引用，无法排序')
    e.code = 'PARAM_INVALID'
    throw e
  }
  const next = stack.concat([value])
  if (Array.isArray(value)) return value.map(function (v) { return sortDeep(v, next) })
  const out = {}
  Object.keys(value).sort().forEach(function (k) {
    out[k] = sortDeep(value[k], next)
  })
  return out
}

/* 非 ASCII → \uXXXX（代理对合并输出，保证往返可解析） */
function ensureAsciiEscape(s) {
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i)
    if (code >= 0x20 && code < 0x7f && s[i] !== '\\') out += s[i]
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < s.length) {
      const lo = s.charCodeAt(i + 1)
      out += '\\u' + code.toString(16).padStart(4, '0') + '\\u' + lo.toString(16).padStart(4, '0')
      i++
    } else out += '\\u' + code.toString(16).padStart(4, '0')
  }
  return out
}

/* JSON5 宽松预处理：字符串外去除 // 与 /* *\/ 注释、删除 } ] 前尾逗号 */
function stripJson5(text) {
  let out = ''
  let inStr = false
  let esc = false
  let i = 0
  const n = text.length
  while (i < n) {
    const c = text[i]
    if (inStr) {
      out += c
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      i++
      continue
    }
    if (c === '"') { inStr = true; out += c; i++; continue }
    if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++
      continue
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++
      i += 2
      continue
    }
    if (c === ',') {
      let j = i + 1
      while (j < n && /\s/.test(text[j])) j++
      if (text[j] === '}' || text[j] === ']') { i++; continue }
    }
    out += c
    i++
  }
  return out
}

/* 树视图：按折叠状态过滤可见行（隐藏被折叠节点的全部后代） */
function visibleRows(rows, collapsed) {
  const out = []
  let hideDepth = -1
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    if (hideDepth >= 0) {
      if (r.depth > hideDepth) continue
      hideDepth = -1
    }
    out.push(r)
    if (r.expandable && collapsed[r.id]) hideDepth = r.depth
  }
  return out
}

function indentOf(v) {
  return v === 'tab' ? '\t' : Number(v) === 4 ? 4 : 2
}

function validate(values, input) {
  const empty = input === '' || input === null || input === undefined
  if (empty) return { code: 'INPUT_EMPTY', message: error.message('INPUT_EMPTY', { reason: '请输入 JSON 文本' }) }
  if (input.length > common.MAX_INPUT_LEN) return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { reason: '文本超过 1,000,000 字符，请精简后重试' }) }
  return null
}

Page({
  data: {
    tool: null,
    values: defaults(),
    input: '',
    schema: [],
    tips: TIPS,
    busy: false,
    result: null,
    error: null,
    tree: null,
    collapsed: {},
    samples: SAMPLES
  },

  onLoad(query) {
    const tool = registry.get(TOOL_ID)
    const values = Object.assign(defaults(), store.params(TOOL_ID) || {})
    this.setData({
      tool: tool,
      values: values,
      input: values.__input || '',
      schema: this.buildSchema(values)
    })
    track.track('tool_open', { toolId: TOOL_ID, from: query.from || 'menu' })
  },

  buildSchema(v) {
    return [
      { key: 'mode', label: '模式', type: 'segment', def: 'pretty', options: [{ value: 'pretty', label: '美化' }, { value: 'minify', label: '压缩' }, { value: 'validate', label: '校验' }, { value: 'tree', label: '树视图' }] },
      { key: 'indent', label: '缩进', type: 'segment', def: 2, options: [{ value: 2, label: '2 空格' }, { value: 4, label: '4 空格' }, { value: 'tab', label: 'Tab' }], showIf: { key: 'mode', in: ['pretty', 'tree'] } },
      { key: 'sortKeys', label: '键名排序', type: 'switch', def: false, showIf: { key: 'mode', in: ['pretty', 'minify'] } },
      { key: 'ensureAscii', label: '中文转 \\u', type: 'switch', def: false, showIf: { key: 'mode', in: ['pretty', 'minify'] } },
      { key: 'lenient', label: '宽松模式（注释/尾逗号）', type: 'switch', def: false }
    ]
  },

  onParamChange(e) {
    const values = Object.assign({}, this.data.values)
    values[e.detail.key] = e.detail.value
    this.setData({ values: values, schema: this.buildSchema(values) })
    this.remember(values)
  },

  remember(values) {
    const saved = Object.assign({}, values, { __input: this.data.input })
    store.saveParams(TOOL_ID, saved)
  },

  onInput(e) {
    this.setData({ input: e.detail.value })
    clearTimeout(this._saveTimer)
    this._saveTimer = setTimeout(function () {
      store.saveParams(TOOL_ID, Object.assign({}, this.data.values, { __input: this.data.input }))
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

  onClearInput() {
    this.setData({ input: '', result: null, tree: null, error: null })
  },

  onSample(e) {
    const s = SAMPLES[Number(e.currentTarget.dataset.index)]
    if (!s) return
    const values = Object.assign(defaults(), s.v)
    this.setData({ input: s.input, values: values, schema: this.buildSchema(values), result: null, tree: null, error: null })
    this.remember(values)
  },

  parseInput() {
    const raw = this.data.values.lenient ? stripJson5(this.data.input) : this.data.input
    const r = json.parseWithLocation(raw)
    if (!r.ok) {
      const err = new Error(r.snippet ? r.message + '\n上下文：' + r.snippet : r.message)
      err.code = 'PARAM_INVALID'
      throw err
    }
    return r.value
  },

  onRun() {
    if (this.data.busy) return
    const v = this.data.values
    const invalid = validate(v, this.data.input)
    if (invalid) return this.setData({ error: invalid, result: null, tree: null })
    this.setData({ busy: true, error: null, result: null, tree: null })
    track.track('tool_run_start', { toolId: TOOL_ID, mode: v.mode })
    const t0 = Date.now()
    try {
      const value = this.parseInput()
      if (v.mode === 'validate') {
        this.finish({ kv: [{ key: '校验结果', value: '合法 JSON' }, { key: '顶层类型', value: this.topType(value) }, { key: '字符数', value: String(this.data.input.length) }], meta: '耗时 ' + (Date.now() - t0) + 'ms · 端' }, t0)
        return
      }
      if (v.mode === 'tree') {
        this._parsed = value
        const f = json.flatten(value)
        this.setData({ tree: { rows: visibleRows(f.rows, {}), all: f.rows, truncated: f.truncated }, collapsed: {}, busy: false })
        track.track('tool_run_success', { toolId: TOOL_ID, costMs: Date.now() - t0, engine: 'client' })
        this.remember(v)
        return
      }
      let out
      if (v.mode === 'minify') out = json.minify(v.sortKeys ? JSON.stringify(sortDeep(value)) : JSON.stringify(value))
      else out = json.format(v.sortKeys ? JSON.stringify(sortDeep(value)) : this.data.input, indentOf(v.indent))
      if (!out.ok) { const e = new Error(out.message); e.code = 'PARAM_INVALID'; throw e }
      let text = out.value
      if (v.ensureAscii) text = ensureAsciiEscape(text)
      this.finish({ text: text, kv: null, meta: (v.mode === 'minify' ? '压缩' : '美化') + ' · ' + text.length + ' 字 · ' + (Date.now() - t0) + 'ms · 端' }, t0)
    } catch (e) {
      const code = e.code || 'PARAM_INVALID'
      track.track('tool_run_fail', { toolId: TOOL_ID, code: code })
      this.setData({ busy: false, error: { code: code, message: e.message || error.message(code) } })
    }
  },

  topType(value) {
    if (value === null) return 'null'
    if (Array.isArray(value)) return 'array'
    return typeof value
  },

  finish(result, t0) {
    track.track('tool_run_success', { toolId: TOOL_ID, costMs: Date.now() - t0, engine: 'client' })
    this.setData({ result: result, busy: false })
    this.remember(this.data.values)
  },

  onToggleNode(e) {
    const id = Number(e.currentTarget.dataset.id)
    const collapsed = Object.assign({}, this.data.collapsed)
    if (collapsed[id]) delete collapsed[id]
    else collapsed[id] = true
    this.setData({ collapsed: collapsed, 'tree.rows': visibleRows(this.data.tree.all, collapsed) })
  },

  onCopyPointer(e) {
    const p = e.currentTarget.dataset.pointer
    common.copyText(p, TOOL_ID, track)
  },

  onCopyAll() {
    if (this.data.result && this.data.result.text) return common.copyText(this.data.result.text, TOOL_ID, track)
    if (this.data.tree && this._parsed !== undefined) {
      common.copyText(JSON.stringify(this._parsed, null, indentOf(this.data.values.indent)), TOOL_ID, track)
    }
  },

  onCopy(e) {
    const text = (e.detail && e.detail.text) || ''
    common.copyText(text, TOOL_ID, track)
  },

  onShare() {
    track.track('result_share', { toolId: TOOL_ID })
    wx.showToast({ title: '点右上角「…」转发给朋友', icon: 'none' })
  },

  onShareAppMessage() {
    return { title: 'JSON 格式化 · 美化/压缩/树视图', path: '/packageText/pages/json/index?toolId=' + TOOL_ID + '&from=share' }
  }
})

module.exports = { sortDeep: sortDeep, ensureAsciiEscape: ensureAsciiEscape, stripJson5: stripJson5, visibleRows: visibleRows }
