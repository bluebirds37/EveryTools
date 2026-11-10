const registry = require('../../../tools/registry')
const store = require('../../../utils/store')
const track = require('../../../utils/track')
const error = require('../../../utils/error')
const rnd = require('../../utils/random')

const TOOL_ID = 'calc-random'
const LIST_MAX = 200
const WHEEL_COLORS = ['#0EA5E9', '#3B82F6', '#8B5CF6', '#EC4899', '#F97316', '#14B8A6', '#38BDF8', '#6366F1'] // 转盘扇区调色板（与主题 accent 同源）
const WHEEL_SPIN_MS = 2200 // ≥1.5s 旋转动画时长
const WHEEL_SPIN_EXTRA = 5 * 360 // 落地前额外整圈数

function defaults() {
  return { mode: 'int', min: 1, max: 100, count: 3, listText: '甲\n乙\n丙\n丁\n戊\n己', groupSize: 3, noRepeat: true, exclude: '' }
}

function buildSchema() {
  const usesList = ['wheel', 'group', 'pick']
  return [
    { key: 'mode', label: '模式', type: 'segment', def: 'int', options: [{ value: 'int', label: '随机整数' }, { value: 'unique', label: '不重复整数' }, { value: 'coin', label: '抛硬币' }, { value: 'wheel', label: '转盘' }, { value: 'group', label: '分组抽签' }, { value: 'pick', label: '名单抽取' }] },
    { key: 'min', label: '最小值', type: 'number', def: 1, min: -1000000, max: 1000000, showIf: { key: 'mode', in: ['int', 'unique'] } },
    { key: 'max', label: '最大值', type: 'number', def: 100, min: -1000000, max: 1000000, showIf: { key: 'mode', in: ['int', 'unique'] } },
    { key: 'count', label: '抽取个数', type: 'slider', def: 3, min: 1, max: 20, step: 1, showIf: { key: 'mode', in: ['int', 'unique', 'pick'] } },
    { key: 'listText', label: '名单（每行一项，≤' + LIST_MAX + ' 项）', type: 'textarea', def: '甲\n乙\n丙', showIf: { key: 'mode', in: usesList } },
    { key: 'exclude', label: '排除项（顿号/换行分隔）', type: 'textarea', def: '', showIf: { key: 'mode', in: usesList } },
    { key: 'groupSize', label: '每组人数', type: 'number', def: 3, min: 1, max: 50, showIf: { key: 'mode', in: ['group'] } },
    { key: 'noRepeat', label: '跨轮不重复', type: 'switch', def: true, showIf: { key: 'mode', in: ['wheel', 'pick'] } }
  ]
}

function parseList(text, excludeText) {
  const ex = {}
  String(excludeText || '').split(/[\n;；、,，]+/).forEach(function (t) {
    const k = t.trim()
    if (k) ex[k] = true
  })
  const items = []
  const seen = {}
  const lines = String(text || '').split(/[\n;；]+/)
  for (let i = 0; i < lines.length && items.length < LIST_MAX; i++) {
    const k = lines[i].trim()
    if (!k || ex[k] || seen[k]) continue
    seen[k] = true
    items.push(k)
  }
  return items
}

function listSig(items) {
  return items.join('|').length + ':' + items.length
}

function validate(v, page) {
  const invalid = function (reason) { return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { reason: reason }) } }
  if (v.mode === 'int' || v.mode === 'unique') {
    const a = Math.ceil(Number(v.min)), b = Math.floor(Number(v.max))
    if (!(a <= b)) return invalid('最小值需不大于最大值')
    if (v.mode === 'unique' && Number(v.count) > b - a + 1) return invalid('抽取个数超过区间可用整数个数')
  }
  if (['wheel', 'group', 'pick'].indexOf(v.mode) >= 0) {
    const items = parseList(v.listText, v.exclude)
    if (items.length < 2) return invalid('名单有效项需 ≥2（每行一项，重复与排除项已剔除）')
    if (v.mode === 'pick' && !poolOf(page, v, items).length) return invalid('候选池已抽完，请先点「重置候选池」')
  }
  return null
}

function poolOf(page, v, items) {
  if (!v.noRepeat) return items
  if (page._remaining && page._sig === listSig(items)) return page._remaining
  return items
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
      '随机源优先使用 wx.getRandomValues 播种，兜底为系统熵混合序列',
      '转盘「先算结果、后播动画」：停止位置即中奖扇区，不会转完再改',
      '名单/转盘开启「跨轮不重复」后，中选项不再进入下一轮，直至抽完',
      '名单最多 ' + LIST_MAX + ' 项，结果可一键复制；硬币/抽取各模式独立'
    ],
    samples: [
      { name: '1–100 抽 5 个', v: { mode: 'int', min: 1, max: 100, count: 5 } },
      { name: '6 人转盘', v: { mode: 'wheel', listText: '甲\n乙\n丙\n丁\n戊\n己' } },
      { name: '8 人分 3 组', v: { mode: 'group', listText: 'A1\nA2\nB1\nB2\nC1\nC2\nD1\nD2', groupSize: 3 } }
    ],
    // 转盘视图状态
    wheelSectors: [],
    wheelStyle: '',
    wheelShowLabels: false,
    remainCount: -1
  },

  onLoad(query) {
    const tool = registry.get(TOOL_ID)
    rnd.trySeedFromWx()
    const saved = store.params(TOOL_ID) || {}
    this._remaining = Array.isArray(saved.__remaining) ? saved.__remaining : null
    this._sig = saved.__sig || ''
    this._rot = 0
    this.setData({ tool: tool, values: Object.assign(defaults(), saved) })
    track.track('tool_open', { toolId: TOOL_ID, from: query.from || 'menu' })
  },

  onParamChange(e) {
    const values = Object.assign({}, this.data.values, { [e.detail.key]: e.detail.value })
    this.setData({ values: values })
    this.persist(values)
    if (this.data.result) this.setData({ result: null })
  },

  persist(values) {
    const out = Object.assign({}, values, {
      __remaining: this._remaining || [],
      __sig: this._sig || ''
    })
    store.saveParams(TOOL_ID, out)
  },

  onResetPool() {
    this._remaining = null
    this._sig = ''
    this.persist(this.data.values)
    this.setData({ result: null, error: null, remainCount: -1 })
    wx.showToast({ title: '候选池已重置', icon: 'none' })
  },

  onRun() {
    if (this.data.busy) return
    const v = this.data.values
    const invalid = validate(v, this)
    if (invalid) return this.setData({ error: invalid, result: null })
    this.setData({ busy: true, error: null })
    track.track('tool_run_start', { toolId: TOOL_ID, mode: v.mode })
    try {
      if (v.mode === 'wheel') return this.runWheel(v)
      const result = this.compute(v)
      track.track('tool_run_success', { toolId: TOOL_ID, costMs: 0, engine: 'client' })
      this.setData({ result: result, busy: false, remainCount: this._remaining ? this._remaining.length : -1 })
      this.persist(v)
    } catch (e) {
      track.track('tool_run_fail', { toolId: TOOL_ID, code: e.code || 'TASK_FAILED' })
      this.setData({ error: { code: e.code || 'TASK_FAILED', message: error.message(e.code || 'TASK_FAILED') }, busy: false })
    }
  },

  compute(v) {
    const kvOf = function (kv, meta) { return { kv: kv, text: kv.map(function (x) { return x.key + ': ' + x.value }).join('\n'), meta: meta } }
    if (v.mode === 'int') {
      const picked = []
      for (let i = 0; i < Number(v.count); i++) picked.push(rnd.intIn(Number(v.min), Number(v.max)))
      return kvOf([{ key: '结果', value: picked.join('、') }, { key: '范围', value: '[' + Math.ceil(Number(v.min)) + ', ' + Math.floor(Number(v.max)) + ']' }], '随机整数')
    }
    if (v.mode === 'unique') {
      const picked = rnd.uniqueInts(Number(v.min), Number(v.max), Number(v.count))
      const set = {}
      picked.forEach(function (x) { set[x] = true })
      return kvOf([
        { key: '结果', value: picked.join('、') },
        { key: '去重校验', value: Object.keys(set).length === picked.length ? picked.length + ' 项互不相同' : '异常：出现重复' }
      ], '不重复整数')
    }
    if (v.mode === 'coin') return kvOf([{ key: '结果', value: rnd.coinFlip() }], '抛硬币')
    if (v.mode === 'group') {
      const items = parseList(v.listText, v.exclude)
      const groups = rnd.groupDraw(items, Number(v.groupSize))
      const kv = groups.map(function (g, i) { return { key: '第 ' + (i + 1) + ' 组（' + g.length + ' 人）', value: g.join('、') } })
      kv.push({ key: '总人数', value: items.length + ' 人 / ' + groups.length + ' 组' })
      return kvOf(kv, '分组抽签')
    }
    // pick：名单抽取（可选跨轮不重复）
    const items = parseList(v.listText, v.exclude)
    const pool = poolOf(this, v, items)
    const round = rnd.drawRound(pool, Number(v.count))
    if (v.noRepeat) {
      this._remaining = round.remaining
      this._sig = listSig(items)
    }
    const kv = [{ key: '本轮抽出', value: round.picked.join('、') }]
    if (v.noRepeat) {
      kv.push({ key: '剩余候选', value: round.remaining.length + ' 项' })
      if (round.remaining.length === 0) kv.push({ key: '提示', value: '候选池已抽完，点下方按钮重置' })
    } else {
      kv.push({ key: '名单总数', value: items.length + ' 项（每轮独立）' })
    }
    return kvOf(kv, '名单抽取')
  },

  runWheel(v) {
    const items = parseList(v.listText, v.exclude)
    const pool = poolOf(this, v, items)
    // 先算结果：在剩余候选中等权重抽取，再映射到完整名单扇区位置
    const idx = rnd.weightedIndex(pool.map(function () { return 1 }))
    const winner = pool[idx]
    const pos = Math.max(0, items.indexOf(winner))
    const sector = 360 / items.length
    const center = pos * sector + sector / 2
    const base = this._rot || 0
    const target = base - (base % 360) + WHEEL_SPIN_EXTRA + (360 - center)
    this._rot = target
    const stops = []
    for (let i = 0; i < items.length; i++) {
      stops.push(WHEEL_COLORS[i % WHEEL_COLORS.length] + ' ' + (i * sector).toFixed(3) + 'deg ' + ((i + 1) * sector).toFixed(3) + 'deg')
    }
    const sectors = items.map(function (name, i) {
      return { name: name, angle: i * sector + sector / 2 }
    })
    this._pendingWheel = { v: v, items: items, winner: winner, pool: pool, idx: idx }
    this.setData({
      wheelSectors: sectors,
      wheelShowLabels: items.length <= 12,
      wheelStyle: 'background: conic-gradient(' + stops.join(',') + '); transform: rotate(' + target + 'deg); transition: transform ' + (WHEEL_SPIN_MS / 1000) + 's cubic-bezier(0.2, 0.85, 0.25, 1);'
    })
    setTimeout(this.revealWheel.bind(this), WHEEL_SPIN_MS + 120)
  },

  revealWheel() {
    const p = this._pendingWheel
    if (!p) return
    this._pendingWheel = null
    if (p.v.noRepeat) {
      const newPool = p.pool.slice()
      newPool.splice(p.idx, 1)
      this._remaining = newPool
      this._sig = listSig(p.items)
      this.persist(p.v)
    }
    const kv = [{ key: '中奖', value: p.winner }]
    if (p.v.noRepeat) {
      kv.push({ key: '剩余候选', value: this._remaining.length + ' 项' })
      if (this._remaining.length === 0) kv.push({ key: '提示', value: '候选池已抽完，点下方按钮重置' })
    }
    kv.push({ key: '扇区数', value: p.items.length + '（等权重）' })
    track.track('tool_run_success', { toolId: TOOL_ID, costMs: WHEEL_SPIN_MS, engine: 'client' })
    this.setData({
      result: { kv: kv, text: kv.map(function (x) { return x.key + ': ' + x.value }).join('\n'), meta: '转盘 · 指针即中奖' },
      busy: false,
      remainCount: p.v.noRepeat ? this._remaining.length : -1
    })
  },

  onSample(e) {
    const idx = Number(e.currentTarget.dataset.index)
    const values = Object.assign(defaults(), this.data.samples[idx].v)
    this._remaining = null
    this._sig = ''
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
    return { title: '随机数与决策 · 转盘先算后转不骗人', path: '/packageCalc/pages/random/index?from=share' }
  }
})
