/**
 * 表达式计算器核心（FR-CAL-12）—— 自研 tokenizer + 递归下降解析，禁止 eval/new Function
 * 支持：+ - × ÷ / ( )、一元负号、%（后缀，÷100）、^（右结合幂）、
 *       sin cos tan asin acos atan ln log sqrt abs exp、常量 pi/e、角度/弧度切换。
 * 语义：'10%' = 0.1（百分号为后缀运算符，除以 100）。
 * 错误：抛 { code: SYNTAX|UNKNOWN_FUNC|DIV_ZERO|DOMAIN|RANGE, message, pos }
 */

const FUNCTIONS = {
  sin: { arith: function (x) { return Math.sin(x) }, inv: 'asin' },
  cos: { arith: function (x) { return Math.cos(x) }, inv: 'acos' },
  tan: { arith: function (x) { return Math.tan(x) }, inv: 'atan' },
  asin: { arith: function (x) { return Math.asin(x) }, dom: [-1, 1] },
  acos: { arith: function (x) { return Math.acos(x) }, dom: [-1, 1] },
  atan: { arith: function (x) { return Math.atan(x) } },
  ln: { arith: function (x) { return Math.log(x) }, dom: [0, Infinity, true] },
  log: { arith: function (x) { return Math.log10(x) }, dom: [0, Infinity, true] },
  sqrt: { arith: function (x) { return Math.sqrt(x) }, dom: [0, Infinity] },
  abs: { arith: function (x) { return Math.abs(x) } },
  exp: { arith: function (x) { return Math.exp(x) } }
}

const CONSTANTS = { pi: Math.PI, e: Math.E }

function CalcError(code, message, pos) {
  const err = new Error(message)
  err.code = code
  err.pos = pos
  err.calc = true
  return err
}

/* ---------- tokenizer ---------- */
function tokenize(src) {
  const tokens = []
  let i = 0
  const len = src.length
  while (i < len) {
    const ch = src[i]
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '␣') { i++; continue }
    if ((ch >= '0' && ch <= '9') || ch === '.') {
      let j = i
      let dot = false
      while (j < len && ((src[j] >= '0' && src[j] <= '9') || (src[j] === '.' && !dot ? (dot = true, true) : false))) j++
      const text = src.slice(i, j)
      if (text === '.') throw CalcError('SYNTAX', '数字格式错误：孤立的点', i)
      tokens.push({ t: 'num', v: Number(text), p: i })
      i = j
      continue
    }
    if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z')) {
      let j = i
      while (j < len && /[A-Za-z_]/.test(src[j])) j++
      tokens.push({ t: 'ident', v: src.slice(i, j).toLowerCase(), p: i })
      i = j
      continue
    }
    // 键盘与内置示例都会输入「π」（index.js 的 const 键、sample '2π'），解析层必须认识它，
    // 否则点一下就报「无法识别的字符」；统一归一到已有的 pi 常量。
    if (ch === 'π' || ch === 'Π') {
      tokens.push({ t: 'ident', v: 'pi', p: i })
      i++
      continue
    }
    if ('+-*/^()%,'.indexOf(ch) >= 0 || ch === '×' || ch === '÷' || ch === '−') {
      const map = { '×': '*', '÷': '/', '−': '-' }
      tokens.push({ t: 'op', v: map[ch] || ch, p: i })
      i++
      continue
    }
    throw CalcError('SYNTAX', '无法识别的字符「' + ch + '」', i)
  }
  return tokens
}

/* ---------- 递归下降解析 ----------
 * expr   := term (('+'|'-') term)*
 * term   := unary (('*'|'/') unary)*        省略乘号：数字/函数/左括号相邻视为乘法
 * unary  := ('-'|'+') unary | power
 * power  := postfix ('^' unary)?            右结合
 * postfix:= primary ('%')*
 * primary:= num | const | func '(' expr ')' | '(' expr ')'
 */
function Parser(tokens, opts) {
  this.toks = tokens
  this.pos = 0
  this.opts = opts || {}
  this.deg = this.opts.angle === 'rad' ? false : true
}

Parser.prototype.peek = function () {
  return this.toks[this.pos]
}
Parser.prototype.next = function () {
  return this.toks[this.pos++]
}
Parser.prototype.expect = function (v) {
  const tk = this.peek()
  if (!tk || (tk.t === 'op' && tk.v === v) === false) {
    throw CalcError('SYNTAX', '缺少「' + v + '」', tk ? tk.p : -1)
  }
  return this.next()
}
Parser.prototype.toRad = function (x) {
  return this.deg ? x * Math.PI / 180 : x
}
Parser.prototype.fromRad = function (x) {
  return this.deg ? x * 180 / Math.PI : x
}

Parser.prototype.parse = function () {
  const v = this.expr()
  if (this.pos < this.toks.length) {
    throw CalcError('SYNTAX', '表达式多余的字符「' + (this.toks[this.pos].v) + '」', this.toks[this.pos].p)
  }
  return v
}

Parser.prototype.expr = function () {
  let v = this.term()
  for (;;) {
    const tk = this.peek()
    if (!tk || tk.t !== 'op' || (tk.v !== '+' && tk.v !== '-')) break
    this.next()
    const r = this.term()
    v = tk.v === '+' ? v + r : v - r
  }
  return v
}

Parser.prototype.startsTerm = function (tk) {
  return !!tk && (tk.t === 'num' || tk.t === 'ident' || (tk.t === 'op' && tk.v === '('))
}

Parser.prototype.term = function () {
  let v = this.unary()
  for (;;) {
    const tk = this.peek()
    if (tk && tk.t === 'op' && (tk.v === '*' || tk.v === '/')) {
      this.next()
      const r = this.unary()
      if (tk.v === '/') {
        if (r === 0) throw CalcError('DIV_ZERO', '除数为 0，无法计算', tk.p)
        v = v / r
      } else v = v * r
    } else if (this.startsTerm(tk) && this.implicitMulAllowed()) {
      // 隐式乘法：2(3)、2pi、2sin(30)
      const r = this.unary()
      v = v * r
    } else break
  }
  return v
}

Parser.prototype.implicitMulAllowed = function () {
  return this.opts.implicitMul !== false
}

Parser.prototype.unary = function () {
  const tk = this.peek()
  if (tk && tk.t === 'op' && (tk.v === '-' || tk.v === '+')) {
    this.next()
    const v = this.unary()
    return tk.v === '-' ? -v : v
  }
  return this.power()
}

Parser.prototype.power = function () {
  const base = this.postfix()
  const tk = this.peek()
  if (tk && tk.t === 'op' && tk.v === '^') {
    this.next()
    const expv = this.unary() // 右结合：2^3^2 = 2^(3^2)
    if (base === 0 && expv < 0) throw CalcError('DIV_ZERO', '0 的负次幂无意义', tk.p)
    const v = Math.pow(base, expv)
    if (!isFinite(v)) throw CalcError('RANGE', '数值溢出', tk.p)
    if (isNaN(v)) throw CalcError('DOMAIN', '负数的小数次幂超出实数范围', tk.p)
    return v
  }
  return base
}

Parser.prototype.postfix = function () {
  let v = this.primary()
  while (this.peek() && this.peek().t === 'op' && this.peek().v === '%') {
    this.next()
    v = v / 100 // 百分号语义：÷100
  }
  return v
}

Parser.prototype.primary = function () {
  const tk = this.peek()
  if (!tk) throw CalcError('SYNTAX', '表达式不完整', -1)
  if (tk.t === 'num') { this.next(); return tk.v }
  if (tk.t === 'op' && tk.v === '(') {
    this.next()
    const v = this.expr()
    this.expect(')')
    return v
  }
  if (tk.t === 'ident') {
    this.next()
    if (CONSTANTS.hasOwnProperty(tk.v)) return CONSTANTS[tk.v]
    const fn = FUNCTIONS[tk.v]
    if (!fn) throw CalcError('UNKNOWN_FUNC', '不支持的函数「' + tk.v + '」', tk.p)
    this.expect('(')
    let arg = this.expr()
    this.expect(')')
    if (['sin', 'cos', 'tan'].indexOf(tk.v) >= 0) arg = this.toRad(arg)
    if (fn.dom) {
      const lo = fn.dom[0], hi = fn.dom[1], open = fn.dom[2]
      const bad = open ? (arg <= lo || arg > hi) : (arg < lo || arg > hi)
      if (bad) {
        throw CalcError('DOMAIN', '函数「' + tk.v + '」参数超出定义域', tk.p)
      }
    }
    const out = fn.arith(arg)
    if (isNaN(out)) throw CalcError('DOMAIN', '函数「' + tk.v + '」结果非实数', tk.p)
    if (['asin', 'acos', 'atan'].indexOf(tk.v) >= 0) return this.fromRad(out)
    return out
  }
  throw CalcError('SYNTAX', '意外的符号「' + tk.v + '」', tk.p)
}

/**
 * 求值入口
 * @param {string} src 表达式
 * @param {object} opts { angle: 'deg'|'rad', implicitMul: bool }
 * @returns {number}
 */
function evaluate(src, opts) {
  const text = String(src || '').trim()
  if (!text) throw CalcError('SYNTAX', '表达式为空', 0)
  const p = new Parser(tokenize(text), opts)
  const v = p.parse()
  if (!isFinite(v)) throw CalcError('RANGE', '结果超出可显示范围', -1)
  // 清理浮点尾差（相对 1e-12）
  if (v !== 0 && Math.abs(v) < 1e-10) return v
  return Number(v.toPrecision(14))
}

/** 千分位格式化：整数部分每 3 位加逗号，小数最多 10 位 */
function formatThousands(v) {
  const n = Number(v)
  if (!isFinite(n)) return '—'
  let s
  if (n !== 0 && (Math.abs(n) >= 1e15 || Math.abs(n) < 1e-9)) s = n.toExponential(8)
  else s = String(Number(n.toPrecision(12)))
  const parts = s.split('.')
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return parts.join('.')
}

/** 校验表达式是否合法（键盘实时提示用） */
function validate(src, opts) {
  try {
    evaluate(src, opts)
    return true
  } catch (e) {
    if (e.calc && (e.code === 'DIV_ZERO' || e.code === 'DOMAIN' || e.code === 'RANGE')) return true // 语法合法
    return false
  }
}

module.exports = {
  tokenize: tokenize,
  evaluate: evaluate,
  validate: validate,
  formatThousands: formatThousands,
  FUNCTIONS: Object.keys(FUNCTIONS),
  CONSTANTS: Object.keys(CONSTANTS)
}
