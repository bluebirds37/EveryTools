/**
 * QR 码标准常量表（ISO/IEC 18004）
 * 纯数据模块，可 node require 自测。
 */

const ECC_LEVELS = ['L', 'M', 'Q', 'H']
const ECC_FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 }

/** 每块纠错码字数：[eccIndex][version]，version 1..40（index 0 占位） */
const ECC_CODEWORDS_PER_BLOCK = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30]
]

/** 分块数：[eccIndex][version] */
const NUM_ERROR_CORRECTION_BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81]
]

/** 模式 */
const MODE = {
  NUMERIC: { id: 1, bits: 4, name: 'numeric' },
  ALPHANUMERIC: { id: 2, bits: 4, name: 'alphanumeric' },
  BYTE: { id: 4, bits: 4, name: 'byte' },
  ECI: { id: 7, bits: 4, name: 'eci' },
  TERMINATOR: { id: 0, bits: 4, name: 'terminator' }
}

const ALPHANUMERIC_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:'

/** 字符计数指示符位数：[mode][版本区间] 0:v1-9 1:v10-26 2:v27-40 */
const CHAR_COUNT_BITS = {
  numeric: [10, 12, 14],
  alphanumeric: [9, 11, 13],
  byte: [8, 16, 16],
  kanji: [8, 10, 12]
}

function versionRangeIndex(version) {
  if (version <= 9) return 0
  if (version <= 26) return 1
  return 2
}

function eccIndex(ecc) {
  const i = ECC_LEVELS.indexOf(ecc)
  if (i < 0) throw new Error('[qr] 未知纠错等级: ' + ecc)
  return i
}

/** 版本可用的功能模块（bit）数，不含剩余 bit 对齐 */
function numRawDataModules(version) {
  if (version < 1 || version > 40) throw new Error('[qr] 版本越界: ' + version)
  let result = (16 * version + 128) * version + 64
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2
    result -= (25 * numAlign - 10) * numAlign - 55
    if (version >= 7) result -= 36
  }
  return result
}

/** 数据码字总数（不含 ECC） */
function numDataCodewords(version, ecc) {
  const ei = eccIndex(ecc)
  return (
    Math.floor(numRawDataModules(version) / 8) -
    ECC_CODEWORDS_PER_BLOCK[ei][version] * NUM_ERROR_CORRECTION_BLOCKS[ei][version]
  )
}

/** 剩余比特数（绘制时需补 0） */
function numRemainderBits(version) {
  return numRawDataModules(version) % 8
}

/**
 * 分块结构
 * @returns {{blocks:Array<{data:Uint8Array,ecc:Uint8Array}>, numBlocks:number, eccPerBlock:number, totalCodewords:number}}
 */
function blockStructure(version, ecc) {
  const ei = eccIndex(ecc)
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[ei][version]
  const eccLen = ECC_CODEWORDS_PER_BLOCK[ei][version]
  const totalCodewords = Math.floor(numRawDataModules(version) / 8)
  const rawDatLen = totalCodewords - eccLen * numBlocks
  const shortBlockLen = Math.floor(rawDatLen / numBlocks)
  const numShort = numBlocks - (rawDatLen % numBlocks)
  return { numBlocks, eccLen, totalCodewords, shortBlockLen, numShort }
}

/** 校正图形（alignment pattern）中心坐标 */
function alignmentPositions(version) {
  if (version === 1) return []
  const numAlign = Math.floor(version / 7) + 2
  const size = version * 4 + 17
  const step = version === 32 ? 26 : Math.ceil((4 * version + 4) / (numAlign * 2 - 2)) * 2
  const result = [6]
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos)
  return result
}

module.exports = {
  ECC_LEVELS,
  ECC_FORMAT_BITS,
  ECC_CODEWORDS_PER_BLOCK,
  NUM_ERROR_CORRECTION_BLOCKS,
  MODE,
  ALPHANUMERIC_CHARS,
  CHAR_COUNT_BITS,
  versionRangeIndex,
  eccIndex,
  numRawDataModules,
  numDataCodewords,
  numRemainderBits,
  blockStructure,
  alignmentPositions
}
