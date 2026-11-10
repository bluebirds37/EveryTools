const registry = require('../../../tools/registry')
const store = require('../../../utils/store')
const track = require('../../../utils/track')
const error = require('../../../utils/error')
const diff = require('../../utils/diff')
const common = require('../../utils/common')

const TOOL_ID = 'text-diff'

const TIPS = [
  '左右分栏可视化新增 / 删除 / 修改三种差异，颜色区分并可切 unified 补丁视图复制',
  '粒度支持行 / 词 / 字符；勾选忽略大小写或空白后，比较与展示均按归一化内容（折叠空白、转小写）',
  '内置 Myers 最短编辑脚本；差异过大（编辑距离 >600）或总量超限（>6000 项）时退化为「全删+全增」的有效脚本并在结果标注，不会崩溃',
  '修改行配对策略：相邻的删除块与新增块两两配对为「修改」'
]

const SAMPLES = [
  { name: '改一行', a: '第一行\n第二行\n第三行', b: '第一行\n第二行改了\n第三行' },
  { name: '纯新增', a: 'A\nB\nC', b: 'A\nB\n新增1\n新增2\nC' },
  { name: '删除+空行', a: '头部\n\n内容一\n内容二\n尾部', b: '头部\n尾部' },
  { name: '词级对比', a: 'the quick brown fox', b: 'the slow red fox', granularity: 'word' },
  { name: '字符级', a: '你好，世界', b: '你好，宇宙', granularity: 'char' }
]

const MAX_DISPLAY_ROWS = 500

/** 按粒度切 token；忽略选项作用于比较与展示（归一化） */
function tokenizeFor(text, granularity, ignoreCase, ignoreWhitespace) {
  let items
  if (granularity === 'line') {
    items = String(text).replace(/\r\n?/g, '\n').split('\n')
    if (ignoreWhitespace) items = items.map(function (s) { return s.trim().replace(/\s+/g, ' ') })
  } else if (granularity === 'char') {
    items = Array.from(String(text))
    if (ignoreWhitespace) items = items.filter(function (ch) { return !/\s/.test(ch) })
  } else {
    if (ignoreWhitespace) items = String(text).trim().split(/\s+/).filter(function (x) { return x.length > 0 })
    else items = String(text).split(/(\s+)/).filter(function (x) { return x.length > 0 })
  }
  if (ignoreCase) items = items.map(function (s) { return String(s).toLowerCase() })
  return items
}

/** 完整对比：返回分栏 rows / 统计 / unified 补丁 */
function diffAll(aText, bText, opts) {
  const o = opts || {}
  const gran = o.granularity || 'line'
  const ctx = o.contextLines === undefined ? 3 : o.contextLines
  const itemsA = tokenizeFor(aText, gran, o.ignoreCase, o.ignoreWhitespace)
  const itemsB = tokenizeFor(bText, gran, o.ignoreCase, o.ignoreWhitespace)
  const ops = diff.diffArrays(itemsA, itemsB)
  const rows = diff.toDisplayRows(ops)
  const sim = Math.round(diff.similarity(ops) * 1000) / 10
  let add = 0, del = 0, mod = 0, eq = 0
  const display = []
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    if (r.type === 'add') add++
    else if (r.type === 'del') del++
    else if (r.type === 'mod') mod++
    else eq++
    if (display.length < MAX_DISPLAY_ROWS) display.push(r)
  }
  return {
    rows: display,
    truncated: rows.length > MAX_DISPLAY_ROWS,
    stats: { add: add, del: del, mod: mod, eq: eq, similarity: sim },
    unified: diff.toUnified(ops, ctx),
    itemsA: itemsA.length,
    itemsB: itemsB.length,
    capped: itemsA.length + itemsB.length > diff.TOTAL_CAP
  }
}

function defaults() {
  return { granularity: 'line', view: 'split', ignoreCase: false, ignoreWhitespace: false, contextLines: 3 }
}

function buildSchema() {
  return [
    { key: 'granularity', label: '对比粒度', type: 'segment', def: 'line', options: [{ value: 'line', label: '行' }, { value: 'word', label: '词' }, { value: 'char', label: '字符' }] },
    { key: 'view', label: '视图', type: 'segment', def: 'split', options: [{ value: 'split', label: '左右分栏' }, { value: 'unified', label: 'unified 补丁' }] },
    { key: 'ignoreCase', label: '忽略大小写', type: 'switch', def: false },
    { key: 'ignoreWhitespace', label: '忽略空白（折叠/去首尾）', type: 'switch', def: false },
    { key: 'contextLines', label: '补丁上下文行数', type: 'slider', def: 3, min: 0, max: 10, step: 1, showIf: { key: 'view', in: ['unified'] } }
  ]
}

Page({
  data: {
    tool: null,
    values: defaults(),
    left: '',
    right: '',
    schema: buildSchema(),
    tips: TIPS,
    busy: false,
    result: null,
    error: null,
    diffOut: null,
    statRows: [],
    samples: SAMPLES
  },

  onLoad(query) {
    const tool = registry.get(TOOL_ID)
    const values = Object.assign(defaults(), store.params(TOOL_ID) || {})
    this.setData({ tool: tool, values: values, left: values.__left || '', right: values.__right || '' })
    track.track('tool_open', { toolId: TOOL_ID, from: query.from || 'menu' })
  },

  onParamChange(e) {
    const values = Object.assign({}, this.data.values)
    values[e.detail.key] = e.detail.value
    this.setData({ values: values, schema: buildSchema() })
    this.remember(values)
  },

  remember(values) {
    store.saveParams(TOOL_ID, Object.assign({}, values, { __left: this.data.left, __right: this.data.right }))
  },

  onLeft(e) {
    this.setData({ left: e.detail.value })
    this.scheduleSave()
  },

  onRight(e) {
    this.setData({ right: e.detail.value })
    this.scheduleSave()
  },

  scheduleSave() {
    clearTimeout(this._saveTimer)
    this._saveTimer = setTimeout(function () {
      store.saveParams(TOOL_ID, Object.assign({}, this.data.values, { __left: this.data.left, __right: this.data.right }))
    }.bind(this), 500)
  },

  onPasteLeft() { this.pasteTo('left') },
  onPasteRight() { this.pasteTo('right') },

  pasteTo(field) {
    wx.getClipboardData({
      success: (res) => {
        const v = String((res && res.data) || '')
        if (!v) return wx.showToast({ title: '剪贴板为空', icon: 'none' })
        const patch = {}
        patch[field] = v.slice(0, common.MAX_INPUT_LEN)
        this.setData(patch)
      },
      fail: () => wx.showToast({ title: '无法读取剪贴板', icon: 'none' })
    })
  },

  onClearAll() { this.setData({ left: '', right: '', result: null, diffOut: null, error: null }) },

  onSwap() {
    this.setData({ left: this.data.right, right: this.data.left })
  },

  onSample(e) {
    const s = SAMPLES[Number(e.currentTarget.dataset.index)]
    if (!s) return
    const values = Object.assign({}, defaults(), this.data.values, { granularity: s.granularity || 'line', view: 'split' })
    this.setData({ left: s.a, right: s.b, values: values, schema: buildSchema(), result: null, diffOut: null, error: null })
    this.onRun()
  },

  onRun() {
    if (this.data.busy) return
    if (!this.data.left && !this.data.right) {
      return this.setData({ error: { code: 'INPUT_EMPTY', message: error.message('INPUT_EMPTY', { reason: '请输入左右两段要对比的文本' }) }, result: null, diffOut: null })
    }
    if (!this.data.left || !this.data.right) {
      return this.setData({ error: { code: 'INPUT_EMPTY', message: error.message('INPUT_EMPTY', { reason: (this.data.left ? '右侧' : '左侧') + '文本为空，diff 需要两段文本（一侧为空请先用清空）' }) }, result: null, diffOut: null })
    }
    if (this.data.left.length > common.MAX_INPUT_LEN || this.data.right.length > common.MAX_INPUT_LEN) {
      return this.setData({ error: { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { reason: '单侧文本超过 1,000,000 字符上限' }) }, result: null, diffOut: null })
    }
    const v = this.data.values
    this.setData({ busy: true, error: null, result: null, diffOut: null })
    track.track('tool_run_start', { toolId: TOOL_ID, granularity: v.granularity })
    const t0 = Date.now()
    try {
      const d = diffAll(this.data.left, this.data.right, {
        granularity: v.granularity,
        ignoreCase: !!v.ignoreCase,
        ignoreWhitespace: !!v.ignoreWhitespace,
        contextLines: Number(v.contextLines)
      })
      const notes = []
      if (d.capped) notes.push('总量超 ' + diff.TOTAL_CAP + ' 项，退化为全删+全增（非最短编辑脚本）')
      if (d.truncated) notes.push('差异行数超 ' + MAX_DISPLAY_ROWS + '，分栏仅展示前 ' + MAX_DISPLAY_ROWS + ' 行，统计仍为全量')
      if (v.ignoreCase || v.ignoreWhitespace) notes.push('已按归一化文本比较与展示')
      const statRows = [
        { k: '新增', v: String(d.stats.add), c: 'ok' },
        { k: '删除', v: String(d.stats.del), c: 'err' },
        { k: '修改', v: String(d.stats.mod), c: 'warn' },
        { k: '相同', v: String(d.stats.eq), c: 'none' },
        { k: '相似度', v: d.stats.similarity + '%', c: 'none' },
        { k: '左/右项数', v: d.itemsA + ' / ' + d.itemsB, c: 'none' }
      ]
      const result = {
        text: d.unified || '（两段内容一致，无补丁输出）',
        meta: '文本对比 · ' + v.granularity + ' · ' + (Date.now() - t0) + 'ms · 端' + (notes.length ? ' · ' + notes.join('；') : '')
      }
      track.track('tool_run_success', { toolId: TOOL_ID, costMs: Date.now() - t0, engine: 'client' })
      this.setData({ result: result, diffOut: d, statRows: statRows, busy: false })
      this.remember(v)
    } catch (e) {
      const code = e.code || 'PARAM_INVALID'
      track.track('tool_run_fail', { toolId: TOOL_ID, code: code })
      this.setData({ busy: false, error: { code: code, message: e.message || error.message(code) } })
    }
  },

  onCopy(e) {
    common.copyText((e.detail && e.detail.text) || '', TOOL_ID, track)
  },

  onCopyPatch() {
    if (this.data.result && this.data.result.text) common.copyText(this.data.result.text, TOOL_ID, track)
  },

  onShare() {
    track.track('result_share', { toolId: TOOL_ID })
    wx.showToast({ title: '点右上角「…」转发给朋友', icon: 'none' })
  },

  onShareAppMessage() {
    return { title: '文本对比 · 行词字符三粒度分栏高亮', path: '/packageText/pages/diff/index?toolId=' + TOOL_ID + '&from=share' }
  }
})

module.exports = { tokenizeFor: tokenizeFor, diffAll: diffAll }
