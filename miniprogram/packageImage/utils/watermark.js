/**
 * 水印绘制（FR-IMG-05）：文字 / logo，九宫格定位 + 平铺（平铺需超出画布一圈，边缘不得留空）。
 * 字号按「短边百分比」换算，保证不同尺寸图片观感一致。
 */

const POSITIONS = {
  tl: { x: 0, y: 0 },
  tc: { x: 0.5, y: 0 },
  tr: { x: 1, y: 0 },
  ml: { x: 0, y: 0.5 },
  mc: { x: 0.5, y: 0.5 },
  mr: { x: 1, y: 0.5 },
  bl: { x: 0, y: 1 },
  bc: { x: 0.5, y: 1 },
  br: { x: 1, y: 1 }
}

/** 字号：slider 给的是「短边千分数基准」→ px。以短边 1000px 为 32px 参照，等价于短边 3.2% */
function fontSizePx(shortSide, slider, min) {
  const base = Math.max(10, Math.min(200, Number(slider) || 32))
  const px = (shortSide * base) / 1000
  return Math.max(min || 8, Math.round(px))
}

/** logo 宽度：相对图宽百分比 5–60 */
function logoWidthPx(width, percent) {
  const p = Math.max(5, Math.min(60, Number(percent) || 20))
  return Math.max(16, Math.round((width * p) / 100))
}

function anchorFor(pos) {
  return POSITIONS[pos] || POSITIONS.br
}

/**
 * 计算水印块（文字或 logo）在画布上的左上角坐标。
 * @param {number} blockW 块宽
 * @param {number} blockH 块高
 * @param {number} margin 外边距（画布 px）
 */
function placeBlock(canvasW, canvasH, blockW, blockH, pos, margin) {
  const a = anchorFor(pos)
  const m = Math.max(0, Number(margin) || 0)
  const x = a.x * (canvasW - blockW)
  const y = a.y * (canvasH - blockH)
  // 贴边时补 margin，居中位置不加
  return {
    x: Math.round(x + (a.x === 0 ? m : a.x === 1 ? -m : 0)),
    y: Math.round(y + (a.y === 0 ? m : a.y === 1 ? -m : 0))
  }
}

/** 单行/多行文字块尺寸 */
function measureText(ctx, text, fontSize, lines) {
  const arr = String(text || '').split('\n')
  let w = 0
  arr.forEach((t) => {
    const m = ctx.measureText(t)
    if (m && m.width > w) w = m.width
  })
  const lh = fontSize * 1.35
  return { width: Math.ceil(w), height: Math.ceil(lh * arr.length), lines: arr.length, lineHeight: lh }
}

/**
 * 绘制文字水印。
 * @param {Object} ctx canvas 2d context
 * @param {Object} opt {text,fontSize,color,opacity,stroke,strokeWidth,shadow,position,margin,
 *                      tile,tileAngle,tileGap,width,height}
 */
function drawTextWatermark(ctx, opt) {
  const text = String(opt.text || '')
  if (!text) return
  const fs = Math.max(8, Math.round(opt.fontSize))
  const alpha = Math.max(0.1, Math.min(1, (Number(opt.opacity) || 60) / 100))
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.font = fs + 'px -apple-system, "PingFang SC", sans-serif'
  ctx.textBaseline = 'top'
  ctx.fillStyle = opt.color || '#FFFFFF'

  const box = measureText(ctx, text, fs)

  const paint = (x, y) => {
    const lines = text.split('\n')
    lines.forEach((line, i) => {
      const ly = y + i * box.height / lines.length
      if (opt.shadow) {
        ctx.shadowColor = 'rgba(0,0,0,.45)'
        ctx.shadowBlur = Math.max(2, fs * 0.18)
        ctx.shadowOffsetX = Math.max(1, fs * 0.05)
        ctx.shadowOffsetY = Math.max(1, fs * 0.05)
      } else {
        ctx.shadowColor = 'transparent'
        ctx.shadowBlur = 0
        ctx.shadowOffsetX = 0
        ctx.shadowOffsetY = 0
      }
      if (opt.stroke) {
        ctx.lineJoin = 'round'
        ctx.lineWidth = Math.max(1, Number(opt.strokeWidth) || 2)
        ctx.strokeStyle = 'rgba(0,0,0,.6)'
        ctx.strokeText(line, x, ly)
      }
      ctx.fillText(line, x, ly)
    })
  }

  if (opt.tile) {
    // 平铺：绘制范围超出画布一圈（-2W..2W），保证边缘无空缺
    const angle = Math.max(-90, Math.min(90, Number(opt.tileAngle) || -30)) * (Math.PI / 180)
    const gapX = Math.max(20, Number(opt.tileGap) || 120) + box.width
    const gapY = Math.max(20, Number(opt.tileGap) || 120) + box.height
    ctx.translate(opt.width / 2, opt.height / 2)
    ctx.rotate(angle)
    const span = Math.ceil(Math.sqrt(opt.width * opt.width + opt.height * opt.height)) + gapX
    for (let y = -span; y <= span; y += gapY) {
      for (let x = -span; x <= span; x += gapX) {
        paint(x, y)
      }
    }
  } else {
    const p = placeBlock(opt.width, opt.height, box.width, box.height, opt.position, opt.margin)
    paint(p.x, p.y)
  }
  ctx.restore()
}

/**
 * 绘制 logo 水印。
 * @param {Object} opt 含 logoNode（media.loadImage 结果）、width/height、logoScale、position/margin、opacity、tile、tileGap、tileAngle
 */
function drawLogoWatermark(ctx, opt) {
  const node = opt.logoNode
  if (!node) return
  const w = logoWidthPx(opt.width, opt.logoScale)
  const h = Math.max(1, Math.round((w * (node.height || 1)) / (node.width || 1)))
  const alpha = Math.max(0.1, Math.min(1, (Number(opt.opacity) || 100) / 100))
  ctx.save()
  ctx.globalAlpha = alpha
  if (opt.tile) {
    const gapX = Math.max(10, Number(opt.tileGap) || 120) + w
    const gapY = Math.max(10, Number(opt.tileGap) || 120) + h
    const angle = Math.max(-90, Math.min(90, Number(opt.tileAngle) || 0)) * (Math.PI / 180)
    ctx.translate(opt.width / 2, opt.height / 2)
    ctx.rotate(angle)
    const span = Math.ceil(Math.sqrt(opt.width * opt.width + opt.height * opt.height)) + gapX
    for (let y = -span; y <= span; y += gapY) {
      for (let x = -span; x <= span; x += gapX) {
        ctx.drawImage(node, x, y, w, h)
      }
    }
  } else {
    const p = placeBlock(opt.width, opt.height, w, h, opt.position, opt.margin)
    ctx.drawImage(node, p.x, p.y, w, h)
  }
  ctx.restore()
}

/** 统一入口：type='text'|'logo' */
function apply(ctx, opt) {
  if (opt.type === 'logo') drawLogoWatermark(ctx, opt)
  else drawTextWatermark(ctx, opt)
}

module.exports = {
  POSITIONS,
  fontSizePx,
  logoWidthPx,
  placeBlock,
  measureText,
  drawTextWatermark,
  drawLogoWatermark,
  apply
}
