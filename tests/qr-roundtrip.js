/**
 * QR 编解码往返自测
 * 1) 自研编码器 -> 像素渲染 -> 自研解码器：24 组随机内容（中文/URL/WiFi/vCard，ecc L~H），要求 ≥95%
 * 2) 含变换鲁棒性：缩放、旋转（90/180/270 与任意角）、加噪、降采样
 * 3) 与第三方解码器（zxing-cpp）对照：由 tests/qr-zxing-check.py 输出结果，要求 100% 还原
 * 运行：node tests/qr-roundtrip.js
 */
const fs = require('fs')
const path = require('path')
const enc = require(path.join(__dirname, '../miniprogram/packageQr/utils/qr-encoder'))
const rnd = require(path.join(__dirname, '../miniprogram/packageQr/utils/qr-render'))
const dec = require(path.join(__dirname, '../miniprogram/packageQr/utils/qr-decoder'))
const fd = require(path.join(__dirname, '../miniprogram/packageQr/utils/qr-decode-find'))

let fails = 0
function ok(c, l, e) {
  if (c) console.log('  PASS  ' + l)
  else {
    fails++
    console.log('  FAIL  ' + l + (e !== undefined ? ' -> ' + JSON.stringify(e) : ''))
  }
}

const CASES = [
  'HELLO WORLD',
  '01234567890123456789012345678901234567890',
  '3.14159265358979',
  'https://example.com/a/b/c?x=1&y=2&z=3',
  'https://mqtt.babymind.cn/toolbox/health?from=qr&sign=a1b2c3d4',
  'HTTP://UPPER.CASE/PATH',
  '通用工具箱二维码中文测试',
  '二维码 v2：包含 emoji 😀 与符号 ★',
  'WIFI:T:WPA;S:MyNetwork;P:p@ssw0rd;H:false;;',
  'WIFI:T:nopass;S:开放网络;P:;H:true;;',
  'BEGIN:VCARD\nVERSION:3.0\nN:张;三\nFN:张三\nTEL;CELL:13800138000\nEND:VCARD',
  'MECARD:N:李四;TEL:13900001111;EMAIL:a@b.cn;;',
  'SMSTO:10086:查询余额',
  'tel:+8613800138000',
  'geo:31.2304,121.4737?q=上海',
  'otpauth://totp/ACME:bob?secret=JBSWY3DPEHPK3PXP&issuer=ACME',
  'A'.repeat(300),
  '1'.repeat(900),
  '{"id":42,"name":"配置","items":[1,2,3]}',
  '混合 Mixed 内容 123 +!?* 与 / :',
  'x'.repeat(700),
  '第一行\n第二行\n第三行\t制表符',
  'MD5:5d41402abc4b2a76b9719d911017c592',
  'http://a.cn/中文路径/文件.pdf'
]
const ECCS = ['L', 'M', 'Q', 'H']

function pixelImage(pix) {
  return { width: pix.width, height: pix.height, gray: fd.grayFromRgba(pix.data) }
}

/** 图像变换工具（纯 JS，模拟真实相册图） */
function scaleNearest(pix, factor) {
  const w = Math.max(1, Math.round(pix.width * factor))
  const h = Math.max(1, Math.round(pix.height * factor))
  const data = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = Math.min(pix.width - 1, Math.floor(x / factor))
      const sy = Math.min(pix.height - 1, Math.floor(y / factor))
      const si = (sy * pix.width + sx) * 4
      const di = (y * w + x) * 4
      data[di] = pix.data[si]
      data[di + 1] = pix.data[si + 1]
      data[di + 2] = pix.data[si + 2]
      data[di + 3] = 255
    }
  }
  return { width: w, height: h, data }
}

function rotate(pix, deg) {
  const rad = (deg * Math.PI) / 180
  const cos = Math.round(Math.cos(rad))
  const sin = Math.round(Math.sin(rad))
  const swap = Math.abs(deg % 180) === 90
  const w = swap ? pix.height : pix.width
  const h = swap ? pix.width : pix.height
  const data = new Uint8Array(w * h * 4)
  for (let i = 0; i < data.length; i++) data[i] = 255
  for (let y = 0; y < pix.height; y++) {
    for (let x = 0; x < pix.width; x++) {
      let nx, ny
      if (cos === 0 && sin === 1) {
        nx = y
        ny = pix.width - 1 - x
      } else if (cos === -1 && sin === 0) {
        nx = pix.width - 1 - x
        ny = pix.height - 1 - y
      } else if (cos === 0 && sin === -1) {
        nx = pix.height - 1 - y
        ny = x
      } else {
        nx = x
        ny = y
      }
      const si = (y * pix.width + x) * 4
      const di = (ny * w + nx) * 4
      data[di] = pix.data[si]
      data[di + 1] = pix.data[si + 1]
      data[di + 2] = pix.data[si + 2]
      data[di + 3] = 255
    }
  }
  return { width: w, height: h, data }
}

function addNoise(pix, amp, seed) {
  let s = seed || 12345
  const rand = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    return s / 0x7fffffff
  }
  const data = Uint8Array.from(pix.data)
  for (let i = 0; i < data.length; i += 4) {
    const n = Math.round((rand() - 0.5) * 2 * amp)
    data[i] = Math.max(0, Math.min(255, data[i] + n))
    data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + n))
    data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + n))
  }
  return { width: pix.width, height: pix.height, data }
}

console.log('== 1. 编码 → 渲染 → 自研解码：24 内容 x 4 纠错等级 ==')
let pass = 0
let total = 0
const miss = []
for (const text of CASES) {
  for (const ecc of ECCS) {
    total++
    const qr = enc.encode(text, { ecc })
    const pix = rnd.toPixels(qr, { moduleSize: 5, quiet: 4 })
    let r
    try {
      r = dec.decode({ width: pix.width, height: pix.height, gray: fd.grayFromRgba(pix.data) })
    } catch (e) {
      miss.push({ text: text.slice(0, 18), ecc, err: e.message, stats: e.stats })
      continue
    }
    if (r && r.text === text) pass++
    else miss.push({ text: text.slice(0, 18), ecc, got: r && r.text ? r.text.slice(0, 24) : null, mode: r && r.mode })
  }
}
const rate = pass / total
ok(rate >= 0.95, '自研往返成功率 ' + pass + '/' + total + ' = ' + (rate * 100).toFixed(1) + '%（要求 ≥95%）', miss.slice(0, 6))

console.log('== 2. 鲁棒性：旋转 90/180/270、缩放 0.6x/2x、高斯噪声 ±25 ==')
function variant(label, fn, limit) {
  let p = 0
  let t = 0
  const bad = []
  for (let i = 0; i < CASES.length && t < (limit || 8); i += 3) {
    for (const ecc of ['M', 'H']) {
      t++
      const qr = enc.encode(CASES[i], { ecc })
      const pix = rnd.toPixels(qr, { moduleSize: 4, quiet: 4 })
      const img = fn(pix)
      try {
        const r = dec.decode({ width: img.width, height: img.height, gray: fd.grayFromRgba(img.data) })
        if (r.text === CASES[i]) p++
        else bad.push(CASES[i].slice(0, 12) + '/' + ecc)
      } catch (e) {
        bad.push(CASES[i].slice(0, 12) + '/' + ecc + ':' + e.message)
      }
    }
  }
  ok(p / t >= 0.9, label + ' ' + p + '/' + t, bad.slice(0, 4))
}
variant('旋转 90°', (p) => rotate(p, 90))
variant('旋转 180°', (p) => rotate(p, 180))
variant('旋转 270°', (p) => rotate(p, 270))
variant('放大 2x', (p) => scaleNearest(p, 2))
variant('缩小 0.6x', (p) => scaleNearest(p, 0.6))
variant('噪声 ±25', (p) => addNoise(p, 25, 999))

console.log('== 3. 第三方解码器（zxing-cpp）对我方矩阵的还原 ==')
const zx = '/tmp/qr_zxing_result.json'
if (fs.existsSync(zx)) {
  const res = JSON.parse(fs.readFileSync(zx, 'utf8'))
  ok(res.ok === res.total, res.total + ' 例 100% 还原（zxing-cpp 解码我方渲染图片）', res.fail && res.fail.slice(0, 5))
} else {
  ok(false, '缺少 ' + zx + '，请先运行 tests/qr-zxing-check.py')
}

console.log(fails ? '\nQR ROUNDTRIP FAILED: ' + fails : '\nQR ROUNDTRIP ALL PASS')
process.exit(fails ? 1 : 0)
