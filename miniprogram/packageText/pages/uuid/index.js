const registry = require('../../../tools/registry')
const store = require('../../../utils/store')
const track = require('../../../utils/track')
const error = require('../../../utils/error')
const random = require('../../utils/random')
const common = require('../../utils/common')

const TOOL_ID = 'text-uuid'

const AMBIGUOUS = '0O1lI|`\'".,;:<>{}[]()/'

const NANOID_DEFAULT = 'A-Za-z0-9_-~'

const TIPS = [
  '随机源优先使用 wx.getRandomValues（CSPRNG），不可用时切换为时间+计数器混合种子的 xorshift 流，结果面板会标注',
  'UUID v4 按 RFC 4122 修正版本位/变体位；批量生成自动查重，重复项重采样',
  '雪花 ID 为 41 位毫秒时间戳 + 5 位机房 + 5 位机器 + 12 位序列（BigInt 组装，无精度坍缩）',
  '口令强度 = 长度 × log2(字符集大小) 比特熵：<40 弱 / 40–60 中 / 60–90 强 / ≥90 极强'
]

const SAMPLES = [
  { name: '批量 UUID ×8', v: { type: 'uuidv4', count: 8, hyphens: true, length: 21, charset: '', excludeAmbiguous: false } },
  { name: '雪花 ID ×5', v: { type: 'snowflake', count: 5, hyphens: true, length: 21, charset: '', excludeAmbiguous: false } },
  { name: 'NanoID ×10', v: { type: 'nanoid', count: 10, hyphens: true, length: 16, charset: '', excludeAmbiguous: false } },
  { name: '高强度口令', v: { type: 'custom', count: 3, hyphens: true, length: 24, charset: 'A-Za-z0-9', excludeAmbiguous: true } }
]

function defaults() {
  return { type: 'uuidv4', count: 5, hyphens: true, length: 21, charset: '', excludeAmbiguous: false }
}

function buildSchema(v) {
  return [
    { key: 'type', label: '类型', type: 'segment', def: 'uuidv4', options: [{ value: 'uuidv4', label: 'UUID v4' }, { value: 'snowflake', label: '雪花 ID' }, { value: 'nanoid', label: 'NanoID' }, { value: 'custom', label: '自定义字符集' }] },
    { key: 'count', label: '数量', type: 'number', def: 5, min: 1, max: 1000, step: 1 },
    { key: 'hyphens', label: '保留连字符', type: 'switch', def: true, showIf: { key: 'type', in: ['uuidv4'] } },
    { key: 'length', label: '串长度', type: 'number', def: 21, min: 4, max: 64, step: 1, showIf: { key: 'type', in: ['nanoid', 'custom'] } },
    { key: 'charset', label: '字符集（支持 A-Za-z0-9 区间或字面集）', type: 'textarea', def: '', rows: 1, placeholder: '留空=A-Za-z0-9；例：A-Za-z0-9!@#', showIf: { key: 'type', in: ['custom'] } },
    { key: 'excludeAmbiguous', label: '排除易混字符(0O1lI等)', type: 'switch', def: false, showIf: { key: 'type', in: ['nanoid', 'custom'] } }
  ]
}

/** 展开 'A-Za-z0-9!@#' 形式的字符集声明：X-Y 为区间，\c 为字面转义，其余为字面字符 */
function expandCharset(spec) {
  const s = String(spec || '').trim()
  const base = s === '' ? 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789' : s
  const out = []
  const isAlnum = (ch) => !!ch && /[a-zA-Z0-9]/.test(ch)
  let i = 0
  while (i < base.length) {
    const c = base[i]
    if (c === '\\' && i + 1 < base.length) { out.push(base[i + 1]); i += 2; continue }
    if (isAlnum(c) && base[i + 1] === '-' && isAlnum(base[i + 2]) && c.charCodeAt(0) <= base.charCodeAt(i + 2)) {
      const hi = base.charCodeAt(i + 2)
      for (let code = c.charCodeAt(0); code <= hi; code++) out.push(String.fromCharCode(code))
      i += 3
      continue
    }
    out.push(c)
    i++
  }
  const uniq = []
  const seen = {}
  for (const ch of out) {
    if (!seen[ch]) { seen[ch] = 1; uniq.push(ch) }
  }
  if (!uniq.length) throw { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { reason: '字符集为空' }) }
  return uniq.join('')
}

/** 均匀抽样：拒绝法消除取模偏差 */
function pickString(charset, length) {
  const n = charset.length
  const limit = 256 - (256 % n)
  const out = []
  let bytes = null
  let p = 0
  let secure = false
  while (out.length < length) {
    if (!bytes || p >= bytes.length) {
      const r = random.getRandomBytes(Math.max(64, length * 4))
      bytes = r.bytes
      secure = secure || r.secure
      p = 0
    }
    const b = bytes[p++]
    if (b < limit) out.push(charset[b % n])
  }
  return { str: out.join(''), secure: secure }
}

function strengthOf(length, charsetSize) {
  const entropy = length * Math.log2(charsetSize)
  if (entropy >= 90) return { label: '极强', entropy: Math.round(entropy) }
  if (entropy >= 60) return { label: '强', entropy: Math.round(entropy) }
  if (entropy >= 40) return { label: '中', entropy: Math.round(entropy) }
  return { label: '弱', entropy: Math.round(entropy) }
}

Page({
  data: {
    tool: null,
    values: defaults(),
    schema: buildSchema(defaults()),
    tips: TIPS,
    busy: false,
    result: null,
    error: null,
    samples: SAMPLES
  },

  onLoad(query) {
    const tool = registry.get(TOOL_ID)
    const values = Object.assign(defaults(), store.params(TOOL_ID) || {})
    this.setData({ tool: tool, values: values, schema: buildSchema(values) })
    track.track('tool_open', { toolId: TOOL_ID, from: query.from || 'menu' })
  },

  onParamChange(e) {
    const values = Object.assign({}, this.data.values)
    values[e.detail.key] = e.detail.value
    this.setData({ values: values, schema: buildSchema(values) })
    this.remember(values)
  },

  remember(values) {
    store.saveParams(TOOL_ID, values)
  },

  onSample(e) {
    const s = SAMPLES[Number(e.currentTarget.dataset.index)]
    if (!s) return
    const values = Object.assign(defaults(), s.v)
    this.setData({ values: values, schema: buildSchema(values), result: null, error: null })
    this.remember(values)
    this.onRun()
  },

  generate() {
    const v = this.data.values
    const count = Math.min(1000, Math.max(1, Number(v.count) | 0))
    let ids = []
    let secure = false
    let duplicatesFixed = 0
    let charsetSize = 0
    if (v.type === 'uuidv4') {
      const r = random.uuidV4Batch(count)
      ids = v.hyphens ? r.ids : r.ids.map(function (x) { return x.replace(/-/g, '') })
      secure = r.secure
      duplicatesFixed = r.duplicatesFixed
    } else if (v.type === 'snowflake') {
      const r = random.snowflakeBatch(count)
      if (r.error) { const e = new Error(r.error); e.code = 'PARAM_INVALID'; throw e }
      ids = r.ids
    } else {
      let alphabet
      if (v.type === 'nanoid') {
        alphabet = expandCharset(NANOID_DEFAULT)
        const clean = alphabet.split('').filter(function (c) { return AMBIGUOUS.indexOf(c) < 0 }).join('')
        alphabet = v.excludeAmbiguous ? clean : alphabet
      } else {
        alphabet = expandCharset(v.charset)
        if (v.excludeAmbiguous) alphabet = alphabet.split('').filter(function (c) { return AMBIGUOUS.indexOf(c) < 0 }).join('')
      }
      if (alphabet.length < 2) { const e = new Error('参数错误：字符集至少需要 2 个字符'); e.code = 'PARAM_INVALID'; throw e }
      charsetSize = alphabet.length
      const len = Math.min(64, Math.max(4, Number(v.length) | 0))
      const set = {}
      for (let i = 0; i < count; i++) {
        let id
        let guard = 0
        do {
          const r = pickString(alphabet, len)
          id = r.str
          secure = secure || r.secure
        } while (set[id] && ++guard < 8)
        set[id] = 1
        ids.push(id)
      }
    }
    const uniq = {}
    ids.forEach(function (x) { uniq[x] = 1 })
    const uniqueCount = Object.keys(uniq).length
    return { ids: ids, secure: secure, duplicatesFixed: duplicatesFixed, charsetSize: charsetSize, uniqueCount: uniqueCount }
  },

  onRun() {
    if (this.data.busy) return
    this.setData({ busy: true, error: null, result: null })
    track.track('tool_run_start', { toolId: TOOL_ID, type: this.data.values.type })
    const t0 = Date.now()
    try {
      const g = this.generate()
      const rows = [
        { key: '数量', value: String(g.ids.length) },
        { key: '去重校验', value: g.ids.length === g.uniqueCount ? '无重复' : '重复 ' + (g.ids.length - g.uniqueCount) + ' 条' },
        { key: '随机源', value: g.secure ? 'wx.getRandomValues（CSPRNG）' : '混合种子（当前环境无 CSPRNG）' }
      ]
      if (g.charsetSize) {
        const st = strengthOf(Math.min(64, Math.max(4, Number(this.data.values.length) | 0)), g.charsetSize)
        rows.push({ key: '口令强度', value: st.label + '（约 ' + st.entropy + ' bit 熵）' })
      }
      const result = {
        text: g.ids.join('\n'),
        kv: rows,
        meta: this.data.values.type + ' ×' + g.ids.length + ' · ' + (Date.now() - t0) + 'ms · 端'
      }
      track.track('tool_run_success', { toolId: TOOL_ID, costMs: Date.now() - t0, engine: 'client' })
      this.setData({ result: result, busy: false })
    } catch (e) {
      const code = e.code || 'PARAM_INVALID'
      track.track('tool_run_fail', { toolId: TOOL_ID, code: code })
      this.setData({ busy: false, error: { code: code, message: e.message || error.message(code) } })
    }
  },

  onCopy(e) {
    const payload = e.detail || {}
    common.copyText(payload.text || (this.data.result && this.data.result.text) || '', TOOL_ID, track)
  },

  onShare() {
    track.track('result_share', { toolId: TOOL_ID })
    wx.showToast({ title: '点右上角「…」转发给朋友', icon: 'none' })
  },

  onShareAppMessage() {
    return { title: 'UUID 生成 · 批量 id 与口令串', path: '/packageText/pages/uuid/index?toolId=' + TOOL_ID + '&from=share' }
  }
})

module.exports = { expandCharset: expandCharset, pickString: pickString, strengthOf: strengthOf }
