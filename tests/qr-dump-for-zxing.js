/** 把我方编码器输出的矩阵导出，交给第三方解码器（zxing-cpp）验证 100% 还原 */
const fs = require('fs')
const path = require('path')
const enc = require(path.join(__dirname, '../miniprogram/packageQr/utils/qr-encoder'))

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

const out = []
for (const text of CASES) {
  for (const ecc of ['L', 'M', 'Q', 'H']) {
    const qr = enc.encode(text, { ecc })
    const rows = []
    for (let y = 0; y < qr.size; y++) {
      let s = ''
      for (let x = 0; x < qr.size; x++) s += qr.modules[y * qr.size + x] ? '1' : '0'
      rows.push(s)
    }
    out.push({ text, ecc, version: qr.version, mask: qr.mask, mode: qr.mode, size: qr.size, matrix: rows })
  }
}
fs.writeFileSync('/tmp/qr_for_zxing.json', JSON.stringify(out))
console.log('dumped', out.length, 'matrices (versions', Math.min.apply(null, out.map((o) => o.version)), '-', Math.max.apply(null, out.map((o) => o.version)), ')')
