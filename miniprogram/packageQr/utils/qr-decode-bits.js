/**
 * QR 解码·比特层：格式/版本信息读取、反掩码、码字去交织、RS 纠错、数据码流解析
 * 纯计算模块，可 node require 自测。
 */

const T = require('./qr-tables')
const rs = require('./rs-gf256')
const mx = require('./qr-matrix')
const bs = require('./qr-bitstream')

/* ---------------- 格式信息 ---------------- */

const FORMAT_CANDIDATES = []
;(function () {
  for (let e = 0; e < 4; e++) {
    for (let m = 0; m < 8; m++) FORMAT_CANDIDATES.push({ ecc: T.ECC_LEVELS[e], mask: m, bits: mx.formatBits(T.ECC_LEVELS[e], m) })
  }
})()

function popcount(x) {
  let n = 0
  while (x) {
    x &= x - 1
    n++
  }
  return n
}

/** 从 15bit 中找出最接近的合法格式（容许 3bit 纠错） */
function matchFormat(bits15) {
  let best = null
  for (const c of FORMAT_CANDIDATES) {
    const d = popcount((c.bits ^ bits15) & 0x7fff)
    if (!best || d < best.d) best = { ecc: c.ecc, mask: c.mask, d }
  }
  return best.d <= 3 ? best : null
}

function readFormatBits(g) {
  const n = g.size
  let a = 0
  // 副本 1：绕左上定位图形
  for (let i = 0; i <= 5; i++) if (g.modules[i * n + 8]) a |= 1 << i
  if (g.modules[7 * n + 8]) a |= 1 << 6
  if (g.modules[8 * n + 8]) a |= 1 << 7
  if (g.modules[8 * n + 7]) a |= 1 << 8
  for (let i = 9; i < 15; i++) if (g.modules[8 * n + (14 - i)]) a |= 1 << i
  // 副本 2：右上 + 左下
  let b = 0
  for (let i = 0; i < 8; i++) if (g.modules[8 * n + (n - 1 - i)]) b |= 1 << i
  for (let i = 8; i < 15; i++) if (g.modules[(n - 15 + i) * n + 8]) b |= 1 << i
  const ma = matchFormat(a)
  const mb = matchFormat(b)
  if (ma && mb) return ma.d <= mb.d ? ma : mb
  return ma || mb || null
}

/** 校验给定 (ecc,mask) 是否与网格格式位一致（用于候选打分） */
function formatDistance(g) {
  return readFormatBits(g)
}

function readVersion(g) {
  const n = g.size
  if (n < 145) return Math.round((n - 17) / 4) // v<7 无需版本信息块
  let lo = 0
  let hi = 0
  for (let i = 0; i < 18; i++) {
    const bit = g.modules[Math.floor(i / 3) * n + (n - 11 + (i % 3))]
    if (bit) lo |= 1 << i
    const bit2 = g.modules[(n - 11 + (i % 3)) * n + Math.floor(i / 3)]
    if (bit2) hi |= 1 << i
  }
  let best = null
  for (let v = 7; v <= 40; v++) {
    const vb = mx.versionBits(v)
    const dl = popcount((vb ^ lo) & 0x3ffff)
    const dh = popcount((vb ^ hi) & 0x3ffff)
    const d = Math.min(dl, dh)
    if (!best || d < best.d) best = { version: v, d }
  }
  return best && best.d <= 3 ? best.version : 0
}

/* ---------------- 码字提取 ---------------- */

/** 功能模块模板仅与版本有关，缓存复用 */
const TEMPLATE_CACHE = {}
function functionTemplate(version) {
  if (TEMPLATE_CACHE[version]) return TEMPLATE_CACHE[version]
  const g = mx.createGrid(version * 4 + 17)
  mx.drawFunctionPatterns(g, version, 'L', 0)
  TEMPLATE_CACHE[version] = g.isFunction
  return TEMPLATE_CACHE[version]
}

/**
 * 从网格读取码字：按 Z 字序收集 -> 去交织 -> RS 纠错 -> 数据码字
 * @param {object} g {size, modules}
 * @param {number} version
 * @param {string} ecc
 * @param {number} mask
 * @param {Uint8Array} template isFunction 模板
 */
function extractCodewords(g, version, ecc, mask, template) {
  const n = g.size
  const st = T.blockStructure(version, ecc)
  const total = st.totalCodewords
  const bits = []
  const fn = mx.MASK_FN[mask]
  let idx = 0
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vert = 0; vert < n; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j
        const upward = ((right + 1) & 2) === 0
        const y = upward ? n - 1 - vert : vert
        const p = y * n + x
        if (template[p]) continue
        if (idx >= total * 8) continue
        let v = g.modules[p]
        if (fn(y, x)) v ^= 1
        bits.push(v)
        idx++
      }
    }
  }
  const cw = new Uint8Array(total)
  for (let i = 0; i < total; i++) {
    let b = 0
    for (let k = 0; k < 8; k++) b = (b << 1) | (bits[i * 8 + k] || 0)
    cw[i] = b
  }

  // 去交织
  const dataLens = []
  for (let i = 0; i < st.numBlocks; i++) dataLens.push(st.shortBlockLen + (i >= st.numShort ? 1 : 0))
  const blocks = dataLens.map((len) => ({ d: new Uint8Array(len), e: new Uint8Array(st.eccLen) }))
  let p = 0
  const maxData = Math.max.apply(null, dataLens)
  for (let i = 0; i < maxData; i++) {
    for (let b = 0; b < blocks.length; b++) if (i < blocks[b].d.length) blocks[b].d[i] = cw[p++]
  }
  for (let i = 0; i < st.eccLen; i++) {
    for (let b = 0; b < blocks.length; b++) blocks[b].e[i] = cw[p++]
  }

  let fixed = 0
  const data = []
  for (let b = 0; b < blocks.length; b++) {
    const cwArr = Uint8Array.from(blocks[b].d)
    const eccArr = Uint8Array.from(blocks[b].e)
    const joined = new Uint8Array(cwArr.length + eccArr.length)
    joined.set(cwArr)
    joined.set(eccArr, cwArr.length)
    const nfix = rs.rsCorrect(joined, st.eccLen)
    if (nfix < 0) return null
    fixed += nfix
    for (let i = 0; i < cwArr.length; i++) data.push(joined[i])
  }
  return { data, fixed, eccLen: st.eccLen, numBlocks: st.numBlocks }
}

/* ---------------- 数据码流解析 ---------------- */

function BitReader(bytes) {
  this.b = bytes
  this.p = 0
}
BitReader.prototype.read = function (n) {
  let v = 0
  for (let i = 0; i < n; i++) {
    const byte = this.b[Math.floor(this.p / 8)] || 0
    const bit = (byte >>> (7 - (this.p % 8))) & 1
    v = (v << 1) | bit
    this.p++
  }
  return v
}
BitReader.prototype.skip = function (n) {
  this.p += n
}
BitReader.prototype.left = function () {
  return this.b.length * 8 - this.p
}

/** 各模式所需比特数（精确值，用于「剩余比特是否够」判断） */
function bitsNeeded(mode, count) {
  if (mode === 'numeric') {
    return Math.floor(count / 3) * 10 + [0, 4, 7][count % 3]
  }
  if (mode === 'alphanumeric') return Math.floor(count / 2) * 11 + (count % 2) * 6
  return count * 8
}

function decodeNumeric(reader, count) {
  let s = ''
  while (s.length < count) {
    const grp = Math.min(3, count - s.length)
    const v = reader.read(grp * 3 + 1)
    s += String(v).padStart(grp, '0')
  }
  return s
}

function decodeAlphanumeric(reader, count) {
  let s = ''
  while (s.length < count) {
    if (count - s.length >= 2) {
      const v = reader.read(11)
      s += T.ALPHANUMERIC_CHARS.charAt(Math.floor(v / 45)) + T.ALPHANUMERIC_CHARS.charAt(v % 45)
    } else {
      s += T.ALPHANUMERIC_CHARS.charAt(reader.read(6))
    }
  }
  return s
}

function decodeByte(reader, count) {
  const out = new Uint8Array(count)
  for (let i = 0; i < count; i++) out[i] = reader.read(8)
  return bs.utf8ToString(out)
}

/**
 * 解析数据码字为文本
 * @returns {{text,mode,segments,terminated}|null}
 */
function parseDataCodewords(data, version) {
  const reader = new BitReader(data)
  const vi = T.versionRangeIndex(version || estimateVersionFromBytes(data))
  let text = ''
  let first = ''
  const segs = []
  let terminated = false
  while (reader.left() >= 4) {
    const mode = reader.read(4)
    if (mode === 0) {
      terminated = true
      break
    }
    if (mode === 1) {
      const count = reader.read(T.CHAR_COUNT_BITS.numeric[vi])
      if (count <= 0 || count > 8000 || reader.left() < bitsNeeded('numeric', count)) break
      const s = decodeNumeric(reader, count)
      segs.push({ mode: 'numeric', count, text: s })
      text += s
    } else if (mode === 2) {
      const count = reader.read(T.CHAR_COUNT_BITS.alphanumeric[vi])
      if (count <= 0 || count > 6000 || reader.left() < bitsNeeded('alphanumeric', count)) break
      const s = decodeAlphanumeric(reader, count)
      segs.push({ mode: 'alphanumeric', count, text: s })
      text += s
    } else if (mode === 4) {
      const count = reader.read(T.CHAR_COUNT_BITS.byte[vi])
      if (count <= 0 || count > 8000 || reader.left() < bitsNeeded('byte', count)) break
      const s = decodeByte(reader, count)
      segs.push({ mode: 'byte', count, text: s })
      text += s
    } else if (mode === 7) {
      // ECI 指派码：0xxxxxxx(7) / 110xxxxx+8(14) / 1110xxxx+16(20)
      const fb = reader.read(8)
      if ((fb & 0x80) === 0) reader.skip(0)
      else if ((fb & 0xe0) === 0xc0) reader.read(8)
      else if ((fb & 0xf0) === 0xe0) reader.read(16)
      else return null
      segs.push({ mode: 'eci' })
    } else if (mode === 8) {
      reader.read(13) // Kanji 首字节计数（不支持解析内容）
      break
    } else {
      break
    }
    if (!first && segs.length) first = segs[0].mode
  }
  if (!text) return null
  return { text, mode: first || 'byte', segments: segs, terminated }
}

function estimateVersionFromBytes(dataBytes) {
  // 由数据码字总数反推版本区间（用于字符计数字位数）
  for (let v = 1; v <= 40; v++) {
    for (const ecc of T.ECC_LEVELS) {
      if (T.numDataCodewords(v, ecc) === dataBytes.length) return v
    }
  }
  for (let v = 1; v <= 40; v++) if (T.numDataCodewords(v, 'L') >= dataBytes.length) return v
  return 40
}

module.exports = {
  readFormatBits,
  formatDistance,
  readVersion,
  functionTemplate,
  extractCodewords,
  parseDataCodewords,
  matchFormat,
  BitReader,
  bitsNeeded
}
