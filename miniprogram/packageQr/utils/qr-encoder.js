/**
 * QR 码编码器（自研，ISO/IEC 18004）
 * 版本 1-40 · 纠错 L/M/Q/H · Numeric/Alphanumeric/Byte(UTF-8) · 掩码 0-7 自动惩罚选优 ·
 * GF(256) Reed-Solomon 分块交织 · 格式信息 BCH(15,5) · 版本信息 BCH(18,6) · 功能图形避让。
 *
 * 纯计算模块，可被 node 直接 require 做自测。渲染（Canvas）在 qr-render.js。
 */

const rs = require('./rs-gf256')
const T = require('./qr-tables')
const bs = require('./qr-bitstream')
const mx = require('./qr-matrix')

/** 数据码字 -> 分块 + RS 纠错 + 交织成最终码字序列 */
function interleave(dataCodewords, version, ecc) {
  const st = T.blockStructure(version, ecc)
  const blocks = []
  let offset = 0
  for (let i = 0; i < st.numBlocks; i++) {
    const len = st.shortBlockLen + (i >= st.numShort ? 1 : 0)
    const d = dataCodewords.slice(offset, offset + len)
    offset += len
    blocks.push({ d, e: Array.from(rs.rsEncode(d, st.eccLen)) })
  }
  const out = []
  const maxData = st.shortBlockLen + (st.numShort < st.numBlocks ? 1 : 0)
  for (let i = 0; i < maxData; i++) {
    for (let b = 0; b < blocks.length; b++) if (i < blocks[b].d.length) out.push(blocks[b].d[i])
  }
  for (let i = 0; i < st.eccLen; i++) {
    for (let b = 0; b < blocks.length; b++) out.push(blocks[b].e[i])
  }
  return { codewords: out, structure: st, blocks }
}

/**
 * 生成 QR 码矩阵
 * @param {string} content 原文（UTF-8）
 * @param {object} [opts] {ecc='M', mode='auto', mask=-1 自动, minVersion=1, maxVersion=40}
 * @returns {{size,modules,isFunction,version,ecc,mask,mode,codewords,penalty,blocks}}
 */
function encode(content, opts) {
  opts = opts || {}
  if (typeof content !== 'string' || content.length === 0) {
    const e = new Error('内容为空')
    e.code = 'INPUT_EMPTY'
    throw e
  }
  const ecc = T.ECC_LEVELS.indexOf(opts.ecc) >= 0 ? opts.ecc : 'M'
  const mode = bs.pickMode(content, opts.mode)
  const version = bs.chooseVersion(content, mode, ecc, opts.minVersion, opts.maxVersion)
  if (!version) {
    const e = new Error('内容超出该纠错等级可容纳的最大长度（请降低等级、换模式或缩短内容）')
    e.code = 'QR_OVERFLOW'
    e.extra = { ecc, mode }
    throw e
  }
  const dataCw = bs.buildDataCodewords(content, mode, version, ecc)
  const il = interleave(dataCw, version, ecc)

  const autoMask = opts.mask === undefined || opts.mask === null || opts.mask < 0
  let best = null
  const candidates = autoMask ? [0, 1, 2, 3, 4, 5, 6, 7] : [opts.mask]
  for (const m of candidates) {
    const g = mx.renderWithMask(version, ecc, m, il.codewords)
    if (!autoMask) {
      best = { g, m, p: 0 }
      break
    }
    const p = mx.penalty(g)
    if (!best || p < best.p) best = { g, m, p }
  }

  return {
    size: best.g.size,
    modules: best.g.modules,
    isFunction: best.g.isFunction,
    version,
    ecc,
    mode,
    mask: best.m,
    penalty: best.p,
    codewords: il.codewords,
    blocks: il.blocks,
    structure: il.structure,
    charCount: bs.charCountOf(content, mode)
  }
}

/** 各版本/等级可容纳的字符数（用于 UI 提示与容量校验） */
function capacityTable(ecc, mode) {
  const out = []
  for (let v = 1; v <= 40; v++) {
    const bits = T.numDataCodewords(v, ecc) * 8
    const cc = T.CHAR_COUNT_BITS[mode][T.versionRangeIndex(v)]
    out.push({ version: v, size: v * 4 + 17, bytes: Math.floor(bits / 8), maxChars: Math.floor((bits - 4 - cc) / (mode === 'byte' ? 8 : mode === 'numeric' ? 3.34 : 5.5)) })
  }
  return out
}

/** 最大可容纳字节数（Byte 模式），用于表单提示 */
function maxByteLength(ecc) {
  let best = 0
  for (let v = 1; v <= 40; v++) {
    const bits = T.numDataCodewords(v, ecc) * 8
    const cc = T.CHAR_COUNT_BITS.byte[T.versionRangeIndex(v)]
    best = Math.max(best, Math.floor((bits - 4 - cc) / 8))
  }
  return best
}

/** 二维布尔矩阵 */
function toBoolMatrix(qr) {
  const out = []
  for (let y = 0; y < qr.size; y++) {
    const row = new Array(qr.size)
    for (let x = 0; x < qr.size; x++) row[x] = qr.modules[y * qr.size + x] === 1
    out.push(row)
  }
  return out
}

function toString10(qr) {
  const lines = []
  for (let y = 0; y < qr.size; y++) {
    let s = ''
    for (let x = 0; x < qr.size; x++) s += qr.modules[y * qr.size + x] ? '1' : '0'
    lines.push(s)
  }
  return lines.join('\n')
}

module.exports = {
  encode,
  interleave,
  toBoolMatrix,
  toString10,
  capacityTable,
  maxByteLength,
  ECC_LEVELS: T.ECC_LEVELS,
  utf8Bytes: bs.utf8Bytes,
  pickMode: bs.pickMode
}
