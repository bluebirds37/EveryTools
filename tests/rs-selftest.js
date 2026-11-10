/**
 * RS(GF256) 自测：与第三方 reedsolo(python, prim=0x11d gen=2 fcr=0) 输出对照
 * 运行：node tests/rs-selftest.js
 */
const fs = require('fs')
const path = require('path')
const rs = require(path.join(__dirname, '../miniprogram/packageQr/utils/rs-gf256'))

const refPath = '/tmp/rs_ref.json'
let fails = 0
function ok(cond, label, extra) {
  if (cond) console.log('  PASS  ' + label)
  else {
    fails++
    console.log('  FAIL  ' + label + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''))
  }
}

console.log('[RS] GF(256) 基本性质')
ok(rs.EXP[0] === 1 && rs.EXP[8] === 29, 'EXP 表 (a^8 = 29, x^8+x^4+x^3+x^2+1)', rs.EXP[8])
// 独立实现（逐位乘加 + 按 0x11D 取模）交叉验证查表法，覆盖全部 256x256 组合
function refMul(a, b) {
  let p = 0
  let x = a
  let y = b
  while (y) {
    if (y & 1) p ^= x
    y >>= 1
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  return p
}
let mulDiff = 0
for (let a = 0; a < 256; a++) for (let b = 0; b < 256; b++) if (rs.gmul(a, b) !== refMul(a, b)) mulDiff++
ok(mulDiff === 0, 'gmul 与独立位运算实现全 65536 组一致', mulDiff)
ok(rs.gdiv(rs.gmul(123, 200), 200) === 123, 'gdiv 为 gmul 逆')
let ident = true
for (let a = 1; a < 256; a++) if (rs.gpow(rs.EXP[rs.LOG[a]], 1) !== a) ident = false
ok(ident, 'log/exp 互为逆')

console.log('[RS] 生成多项式与对照 reedsolo')
if (fs.existsSync(refPath)) {
  const ref = JSON.parse(fs.readFileSync(refPath, 'utf8'))
  const enc = Array.from(rs.rsEncode(ref.msg, 10))
  ok(JSON.stringify(enc) === JSON.stringify(ref.ecc), 'rsEncode 与 reedsolo 一致', { mine: enc, ref: ref.ecc })
  const cw = Uint8Array.from(ref.bad)
  const n = rs.rsCorrect(cw, 10)
  ok(n === ref.pos.length, '纠错数量 = 注入错误数 5', n)
  ok(JSON.stringify(Array.from(cw.slice(0, 20))) === JSON.stringify(ref.recovered), '纠错后数据与 reedsolo 一致')
  ok(JSON.stringify(Array.from(cw)) === JSON.stringify(ref.msg.concat(ref.ecc)), '完整码字（数据+ECC）与原始一致')
} else {
  console.log('  SKIP  未找到 /tmp/rs_ref.json')
}

console.log('[RS] 随机纠错压力测试')
let allOk = true
for (let t = 0; t < 300; t++) {
  const dataLen = 10 + Math.floor(Math.random() * 40)
  const eccLen = [7, 10, 15, 18, 20, 24, 26, 28, 30][t % 9]
  const data = []
  for (let i = 0; i < dataLen; i++) data.push(Math.floor(Math.random() * 256))
  const ecc = rs.rsEncode(data, eccLen)
  const cw = Uint8Array.from(data.concat(Array.from(ecc)))
  const errCount = Math.floor(eccLen / 2)
  const idx = []
  while (idx.length < errCount) {
    const p = Math.floor(Math.random() * cw.length)
    if (idx.indexOf(p) < 0) idx.push(p)
  }
  for (const p of idx) cw[p] ^= 1 + Math.floor(Math.random() * 255)
  const fixed = rs.rsCorrect(cw, eccLen)
  if (fixed !== errCount || Array.from(cw.slice(0, dataLen)).join() !== data.join()) {
    allOk = false
    console.log('  FAIL  t=' + t, { dataLen, eccLen, errCount, fixed })
    break
  }
}
ok(allOk, '300 组随机「编码→注入 eccLen/2 个错误→解码」全部还原')

console.log(fails === 0 ? '\n[RS] ALL PASS' : '\n[RS] ' + fails + ' FAIL')
process.exit(fails === 0 ? 0 : 1)
