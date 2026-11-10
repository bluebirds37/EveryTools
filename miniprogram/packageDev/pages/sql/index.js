const registry = require('../../../tools/registry')
const store = require('../../../utils/store')
const track = require('../../../utils/track')
const error = require('../../../utils/error')
const sqlutil = require('../../utils/sql')

const TOOL_ID = 'dev-sql'
const MAX_SQL_CHARS = 200000 // tools-spec FR-G-03：文本输入 200KB 上限（registry limits.maxBytes=0 表示无文件大小限制）
const BLOCK_LINES = 120 // 超长结果分段渲染，避免一次铺满整屏

function defaults() {
  return { sql: '', mode: 'pretty', keywordCase: 'upper', indent: '2' }
}

function buildSchema() {
  return [
    { key: 'sql', label: 'SQL 语句', type: 'textarea', def: '', rows: 8, placeholder: '粘贴 SELECT / INSERT / UPDATE 语句（只做语法层排版，绝不执行）', hint: '上限 ' + MAX_SQL_CHARS + ' 字符；字符串与注释原样保留' },
    { key: 'mode', label: '输出方式', type: 'segment', def: 'pretty', options: [{ value: 'pretty', label: '美化排版' }, { value: 'compact', label: '单行压缩' }] },
    { key: 'keywordCase', label: '关键字大小写', type: 'segment', def: 'upper', options: [{ value: 'upper', label: '大写' }, { value: 'lower', label: '小写' }, { value: 'keep', label: '保持' }] },
    { key: 'indent', label: '缩进', type: 'segment', def: '2', options: [{ value: '2', label: '2 空格' }, { value: '4', label: '4 空格' }], showIf: { key: 'mode', in: ['pretty'] } }
  ]
}

function validate(v) {
  const text = String(v.sql || '')
  if (!text.trim()) return { code: 'INPUT_EMPTY', message: error.message('INPUT_EMPTY') }
  if (text.length > MAX_SQL_CHARS) {
    return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { field: 'SQL 长度', range: '≤ ' + MAX_SQL_CHARS + ' 字符（当前 ' + text.length + '，请拆分语句或改用文件处理）' }) }
  }
  if (!/[A-Za-z\u4e00-\u9fa5]/.test(text)) return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { reason: '内容里没有任何标识符，不像 SQL 语句' }) }
  return null
}

function splitBlocks(text) {
  const lines = String(text).split('\n')
  if (lines.length <= BLOCK_LINES) {
    return [{ label: '共 ' + lines.length + ' 行', text: text }]
  }
  const blocks = []
  for (let i = 0; i < lines.length; i += BLOCK_LINES) {
    const part = lines.slice(i, i + BLOCK_LINES)
    blocks.push({ label: '第 ' + (i + 1) + '–' + (i + part.length) + ' 行', text: part.join('\n') })
  }
  return blocks
}

function run(v) {
  const opts = { keywordCase: v.keywordCase, indent: Number(v.indent) === 4 ? 4 : 2 }
  const out = v.mode === 'compact' ? sqlutil.compact(v.sql, opts) : sqlutil.pretty(v.sql, opts)
  if (out.error) {
    throw error.make('PARAM_INVALID', { field: '第 ' + out.error.line + ' 行（第 ' + (out.error.position + 1) + ' 个字符）', reason: out.error.reason })
  }
  const balance = sqlutil.balanceCheck(v.sql)
  const notes = []
  if (!balance.ok) notes.push(balance.diff > 0 ? '左括号比右括号多 ' + balance.diff + ' 个，原样输出不补全' : '右括号多出 ' + -balance.diff + ' 个，请检查语句')
  if (v.mode === 'compact' && out.multilineForced) notes.push('含 -- / # 行注释，压缩时按注释边界保留换行，否则会吞掉后续语句')
  if (v.mode === 'compact' && out.lines > 1 && !out.multilineForced) notes.push('按 ; 语句分隔换行')
  const tokens = sqlutil.tokenize(v.sql)
  // token 的形状是 {type,value,index}（不是 {t}），空白段类型叫 space
  const count = tokens.tokens ? tokens.tokens.filter(function (t) {
    return t.type !== 'space'
  }).length : 0
  return {
    mode: v.mode,
    text: out.text,
    blocks: splitBlocks(out.text),
    lines: out.text.split('\n').length,
    tokens: count,
    notes: notes,
    engineUsed: 'client',
    meta: ''
  }
}

Page({
  data: {
    tool: null,
    values: defaults(),
    schema: buildSchema(),
    busy: false,
    result: null,
    error: null,
    actions: [{ toolId: 'text-json', label: '转成 JSON 查看' }],
    tips: [
      '只做词法级排版：SELECT/FROM/WHERE 等主关键字换行、AND/OR 缩进、子查询按括号层级缩进，不解析语义、不执行 SQL',
      '字符串字面量（含单引号转义）、反引号/双引号标识符、-- 与 # 行注释、/* */ 块注释内部绝不会被插入换行',
      '关键字大写只作用于识别到的关键字，表名/列名保持原样，避免大小写敏感引擎被改坏',
      '单行压缩遇到行注释时会保留换行（否则注释会吞掉整行语句），并在提示里说明原因',
      '结果超过 ' + BLOCK_LINES + ' 行会自动分段渲染，可逐段复制，也可一次复制全部'
    ],
    samples: [
      { name: '多表 JOIN', v: { sql: "select u.id,u.name,o.amount from users u inner join orders o on o.uid=u.id and o.status='paid' where u.created_at>='2026-01-01' order by o.amount desc limit 20;", mode: 'pretty' } },
      { name: '子查询与注释', v: { sql: "-- 统计活跃用户\nselect count(1) from users u where u.id in (select uid from sessions s where s.last_seen > /* 阈值 */ 1767289600) and u.tag like '%\\_vip%';" } },
      { name: '压缩为单行', v: { sql: "INSERT INTO logs (a, b, c) VALUES ( 1 , 'x, y' , NOW() );", mode: 'compact' } },
      { name: '未闭合字符串', v: { sql: "select * from t where name = 'abc" } }
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
      const cost = Math.max(1, Date.now() - t0)
      result.cost = cost
      result.meta = (v.mode === 'compact' ? '单行压缩' : '美化排版') + ' · ' + result.lines + ' 行 · ' + result.tokens + ' 个记号 · 耗时 ' + cost + ' ms · 引擎 client'
      track.track('tool_run_success', { toolId: TOOL_ID, costMs: cost, engine: 'client' })
      store.bumpUsage(TOOL_ID)
      this.setData({ result: result, busy: false })
      if (cost > 500) wx.showToast({ title: '语句较长，已优化分段渲染', icon: 'none' })
    } catch (e) {
      track.track('tool_run_fail', { toolId: TOOL_ID, code: e.code || 'TASK_FAILED' })
      this.setData({ error: { code: e.code || 'TASK_FAILED', message: error.message(e.code || 'TASK_FAILED', e.extra) }, busy: false })
    }
  },

  onSample(e) {
    const idx = Number(e.currentTarget.dataset.index)
    const values = Object.assign({}, this.data.values, this.data.samples[idx].v)
    this.setData({ values: values, result: null, error: null })
    store.saveParams(TOOL_ID, values)
    this.onRun()
  },

  copy(text) {
    if (!text) return
    wx.setClipboardData({
      data: text,
      success: function () {
        wx.showToast({ title: '已复制', icon: 'success' })
        track.track('result_copy', { toolId: TOOL_ID })
      }
    })
  },

  onCopyBlock(e) {
    this.copy(e.currentTarget.dataset.text || '')
  },

  onCopy(e) {
    this.copy((e.detail && e.detail.text) || (this.data.result && this.data.result.text) || '')
  },

  onAction(e) {
    const id = e.detail && e.detail.toolId
    if (id) track.openTool(id, 'dev-sql')
  },

  onShareAppMessage() {
    return { title: 'SQL 格式化 · 美化与单行压缩', path: '/packageDev/pages/sql/index?toolId=' + TOOL_ID + '&from=share' }
  }
})
