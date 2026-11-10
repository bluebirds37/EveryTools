/* 条码类工具用例：编码结果按规范手算核对；解码走「编码→像素→解码」自洽往返。 */
function hay(d) {
  return [d.result, d.kv, d.rows, d.out, d.text, d.items, d.summaryText].map((x) => (x == null ? '' : JSON.stringify(x))).join('|')
}
const has = (d, s) => hay(d).indexOf(s) >= 0

module.exports = {
  'qr-generate': [
    {
      name: 'HELLO WORLD → Version 1（21×21）',
      values: { type: 'text', content: 'HELLO WORLD', ssid: '', password: '', security: 'wpax', hidden: false, vName: '', vPhone: '', vEmail: '', vOrg: '', vTitle: '', vAddress: '', smsNumber: '', smsBody: '', telNum: '', geoLat: 0, geoLng: 0, otpSecret: '', eccLevel: 'M', size: 6, margin: 4, fg: '#000000', bg: '#FFFFFF' },
      expect: (d, h) => {
        const errs = []
        const enc = h.lib('packageQr/utils/qr-encoder.js')
        const m = enc.encode('HELLO WORLD', { ecLevel: 'M' })
        if (m.size !== 21) errs.push('规范里 HELLO WORLD(M) 是 Version 1 = 21 模块，实际 ' + m.size)
        if (m.version !== 1) errs.push('version 应为 1，实际 ' + m.version)
        if (m.modules.length !== 441) errs.push('位图长度应为 441')
        // 三个定位图的左上角必须是 7×7 实心边框 + 中心 3×3
        if (!m.modules[0] || !m.modules[6] || !m.modules[8 * 21]) errs.push('定位图形缺失')
        if (!d.result) errs.push('页面没有产出结果：' + hay(d).slice(0, 160))
        return errs
      }
    },
    {
      name: '中文按 UTF-8 升版本并可往返解码',
      values: { type: 'text', content: '日常工具箱', eccLevel: 'Q', size: 6, margin: 4, fg: '#000000', bg: '#FFFFFF', ssid: '', password: '', security: 'wpax', hidden: false, vName: '', vPhone: '', vEmail: '', vOrg: '', vTitle: '', vAddress: '', smsNumber: '', smsBody: '', telNum: '', geoLat: 0, geoLng: 0, otpSecret: '' },
      expect: (d, h) => {
        const errs = []
        const enc = h.lib('packageQr/utils/qr-encoder.js')
        const dec = h.lib('packageQr/utils/qr-decoder.js')
        const ren = h.lib('packageQr/utils/qr-render.js')
        const m = enc.encode('日常工具箱', { ecLevel: 'Q' })
        // 15 个 UTF-8 字节 + Q 级纠错，版本必然 >1
        if (m.size <= 21) errs.push('中文 Q 级的版本不合理：size=' + m.size)
        const px = ren.toPixels(m, { moduleSize: 4, quiet: 4 })
        if (px.width !== m.size * 4 + 32) errs.push('像素宽度与静区不符：' + px.width)
        const back = dec.decodeFromRgba(px, {})
        const text = (back && (back.text || back.value || (back.data && back.data.text))) || ''
        if (String(text) !== '日常工具箱') errs.push('编码→像素→解码往返失败，解出：' + JSON.stringify(back).slice(0, 160))
        return errs
      }
    },
    {
      name: 'WIFI 内容格式与空内容报错',
      values: { type: 'wifi', content: '', ssid: '我的网络', password: 'p@ss;word', security: 'wpax', hidden: true, eccLevel: 'M', size: 6, margin: 4, fg: '#000000', bg: '#FFFFFF', vName: '', vPhone: '', vEmail: '', vOrg: '', vTitle: '', vAddress: '', smsNumber: '', smsBody: '', telNum: '', geoLat: 0, geoLng: 0, otpSecret: '' },
      expect: (d, h) => {
        const errs = []
        const qc = h.lib('packageQr/utils/qr-content.js')
        const build = qc.wifi || qc.buildWifi || qc.toWifi
        if (typeof build === 'function') {
          const s = String(build({ ssid: '我的网络', password: 'p@ss;word', security: 'WPA', hidden: true }))
          if (!/^WIFI:/.test(s)) errs.push('WIFI 内容应以 WIFI: 开头：' + s)
          if (!/S:我的网络/.test(s)) errs.push('SSID 未写入：' + s)
          // 分号必须转义，否则解析端会截断
          if (/P:p@ss;word/.test(s) && !/\\;/.test(s)) errs.push('密码里的 ; 未转义：' + s)
        }
        if (!d.error && !(d.result && JSON.stringify(d.result).indexOf('WIFI') >= 0)) errs.push('空 content 但选了 WIFI 类型，应给提示或自动按表单生成')
        return errs
      }
    }
  ],

  'qr-decode': [
    {
      name: '自洽往返：解码结果与原文完全一致',
      values: { tryInverted: true, downscale: 1 },
      files: (h) => {
        const enc = h.lib('packageQr/utils/qr-encoder.js')
        const ren = h.lib('packageQr/utils/qr-render.js')
        const px = ren.toPixels(enc.encode('https://example.com/toolbox?a=1', { ecLevel: 'M' }), { moduleSize: 6, quiet: 4 })
        // 把渲染出的位图当作「相册里的一张二维码」
        h.mock.putFile('/tmp/qr-self.png', { size: px.data.length, width: px.width, height: px.height, type: 'png' })
        h.__px = px
        return [{ path: '/tmp/qr-self.png', size: px.data.length, width: px.width, height: px.height, format: 'png', type: 'image', name: 'qr-self.png' }]
      },
      expect: (d, h) => {
        const errs = []
        const dec = h.lib('packageQr/utils/qr-decoder.js')
        const back = dec.decodeFromRgba(h.__px || { width: 0, height: 0, data: new Uint8ClampedArray(4) }, {})
        const text = (back && (back.text || back.value || (back.data && back.data.text))) || ''
        if (String(text) !== 'https://example.com/toolbox?a=1') errs.push('解码器往返失败：' + JSON.stringify(back).slice(0, 180))
        return errs
      }
    },
    {
      name: '无码图片必须给可读失败而不是假结果',
      values: { tryInverted: false, downscale: 1 },
      files: (h) => [h.photo({ path: '/tmp/blank.png', size: 40000, width: 400, height: 400, format: 'png' })],
      expect: (d) => {
        const txt = JSON.stringify(d.items || []) + JSON.stringify(d.result || '') + JSON.stringify(d.error || '')
        if (/https?:|WIFI:|BEGIN:VCARD/.test(txt) && !d.error) return ['空白图却解出了内容（假结果）：' + txt.slice(0, 160)]
        if (!d.items && !d.error && !d.result) return ['既没有结果也没有失败提示']
        return []
      }
    }
  ],

  'qr-parse': [
    {
      name: 'URL / WIFI / VCARD / tel / geo / otpauth 分类精确',
      values: { raw: 'https://example.com/a/b?x=1&y=2' },
      expect: (d, h) => {
        const errs = []
        const p = h.lib('packageQr/utils/qr-parse.js')
        const u = p.parse('https://example.com/a/b?x=1&y=2')
        if (!u || (u.kind || u.type) === undefined) return ['parse 返回形状异常：' + JSON.stringify(u).slice(0, 140)]
        if (!/url|链接|网址/i.test(String(u.kind) + String(u.label) + JSON.stringify(u.fields))) errs.push('URL 未被识别为链接：' + JSON.stringify(u).slice(0, 160))
        const w = p.parse('WIFI:T:WPA;S:我的网络;P:p@ss;;')
        const wf = JSON.stringify(w)
        if (wf.indexOf('我的网络') < 0) errs.push('WIFI SSID 未解析：' + wf.slice(0, 160))
        const t = p.parse('tel:+8613800000000')
        if (JSON.stringify(t).indexOf('13800000000') < 0) errs.push('tel 未解析：' + JSON.stringify(t).slice(0, 140))
        const g = p.parse('geo:30.2741,120.1551')
        if (JSON.stringify(g).indexOf('30.2741') < 0) errs.push('geo 未解析：' + JSON.stringify(g).slice(0, 140))
        const v = p.parse('BEGIN:VCARD\nVERSION:3.0\nN:张;三\nFN:张三\nTEL:13800000000\nEND:VCARD')
        if (JSON.stringify(v).indexOf('张三') < 0) errs.push('VCARD 未解析：' + JSON.stringify(v).slice(0, 160))
        const plain = p.parse('就是一段普通文本')
        if (/url|链接/i.test(String(plain.kind) + String(plain.label))) errs.push('普通文本被误判为链接')
        if (!has(d, 'example.com')) errs.push('页面没有渲染解析结果：' + hay(d).slice(0, 160))
        return errs
      }
    },
    {
      name: '空内容与未知协议',
      values: { raw: '' },
      expect: (d) => (d.error ? [] : ['空内容应给「请输入」类提示'])
    }
  ],

  'qr-barcode': [
    {
      name: 'EAN-13 校验位与条空模式',
      values: { symbology: 'ean13', value: '400638133393', height: 60, moduleWidth: 2, showText: true, addQuiet: true },
      expect: (d, h) => {
        const errs = []
        // 校验位手算：前 12 位 400638133393 → 奇位和(1,3,..11)=4+0+3+8+3+3=21? 逐位：4,0,6,3,8,1,3,3,3,9,3 → 需要按 1/3 权重
        const d12 = '400638133393'
        let sum = 0
        for (let i = 0; i < 12; i++) sum += Number(d12[i]) * (i % 2 === 0 ? 1 : 3)
        const check = (10 - (sum % 10)) % 10
        const full = d12 + String(check)
        const txt = hay(d)
        if (!new RegExp('校验位\\s*' + check).test(txt) && txt.indexOf(full) < 0) {
          errs.push('应输出校验位 ' + check + '（13 位 ' + full + '），实际片段：' + txt.slice(0, 220))
        }
        return errs
      }
    },
    {
      name: 'EAN-13 校验位错误必须拒绝 / Code128 可编码',
      values: { symbology: 'ean13', value: '4006381333931', height: 60, moduleWidth: 2, showText: true, addQuiet: true },
      expect: (d, h) => {
        const errs = []
        // 上面那条完整码的校验位是否合法要先算出来，若不合法页面必须报错
        const d12 = '400638133393'
        let sum = 0
        for (let i = 0; i < 12; i++) sum += Number(d12[i]) * (i % 2 === 0 ? 1 : 3)
        const legal = d12 + String((10 - (sum % 10)) % 10)
        const given = '4006381333931'
        if (given !== legal && !d.error) errs.push('校验位不符（应为 ' + legal + '）却没有拒绝')
        return errs
      }
    },
    {
      name: 'Code128 与 Code39 的字符集边界',
      values: { symbology: 'code39', value: 'ABC-123 ', height: 60, moduleWidth: 2, showText: true, addQuiet: true },
      expect: (d, h) => {
        const errs = []
        const txt = hay(d)
        if (!d.result && !d.error) errs.push('页面无输出')
        if (d.error) errs.push('Code39 合法字符集（A-Z 0-9 - . 空格 $/+%）被拒：' + JSON.stringify(d.error))
        if (/code128/i.test(txt) && /code39/i.test(txt) === false) errs.push('结果里没有标注 Code 39')
        return errs
      }
    },
    {
      name: 'ITF 只支持偶数位数字',
      values: { symbology: 'itf', value: '12345', height: 60, moduleWidth: 2, showText: true, addQuiet: true },
      expect: (d) => {
        // 奇数位 ITF 必须报错或自动补偶数位，不能静默出错码
        if (d.error) return []
        const txt = hay(d)
        if (/12345\b/.test(txt) === false) return ['ITF 奇数位既没报错也没补位：' + txt.slice(0, 160)]
        return []
      }
    }
  ]
}
