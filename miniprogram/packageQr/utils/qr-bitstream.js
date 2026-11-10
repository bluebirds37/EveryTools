/**
 * QR 数据编码：模式判定 + 比特流构造（Numeric / Alphanumeric / Byte-UTF8）
 * 纯计算模块，可 node require 自测。
 */

const T = require('./qr-tables')

/* ---- UTF-8 编码（不依赖 TextEncoder，兼容低版本基础库） ---- */
function utf8Bytes(str) {
  const out = []
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i)
    if (c < 0x80) {
      out.push(c)
    } else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f))
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      const c2 = str.charCodeAt(i + 1)
      if (c2 >= 0xdc00 && c2 <= 0xdfff) {
        const cp = 0x10000 + (((c - 0xd800) << 10) | (c2 - 0xdc00))
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f))
        i++
      } else {
        out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f))
      }
    } else {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f))
    }
  }
  return out
}

function utf8ToString(bytes) {
  let s = ''
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i]
    if (b < 0x80) {
      s += String.fromCharCode(b)
      i++
    } else if (b >= 0xc0 && b < 0xe0) {
      s += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i + 1] & 0x3f))
      i += 2
    } else if (b >= 0xe0 && b < 0xf0) {
      s += String.fromCharCode(((b & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f))
      i += 3
    } else {
      const cp = (((b & 0x07) << 18) | ((bytes[i + 1] & 0x3f) << 12) | ((bytes[i + 2] & 0x3f) << 6) | (bytes[i + 3] & 0x3f)) - 0x10000
      s += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff))
      i += 4
    }
  }
  return s
}

/* ---- 模式判定 ---- */
function isNumeric(s) {
  return /^[0-9]+$/.test(s)
}
function isAlphanumeric(s) {
  for (let i = 0; i < s.length; i++) if (T.ALPHANUMERIC_CHARS.indexOf(s.charAt(i)) < 0) return false
  return true
}
function pickMode(content, want) {
  if (want && want !== 'auto') return want
  if (isNumeric(content)) return 'numeric'
  if (isAlphanumeric(content)) return 'alphanumeric'
  return 'byte'
}

/* ---- 比特缓冲 ---- */
function BitBuf() {
  this.bits = []
}
BitBuf.prototype.put = function (val, len) {
  for (let i = len - 1; i >= 0; i--) this.bits.push((val >>> i) & 1)
}
BitBuf.prototype.append = function (other) {
  for (let i = 0; i < other.bits.length; i++) this.bits.push(other.bits[i])
}
BitBuf.prototype.length = function () {
  return this.bits.length
}
/** 补终止符 + 字节对齐 + 0xEC/0x11 交替填充，返回码字数组 */
BitBuf.prototype.finalize = function (capacityBytes) {
  const remain = capacityBytes * 8 - this.bits.length
  const term = Math.max(0, Math.min(4, remain))
  for (let i = 0; i < term; i++) this.bits.push(0)
  while (this.bits.length % 8 !== 0) this.bits.push(0)
  // 填充码字从 0xEC 开始交替（ISO/IEC 18004 §8.4.9），交替计数只针对填充段，
  // 不能用「绝对码字下标奇偶」——数据码字数为奇数时会先写 0x11，与标准不符。
  for (let padIndex = 0; this.bits.length / 8 < capacityBytes; padIndex++) {
    const pad = padIndex % 2 === 0 ? 0xec : 0x11
    for (let i = 7; i >= 0; i--) this.bits.push((pad >>> i) & 1)
  }
  const out = []
  for (let i = 0; i < this.bits.length; i += 8) {
    let b = 0
    for (let j = 0; j < 8; j++) b = (b << 1) | this.bits[i + j]
    out.push(b)
  }
  return out
}

/* ---- 段编码（不含模式指示符与字符计数） ---- */
function dataBits(content, mode) {
  const buf = new BitBuf()
  if (mode === 'numeric') {
    for (let i = 0; i < content.length; i += 3) {
      const grp = content.substring(i, Math.min(i + 3, content.length))
      buf.put(parseInt(grp, 10), grp.length * 3 + 1)
    }
  } else if (mode === 'alphanumeric') {
    let i = 0
    for (; i + 1 < content.length; i += 2) {
      buf.put(T.ALPHANUMERIC_CHARS.indexOf(content.charAt(i)) * 45 + T.ALPHANUMERIC_CHARS.indexOf(content.charAt(i + 1)), 11)
    }
    if (i < content.length) buf.put(T.ALPHANUMERIC_CHARS.indexOf(content.charAt(i)), 6)
  } else if (mode === 'byte') {
    const bytes = utf8Bytes(content)
    for (let i = 0; i < bytes.length; i++) buf.put(bytes[i], 8)
  } else {
    throw new Error('[qr] 不支持的编码模式: ' + mode)
  }
  return { buf, bytes: mode === 'byte' ? utf8Bytes(content) : null }
}

const MODE_ID = { numeric: 1, alphanumeric: 2, byte: 4 }

function charCountOf(content, mode) {
  return mode === 'byte' ? utf8Bytes(content).length : content.length
}

/** 该版本下所需比特数（模式 4 + 字符计数 + 数据） */
function requiredBits(content, mode, version) {
  const cc = T.CHAR_COUNT_BITS[mode][T.versionRangeIndex(version)]
  return 4 + cc + dataBits(content, mode).buf.length()
}

/** 选取最小可用版本；超出容量返回 0 */
function chooseVersion(content, mode, ecc, minVersion, maxVersion) {
  const lo = Math.max(1, minVersion || 1)
  const hi = Math.min(40, maxVersion || 40)
  for (let v = lo; v <= hi; v++) {
    if (requiredBits(content, mode, v) <= T.numDataCodewords(v, ecc) * 8) return v
  }
  return 0
}

/** 生成数据码字（已含终止符与填充） */
function buildDataCodewords(content, mode, version, ecc) {
  const cc = T.CHAR_COUNT_BITS[mode][T.versionRangeIndex(version)]
  const buf = new BitBuf()
  buf.put(MODE_ID[mode], 4)
  buf.put(charCountOf(content, mode), cc)
  buf.append(dataBits(content, mode).buf)
  return buf.finalize(T.numDataCodewords(version, ecc))
}

module.exports = {
  utf8Bytes,
  utf8ToString,
  isNumeric,
  isAlphanumeric,
  pickMode,
  MODE_ID,
  charCountOf,
  requiredBits,
  chooseVersion,
  buildDataCodewords,
  BitBuf
}
