const registry = require('../../../tools/registry')
const store = require('../../../utils/store')
const track = require('../../../utils/track')
const error = require('../../../utils/error')
const textops = require('../../utils/textops')
const common = require('../../utils/common')

const TOOL_ID = 'text-multiline'

const OP_LABEL = {}
const OP_META = {}
textops.MULTILINE_OPS.forEach(function (o) {
  OP_LABEL[o.id] = o.label
  OP_META[o.id] = o
})

const TIPS = [
  '按添加顺序依次执行，操作链在结果中可视化（A → B → C）',
  '去重保留首次出现顺序；排序含升/降/行长/自然数字四种',
  '随机打乱使用与 UUID 页同源的随机源（wx.getRandomValues 可用时为其结果）',
  '单步参数错误不会中断整条链：该步跳过并在备注中说明',
  '参数（操作链与文本）本地记忆，下次进入自动恢复'
]

const SAMPLES = [
  { name: '去重排序编号', chain: [{ id: 'trim', arg: '' }, { id: 'nonempty', arg: '' }, { id: 'dedup', arg: '' }, { id: 'sortNat', arg: '' }, { id: 'number', arg: '1,1' }], input: 'b\na\n  a \nc\n\nb' },
  { name: '加前缀替换', chain: [{ id: 'replace', arg: 'foo=>bar' }, { id: 'prefix', arg: '- ' }], input: 'foo is good\nnot foo' },
  { name: '截取合并', chain: [{ id: 'nonempty', arg: '' }, { id: 'slice', arg: '2,4' }, { id: 'join', arg: ', ' }], input: '第1行\n第2行\n第3行\n第4行\n第5行' },
  { name: '正则清洗', chain: [{ id: 'replaceRe', arg: '\\s+=>_' }, { id: 'suffix', arg: '!' }], input: 'Hello World ToolBox' }
]

function defaults() {
  return { chain: [{ id: 'trim', arg: '' }, { id: 'dedup', arg: '' }] }
}

Page({
  data: {
    tool: null,
    values: defaults(),
    input: '',
    tips: TIPS,
    opList: textops.MULTILINE_OPS.map(function (o) { return { id: o.id, label: o.label } }),
    steps: [],
    busy: false,
    result: null,
    error: null,
    kv: [],
    samples: SAMPLES
  },

  onLoad(query) {
    const tool = registry.get(TOOL_ID)
    const saved = store.params(TOOL_ID) || {}
    const values = Object.assign(defaults(), saved)
    if (!Array.isArray(values.chain)) values.chain = defaults().chain
    this.setData({ tool: tool, values: values, input: values.__text || '' })
    this.refreshSteps()
    track.track('tool_open', { toolId: TOOL_ID, from: query.from || 'menu' })
  },

  refreshSteps() {
    const steps = this.data.values.chain.map(function (st) {
      const meta = OP_META[st.id] || { label: st.id, hasArg: false, argLabel: '', argPlaceholder: '' }
      return { id: st.id, arg: st.arg || '', label: meta.label, hasArg: meta.hasArg, argLabel: meta.argLabel || '', argPlaceholder: meta.argPlaceholder || '' }
    })
    this.setData({ steps: steps })
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

  onClearInput() { this.setData({ input: '', result: null, kv: [], error: null }) },

  onAddOp(e) {
    const id = e.currentTarget.dataset.id
    if (!OP_META[id]) return
    const chain = this.data.values.chain.concat([{ id: id, arg: '' }])
    const values = Object.assign({}, this.data.values, { chain: chain })
    this.setData({ values: values })
    this.refreshSteps()
    this.remember(values)
  },

  onRemoveOp(e) {
    const i = Number(e.currentTarget.dataset.index)
    const chain = this.data.values.chain.slice()
    if (i < 0 || i >= chain.length) return
    chain.splice(i, 1)
    const values = Object.assign({}, this.data.values, { chain: chain })
    this.setData({ values: values })
    this.refreshSteps()
    this.remember(values)
  },

  onMoveOp(e) {
    const i = Number(e.currentTarget.dataset.index)
    const dir = e.currentTarget.dataset.dir === 'up' ? -1 : 1
    const chain = this.data.values.chain.slice()
    const j = i + dir
    if (i < 0 || j < 0 || i >= chain.length || j >= chain.length) return
    const t = chain[i]
    chain[i] = chain[j]
    chain[j] = t
    const values = Object.assign({}, this.data.values, { chain: chain })
    this.setData({ values: values })
    this.refreshSteps()
    this.remember(values)
  },

  onStepArg(e) {
    const i = Number(e.currentTarget.dataset.index)
    const chain = this.data.values.chain.slice()
    if (i < 0 || i >= chain.length) return
    chain[i] = { id: chain[i].id, arg: e.detail.value }
    const values = Object.assign({}, this.data.values, { chain: chain })
    this.setData({ values: values })
    this.refreshSteps()
    this.remember(values)
  },

  onSample(e) {
    const s = SAMPLES[Number(e.currentTarget.dataset.index)]
    if (!s) return
    const chain = s.chain.map(function (c) { return { id: c.id, arg: c.arg || '' } })
    const values = Object.assign({}, this.data.values, { chain: chain })
    this.setData({ input: s.input, values: values, result: null, kv: [], error: null })
    this.refreshSteps()
    this.remember(values)
    this.onRun()
  },

  onRun() {
    if (this.data.busy) return
    const check = common.checkTextInput(this.data.input, '多行文本')
    if (check) {
      return this.setData({ error: { code: this.data.input ? 'PARAM_INVALID' : 'INPUT_EMPTY', message: check }, result: null, kv: [] })
    }
    const chain = this.data.values.chain
    if (!chain.length) {
      return this.setData({ error: { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { reason: '请先从下方操作清单添加至少一个操作' }) }, result: null })
    }
    this.setData({ busy: true, error: null, result: null, kv: [] })
    track.track('tool_run_start', { toolId: TOOL_ID, ops: chain.length })
    const t0 = Date.now()
    try {
      const d = textops.applyChain(this.data.input, chain)
      const kv = [
        { key: '操作链', value: d.chainText },
        { key: '行数变化', value: d.lineIn + ' → ' + d.lineOut }
      ]
      if (d.shuffleSecure !== null) kv.push({ key: '打乱随机源', value: d.shuffleSecure ? 'wx.getRandomValues' : '混合种子' })
      for (let i = 0; i < d.notes.length; i++) kv.push({ key: '备注 ' + (i + 1), value: d.notes[i] })
      const result = {
        text: d.output,
        meta: '多行处理 · ' + chain.length + ' 步 · ' + (Date.now() - t0) + 'ms · 端'
      }
      track.track('tool_run_success', { toolId: TOOL_ID, costMs: Date.now() - t0, engine: 'client' })
      this.setData({ result: result, kv: kv, busy: false })
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
    return { title: '多行处理 · 去重排序加序号批处理', path: '/packageText/pages/multiline/index?toolId=' + TOOL_ID + '&from=share' }
  }
})

module.exports = { OP_LABEL: OP_LABEL }
