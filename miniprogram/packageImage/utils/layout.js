/**
 * 图片几何计算（纯函数，可 node 直测）：裁剪输出映射 / 拼接排版 / 宫格切图 / 证件照规格。
 */

const RATIOS = {
  free: null,
  '1:1': 1,
  '4:3': 4 / 3,
  '3:4': 3 / 4,
  '16:9': 16 / 9,
  '9:16': 9 / 16,
  original: 'original'
}

/** '1:1' / 'a:b' / 数字 → 数值比例；free 返回 null */
function parseRatio(ratio, imageRatio) {
  if (!ratio || ratio === 'free') return null
  if (ratio === 'original' || ratio === 'raw') return imageRatio || null
  const s = String(ratio)
  if (s.indexOf(':') > 0) {
    const p = s.split(':')
    const a = Number(p[0])
    const b = Number(p[1])
    if (a > 0 && b > 0) return a / b
    return null
  }
  const n = Number(s)
  return n > 0 ? n : null
}

/**
 * 把屏幕上的选框换算为「源图像素矩形」。
 * @param {Object} sel 显示层选框 {x,y,w,h}（相对展示图，单位 px，可含负偏移）
 * @param {Object} view 展示图尺寸 {width,height}（同单位）
 * @param {Object} image 源图 {width,height}
 * @returns {{sx,sy,sw,sh}|null}
 */
function displayToSource(sel, view, image) {
  if (!sel || !view || !image) return null
  if (!(sel.w > 0) || !(sel.h > 0) || !(view.width > 0) || !(view.height > 0)) return null
  const kx = image.width / view.width
  const ky = image.height / view.height
  let sx = Math.round(sel.x * kx)
  let sy = Math.round(sel.y * ky)
  let sw = Math.round(sel.w * kx)
  let sh = Math.round(sel.h * ky)
  sx = Math.max(0, Math.min(image.width - 1, sx))
  sy = Math.max(0, Math.min(image.height - 1, sy))
  sw = Math.max(1, Math.min(image.width - sx, sw))
  sh = Math.max(1, Math.min(image.height - sy, sh))
  return { sx, sy, sw, sh }
}

/**
 * 计算裁剪导出尺寸：选 presetSize 时输出精确等于该尺寸；否则按选框的源像素尺寸（可限长边）。
 * @returns {{outWidth,outHeight,source,exact:boolean}}
 */
function cropOutput(sel, view, image, opt) {
  const o = opt || {}
  const source = displayToSource(sel, view, image)
  if (!source) return null
  if (o.outWidth > 0 && o.outHeight > 0) {
    return {
      outWidth: Math.max(1, Math.round(o.outWidth)),
      outHeight: Math.max(1, Math.round(o.outHeight)),
      source,
      exact: true
    }
  }
  const fit = fitWithinLongSide(source.sw, source.sh, o.maxSide || 0)
  return { outWidth: fit.width, outHeight: fit.height, source, exact: false }
}

function fitWithinLongSide(w, h, maxSide) {
  if (!maxSide || maxSide <= 0) return { width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)), scale: 1 }
  const long = Math.max(w, h)
  if (long <= maxSide) return { width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)), scale: 1 }
  const k = maxSide / long
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)), scale: k }
}

/**
 * 拼接排版。
 * @param {Array<{width,height}>} items 图片（顺序即拼接顺序）
 * @param {Object} opt {layout:'vertical'|'horizontal'|'grid'|'nine', gridCols, gap, padding, align, maxSide}
 * @returns {{canvasWidth,canvasHeight,cells:[{index,x,y,width,height,scale}],maxSideUsed,reduced}}
 */
function stitchPlan(items, opt) {
  const o = Object.assign({ layout: 'vertical', gridCols: 2, gap: 10, padding: 0, align: 'center', maxSide: 4096 }, opt || {})
  const list = (items || []).filter((it) => it && it.width > 0 && it.height > 0)
  if (!list.length) return null
  const layout = o.layout === 'nine' ? 'grid' : o.layout
  const cols = Math.max(1, Math.min(4, Math.round(o.gridCols || (o.layout === 'nine' ? 3 : 2))))
  const gap = Math.max(0, Math.round(o.gap))
  const pad = Math.max(0, Math.round(o.padding))
  const maxSide = Math.max(256, Math.round(o.maxSide || 4096))

  // 基准边：所有图最短边的最小值 → 等比归一，避免变形
  const baseShort = Math.min.apply(null, list.map((it) => Math.min(it.width, it.height)))
  const scales = list.map((it) => (baseShort > 0 ? baseShort / Math.min(it.width, it.height) : 1))
  const sized = list.map((it, i) => ({
    index: i,
    width: Math.max(1, Math.round(it.width * scales[i])),
    height: Math.max(1, Math.round(it.height * scales[i])),
    scale: scales[i]
  }))

  let cw = 0
  let chh = 0
  const cells = []
  if (layout === 'horizontal') {
    const maxH = Math.max.apply(null, sized.map((s) => s.height))
    cw = sized.reduce((a, s) => a + s.width, 0) + gap * (sized.length - 1)
    chh = maxH
    let x = 0
    sized.forEach((s) => {
      const y = o.align === 'start' ? 0 : o.align === 'end' ? maxH - s.height : Math.round((maxH - s.height) / 2)
      cells.push({ index: s.index, x, y, width: s.width, height: s.height, scale: s.scale })
      x += s.width + gap
    })
  } else if (layout === 'vertical') {
    const maxW = Math.max.apply(null, sized.map((s) => s.width))
    chh = sized.reduce((a, s) => a + s.height, 0) + gap * (sized.length - 1)
    cw = maxW
    let y = 0
    sized.forEach((s) => {
      const x = o.align === 'start' ? 0 : o.align === 'end' ? maxW - s.width : Math.round((maxW - s.width) / 2)
      cells.push({ index: s.index, x, y, width: s.width, height: s.height, scale: s.scale })
      y += s.height + gap
    })
  } else {
    // grid：列宽取该列最大、行高取该行最大，图片按比例放入，不变形
    const rows = Math.ceil(sized.length / cols)
    const rowH = []
    const colW = []
    sized.forEach((s, i) => {
      const r = Math.floor(i / cols)
      const c = i % cols
      rowH[r] = Math.max(rowH[r] || 0, s.height)
      colW[c] = Math.max(colW[c] || 0, s.width)
    })
    cw = colW.slice(0, cols).reduce((a, v) => a + (v || 0), 0) + gap * (cols - 1)
    chh = rowH.reduce((a, v) => a + (v || 0), 0) + gap * (rows - 1)
    sized.forEach((s, i) => {
      const r = Math.floor(i / cols)
      const c = i % cols
      let x = 0
      for (let k = 0; k < c; k++) x += colW[k] + gap
      let y = 0
      for (let k = 0; k < r; k++) y += rowH[k] + gap
      const ox = o.align === 'start' ? 0 : o.align === 'end' ? colW[c] - s.width : Math.round((colW[c] - s.width) / 2)
      const oy = o.align === 'start' ? 0 : o.align === 'end' ? rowH[r] - s.height : Math.round((rowH[r] - s.height) / 2)
      cells.push({ index: s.index, x: x + ox, y: y + oy, width: s.width, height: s.height, scale: s.scale })
    })
  }

  // 统一加 padding，再按 maxSide / 16M 像素上限整体等比降尺度
  let f = 1
  const rawLong = Math.max(cw, chh) + pad * 2
  const rawPixels = (cw + pad * 2) * (chh + pad * 2)
  if (rawLong > maxSide) f = Math.min(f, maxSide / rawLong)
  if (rawPixels * f * f > 16000000) f = Math.min(f, Math.sqrt(16000000 / rawPixels))
  const reduced = f < 1

  const outCells = cells.map((c) => ({
    index: c.index,
    x: Math.max(0, Math.round((c.x + pad) * f)),
    y: Math.max(0, Math.round((c.y + pad) * f)),
    width: Math.max(1, Math.round(c.width * f)),
    height: Math.max(1, Math.round(c.height * f)),
    scale: c.scale * f
  }))
  const canvasWidth = Math.max(1, Math.round((cw + pad * 2) * f))
  const canvasHeight = Math.max(1, Math.round((chh + pad * 2) * f))
  return {
    canvasWidth,
    canvasHeight,
    cells: outCells,
    maxSideUsed: Math.min(maxSide, Math.max(canvasWidth, canvasHeight)),
    reduced,
    pixels: canvasWidth * canvasHeight,
    naturalWidth: cw + pad * 2,
    naturalHeight: chh + pad * 2
  }
}

/**
 * 宫格切图：cols×rows，子图尺寸严格一致；fillEdge=true 时居中裁切保证每格比例相同。
 * @returns {{cellWidth,cellHeight,cells:[{index,sx,sy,sw,sh,outWidth,outHeight}]}}
 */
function gridPlan(imageW, imageH, cols, rows, fillEdge) {
  const c = Math.max(1, Math.min(4, Math.round(cols || 3)))
  const r = Math.max(1, Math.min(4, Math.round(rows || 3)))
  if (!(imageW > 0) || !(imageH > 0)) return null
  const cellW = Math.floor(imageW / c)
  const cellH = Math.floor(imageH / r)
  if (cellW < 1 || cellH < 1) return null

  const uniform = fillEdge === false
  // fillEdge=true：每格裁成同一正方形（边长 = min(cellW, cellH)）居中裁切，保证子图尺寸完全一致
  const side = Math.min(cellW, cellH)
  const targetW = uniform ? cellW : side
  const targetH = uniform ? cellH : side

  const cells = []
  for (let y = 0; y < r; y++) {
    for (let x = 0; x < c; x++) {
      const srcX = x * cellW
      const srcY = y * cellH
      let sw = cellW
      let sh = cellH
      if (!uniform) {
        // 居中裁到同一比例，边缘不足不外扩
        const ratio = targetW / targetH
        if (cellW / cellH > ratio) {
          sw = Math.round(cellH * ratio)
        } else {
          sh = Math.round(cellW / ratio)
        }
        sw = Math.min(sw, imageW - srcX)
        sh = Math.min(sh, imageH - srcY)
      }
      const offX = Math.round((cellW - sw) / 2)
      const offY = Math.round((cellH - sh) / 2)
      cells.push({
        index: cells.length, // 行优先（朋友圈九宫格顺序）
        sx: srcX + offX,
        sy: srcY + offY,
        sw,
        sh,
        outWidth: uniform ? sw : targetW,
        outHeight: uniform ? sh : targetH,
        row: y,
        col: x
      })
    }
  }
  return {
    cellWidth: uniform ? cellW : targetW,
    cellHeight: uniform ? cellH : targetH,
    cols: c,
    rows: r,
    cells,
    edgeTrim: !uniform
  }
}

/** 证件照规格表：px 为准，mm 由 dpi 换算展示 */
const ID_SPECS = [
  { id: 'small-1inch', name: '小一寸', width: 260, height: 378, mm: [22, 32], dpi: 300 },
  { id: '1inch', name: '一寸', width: 295, height: 413, mm: [25, 35], dpi: 300 },
  { id: 'big-2inch', name: '大二寸', width: 413, height: 579, mm: [35, 49], dpi: 300 },
  { id: 'passport', name: '护照', width: 390, height: 567, mm: [33, 48], dpi: 300 },
  { id: 'usa-visa', name: '美签', width: 378, height: 378, mm: [51, 51], dpi: 150 },
  { id: 'japan-visa', name: '日签', width: 295, height: 413, mm: [45, 45], dpi: 300 },
  { id: 'resume', name: '简历照', width: 295, height: 413, mm: [25, 35], dpi: 300 }
]

function findSpec(id) {
  for (let i = 0; i < ID_SPECS.length; i++) {
    if (ID_SPECS[i].id === id) return ID_SPECS[i]
  }
  return null
}

/** mm ↔ px（@dpi） */
function mmToPx(mm, dpi) {
  return Math.round((Number(mm) || 0) * ((Number(dpi) || 300) / 25.4))
}

function pxToMm(px, dpi) {
  return Math.round(((Number(px) || 0) * 25.4) / (Number(dpi) || 300) * 10) / 10
}

/** 证件照底色预设 */
const ID_BG = {
  white: '#FFFFFF',
  blue: '#438EDB',
  red: '#C8102E'
}

/** 选框在图内可拖动的边界约束（保持比例） */
function constrainBox(box, bounds, ratio) {
  const b = Object.assign({}, box)
  const maxW = bounds.width
  const maxH = bounds.height
  if (ratio) {
    let w = Math.min(maxW, b.w)
    let h = Math.round(w / ratio)
    if (h > maxH) {
      h = maxH
      w = Math.round(h * ratio)
    }
    b.w = Math.max(24, w)
    b.h = Math.max(24, h)
  }
  b.w = Math.min(b.w, maxW)
  b.h = Math.min(b.h, maxH)
  b.x = Math.max(0, Math.min(b.x, maxW - b.w))
  b.y = Math.max(0, Math.min(b.y, maxH - b.h))
  return b
}

/**
 * 裁剪取景 → 输出画布的仿射矩阵（按输出像素精确渲染，避免屏宽缩放失真）。
 * 显示层模型：图片中心 center_img（源像素）经 flip → rotate(rot) → 缩放 sU → 平移到 C（视口坐标）。
 * 输出层：视口选框 F 映射到 [0,outW]×[0,outH]。
 * @param {Object} st {imageWidth,imageHeight,rotate,flipH,flipV,zoom,panX,panY,baseScale,viewWidth,viewHeight,frame:{x,y,w,h}}
 * @param {number} outW 输出宽（px）
 * @param {number} outH 输出高（px）
 * @returns {null|{a,b,c,d,e,f,scaleX,scaleY,sourceWidth,sourceHeight}}
 */
function cropMatrix(st, outW, outH) {
  const iw = Number(st.imageWidth)
  const ih = Number(st.imageHeight)
  const frame = st.frame
  if (!(iw > 0) || !(ih > 0) || !frame || !(frame.w > 0) || !(frame.h > 0) || !(outW > 0) || !(outH > 0)) {
    return null
  }
  const sU = (Number(st.baseScale) || 1) * (Number(st.zoom) || 1)
  if (!(sU > 0)) return null
  const rot = ((Number(st.rotate) || 0) % 360 + 360) % 360
  const th = (rot * Math.PI) / 180
  const cos = Math.cos(th)
  const sin = Math.sin(th)
  const fh = st.flipH ? -1 : 1
  const fv = st.flipV ? -1 : 1

  // A = sU * R(rot) * diag(fh, fv)
  const a11 = sU * cos * fh
  const a12 = sU * -sin * fv
  const a21 = sU * sin * fh
  const a22 = sU * cos * fv

  const cx = (Number(st.viewWidth) || 0) / 2 + (Number(st.panX) || 0)
  const cy = (Number(st.viewHeight) || 0) / 2 + (Number(st.panY) || 0)
  const sx = frame.w / outW
  const sy = frame.h / outH
  const cimg = { x: iw / 2, y: ih / 2 }
  const acx = a11 * cimg.x + a12 * cimg.y
  const acy = a21 * cimg.x + a22 * cimg.y

  return {
    a: a11 / sx,
    b: a21 / sx,
    c: a12 / sy,
    d: a22 / sy,
    e: (cx - frame.x - acx) / sx,
    f: (cy - frame.y - acy) / sy,
    scaleX: sx,
    scaleY: sy,
    // 选框对应的源像素尺寸（用于展示与比例校验）
    sourceWidth: Math.round(frame.w / sU),
    sourceHeight: Math.round(frame.h / sU)
  }
}

/** 取景是否越界（旋转后的图片包围盒需覆盖选框，避免黑边） */
function coversFrame(st) {
  const m = cropMatrix(st, 100, 100)
  if (!m) return false
  const iw = st.imageWidth
  const ih = st.imageHeight
  const rot = ((Number(st.rotate) || 0) % 360 + 360) % 360
  const th = (rot * Math.PI) / 180
  const cos = Math.abs(Math.cos(th))
  const sin = Math.abs(Math.sin(th))
  const boxW = (cos * iw + sin * ih) * (st.baseScale || 1) * (st.zoom || 1)
  const boxH = (sin * iw + cos * ih) * (st.baseScale || 1) * (st.zoom || 1)
  return boxW >= st.frame.w - 1 && boxH >= st.frame.h - 1 && m.scaleX > 0
}

module.exports = {
  RATIOS,
  parseRatio,
  displayToSource,
  cropOutput,
  fitWithinLongSide,
  stitchPlan,
  gridPlan,
  ID_SPECS,
  findSpec,
  ID_BG,
  mmToPx,
  pxToMm,
  constrainBox,
  cropMatrix,
  coversFrame
}
