/**
 * 二维码编码器权威对照自测
 *   node tests/qr-enc-selftest.js
 *
 * 参考数据来自 tests/reference/（由 tests/gen-reference.py 用 python-qrcode 生成，
 * 单段编码 + 强制掩码，与本页实现同构可比）：
 *   qr_rs_blocks.json    40 版本 x 4 等级分块表
 *   qr_ref_matrix.jsonl  160 组参考矩阵（逐行 0/1）
 *   qr_penalty.json      320 组 ISO lost_point
 *   qr_codewords.json    交织后的码字序列
 *   zxing 第三方解码结果由 tests/qr-zxing-check.py 写入 /tmp/qr_zxing_result.json
 */
const fs = require('fs')
const path = require('path')
const ROOT = path.join(__dirname, '..')
const enc = require(path.join(ROOT, 'miniprogram/packageQr/utils/qr-encoder'))
const T = require(path.join(ROOT, 'miniprogram/packageQr/utils/qr-tables'))
const MX = require(path.join(ROOT, 'miniprogram/packageQr/utils/qr-matrix'))
const REF = (f) => path.join(__dirname, 'reference', f)
const readJSON = (f) => JSON.parse(fs.readFileSync(REF(f), 'utf8'))

let fails = 0
function ok(c, l, e) {
  if (c) console.log('  PASS  ' + l)
  else { fails++; console.log('  FAIL  ' + l + (e !== undefined ? ' -> ' + JSON.stringify(e) : '')) }
}
function mineRows(q) {
  const out = []
  for (let y = 0; y < q.size; y++) {
    let r = ''
    for (let x = 0; x < q.size; x++) r += q.modules[y * q.size + x] ? '1' : '0'
    out.push(r)
  }
  return out.join('\n')
}
function mineBool(q) {
  const out = []
  for (let y = 0; y < q.size; y++) {
    const r = []
    for (let x = 0; x < q.size; x++) r.push(q.modules[y * q.size + x] === 1)
    out.push(r)
  }
  return out
}
function refMatrix(text) {
  return text.trim().split('\n').map((s) => s.split('').map((c) => c === '1'))
}

// ---------- 1. 分块表 ----------
console.log('== 1. RS 分块表（40 版本 x 4 等级）与 python-qrcode 一致 ==')
const tab = readJSON('qr_rs_blocks.json')
let diff = null
for (let v = 1; v <= 40 && !diff; v++) {
  T.ECC_LEVELS.forEach((ecc, e) => {
    if (diff) return
    const st = T.blockStructure(v, ecc)
    if (st.eccLen !== tab.ecc[ecc][v] || st.numBlocks !== tab.blocks[ecc][v] || T.numDataCodewords(v, ecc) !== tab.data[ecc][v]) {
      diff = { v, ecc, mine: st, ref: { ecc: tab.ecc[ecc][v], blocks: tab.blocks[ecc][v], data: tab.data[ecc][v] } }
    }
  })
}
ok(!diff, '每块纠错码字数 / 分块数 / 数据码字总数全部一致', diff)

// ---------- 2. 码字序列 ----------
console.log('== 2. 数据码字 + 分块交织序列一致 ==')
const cw = readJSON('qr_codewords.json')
cw.forEach((c) => {
  const q = enc.encode(c.text, { ecc: c.ecc, mask: c.mask })
  ok(q.codewords.join() === c.codewords.join(), '码字一致: [' + c.text.slice(0, 10) + '/' + c.ecc + '] v' + c.version)
})

// ---------- 3. 掩码惩罚 + 自动掩码 ----------
console.log('== 3. 四项惩罚评分 = ISO lost_point；自动掩码选择一致 ==')
const pen = readJSON('qr_penalty.json')
let penBad = 0
let penTotal = 0
pen.forEach((row) => {
  row.points.forEach((pt) => {
    const q = enc.encode(row.text, { ecc: row.ecc, mask: pt.mask })
    penTotal++
    if (MX.penalty(q) !== pt.lostPoint) penBad++
  })
})
ok(penBad === 0, '惩罚值与参考 lost_point 一致：' + (penTotal - penBad) + '/' + penTotal, penBad)
let maskBad = 0
pen.forEach((row) => {
  const a = enc.encode(row.text, { ecc: row.ecc })
  if (a.mask !== row.best.mask) maskBad++
})
ok(maskBad === 0, '自动掩码（惩罚最小者）与参考一致：' + (pen.length - maskBad) + '/' + pen.length, maskBad)

// ---------- 4. 结构断言 ----------
console.log('== 4. 功能图形结构自校验 ==')
function finderOk(m) {
  const n = m.length
  const at = (ox, oy) => {
    for (let dy = 0; dy < 7; dy++) {
      for (let dx = 0; dx < 7; dx++) {
        const d = Math.max(Math.abs(dx - 3), Math.abs(dy - 3))
        if (m[oy + dy][ox + dx] !== (d !== 2)) return false
      }
    }
    return true
  }
  return at(0, 0) && at(n - 7, 0) && at(0, n - 7)
}
function timingOk(m) {
  const n = m.length
  for (let i = 8; i < n - 8; i++) {
    if (m[6][i] !== (i % 2 === 0)) return false
    if (m[i][6] !== (i % 2 === 0)) return false
  }
  return true
}
/** ISO/IEC 18004 Table 7：指定版本/等级的 Byte 模式最大字符数 */
function byteCap(v, ecc) {
  const bits = T.numDataCodewords(v, ecc) * 8
  const cc = T.CHAR_COUNT_BITS.byte[T.versionRangeIndex(v)]
  return Math.floor((bits - 4 - cc) / 8)
}
function fmtOk(m, ecc, mask) {
  const bits = (T.ECC_FORMAT_BITS[ecc] << 3) | mask
  let rem = bits
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
  const F = (((bits << 10) | (rem & 0x3ff)) ^ 0x5412) >>> 0
  const b = (i) => ((F >>> i) & 1) === 1
  for (let i = 0; i <= 5; i++) if (m[i][8] !== b(i)) return false
  if (m[7][8] !== b(6) || m[8][8] !== b(7) || m[8][7] !== b(8)) return false
  for (let i = 9; i < 15; i++) if (m[8][14 - i] !== b(i)) return false
  return true
}
;[['HELLO WORLD', 'Q', 2], ['0123456789', 'L', 4], ['3.14159265', 'H', 7], ['中文测试二维码生成', 'M', 1]].forEach((t, i) => {
  const q = enc.encode(t[0], { ecc: t[1], mask: t[2] })
  const m = mineBool(q)
  const n = m.length
  ok((n - 17) % 4 === 0, '样例' + (i + 1) + ' [' + t[0].slice(0, 8) + '] 尺寸为合法 QR 边长 ' + n)
  ok(finderOk(m), '样例' + (i + 1) + ' 三个定位图形正确')
  ok(timingOk(m), '样例' + (i + 1) + ' 时序图形正确')
  ok(fmtOk(m, t[1], q.mask), '样例' + (i + 1) + ' 格式信息 BCH(15,5) 位正确')
  ok(m[n - 8][8] === true, '样例' + (i + 1) + ' 固定深色模块置位')
  if (q.version >= 7) {
    const vbits = (() => {
      let d = q.version
      for (let j = 0; j < 12; j++) d = (d << 1) ^ ((d >>> 11) * 0x1f25)
      return ((q.version << 12) | d) >>> 0
    })()
    let seen = 0
    for (let y = 0; y < 6; y++) {
      for (let x = 0; x < 3; x++) {
        const want = ((vbits >>> (y * 3 + x)) & 1) === 1
        if (m[n - 11 + x][y] === want) seen++
        if (m[y][n - 11 + x] === want) seen++
      }
    }
    ok(seen === 36, '样例' + (i + 1) + ' 版本信息 BCH(18,6) 位正确', seen)
  }
})

// ---------- 5. 与参考矩阵逐模块一致 ----------
console.log('== 5. 与 python-qrcode 参考矩阵逐模块一致 ==')
const rows = fs.readFileSync(REF('qr_ref_matrix.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse)
let bad = 0
let checked = 0
const badList = []
rows.forEach((it) => {
  const q = enc.encode(it.text, { ecc: it.ecc, mask: it.mask })
  checked++
  if (q.version !== it.version) {
    bad++
    badList.push({ text: it.text.slice(0, 12), ecc: it.ecc, mine: q.version, ref: it.version, why: 'version' })
  } else if (mineRows(q) !== it.matrix.trim()) {
    bad++
    badList.push({ text: it.text.slice(0, 12), ecc: it.ecc, mask: it.mask, v: q.version, why: 'matrix' })
  }
})
ok(bad === 0, '参考矩阵逐模块一致：' + (checked - bad) + '/' + checked, badList.slice(0, 4))

// ---------- 6. 容量表（ISO/IEC 18004 Table 7 抽样）----------
console.log('== 6. 字节模式容量抽样 + 40x4 边界精确性 ==')
const ISO_BYTE_CAP = {
  1: { L: 17, M: 14, Q: 11, H: 7 },
  5: { L: 106, M: 84, Q: 60, H: 44 },
  10: { L: 271, M: 213, Q: 151, H: 119 },
  26: { L: 1367, M: 1059, Q: 751, H: 593 },
  40: { L: 2953, M: 2331, Q: 1663, H: 1273 }
}
let capBad = []
Object.keys(ISO_BYTE_CAP).forEach((v) => {
  const v2 = parseInt(v, 10)
  T.ECC_LEVELS.forEach((ecc) => {
    const cap = byteCap(v2, ecc)
    if (cap !== ISO_BYTE_CAP[v2][ecc]) capBad.push({ v: v2, ecc, mine: cap, iso: ISO_BYTE_CAP[v2][ecc] })
  })
})
ok(capBad.length === 0, 'ISO Table 7 抽样容量一致（v1/5/10/26/40 x 4 等级）', capBad)
let edgeBad = []
for (let v = 1; v <= 40; v++) {
  T.ECC_LEVELS.forEach((ecc) => {
    const cap = byteCap(v, ecc)
    const at = 'a'.repeat(cap)
    const over = 'a'.repeat(cap + 1)
    let fits = true
    let overflow = false
    try {
      const q = enc.encode(at, { ecc, minVersion: v, maxVersion: v })
      if (q.version !== v || q.charCount !== cap) fits = false
    } catch (e) {
      fits = false
    }
    try {
      enc.encode(over, { ecc, minVersion: v, maxVersion: v })
      overflow = false
    } catch (e) {
      overflow = /溢出|overflow|CAPACITY/i.test(String(e.message) + String(e.code))
    }
    if (!fits || !overflow) edgeBad.push({ v, ecc, cap, fits, overflow })
  })
}
ok(edgeBad.length === 0, '40 版本 x 4 等级边界精确：cap 恰好可编码、cap+1 必须报容量溢出（' + 160 + ' 组）', edgeBad.slice(0, 4))

// ---------- 7. 第三方解码 ----------
console.log('== 7. 第三方解码器（zxing-cpp）还原 ==')
const zxp = '/tmp/qr_zxing_result.json'
if (fs.existsSync(zxp)) {
  const z = JSON.parse(fs.readFileSync(zxp, 'utf8'))
  ok(z.ok === z.total, z.total + ' 例矩阵被 zxing-cpp 100% 还原', z)
} else {
  ok(false, '未找到 /tmp/qr_zxing_result.json（先跑 node tests/qr-dump-for-zxing.js && python tests/qr-zxing-check.py）')
}

console.log(fails ? 'QR-ENC SELFTEST FAILED: ' + fails : 'QR-ENC SELFTEST ALL PASS (' + checked + ' 组参考矩阵 + ' + penTotal + ' 组惩罚)')
process.exit(fails ? 1 : 0)
