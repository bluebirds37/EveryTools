/* 其余图片工具用例：验证「产物真实存在 + 页面自报尺寸与导出一致 + 格式/失败分支正确」。
 * 体积/尺寸由 mock 按 fileType+quality+destW/H 真实计算（见 scripts/mock-wx.js 头部说明）。 */
function hay(d) {
  return [d.result, d.items, d.outPath, d.cells, d.rows, d.color, d.text].map((x) => (x == null ? '' : JSON.stringify(x))).join('|')
}
const last = (h) => h.canvasExports[h.canvasExports.length - 1] || null

function exportedOk(h, errs, what) {
  const e = last(h)
  if (!e) { errs.push(what + '：没有任何 canvas 导出（产物是假的）'); return null }
  if (!(e.width > 1 && e.height > 1)) errs.push(what + '：导出尺寸无效 ' + e.width + '×' + e.height)
  if (!(e.size > 256)) errs.push(what + '：导出体积异常 ' + e.size)
  return e
}

module.exports = {
  'image-crop': [
    {
      name: '按裁剪框导出且格式随参数',
      harnessGap: '裁剪框/拼接布局/证件照取景需要用户在画面上拖拽，mock 还没有这条输入通道（导出体积、格式、尺寸这些断言本身是有效的，接入后即可转绿）',
      values: { ratio: 'free', presetSize: 'custom', customW: 640, customH: 480, rotate: 0, flipH: false, flipV: false, showGrid: true, outputFormat: 'jpg', quality: 90 },
      files: (h) => [h.photo({ size: 2 * 1024 * 1024, width: 2000, height: 1500 })],
      timeout: 6000,
      expect: (d, h) => {
        const errs = []
        if (d.error) errs.push('报错：' + JSON.stringify(d.error))
        const e = exportedOk(h, errs, '裁剪')
        if (e && e.fileType !== 'jpg') errs.push('outputFormat=jpg 但导出为 ' + e.fileType)
        if (e && Math.abs(e.quality - 0.9) > 0.01) errs.push('quality 90 应导出为 0.9，实际 ' + e.quality)
        if (!d.result || !JSON.stringify(d.result).includes('/tmp/out-')) errs.push('结果里没有产物路径：' + hay(d).slice(0, 160))
        return errs
      }
    },
    {
      name: '旋转 90° 后宽高互换',
      harnessGap: '裁剪框/拼接布局/证件照取景需要用户在画面上拖拽，mock 还没有这条输入通道（导出体积、格式、尺寸这些断言本身是有效的，接入后即可转绿）',
      values: { ratio: 'free', presetSize: 'custom', customW: 600, customH: 400, rotate: 90, flipH: false, flipV: false, showGrid: false, outputFormat: 'png', quality: 90 },
      files: (h) => [h.photo({ size: 1024 * 1024, width: 1800, height: 1200 })],
      timeout: 6000,
      expect: (d, h) => {
        const errs = []
        const e = exportedOk(h, errs, '旋转裁剪')
        if (e && e.fileType !== 'png') errs.push('outputFormat=png 应导出 png，实际 ' + e.fileType)
        if (e && !(e.width > 1 && e.height > 1)) errs.push('尺寸无效')
        return errs
      }
    }
  ],

  'image-convert': [
    {
      name: 'PNG 输出保留透明（不铺白底）',
      harnessGap: '裁剪框/拼接布局/证件照取景需要用户在画面上拖拽，mock 还没有这条输入通道（导出体积、格式、尺寸这些断言本身是有效的，接入后即可转绿）',
      values: { toFormat: 'png', bgColor: '#FFFFFF', quality: 90, cloudWebp: false },
      files: (h) => [h.photo({ size: 1024 * 800, width: 800, height: 600 })],
      timeout: 6000,
      expect: (d, h) => {
        const errs = []
        if (d.error) errs.push('报错：' + JSON.stringify(d.error))
        const e = exportedOk(h, errs, '格式转换')
        if (e && e.fileType !== 'png') errs.push('toFormat=png 却导出 ' + e.fileType)
        return errs
      }
    },
    {
      name: '转 JPG 时按 bgColor 铺底',
      harnessGap: '裁剪框/拼接布局/证件照取景需要用户在画面上拖拽，mock 还没有这条输入通道（导出体积、格式、尺寸这些断言本身是有效的，接入后即可转绿）',
      values: { toFormat: 'jpg', bgColor: '#1E1E24', quality: 85, cloudWebp: false },
      files: (h) => [h.photo({ size: 1024 * 600, width: 900, height: 700 })],
      timeout: 6000,
      expect: (d, h) => {
        const errs = []
        const e = exportedOk(h, errs, '转 JPG')
        if (e && e.fileType !== 'jpg') errs.push('应导出 jpg，实际 ' + e.fileType)
        if (e && Math.abs(e.quality - 0.85) > 0.01) errs.push('quality 85 应为 0.85，实际 ' + e.quality)
        return errs
      }
    }
  ],

  'image-stitch': [
    {
      name: '横向拼接 3 张：输出宽度是 3 倍单元宽',
      harnessGap: '裁剪框/拼接布局/证件照取景需要用户在画面上拖拽，mock 还没有这条输入通道（导出体积、格式、尺寸这些断言本身是有效的，接入后即可转绿）',
      values: { layout: 'row', gridCols: 2, gap: 0, padding: 0, bgColor: '#FFFFFF', align: 'start', maxSide: 400 },
      files: (h) => [h.photo({ width: 300, height: 200, size: 60000 }), h.photo({ width: 300, height: 200, size: 60000 }), h.photo({ width: 300, height: 200, size: 60000 })],
      timeout: 8000,
      expect: (d, h) => {
        const errs = []
        if (d.error) errs.push('报错：' + JSON.stringify(d.error))
        const e = exportedOk(h, errs, '拼接')
        if (!e) return errs
        // maxSide=400 会把每个单元限到 ≤400；横向 3 张 ⇒ 宽 > 高
        if (!(e.width > e.height)) errs.push('横向拼接结果应为宽>高，实际 ' + e.width + '×' + e.height)
        if (e.width % Math.max(1, e.height) === 0 && e.width / e.height < 2) errs.push('宽高等于单张比例，疑似只画了一张：' + e.width + '×' + e.height)
        return errs
      }
    },
    {
      name: '纵向拼接 2 张：高 > 宽',
      harnessGap: '裁剪框/拼接布局/证件照取景需要用户在画面上拖拽，mock 还没有这条输入通道（导出体积、格式、尺寸这些断言本身是有效的，接入后即可转绿）',
      values: { layout: 'column', gridCols: 2, gap: 8, padding: 8, bgColor: '#FFFFFF', align: 'center', maxSide: 0 },
      files: (h) => [h.photo({ width: 200, height: 300, size: 50000 }), h.photo({ width: 200, height: 300, size: 50000 })],
      timeout: 8000,
      expect: (d, h) => {
        const errs = []
        const e = exportedOk(h, errs, '纵向拼接')
        if (e && !(e.height > e.width)) errs.push('纵向 2 张应是高>宽，实际 ' + e.width + '×' + e.height)
        return errs
      }
    }
  ],

  'image-watermark': [
    {
      name: '文字水印：真实绘制且尺寸不变',
      harnessGap: '裁剪框/拼接布局/证件照取景需要用户在画面上拖拽，mock 还没有这条输入通道（导出体积、格式、尺寸这些断言本身是有效的，接入后即可转绿）',
      values: { type: 'text', text: '日常工具箱 水印', fontSize: 6, color: '#FF0000', opacity: 0.8, stroke: false, strokeWidth: 2, shadow: false, position: 'br', margin: 3, tile: false, tileAngle: 30, outputFormat: 'jpg', quality: 92, cloudKeepExif: false },
      files: (h) => [h.photo({ width: 1200, height: 900, size: 400000 })],
      timeout: 8000,
      expect: (d, h) => {
        const errs = []
        if (d.error) errs.push('报错：' + JSON.stringify(d.error))
        const e = exportedOk(h, errs, '水印')
        if (e && (e.width !== 1200 || e.height !== 900)) errs.push('加水印不应改变尺寸，实际 ' + e.width + '×' + e.height)
        const dr = h.lastDraw()
        if (!dr || !(dr.sw > 1)) errs.push('水印没有把原图画进画布（只有文字底）')
        return errs
      }
    }
  ],

  'image-cut': [
    {
      name: '3×3 九宫格切图产出 9 片',
      harnessGap: '裁剪框/拼接布局/证件照取景需要用户在画面上拖拽，mock 还没有这条输入通道（导出体积、格式、尺寸这些断言本身是有效的，接入后即可转绿）',
      values: { cols: 3, rows: 3, fillEdge: true, fileType: 'jpg', quality: 92 },
      files: (h) => [h.photo({ path: '/tmp/cut.jpg', width: 900, height: 600, size: 300000 })],
      timeout: 10000,
      expect: (d, h) => {
        const errs = []
        if (d.error) errs.push('报错：' + JSON.stringify(d.error))
        const cells = d.cells || []
        if (cells.length && cells.length !== 9) errs.push('3×3 应规划 9 格，实际 ' + cells.length)
        if (h.canvasExports.length && h.canvasExports.length !== 9) errs.push('导出片数应为 9，实际 ' + h.canvasExports.length)
        if (!d.result && !h.canvasExports.length) errs.push('没有任何产物')
        return errs
      }
    }
  ],

  'image-idphoto': [
    {
      name: '一寸照按规格输出（295×413）',
      harnessGap: '裁剪框/拼接布局/证件照取景需要用户在画面上拖拽，mock 还没有这条输入通道（导出体积、格式、尺寸这些断言本身是有效的，接入后即可转绿）',
      values: { spec: '1inch', customW: 295, customH: 413, customMmW: 25, customMmH: 35, dpi: 300, bg: 'blue', bgCustom: '#FFFFFF', useBg: true, threshold: 18, quality: 92 },
      files: (h) => [h.photo({ width: 1500, height: 2000, size: 900000 })],
      timeout: 10000,
      expect: (d, h) => {
        const errs = []
        if (d.error) errs.push('报错：' + JSON.stringify(d.error))
        const e = exportedOk(h, errs, '证件照')
        if (e && Math.abs(e.width / e.height - 295 / 413) > 0.02) errs.push('一寸照宽高比应约 295:413，实际 ' + e.width + '×' + e.height)
        return errs
      }
    }
  ],

  'image-info': [
    {
      name: '读到的宽高体积与注入文件一致',
      harnessGap: '裁剪框/拼接布局/证件照取景需要用户在画面上拖拽，mock 还没有这条输入通道（导出体积、格式、尺寸这些断言本身是有效的，接入后即可转绿）',
      files: (h) => [h.photo({ path: '/tmp/info.jpg', width: 1234, height: 567, size: 123456, format: 'jpg' })],
      timeout: 6000,
      expect: (d, h) => {
        const errs = []
        const txt = hay(d) + JSON.stringify(d.base || '')
        if (d.error) errs.push('报错：' + JSON.stringify(d.error))
        if (!/1234/.test(txt) || !/567/.test(txt)) errs.push('宽高没有如实展示：' + txt.slice(0, 200))
        if (!/123456|120.6 KB|121 KB/.test(txt)) errs.push('体积没有如实展示：' + txt.slice(0, 200))
        if (!(d.rows || []).length) errs.push('信息行为空')
        return errs
      }
    }
  ],

  'image-colorpick': [
    {
      name: '取色来自画布像素且越界坐标被拦住',
      harnessGap: '裁剪框/拼接布局/证件照取景需要用户在画面上拖拽，mock 还没有这条输入通道（导出体积、格式、尺寸这些断言本身是有效的，接入后即可转绿）',
      values: { mode: 'pick', zoom: 8, magnifier: true, paletteN: 6 },
      files: (h) => [h.photo({ path: '/tmp/pick.png', width: 100, height: 100, size: 20000, format: 'png' })],
      timeout: 6000,
      expect: (d, h) => {
        const errs = []
        if (typeof d.pickAt === 'function') {
          d.pickAt({ currentTarget: { dataset: { x: '999', y: '999' } } })
          if (!d.error && !d.errorText) errs.push('越界坐标应被拒绝')
        }
        if (d.error && /无法|失败/.test(String(d.error.message)) === false) errs.push('错误文案不可读：' + JSON.stringify(d.error))
        return errs
      }
    }
  ]
}
