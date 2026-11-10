/**
 * utils/media.js —— 图片引擎公共 API（CONTRACT C3）
 * 底座原语在 utils/canvas2d.js（C1 单文件 ≤400 行，故拆分），本文件只负责：
 *   exportCanvas / drawToCanvas / compressToJpeg（二分搜索质量 + 必要时降采样）
 * canvas.toDataURL 在小程序 2d canvas 上不可用 → 导出统一走 wx.canvasToTempFilePath。
 * 导出格式白名单：jpg / png / webp；处理完把 canvas 置 1×1 释放内存。
 */

const error = require('./error')
const c = require('./canvas2d')

const DOWNSCALE_STEPS = [1, 0.8, 0.64, 0.5, 0.4]

/**
 * 导出 canvas 到临时文件（完成后默认把 canvas 置 1×1 释放内存）
 * @param {any} canvas
 * @param {{fileType?:string, quality?:number, width?:number, height?:number, autoRelease?:boolean}} [opts]
 * @returns {Promise<{path,size,width,height,fileType}>}
 */
function exportCanvas(canvas, opts) {
  const o = opts || {}
  let fileType
  try {
    fileType = c.normalizeFileType(o.fileType || 'jpg')
  } catch (e) {
    return Promise.reject(e)
  }
  if (!canvas) return Promise.reject(error.make(error.CODES.ENGINE_UNAVAILABLE, { reason: 'no canvas' }))
  if (!c.hasWx() || !wx.canvasToTempFilePath) return c.unavailable('canvasToTempFilePath')
  const width = Math.max(1, Math.round(o.width || canvas.width || 0))
  const height = Math.max(1, Math.round(o.height || canvas.height || 0))
  return new Promise(function (resolve, reject) {
    wx.canvasToTempFilePath({
      canvas: canvas,
      x: 0,
      y: 0,
      width: width,
      height: height,
      destWidth: width,
      destHeight: height,
      fileType: fileType,
      quality: c.qualityParam(o.quality == null ? 0.9 : o.quality),
      success: function (res) {
        const path = res && res.tempFilePath
        if (!path) {
          reject(error.make(error.CODES.TASK_FAILED))
          return
        }
        c.fileSize(path).then(function (size) {
          if (o.autoRelease !== false) c.release(canvas)
          resolve({ path: path, size: Number(size) || 0, width: width, height: height, fileType: fileType })
        })
      },
      fail: function (e) {
        reject(error.normalize(e, error.CODES.IMAGE_TOO_BIG))
      }
    })
  })
}

function loadImageFor(canvas, p) {
  if (p.image) {
    return Promise.resolve({ width: Number(p.sourceWidth) || p.image.width || 0, height: Number(p.sourceHeight) || p.image.height || 0, node: p.image })
  }
  if (!p.path) return Promise.reject(error.make(error.CODES.INPUT_EMPTY))
  return c.loadImage(canvas, p.path)
}

/**
 * 通用绘制：解码 → 离屏绘制（含 transform）→ 可选 painter 叠加层 → 返回 canvas
 * painter 在基础图像绘制之后调用（水印/标注直接在上方画；需完全自绘时传 skipBaseDraw）
 * @param {{path?:string, image?:any, canvas?:any, canvasId?:string, scope?:any, width?:number, height?:number,
 *          maxSide?:number, bg?:string, skipBaseDraw?:boolean,
 *          transform?:{rotate?:number,flipH?:boolean,flipV?:boolean,scale?:number,offsetX?:number,offsetY?:number,clip?:{x,y,width,height}}}} params
 * @param {(ctx:object, info:{canvas,image,width,height,sourceWidth,sourceHeight})=>void} [painter]
 * @returns {Promise<any>} canvas
 */
function drawToCanvas(params, painter) {
  const p = params || {}
  const canvasStep = p.canvas && p.canvas.getContext ? Promise.resolve(p.canvas) : c.makeOffscreen(p.canvasId || c.DEFAULT_OFFSCREEN, p.scope)
  return canvasStep.then(function (canvas) {
    return loadImageFor(canvas, p).then(function (img) {
      return render(canvas, img, p, painter)
    })
  })
}

function render(canvas, img, p, painter) {
  const tr = p.transform || {}
  const rotate = ((Math.round(Number(tr.rotate) || 0) % 360) + 360) % 360
  let outW = Math.max(1, Math.round(p.width || img.width))
  let outH = Math.max(1, Math.round(p.height || img.height))
  if (p.maxSide) {
    const fit = c.fitInside(outW, outH, p.maxSide)
    outW = fit.width
    outH = fit.height
  }
  const swap = rotate === 90 || rotate === 270
  const px = c.pixelScale(swap ? outH : outW, swap ? outW : outH)
  if (px < 1) {
    outW = Math.max(1, Math.round(outW * px))
    outH = Math.max(1, Math.round(outH * px))
  }
  const drawW = swap ? outH : outW
  const drawH = swap ? outW : outH

  const pre = c.prepare(canvas, outW, outH, p.bg)
  if (!p.skipBaseDraw) {
    const ctx = pre.ctx
    ctx.save()
    ctx.translate(outW / 2 + (Number(tr.offsetX) || 0), outH / 2 + (Number(tr.offsetY) || 0))
    if (rotate) ctx.rotate((rotate * Math.PI) / 180)
    const zoom = Number(tr.scale) > 0 ? Number(tr.scale) : 1
    ctx.scale((tr.flipH ? -1 : 1) * zoom, (tr.flipV ? -1 : 1) * zoom)
    const clip = tr.clip
    if (clip && Number(clip.width) > 0 && Number(clip.height) > 0) {
      ctx.drawImage(img.node, Number(clip.x) || 0, Number(clip.y) || 0, Number(clip.width), Number(clip.height), -drawW / 2, -drawH / 2, drawW, drawH)
    } else {
      ctx.drawImage(img.node, -drawW / 2, -drawH / 2, drawW, drawH)
    }
    ctx.restore()
  }
  if (typeof painter === 'function') {
    const ret = painter(pre.ctx, {
      canvas: canvas,
      image: img.node,
      width: outW,
      height: outH,
      sourceWidth: img.width,
      sourceHeight: img.height,
      transform: tr
    })
    if (ret && typeof ret.then === 'function') return ret.then(function () { return canvas })
  }
  return canvas
}

/** 单次「设尺寸 → 画 → 导出」，canvas 复用不释放（供压缩迭代使用） */
function encodeAt(canvas, imgNode, width, height, quality, fileType, bg) {
  const pre = c.prepare(canvas, width, height, bg)
  pre.ctx.drawImage(imgNode, 0, 0, pre.width, pre.height)
  return exportCanvas(canvas, { fileType: fileType, quality: quality, width: pre.width, height: pre.height, autoRelease: false })
}

/** 降采样阶梯：原尺寸 → 80% → 64% → 50% → 40%（去重） */
function scaleLadder(info, maxSide) {
  const base = c.fitInside(info.width, info.height, maxSide)
  const seen = {}
  const out = []
  DOWNSCALE_STEPS.forEach(function (s) {
    const w = Math.max(16, Math.round(base.width * s))
    const h = Math.max(16, Math.round(base.height * s))
    const k = w + 'x' + h
    if (seen[k]) return
    seen[k] = 1
    out.push({ width: w, height: h })
  })
  return out
}

function resultOf(out, quality, target, iterations, reached, originalSize, canvas) {
  c.release(canvas)
  const src = Number(originalSize) || 0
  return {
    path: out.path,
    size: out.size,
    width: out.width,
    height: out.height,
    fileType: out.fileType,
    quality: quality,
    originalSize: src,
    savedRatio: src > 0 ? Math.max(0, +((((src - out.size) / src) * 100).toFixed(1))) : 0,
    targetBytes: target || 0,
    reachedTarget: !!reached,
    iterations: iterations,
    code: reached ? '' : 'OVER_TARGET_NOT_REACHABLE'
  }
}

/**
 * JPEG 压缩。
 *  - 不给 targetBytes：按 quality（10–95，默认 80）单次编码，maxSide 可选限边长。
 *  - 给 targetBytes/targetKB：二分搜索质量（10–95，总迭代 ≤7）逼近目标；最小质量仍超标时按阶梯降采样重试；
 *    仍达不到 → 返回最小可达体积那张图，reachedTarget=false + code=OVER_TARGET_NOT_REACHABLE
 *    （页面据此提示，绝不静默超标，对齐 tools-spec FR-IMG-01 处理规则 2）。
 * @param {{path:string, quality?:number, maxSide?:number, canvasId?:string, targetBytes?:number, targetKB?:number,
 *          maxIterations?:number, maxQuality?:number, fileType?:string, allowDownscale?:boolean, bg?:string, scope?:any}} opts
 * @returns {Promise<{path,size,width,height,quality,fileType,originalSize,savedRatio,reachedTarget,iterations,code}>}
 */
function compressToJpeg(opts) {
  const o = opts || {}
  if (!o.path) return Promise.reject(error.make(error.CODES.INPUT_EMPTY))
  let fileType
  try {
    fileType = c.normalizeFileType(o.fileType || 'jpg')
  } catch (e) {
    return Promise.reject(e)
  }
  const quality = c.clampQuality(o.quality, 80)
  const target = Number(o.targetBytes) || (Number(o.targetKB) ? Number(o.targetKB) * 1024 : 0)
  const ceiling = c.clampQuality(o.maxQuality, c.QUALITY_MAX)
  const budget = target ? Math.min(7, Math.max(1, Number(o.maxIterations) || 7)) : 1
  let canvas = null

  return c.readImage(o.path)
    .then(function (info) {
      return c.makeOffscreen(o.canvasId || c.DEFAULT_OFFSCREEN, o.scope).then(function (node) {
        canvas = node
        return c.loadImage(node, o.path).then(function (img) {
          return { info: info, img: img }
        })
      })
    })
    .then(function (st) {
      if (!target) {
        const s = o.maxSide ? c.fitInside(st.info.width, st.info.height, o.maxSide) : { width: st.info.width, height: st.info.height }
        return encodeAt(canvas, st.img.node, s.width, s.height, quality, fileType, o.bg).then(function (out) {
          return resultOf(out, quality, 0, 1, true, st.info.size, canvas)
        })
      }
      return searchQuality({
        canvas: canvas,
        img: st.img.node,
        ladder: o.allowDownscale === false ? [c.fitInside(st.info.width, st.info.height, o.maxSide)] : scaleLadder(st.info, o.maxSide),
        target: target,
        ceiling: ceiling,
        budget: budget,
        fileType: fileType,
        bg: o.bg,
        originalSize: st.info.size
      })
    })
    .catch(function (e) {
      c.release(canvas)
      throw error.normalize(e, error.CODES.IMAGE_TOO_BIG)
    })
}

/** 二分搜索：在阶梯尺寸上找「体积仍 ≤ target 的最高质量」，总编码次数 ≤ budget */
function searchQuality(cfg) {
  let used = 0
  let best = null // 达标里质量最高
  let smallest = null // 所有尝试里体积最小
  let scaleIndex = 0

  const encode = function (q, size) {
    used++
    return encodeAt(cfg.canvas, cfg.img, size.width, size.height, q, cfg.fileType, cfg.bg).then(function (out) {
      if (!smallest || out.size < smallest.out.size) smallest = { out: out, quality: q }
      if (out.size <= cfg.target && (!best || q > best.quality)) best = { out: out, quality: q }
      return out
    })
  }

  const upward = function (lo, hi, size) {
    if (lo > hi || used >= cfg.budget) return Promise.resolve(best)
    const mid = Math.round((lo + hi) / 2)
    return encode(mid, size).then(function (out) {
      if (out.size <= cfg.target) return upward(mid + 1, hi, size)
      return upward(lo, mid - 1, size)
    })
  }

  const nextScale = function () {
    if (best) return Promise.resolve(best)
    if (scaleIndex >= cfg.ladder.length || used >= cfg.budget) return Promise.resolve(best)
    const size = cfg.ladder[scaleIndex]
    return encode(c.QUALITY_MIN, size).then(function (out) {
      if (out.size <= cfg.target) return upward(c.QUALITY_MIN + 1, cfg.ceiling, size)
      scaleIndex++
      return nextScale()
    })
  }

  return nextScale().then(function () {
    const pick = best || smallest
    if (!pick) throw error.make(error.CODES.IMAGE_TOO_BIG)
    return resultOf(pick.out, pick.quality, cfg.target, used, !!best, cfg.originalSize, cfg.canvas)
  })
}

module.exports = {
  MAX_PIXELS: c.MAX_PIXELS,
  DEFAULT_OFFSCREEN: c.DEFAULT_OFFSCREEN,
  QUALITY_MIN: c.QUALITY_MIN,
  QUALITY_MAX: c.QUALITY_MAX,
  FILE_TYPES: c.FILE_TYPES,
  makeOffscreen: c.makeOffscreen,
  registerOffscreen: c.registerOffscreen,
  loadImage: c.loadImage,
  readImage: c.readImage,
  readVideo: c.readVideo,
  fileSize: c.fileSize,
  release: c.release,
  fitInside: c.fitInside,
  pixelScale: c.pixelScale,
  prepare: c.prepare,
  normalizeFileType: c.normalizeFileType,
  clampQuality: c.clampQuality,
  qualityParam: c.qualityParam,
  extension: c.extension,
  exportCanvas: exportCanvas,
  drawToCanvas: drawToCanvas,
  compressToJpeg: compressToJpeg,
  encodeAt: encodeAt,
  scaleLadder: scaleLadder
}
