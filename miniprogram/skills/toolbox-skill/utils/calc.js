/**
 * utils/calc.js —— 对话内纯计算原子接口（formatJson / convertUnit / calcDateRange）逻辑
 *
 * ⚠️ 与主包 packageText/packageCalc 同源逻辑：skill 为 independent 分包不可跨包 require，
 *    本文件是 FR-TXT-01（JSON 格式化）与 FR-CAL-02（日期计算）核心算法的独立副本，
 *    **修改任一侧必须同步另一侧**。单位换算表见同目录 utils/units.js。
 *
 * 无 wx 依赖，纯函数，可在 node 环境直接单测。
 */

const units = require('./units.js')

/* ---------------- JSON 格式化（FR-TXT-01） ---------------- */

/** 缩进解析：2 / 4 / 'tab' */
function resolveIndent(indent) {
  if (indent === 'tab' || indent === '\t') return '\t'
  const n = Number(indent)
  return n === 4 ? 4 : 2
}

/** 递归键排序（不影响数组顺序，与 packageText/pages/json 行为一致） */
function sortDeep(node) {
  if (Array.isArray(node)) return node.map(sortDeep)
  if (node && typeof node === 'object') {
    const keys = Object.keys(node).sort()
    const out = {}
    for (let i = 0; i < keys.length; i++) out[keys[i]] = sortDeep(node[keys[i]])
    return out
  }
  return node
}

/** 由字符偏移量计算 行:列（1 起始） */
function lineColAt(text, pos) {
  let line = 1
  let col = 1
  const limit = Math.min(pos, text.length)
  for (let i = 0; i < limit; i++) {
    if (text.charCodeAt(i) === 10) { line++; col = 1 } else { col++ }
  }
  return { line, col }
}

/** 出错行片段：整行内容 + 在列位置下的 '^' 标记 */
function errorSnippet(text, pos, line, col) {
  const start = text.lastIndexOf('\n', Math.max(0, pos - 1)) + 1
  let end = text.indexOf('\n', pos)
  if (end < 0) end = text.length
  const raw = text.slice(start, end)
  const head = raw.length > 80 ? raw.slice(0, 80) + '…' : raw
  const caretCol = Math.min(col, 80)
  return head + '\n' + new Array(caretCol).join(' ') + '^'
}

/**
 * 从 JSON.parse 异常信息提取字符偏移量（兼容三种 V8 文案）：
 *   "... at position 42" / "... (3:15)" / "Unexpected token '}', "…" is not valid JSON"
 *   第三种从「上下文片段」反推：片段在原文中定位后，出错 token 位于片段末尾（跳过空白）。
 */
function parseErrorPos(err, text) {
  const msg = String(err && err.message ? err.message : err)
  let m = /position\s+(\d+)/i.exec(msg)
  if (m) return Number(m[1])
  m = /\((\d+):(\d+)\)/.exec(msg)
  if (m) {
    // 直接给出行列
    const line = Number(m[1])
    const col = Number(m[2])
    let pos = 0
    let seen = 1
    while (seen < line && pos < text.length) {
      if (text.charCodeAt(pos) === 10) seen++
      pos++
    }
    return pos + col - 1
  }
  m = /Unexpected token\s*'(?:.+?)'?,\s*"([\s\S]*)" is not valid/.exec(msg)
  if (m) {
    const ctx = m[1]
    const idx = ctx.length === text.length ? 0 : text.indexOf(ctx)
    if (idx >= 0) {
      let end = idx + ctx.length - 1
      while (end > idx && /\s/.test(text.charAt(end))) end--
      return Math.min(Math.max(end, 0), text.length - 1)
    }
  }
  return -1
}

/**
 * JSON 格式化。
 * @param {string} content 待格式化文本
 * @param {Object} [opts] { indent: 2|4|'tab'（默认 2）, sortKeys: boolean=false, mode: 'pretty'|'minify'|'validate'（默认 pretty） }
 * @returns {{ok:boolean, formatted?:string, mode:string, stats:Object, error?:{message,line,col,snippet}}}
 */
function formatJson(content, opts) {
  const o = opts || {}
  const mode = o.mode === 'minify' || o.mode === 'validate' ? o.mode : 'pretty'
  const raw = typeof content === 'string' ? content : String(content == null ? '' : content)
  if (!raw.trim()) {
    return { ok: false, mode, stats: {}, error: { message: '输入为空（INPUT_EMPTY）', line: 1, col: 1, snippet: '' } }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    const pos = parseErrorPos(err, raw)
    const lc = pos >= 0 ? lineColAt(raw, pos) : { line: 1, col: 1 }
    return {
      ok: false, mode, stats: { inputLength: raw.length },
      error: {
        message: String(err && err.message ? err.message : err),
        line: lc.line, col: lc.col,
        snippet: pos >= 0 ? errorSnippet(raw, pos, lc.line, lc.col) : ''
      }
    }
  }
  if (o.sortKeys === true) parsed = sortDeep(parsed)
  const stats = { inputLength: raw.length, rootType: Array.isArray(parsed) ? 'array' : (parsed === null ? 'null' : typeof parsed) }
  if (mode === 'validate') {
    return { ok: true, mode, formatted: '', stats: Object.assign({}, stats, { valid: true }) }
  }
  const formatted = mode === 'minify' ? JSON.stringify(parsed) : JSON.stringify(parsed, null, resolveIndent(o.indent))
  stats.outputLength = formatted.length
  return { ok: true, mode, formatted, stats }
}

/* ---------------- 日期计算（FR-CAL-02 · 间隔模式） ---------------- */

const WEEKDAY_CN = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']

/** 严格解析 YYYY-MM-DD / YYYY/MM/DD / YYYY.MM.DD / YYYYMMDD；拒绝非法日期（2026-02-30 等） */
function parseDate(input) {
  const s = String(input == null ? '' : input).trim()
  let y, mo, d
  const m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s)
  if (m) { y = +m[1]; mo = +m[2]; d = +m[3] } else {
    const c = /^(\d{4})(\d{2})(\d{2})$/.exec(s)
    if (!c) return { ok: false, message: '日期格式非法：「' + s + '」，应为 YYYY-MM-DD' }
    y = +c[1]; mo = +c[2]; d = +c[3]
  }
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return { ok: false, message: '日期越界：「' + s + '」' }
  const dt = new Date(Date.UTC(y, mo - 1, d))
  // 回读校验：JS 会把 2/30 顺延成 3/2，用字段回读识别不存在的日期
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    return { ok: false, message: '该日期不存在：「' + s + '」' }
  }
  return { ok: true, date: dt, year: y, month: mo, day: d }
}

function isLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
}

/**
 * 计算两个日期的间隔。
 * @param {string} start YYYY-MM-DD
 * @param {string} end YYYY-MM-DD
 * @returns {{ok:boolean, error?:string, days?:number, inclusiveDays?:number, breakdown?:Object, weeks?:{whole:number,rest:number}, direction?:string, meta?:Object}}
 */
function calcDateRange(start, end) {
  const a = parseDate(start)
  if (!a.ok) return { ok: false, error: 'start 无效：' + a.message }
  const b = parseDate(end)
  if (!b.ok) return { ok: false, error: 'end 无效：' + b.message }
  const DAY = 86400000
  let sign = 1
  let from = a.date
  let to = b.date
  if (to.getTime() < from.getTime()) { sign = -1; from = b.date; to = a.date }
  const days = Math.round((to.getTime() - from.getTime()) / DAY) // 间隔天数（后 - 前，恒正）
  const direction = sign === 1 ? 'forward' : 'backward'

  // X 年 X 月 X 天 分解（从 from 起累加到 to；天数为精确间隔，年月为展示用近似）
  let years = 0
  let months = 0
  let rest = 0
  {
    const fy = from.getUTCFullYear()
    const fm = from.getUTCMonth()
    const fd = from.getUTCDate()
    while (new Date(Date.UTC(fy + years + 1, fm, fd)).getTime() <= to.getTime()) years++
    let mCount = 0
    while (new Date(Date.UTC(fy + years, fm + mCount + 1, fd)).getTime() <= to.getTime()) mCount++
    months = mCount
    const anchor = new Date(Date.UTC(fy + years, fm + months, fd))
    rest = Math.round((to.getTime() - anchor.getTime()) / DAY)
  }

  const leap = isLeap(b.year) || isLeap(a.year)
  return {
    ok: true,
    days,
    inclusiveDays: days + 1, // 含首尾两天
    direction,
    breakdown: { years, months, days: rest, text: years + '年' + months + '月' + rest + '天' },
    weeks: { whole: Math.floor(days / 7), rest: days % 7 },
    meta: {
      startWeekday: WEEKDAY_CN[a.date.getUTCDay()],
      endWeekday: WEEKDAY_CN[b.date.getUTCDay()],
      involvesLeapYear: leap,
      monthsBetween: (b.year - a.year) * 12 + (b.month - a.month)
    }
  }
}

module.exports = {
  formatJson,
  convertUnit: units.convertUnit,
  allUnitKeys: units.allUnitKeys,
  calcDateRange,
  parseDate,
  isLeap,
  WEEKDAY_CN
}
