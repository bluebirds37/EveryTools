/**
 * 金融计算核心（FR-CAL-03/04/10）—— 纯函数模块，无 wx 依赖
 * 等额本息 / 等额本金 / 组合贷 / 个税累计预扣 / 年终奖 / 复利 / 定投 / 存款
 * 精度：全程 double 运算，月供误差 <0.01 元（公式解析解）。
 */

function monthRate(annualPct) {
  return Number(annualPct) / 100 / 12
}

function round2(v) {
  return Math.round(v * 100) / 100
}

/* ---------------- 房贷 ---------------- */

/** 等额本息：月供 = P·i·(1+i)^n / ((1+i)^n − 1) */
function annuitySchedule(principal, annualPct, months) {
  const i = monthRate(annualPct)
  const p = Number(principal)
  const n = Number(months)
  if (p <= 0 || n <= 0) return null
  let monthly
  if (i === 0) monthly = p / n
  else {
    const q = Math.pow(1 + i, n)
    monthly = p * i * q / (q - 1)
  }
  const rows = []
  let remain = p
  let totalInterest = 0
  for (let k = 1; k <= n; k++) {
    const interest = remain * i
    let principalPart = monthly - interest
    if (k === n) {
      principalPart = remain
    }
    const payment = principalPart + interest
    remain -= principalPart
    if (remain < 0) remain = 0
    totalInterest += interest
    rows.push({
      i: k,
      payment: round2(payment),
      principalPart: round2(principalPart),
      interest: round2(interest),
      remain: round2(remain)
    })
  }
  return {
    monthly: round2(monthly),
    totalInterest: round2(totalInterest),
    totalPayment: round2(p + totalInterest),
    rows: rows
  }
}

/** 等额本金：第 k 期 = P/n + (P − P(k−1)/n)·i，逐月递减 */
function equalPrincipalSchedule(principal, annualPct, months) {
  const i = monthRate(annualPct)
  const p = Number(principal)
  const n = Number(months)
  if (p <= 0 || n <= 0) return null
  const base = p / n
  const rows = []
  let totalInterest = 0
  for (let k = 1; k <= n; k++) {
    const remainBefore = p - base * (k - 1)
    const interest = remainBefore * i
    const payment = base + interest
    totalInterest += interest
    rows.push({
      i: k,
      payment: round2(payment),
      principalPart: round2(base),
      interest: round2(interest),
      remain: round2(remainBefore - base < 0 ? 0 : remainBefore - base)
    })
  }
  return {
    firstPayment: round2(rows[0].payment),
    lastPayment: round2(rows[n - 1].payment),
    monthlyDecrease: round2(base * i),
    totalInterest: round2(totalInterest),
    totalPayment: round2(p + totalInterest),
    rows: rows
  }
}

const RATE_DEFAULTS = { commercial: 4.35, provident: 2.85 } // LPR/公积金参考值，可编辑

/**
 * 读取 tool_flags 下发的利率覆盖（storage 键 'tool_flags'，由 app.js 写入）
 * flags = { loan: { commercial: 3.85, provident: 2.6 } } 缺失回落默认值
 */
function resolveRates(flags) {
  const out = { commercial: RATE_DEFAULTS.commercial, provident: RATE_DEFAULTS.provident, fromServer: false }
  const f = flags && flags.loan
  if (f) {
    if (Number(f.commercial) > 0) { out.commercial = Number(f.commercial); out.fromServer = true }
    if (Number(f.provident) > 0) { out.provident = Number(f.provident); out.fromServer = true }
  }
  return out
}

/** 组合贷：公积金部分优先，超出上限走商贷，逐期合并 */
function mixedSchedule(loanTotal, commercialPct, providentPct, months, providentCap) {
  const cap = Math.min(Number(providentCap) || 0, loanTotal)
  const pf = annuitySchedule(cap, providentPct, months)
  const cm = annuitySchedule(loanTotal - cap, commercialPct, months)
  if (!pf || !cm) return null
  const rows = pf.rows.map(function (r, idx) {
    const c = cm.rows[idx]
    return {
      i: r.i,
      payment: round2(r.payment + c.payment),
      principalPart: round2(r.principalPart + c.principalPart),
      interest: round2(r.interest + c.interest),
      remain: round2(r.remain + c.remain)
    }
  })
  const totalInterest = round2(pf.totalInterest + cm.totalInterest)
  return {
    monthly: round2(pf.monthly + cm.monthly),
    totalInterest: totalInterest,
    totalPayment: round2(loanTotal + totalInterest),
    providentPart: pf,
    commercialPart: cm,
    providentPrincipal: cap,
    commercialPrincipal: loanTotal - cap,
    rows: rows
  }
}

/** 两种还款方式对比结论 */
function compareMethods(principal, annualPct, months) {
  const a = annuitySchedule(principal, annualPct, months)
  const b = equalPrincipalSchedule(principal, annualPct, months)
  if (!a || !b) return null
  const diff = round2(a.totalInterest - b.totalInterest)
  return {
    annuityInterest: a.totalInterest,
    equalPrincipalInterest: b.totalInterest,
    interestDiff: diff,
    firstMonthDiff: round2(b.firstPayment - a.monthly),
    conclusion: '等额本金总利息少 ' + fmtMoney(diff) + ' 元，但首月比等额本息多还 ' + fmtMoney(b.firstPayment - a.monthly) + ' 元；前期压力大选等额本息，现金流充裕选等额本金。'
  }
}

/* ---------------- 个税（累计预扣预缴） ---------------- */

const TAX_TABLE_VERSION = 'CN-2019 年度税率表 v1.0'

// 综合所得年度税率表（7 级）：速算扣除数由连续性推导，级距为含税年应纳税所得额
const ANNUAL_BRACKETS = [
  { limit: 36000, rate: 0.03, qd: 0 },
  { limit: 144000, rate: 0.10, qd: 2520 },
  { limit: 300000, rate: 0.12, qd: 5400 },
  { limit: 420000, rate: 0.20, qd: 29400 },
  { limit: 660000, rate: 0.30, qd: 71400 },
  { limit: 960000, rate: 0.35, qd: 104400 },
  { limit: Infinity, rate: 0.45, qd: 200400 }
]

// 年终奖单独计税：按月换算税率表（bonus/12 找档，全额计税）
const MONTHLY_BRACKETS = [
  { limit: 3000, rate: 0.03, qd: 0 },
  { limit: 12000, rate: 0.10, qd: 210 },
  { limit: 25000, rate: 0.20, qd: 1410 },
  { limit: 35000, rate: 0.25, qd: 2660 },
  { limit: 55000, rate: 0.30, qd: 4410 },
  { limit: 80000, rate: 0.35, qd: 7160 },
  { limit: Infinity, rate: 0.45, qd: 15160 }
]

function pickBracket(table, amount) {
  for (let k = 0; k < table.length; k++) {
    if (amount <= table[k].limit) return table[k]
  }
  return table[table.length - 1]
}

/** 年度应纳税所得额 → 全年税额 */
function annualTaxOf(taxable) {
  if (taxable <= 0) return { tax: 0, rate: 0, qd: 0 }
  const b = pickBracket(ANNUAL_BRACKETS, taxable)
  return { tax: taxable * b.rate - b.qd, rate: b.rate, qd: b.qd }
}

/**
 * 累计预扣预缴逐月表
 * opts: { monthlyIncome, social, housingFund, specialTotal, months(1-12), startMonth }
 * 每月预扣税额 = 累计应纳税所得额×税率−速算扣除数 − 已预扣
 */
function withholdingSchedule(opts) {
  const income = Number(opts.monthlyIncome)
  const months = Math.max(1, Math.min(12, Number(opts.months) || 12))
  const subtract = 5000 + Number(opts.social || 0) + Number(opts.housingFund || 0) + Number(opts.specialTotal || 0)
  const rows = []
  let lastTax = 0
  for (let m = 1; m <= months; m++) {
    const taxableCum = Math.max(0, (income - subtract) * m)
    const info = annualTaxOf(taxableCum)
    const taxMonth = Math.max(0, round2(info.tax) - lastTax)
    rows.push({
      month: m,
      incomeCum: round2(income * m),
      taxableCum: round2(taxableCum),
      rate: info.rate,
      taxCum: round2(info.tax),
      taxMonth: round2(taxMonth)
    })
    lastTax = round2(info.tax)
  }
  return { rows: rows, yearTax: lastTax, tableVersion: TAX_TABLE_VERSION }
}

/** 年终奖：单独计税 vs 并入综合所得 */
function bonusCompare(bonus, annualTaxableWithoutBonus) {
  const b = Number(bonus)
  const t = Number(annualTaxableWithoutBonus)
  if (b <= 0) return null
  const mb = pickBracket(MONTHLY_BRACKETS, b / 12)
  const separateTax = round2(b * mb.rate - mb.qd)
  const withAll = annualTaxOf(Math.max(0, t) + b)
  const without = annualTaxOf(Math.max(0, t))
  const combinedExtra = round2(withAll.tax - without.tax)
  return {
    separateTax: separateTax,
    separateRate: mb.rate,
    combinedExtraTax: combinedExtra,
    saving: round2(combinedExtra - separateTax),
    advice: combinedExtra > separateTax
      ? '单独计税更省，可少缴 ' + fmtMoney(combinedExtra - separateTax) + ' 元'
      : '并入综合所得更省，可少缴 ' + fmtMoney(separateTax - combinedExtra) + ' 元'
  }
}

/* ---------------- 复利 / 存款 ---------------- */

function compoundFV(principal, annualPct, years, freqPerYear) {
  const p = Number(principal)
  const i = Number(annualPct) / 100
  const f = Math.max(1, Number(freqPerYear) || 12)
  const n = Number(years) * f
  const factor = Math.pow(1 + i / f, n)
  const fv = p * factor
  return { fv: round2(fv), interest: round2(fv - p), factor: factor, periods: n, ratePerPeriod: i / f }
}

/** 定投（期末值）：FV = A·((1+i)^n − 1)/i，i 为月利率 */
function dcaFV(monthlyInvest, annualPct, years) {
  const a = Number(monthlyInvest)
  const i = monthRate(annualPct)
  const n = Math.round(Number(years) * 12)
  const fv = i === 0 ? a * n : a * (Math.pow(1 + i, n) - 1) / i
  const invested = a * n
  return { fv: round2(fv), invested: round2(invested), gain: round2(fv - invested), periods: n, monthlyRate: i }
}

/** 存款：lump 整存整取（到期一次性还本付息，单利）/ zero 零存整取 */
function depositCalc(kind, amount, years, annualPct) {
  const p = Number(annualPct) / 100
  const y = Number(years)
  if (kind === 'lump') {
    const interest = Number(amount) * p * y
    return { total: round2(Number(amount) + interest), interest: round2(interest), mode: '整存整取（单利，到期支取）' }
  }
  const n = Math.round(y * 12)
  const i = p / 12
  const interest = Number(amount) * (n * (n + 1) / 2) * i
  const principal = Number(amount) * n
  return { total: round2(principal + interest), interest: round2(interest), principal: round2(principal), mode: '零存整取（每月存入，累计月积数法）' }
}

/* ---------------- 百分比 / 比例 ---------------- */

/** 比例分配：四舍五入到 2 位，末项吸收舍入差，保证和=total */
function allocateByWeights(total, weights, decimals) {
  const d = decimals === undefined ? 2 : decimals
  const t = Number(total)
  const sum = weights.reduce(function (s, w) { return s + Number(w) }, 0)
  if (!(sum > 0) || weights.length === 0) return null
  const factor = Math.pow(10, d)
  const scale = t * factor / sum
  const parts = []
  let acc = 0
  for (let k = 0; k < weights.length; k++) {
    if (k === weights.length - 1) {
      parts.push((Math.round(t * factor) - acc) / factor)
    } else {
      const v = Math.round(Number(weights[k]) * scale)
      acc += v
      parts.push(v / factor)
    }
  }
  return parts
}

function fmtMoney(v) {
  const neg = v < 0
  const s = Math.abs(v).toFixed(2)
  const arr = s.split('.')
  arr[0] = arr[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return (neg ? '-' : '') + arr.join('.')
}

module.exports = {
  RATE_DEFAULTS: RATE_DEFAULTS,
  TAX_TABLE_VERSION: TAX_TABLE_VERSION,
  ANNUAL_BRACKETS: ANNUAL_BRACKETS,
  MONTHLY_BRACKETS: MONTHLY_BRACKETS,
  monthRate: monthRate,
  round2: round2,
  fmtMoney: fmtMoney,
  annuitySchedule: annuitySchedule,
  equalPrincipalSchedule: equalPrincipalSchedule,
  mixedSchedule: mixedSchedule,
  resolveRates: resolveRates,
  compareMethods: compareMethods,
  annualTaxOf: annualTaxOf,
  withholdingSchedule: withholdingSchedule,
  bonusCompare: bonusCompare,
  compoundFV: compoundFV,
  dcaFV: dcaFV,
  depositCalc: depositCalc,
  allocateByWeights: allocateByWeights
}
