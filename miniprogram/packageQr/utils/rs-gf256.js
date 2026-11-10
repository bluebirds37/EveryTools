/**
 * GF(256) 有限域运算 + Reed-Solomon 编解码（QR 码用）
 *
 * 纯计算模块，可被 node 直接 require 自测。
 * 域：GF(2^8)，素多项式 p(x)=x^8+x^4+x^3+x^2+1 (0x11D)，本原元 a=2。
 * 码字顺序约定：数组下标 0 为最高次项系数（传输顺序）。
 */

const PRIMITIVE = 0x11d

const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)

;(function buildTables() {
  let x = 1
  for (let i = 0; i < 255; i++) {
    EXP[i] = x
    LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= PRIMITIVE
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]
})()

function gmul(a, b) {
  if (a === 0 || b === 0) return 0
  return EXP[LOG[a] + LOG[b]]
}

function gdiv(a, b) {
  if (b === 0) throw new Error('[rs] division by zero')
  if (a === 0) return 0
  return EXP[(LOG[a] - LOG[b] + 255) % 255]
}

function gpow(base, e) {
  if (e === 0) return 1
  if (base === 0) return 0
  const lg = LOG[base]
  return EXP[(lg * e) % 255]
}

/** α^k，k 可为负数或大数 */
function aPow(k) {
  return EXP[((k % 255) + 255) % 255]
}

/* ---------------- 生成多项式 ---------------- */

const GEN_CACHE = {}
/** g(x) = Π_{i=0}^{degree-1} (x - a^i)，返回降幂系数数组（首项 1，长度 degree+1） */
function generatorPoly(degree) {
  if (GEN_CACHE[degree]) return GEN_CACHE[degree].slice()
  let poly = [1]
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0)
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j]
      next[j + 1] ^= gmul(poly[j], EXP[i])
    }
    poly = next
  }
  GEN_CACHE[degree] = poly
  return poly.slice()
}

/**
 * 系统式编码：返回纠错码字
 * @param {ArrayLike<number>} data 数据码字（传输顺序）
 * @param {number} eccLen 纠错码字数
 */
function rsEncode(data, eccLen) {
  const gen = generatorPoly(eccLen)
  const res = new Uint8Array(eccLen)
  for (let i = 0; i < data.length; i++) {
    const lead = data[i] ^ res[0]
    res.copyWithin(0, 1)
    res[eccLen - 1] = 0
    if (lead !== 0) {
      for (let j = 1; j <= eccLen; j++) res[j - 1] ^= gmul(gen[j], lead)
    }
  }
  return res
}

/* ---------------- 求值 / 伴随式 ---------------- */

/** 降幂系数数组在 x = α^k 处取值 */
function polyEvalDesc(coeff, k) {
  const x = aPow(k)
  let r = 0
  for (let i = 0; i < coeff.length; i++) r = gmul(r, x) ^ coeff[i]
  return r
}

/** 升幂系数数组在 x = α^k 处取值 */
function polyEvalAsc(coeff, k) {
  const x = aPow(k)
  let r = 0
  for (let i = coeff.length - 1; i >= 0; i--) r = gmul(r, x) ^ coeff[i]
  return r
}

/** 伴随式 S[i] = c(α^i)，i=0..eccLen-1（升幂输出） */
function syndromes(cwDesc, eccLen) {
  const s = new Uint8Array(eccLen)
  let clean = true
  for (let i = 0; i < eccLen; i++) {
    s[i] = polyEvalDesc(cwDesc, i)
    if (s[i] !== 0) clean = false
  }
  return { s, clean }
}

/* ---------------- Berlekamp-Massey ---------------- */

/**
 * @param {Uint8Array} synd 升幂伴随式（长度 eccLen）
 * @param {number} maxDeg 允许的最大错误数（eccLen/2）
 * @returns {Array<number>|null} 错误位置多项式 Λ（升幂，Λ[0]=1）
 */
function berlekampMassey(synd, maxDeg) {
  let lam = [1]
  let b = [1]
  let L = 0
  let m = 1
  let bb = 1
  for (let n = 0; n < synd.length; n++) {
    let d = synd[n]
    for (let i = 1; i <= L; i++) d ^= gmul(lam[i], synd[n - i])
    if (d === 0) {
      m++
      continue
    }
    const T = lam.slice()
    const coef = gdiv(d, bb)
    while (lam.length < b.length + m) lam.push(0)
    for (let i = 0; i < b.length; i++) lam[i + m] ^= gmul(coef, b[i])
    if (2 * L <= n) {
      L = n + 1 - L
      b = T
      bb = d
      m = 1
    } else {
      m++
    }
    if (L > maxDeg) return null
  }
  if (L === 0) return null
  return lam.slice(0, L + 1)
}

/** Chien 搜索：返回出错的数组下标（传输顺序，0=最高次） */
function findErrorPositions(lam, totalLen) {
  const deg = lam.length - 1
  const pos = []
  for (let j = 0; j < totalLen; j++) {
    // x = α^{-j}
    if (polyEvalAsc(lam, -j) === 0) pos.push(totalLen - 1 - j)
  }
  return pos.length === deg ? pos : null
}

/** Forney：计算并纠正错误，返回是否成功 */
function forneyCorrect(cw, eccLen, lam, positions) {
  const totalLen = cw.length
  // Ω(x) = S(x)Λ(x) mod x^eccLen（均为升幂）
  const { s: synd } = syndromes(cw, eccLen)
  const omega = new Array(eccLen).fill(0)
  for (let i = 0; i < eccLen; i++) {
    let v = 0
    for (let j = 0; j <= i; j++) v ^= gmul(lam[j], synd[i - j] || 0)
    omega[i] = v
  }
  for (const p of positions) {
    const k = totalLen - 1 - p // 错误位置的指数
    const xInv = -k
    let num = polyEvalAsc(omega, xInv)
    // Λ'(x) = Σ_{i 奇} Λ[i] x^{i-1}
    let den = 0
    for (let i = 1; i < lam.length; i += 2) den ^= gmul(lam[i], aPow((i - 1) * xInv))
    if (den === 0) return false
    num = gmul(aPow(k), num)
    cw[p] ^= gdiv(num, den)
  }
  const chk = syndromes(cw, eccLen)
  return chk.clean
}

/**
 * 纠错解码（就地修改 cw）
 * @param {Uint8Array|Array<number>} cw 码字（数据+纠错，传输顺序）
 * @param {number} eccLen 纠错码字数
 * @returns {number} 纠正的错误个数；-1 表示无法纠正
 */
function rsCorrect(cw, eccLen) {
  if (eccLen <= 0) return 0
  const before = Array.prototype.slice.call(cw)
  const syn = syndromes(cw, eccLen)
  if (syn.clean) return 0
  const maxDeg = Math.floor(eccLen / 2)
  const lam = berlekampMassey(syn.s, maxDeg)
  if (!lam) return -1
  const positions = findErrorPositions(lam, cw.length)
  if (!positions) return -1
  const ok = forneyCorrect(cw, eccLen, lam, positions)
  if (!ok) {
    for (let i = 0; i < cw.length; i++) cw[i] = before[i]
    return -1
  }
  return positions.length
}

module.exports = {
  EXP,
  LOG,
  aPow,
  gmul,
  gdiv,
  gpow,
  generatorPoly,
  rsEncode,
  rsCorrect,
  syndromes,
  polyEvalDesc,
  polyEvalAsc
}
