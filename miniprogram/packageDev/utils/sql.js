/**
 * packageDev/utils/sql.js —— SQL 美化 / 压缩（FR-DEV-05）
 * 自研 tokenizer 做词法层处理：只识别字符串/注释/引号标识符/数字/词/符号，
 * 依据标准关键字列表换行缩进。
 * ⚠ 本工具**不连接数据库、不执行任何 SQL**，只做文本格式化。
 */

const KEYWORDS = (
  'select from where group by having order asc desc limit offset insert into values update set delete ' +
  'create table alter drop index view database schema truncate replace union all distinct as on join ' +
  'inner left right full outer cross natural using force straight_straight explain analyze ' +
  'and or not null is in like between exists case when then else end ' +
  'primary key foreign references unique check default auto_increment identity ' +
  'begin commit rollback transaction start with without ' +
  'grant revoke user role ' +
  'count sum avg min max coalesce if ifnull nvl cast convert substring concat upper lower trim length ' +
  'round floor abs now curdate curtime current_date current_time current_timestamp ' +
  'over partition rows range unbounded preceding following row_number rank dense_rank lag lead ' +
  'asc desc nulls first last for update share lock ignore ' +
  'engine charset collate comment unsigned zerofill binary varchar char text blob int integer bigint smallint tinyint mediumint ' +
  'decimal numeric float double date datetime time timestamp year enum ' +
  'with recursive return returns function procedure trigger while loop if then elseif ' +
  'tablespace storage temporary global local '
)
  .split(/\s+/)
  .filter(Boolean)

const KW = {}
KEYWORDS.forEach((k) => {
  KW[k.toUpperCase()] = true
})
// 组合关键字（成行时保持一行）
const CLAUSES = ['SELECT', 'FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'OFFSET', 'INSERT INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE FROM', 'CREATE TABLE', 'ALTER TABLE', 'DROP TABLE', 'UNION ALL', 'UNION', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'FULL JOIN', 'CROSS JOIN', 'JOIN', 'ON', 'AND', 'OR', 'WITH', 'RETURNING', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END']
const NEWLINE_BEFORE = ['SELECT', 'FROM', 'WHERE', 'GROUP BY', 'HAVING', 'ORDER BY', 'LIMIT', 'OFFSET', 'INSERT INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE FROM', 'CREATE TABLE', 'ALTER TABLE', 'DROP TABLE', 'UNION', 'UNION ALL', 'JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'FULL JOIN', 'CROSS JOIN', 'WITH', 'RETURNING']
const INDENT_AFTER = ['SELECT', 'FROM', 'WHERE', 'GROUP BY', 'HAVING', 'ORDER BY', 'LIMIT', 'OFFSET', 'INSERT INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE FROM', 'CREATE TABLE', 'ALTER TABLE', 'DROP TABLE', 'UNION', 'UNION ALL', 'JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'FULL JOIN', 'CROSS JOIN', 'WITH', 'ON', 'AND', 'OR', 'RETURNING']

/**
 * 词法切分：type ∈ space | word | number | string | ident | comment | op | punct
 * 对未闭合字符串/注释做容错（标记 unclosed，供页面提示）。
 */
function tokenize(sql) {
  const src = String(sql === undefined ? '' : sql)
  const out = []
  let i = 0
  let unclosed = null
  const push = (type, value) => out.push({ type, value, index: i - value.length })
  while (i < src.length) {
    const c = src.charAt(i)
    const c2 = src.substr(i, 2)
    // 空白
    if (/\s/.test(c)) {
      let j = i
      while (j < src.length && /\s/.test(src.charAt(j))) j++
      out.push({ type: 'space', value: src.slice(i, j), index: i })
      i = j
      continue
    }
    // 行注释 -- / #
    if (c2 === '--' || c === '#') {
      let j = src.indexOf('\n', i)
      if (j < 0) {
        j = src.length
        unclosed = '行注释缺少结尾换行'
      }
      out.push({ type: 'comment', value: src.slice(i, j), index: i })
      i = j
      continue
    }
    // 块注释 /* */
    if (c2 === '/*') {
      let j = src.indexOf('*/', i + 2)
      if (j < 0) {
        j = src.length
        unclosed = '块注释 /* 未闭合'
      } else j += 2
      out.push({ type: 'comment', value: src.slice(i, j), index: i })
      i = j
      continue
    }
    // 字符串 ' "  与三引号、N'...'
    if (c === "'" || c === '"') {
      const quote = c
      // 双写引号 '' 表示转义（标准 SQL）
      let j = i + 1
      let closed = false
      let buf = ''
      while (j < src.length) {
        if (src.charAt(j) === quote) {
          if (src.charAt(j + 1) === quote) {
            buf += quote + quote
            j += 2
            continue
          }
          closed = true
          j++
          break
        }
        if (src.charAt(j) === '\\') {
          buf += src.substr(j, 2)
          j += 2
          continue
        }
        buf += src.charAt(j)
        j++
      }
      if (quote === "'" && !closed) unclosed = "单引号字符串未闭合（'）"
      if (quote === '"' && !closed) unclosed = null
      out.push({ type: quote === "'" ? 'string' : 'ident', value: src.slice(i, j), index: i, unclosed: quote === "'" && !closed })
      i = j
      continue
    }
    // 反引号 / 方括号标识符
    if (c === '`' || c === '[') {
      const close = c === '`' ? '`' : ']'
      let j = i + 1
      while (j < src.length && src.charAt(j) !== close) j++
      if (j >= src.length) unclosed = (c === '`' ? '反引号' : '方括号') + '标识符未闭合'
      out.push({ type: 'ident', value: src.slice(i, Math.min(j + 1, src.length)), index: i })
      i = Math.min(j + 1, src.length)
      continue
    }
    // 数字
    if (/\d/.test(c) || (c === '.' && /\d/.test(src.charAt(i + 1)))) {
      let j = i
      while (j < src.length && /[\dxXa-fA-F._eE+-]/.test(src.charAt(j))) {
        if ((src.charAt(j) === 'e' || src.charAt(j) === 'E') && !/[+-]?\d/.test(src.substr(j + 1, 2))) break
        if ((src.charAt(j) === '+' || src.charAt(j) === '-') && !(src.charAt(j - 1) === 'e' || src.charAt(j - 1) === 'E')) break
        j++
      }
      out.push({ type: 'number', value: src.slice(i, j), index: i })
      i = j
      continue
    }
    // 词（含中文/字母/数字/_/$/@/#/.）
    if (/[\w$@\u0080-\uFFFF]/.test(c) || c === '.') {
      let j = i
      while (j < src.length && /[\w$@\u0080-\uFFFF.]/.test(src.charAt(j))) j++
      const word = src.slice(i, j)
      out.push({ type: 'word', value: word, index: i, upper: word.toUpperCase() })
      i = j
      continue
    }
    // 参数占位符
    if (c === ':' || c === '?') {
      let j = i + 1
      if (c === ':') while (j < src.length && /\w/.test(src.charAt(j))) j++
      out.push({ type: 'param', value: src.slice(i, j), index: i })
      i = j
      continue
    }
    // 运算符/符号
    if (c === ';') {
      out.push({ type: 'semi', value: ';', index: i })
      i++
      continue
    }
    if (c === '(' || c === ')') {
      out.push({ type: c === '(' ? 'lparen' : 'rparen', value: c, index: i })
      i++
      continue
    }
    if (c === ',') {
      out.push({ type: 'comma', value: ',', index: i })
      i++
      continue
    }
    out.push({ type: 'op', value: c, index: i })
    i++
  }
  return { tokens: out, unclosed }
}

/** 去掉空白与注释后的 token 序列（用于结构判断） */
function significant(tokens, keepComments) {
  return tokens.filter((t) => t.type !== 'space' && (keepComments ? true : t.type !== 'comment'))
}

function mergeClause(sig) {
  // 把「GROUP」「BY」这类两词关键字合成 GROUP BY 以便对齐
  const out = []
  for (let i = 0; i < sig.length; i++) {
    const t = sig[i]
    if (t.type === 'word') {
      const next = sig[i + 1]
      const two = t.upper + ' ' + (next && next.type === 'word' ? next.upper : '')
      if (CLAUSES.indexOf(two) >= 0) {
        out.push({ type: 'word', value: t.value + ' ' + next.value, upper: two, isClause: true })
        i++
        continue
      }
      out.push(t)
      continue
    }
    out.push(t)
  }
  return out
}

/**
 * 美化：按子句换行 + 续行缩进；只依赖 token 序列，因此可幂等。
 * @param {string} sql
 * @param {{indent:string, keywordCase:'upper'|'lower'|'keep', lines:boolean, keepComments:boolean}} opts
 */
function format(sql, opts) {
  const o = opts || {}
  const unit = o.indent === undefined ? '  ' : o.indent
  const keepComments = o.keepComments !== false
  const kase = o.keywordCase || 'upper'
  const brk = o.lines !== false
  const tk = tokenize(sql)
  const sig = mergeClause(tk.tokens.filter((t) => t.type !== 'space' && (keepComments ? true : t.type !== 'comment')))
  sig.forEach((t) => {
    if (t.type === 'word' && (KW[t.upper] || t.isClause)) {
      t.disp = kase === 'upper' ? t.upper : kase === 'lower' ? t.upper.toLowerCase() : t.value
    }
  })
  const lines = []
  let cur = ''
  let depth = 0
  let cont = 0
  let prevType = null
  const pad = (n) => unit.repeat(Math.max(0, n))
  const flush = () => {
    if (cur.replace(/\s/g, '')) lines.push(cur.replace(/\s+$/, ''))
    cur = ''
  }
  const put = (text) => {
    if (cur !== '' && !/[ (\t]$/.test(cur) && cur.replace(/\s/g, '') !== '') cur += ' '
    cur += text
  }
  sig.forEach((t) => {
    const text = t.disp !== undefined ? t.disp : t.value
    if (t.type === 'semi') {
      cur += ';'
      flush()
      depth = 0
      cont = 0
      prevType = t.type
      return
    }
    if (t.type === 'lparen') {
      if (cur !== '' && !/[ (\t]$/.test(cur) && ['word', 'ident', 'number', 'string', 'rparen'].indexOf(prevType) < 0) cur += ' '
      cur += '('
      depth++
      prevType = t.type
      return
    }
    if (t.type === 'rparen') {
      cur = cur.replace(/\s+$/, '')
      cur += ')'
      depth = Math.max(0, depth - 1)
      prevType = t.type
      return
    }
    if (t.type === 'comma') {
      if (brk && depth === 0) {
        cur = cur.replace(/\s+$/, '') + ','
        flush()
        cur = pad(cont)
      } else cur = cur.replace(/\s+$/, '') + ','
      prevType = t.type
      return
    }
    if (t.type === 'comment') {
      if (brk && cur.replace(/\s/g, '')) cur += ' '
      cur += text
      prevType = t.type
      if (/^--|^#/.test(text.trim()) || /\n/.test(text)) flush()
      return
    }
    if (t.type === 'word' && brk && depth === 0 && NEWLINE_BEFORE.indexOf(t.upper) >= 0) {
      flush()
      cur = pad(0) + text
      cont = 1
      prevType = t.type
      return
    }
    if (t.type === 'word' && brk && depth === 0 && (t.upper === 'AND' || t.upper === 'OR')) {
      flush()
      cur = pad(cont) + text
      prevType = t.type
      return
    }
    if (t.type === 'word' && brk && depth === 0 && (t.upper === 'ON' || /JOIN$/ .test(t.upper) === true && t.upper !== 'JOIN')) {
      flush()
      cur = pad(cont) + text
      prevType = t.type
      return
    }
    if (t.type === 'word' && brk && depth === 0 && t.upper === 'JOIN') {
      flush()
      cur = pad(cont) + text
      prevType = t.type
      return
    }
    put(text)
    prevType = t.type
  })
  flush()
  return { text: lines.join('\n').replace(/\n{3,}/g, '\n\n'), lines: lines.length, unclosed: tk.unclosed, tokens: sig.length }
}

/** 压缩：去注释（可选）、折叠空白、保留字符串 */
function minify(sql, opts) {
  const o = opts || {}
  const { tokens, unclosed } = tokenize(sql)
  const parts = []
  let prev = null
  tokens.forEach((t) => {
    if (t.type === 'space') return
    if (t.type === 'comment' && !o.keepComments) return
    let v = t.type === 'word' && KW[t.upper] ? t.upper : t.value
    if (prev) {
      const needSpace =
        (prev.type === 'word' || prev.type === 'number' || prev.type === 'ident' || prev.type === 'string') &&
        (t.type === 'word' || t.type === 'number' || t.type === 'ident' || t.type === 'string')
      if (needSpace) parts.push(' ')
    }
    parts.push(v)
    prev = t
  })
  return { text: parts.join('').replace(/\s+/g, ' ').trim(), unclosed }
}

/**
 * 超长文本分帧（>20000 字符时页面按帧渲染，避免一次性 setData 卡顿）
 */
function chunkByLines(text, size) {
  const max = size || 40
  const rows = String(text).split('\n')
  const out = []
  for (let i = 0; i < rows.length; i += max) {
    out.push({ start: i + 1, end: Math.min(i + max, rows.length), text: rows.slice(i, i + max).join('\n') })
  }
  return out
}

/** 统计：语句数/表名/字段数，供结果区展示 */
function stats(sql) {
  const { tokens } = tokenize(sql)
  const sig = significant(tokens, false)
  const semi = tokens.filter((t) => t.type === 'semi').length
  const words = sig.filter((t) => t.type === 'word')
  const tables = []
  for (let i = 0; i < sig.length - 1; i++) {
    const u = sig[i].upper
    if (['FROM', 'JOIN', 'INTO', 'UPDATE', 'TABLE'].indexOf(u) >= 0 && sig[i + 1] && (sig[i + 1].type === 'word' || sig[i + 1].type === 'ident')) {
      tables.push(sig[i + 1].value)
    }
  }
  return {
    statements: Math.max(semi, words.length ? 1 : 0),
    tokens: sig.length,
    words: words.length,
    tables: Array.from(new Set(tables)),
    hasWhere: sig.some((t) => t.upper === 'WHERE'),
    dangerous: sig.some((t) => t.upper === 'DELETE' || t.upper === 'DROP' || t.upper === 'TRUNCATE')
  }
}

/**
 * 页面（FR-DEV-SQL）用的入口。format/minify 是最底层实现，这里补上页面声明的契约：
 * 返回 { text, lines, tokens, error?:{line,position,reason}, multilineForced? }。
 */
function locateUnclosed(sql, tk) {
  const bad = (tk.tokens || []).filter(function (t) { return t.unclosed })[0]
  const idx = bad ? Number(bad.index) || 0 : String(sql || '').length
  return { position: idx, line: String(sql || '').slice(0, idx).split('\n').length, reason: tk.unclosed }
}

function pretty(sql, opts) {
  const o = opts || {}
  const tk = tokenize(sql)
  const r = format(sql, { keywordCase: o.keywordCase, indent: Number(o.indent) === 4 ? '    ' : '  ' })
  const out = { text: r.text, lines: r.lines, tokens: r.tokens }
  if (tk.unclosed) out.error = locateUnclosed(sql, tk)
  return out
}

function compact(sql, opts) {
  const o = opts || {}
  const tk = tokenize(sql)
  const lineComment = tk.tokens.some(function (t) {
    return t.type === 'comment' && /^(\-\-|#)/.test(String(t.value).trim()) && !/^\-\-.*--$/.test(String(t.value).trim())
  })
  let text
  let forced = false
  if (lineComment) {
    // 行注释后必须保留换行，否则同一行的后续语句会被注释吞掉
    text = String(sql)
      .split('\n')
      .map(function (l) { return minify(l, { keepComments: true }).text })
      .filter(function (l) { return l })
      .join('\n')
    forced = true
  } else {
    text = minify(sql, { keepComments: o.keepComments !== false }).text
  }
  const out = { text: text, lines: text.split('\n').length, multilineForced: forced, tokens: tk.tokens.filter(function (t) { return t.type !== 'space' }).length }
  if (tk.unclosed) out.error = locateUnclosed(sql, tk)
  return out
}

/** 括号配平（忽略字符串与注释里的括号） */
function balanceCheck(sql) {
  const tk = tokenize(sql)
  let diff = 0
  tk.tokens.forEach(function (t) {
    if (t.type === 'lparen') diff++
    else if (t.type === 'rparen') diff--
  })
  return { ok: diff === 0, diff: diff }
}

module.exports = {
  tokenize,
  format,
  pretty,
  compact,
  balanceCheck,
  minify,
  stats,
  chunkByLines,
  KEYWORDS,
  KW,
  CLAUSES,
  NEWLINE_BEFORE
}
