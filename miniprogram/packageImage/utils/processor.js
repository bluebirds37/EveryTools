/**
 * packageImage 通用绘制管线（所有图片工具页共用）
 * 约定（CONTRACT C3）：Canvas 的解码/导出只经 utils/media.js 暴露的能力，
 * 本文件仅做「尺寸规划 / 绘制编排 / 批量串行 / 保存出口」的复用封装。
 */
const media = require('../../utils/media')
const error = require('../../utils/error')

const MAX_PIXELS = 16000000 // 单次像素上限，超出先降采样
const ID = 'tb-offscreen'

/** 字节 → 可读体积 */
function formatBytes(bytes) {
  const n = Number(bytes)
  if (!isFinite(n) || n <= 0) return '0 B'
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB'
  return (n / 1024 / 1024).toFixed(2) + ' MB'
}

/** 把 w×h 收进 maxSide（0=不限制），等比、至少 1px */
function fitWithin(w, h, maxSide) {
  const sw = Math.max(1, Math.floor(w))
  const sh = Math.max(1, Math.floor(h))
  if (!maxSide || maxSide <= 0) return { width: sw, height: sh, scale: 1 }
  const cap = Math.max(1, Math.floor(maxSide))
  const long = Math.max(sw, sh)
  if (long <= cap) return { width: sw, height: sh, scale: 1 }
  const k = cap / long
  return {
    width: Math.max(1, Math.round(sw * k)),
    height: Math.max(1, Math.round(sh * k)),
    scale: k
  }
}

/**
 * 规划输出尺寸：先按 maxSide 限边长，再按 16M 像素上限降采样。
 * @returns {{width:number,height:number,scale:number,downscaled:boolean}}
 */
function planSize(w, h, maxSide) {
  const base = fitWithin(w, h, maxSide)
  let px = base.width * base.height
  if (px <= MAX_PIXELS) {
    return { width: base.width, height: base.height, scale: base.scale, downscaled: false }
  }
  const k = Math.sqrt(MAX_PIXELS / px)
  const out = {
    width: Math.max(1, Math.floor(base.width * k)),
    height: Math.max(1, Math.floor(base.height * k)),
    scale: base.scale * k,
    downscaled: true
  }
  console.warn('[processor] 像素超限降采样', px, '->', out.width * out.height)
  return out
}

/** 取隐藏离屏 canvas 节点（scope 传页面实例，便于基础库不支持 createOffscreenCanvas 时回退到页面 #tb-offscreen） */
function getCanvas(scope) {
  return media.makeOffscreen(ID, scope)
}

/** 读取图片基础信息（宽/高/体积/格式） */
function readInfo(path) {
  return media.readImage(path)
}

/** 释放画布内存（CONTRACT C3：处理完置 1×1） */
function release(canvas) {
  if (!canvas) return
  try {
    canvas.width = 1
    canvas.height = 1
  } catch (e) {
    /* 节点已回收，忽略 */
  }
}

/**
 * 在目标尺寸画布上绘制源图。
 * @param {Object} ctx 2d context
 * @param {Object} node media.loadImage 返回的可绘制节点
 * @param {Object} opt {width,height,rotate,flipH,flipV,fit:'cover'|'contain',bg,
 *                      zoom,offsetX,offsetY}
 * zoom/offset 用于裁剪取景（单位：目标画布像素）
 */
function drawFit(ctx, node, opt) {
  const w = Math.max(1, Math.floor(opt.width))
  const h = Math.max(1, Math.floor(opt.height))
  ctx.save()
  if (opt.bg) {
    ctx.fillStyle = opt.bg
    ctx.fillRect(0, 0, w, h)
  }
  if (typeof ctx.imageSmoothingQuality === 'string') ctx.imageSmoothingQuality = 'high'
  ctx.imageSmoothingEnabled = true

  const iw = node.width || 1
  const ih = node.height || 1
  const rot = ((Number(opt.rotate) || 0) % 360 + 360) % 360
  const quarter = Math.round(rot / 90) % 4
  const odd = quarter % 2 === 1
  // 旋转后包围盒
  const boxW = odd ? ih : iw
  const boxH = odd ? iw : ih

  ctx.translate(w / 2, h / 2)
  ctx.rotate((rot * Math.PI) / 180)
  if (opt.flipH || opt.flipV) ctx.scale(opt.flipH ? -1 : 1, opt.flipV ? -1 : 1)

  let dw, dh
  if (opt.fit === 'contain') {
    dw = w
    dh = h
    const k = Math.min(w / boxW, h / boxH)
    dw = boxW * k
    dh = boxH * k
  } else {
    const k = Math.max(w / boxW, h / boxH)
    dw = boxW * k
    dh = boxH * k
  }
  if (opt.zoom) {
    dw *= opt.zoom
    dh *= opt.zoom
  }
  ctx.translate(opt.offsetX || 0, opt.offsetY || 0)
  ctx.drawImage(node, -dw / 2, -dh / 2, dw, dh)
  ctx.restore()
}

/**
 * 标准渲染流程：申请画布 → 解码 → 绘制 → 导出 → 释放。
 * @param {Object} opt {canvas, srcPath, width, height, fileType, quality,
 *                      rotate, flipH, flipV, fit, bg, extraDraw(ctx,canvas,info)}
 * @returns {Promise<{path,size,width,height}>}
 */
async function render(opt) {
  const canvas = opt.canvas || (await getCanvas(opt.scope))
  const plan = planSize(opt.width, opt.height, opt.maxSide || 0)
  let node = null
  try {
    const img = await media.loadImage(canvas, opt.srcPath)
    node = (img && img.node) || img
    canvas.width = plan.width
    canvas.height = plan.height
    const ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, plan.width, plan.height)
    drawFit(ctx, node, {
      width: plan.width,
      height: plan.height,
      rotate: opt.rotate,
      flipH: opt.flipH,
      flipV: opt.flipV,
      fit: opt.fit || 'cover',
      bg: opt.bg,
      zoom: opt.zoom,
      offsetX: opt.offsetX,
      offsetY: opt.offsetY
    })
    if (typeof opt.extraDraw === 'function') {
      await opt.extraDraw(ctx, canvas, { width: plan.width, height: plan.height, source: node })
    }
    const out = await media.exportCanvas(canvas, {
      fileType: opt.fileType || 'jpg',
      quality: typeof opt.quality === 'number' ? opt.quality : 0.9,
      width: plan.width,
      height: plan.height
    })
    return { path: out.path, size: out.size, width: plan.width, height: plan.height, downscaled: plan.downscaled }
  } finally {
    release(canvas)
  }
}

/**
 * 只解码到已设置好尺寸的画布，交由调用方逐块绘制（拼接/切图/水印复用同一节点，省解码次数）。
 * @returns {Promise<{canvas,ctx,node,width,height}>}
 */
async function openCanvas(opt) {
  const canvas = opt.canvas || (await getCanvas(opt.scope))
  const plan = planSize(opt.width, opt.height, opt.maxSide || 0)
  canvas.width = plan.width
  canvas.height = plan.height
  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, plan.width, plan.height)
  return { canvas, ctx, width: plan.width, height: plan.height, plan }
}

/**
 * 解码单张图到指定画布节点，返回可直接 ctx.drawImage 的 image 节点
 * （media.loadImage 契约返回 {width,height,node}，此处统一拆包）
 */
async function decode(canvas, path) {
  const res = await media.loadImage(canvas, path)
  return (res && res.node) || res
}

/** 导出当前画布内容 */
async function exportCanvas(canvas, opt) {
  const out = await media.exportCanvas(canvas, {
    fileType: (opt && opt.fileType) || 'jpg',
    quality: opt && typeof opt.quality === 'number' ? opt.quality : 0.9,
    width: opt && opt.width,
    height: opt && opt.height
  })
  return { path: out.path, size: out.size }
}

/** 直接走 media 的压缩（不重绘时最快路径） */
function compress(opt) {
  return media.compressToJpeg(opt)
}

/**
 * 串行批量执行，逐张回调进度；单张失败不中断整批。
 * @param {Array} list 输入项
 * @param {Function} worker (item, index) => Promise<any>
 * @param {Function} onProgress ({index,total,current,outcome}) => void
 */
async function runSerial(list, worker, onProgress) {
  const results = []
  for (let i = 0; i < list.length; i++) {
    if (typeof onProgress === 'function') {
      onProgress({ index: i, total: list.length, current: list[i], stage: 'start' })
    }
    try {
      const r = await worker(list[i], i)
      results.push({ ok: true, index: i, value: r })
    } catch (e) {
      results.push({ ok: false, index: i, code: (e && e.code) || 'TASK_FAILED', message: e && e.message })
    }
    if (typeof onProgress === 'function') {
      onProgress({ index: i, total: list.length, current: list[i], stage: 'done' })
    }
  }
  return results
}

/**
 * 保存到相册：区分「授权拒绝」与「写入失败」，前者页面保留结果可重试（FR-G-04）。
 * @param {string} filePath 临时文件路径
 * @param {string} type 'image'|'video'
 */
function saveToAlbum(filePath, type) {
  return new Promise((resolve, reject) => {
    const api = type === 'video' ? 'saveVideoToPhotosAlbum' : 'saveImageToPhotosAlbum'
    const call = () =>
      new Promise((res, rej) => wx[api]({ filePath, success: () => res(true), fail: (e) => rej(e) }))
    call().then(resolve).catch((e) => {
      const msg = (e && e.errMsg) || ''
      if (msg.indexOf('auth') >= 0 || msg.indexOf('deny') >= 0 || /permission/i.test(msg)) {
        reject({ code: 'PERMISSION_DENIED', message: error.message('PERMISSION_DENIED'), raw: msg })
      } else {
        reject({ code: 'TASK_FAILED', message: error.message('TASK_FAILED', { reason: '写入相册失败' }), raw: msg })
      }
    })
  })
}

/** 批量保存（相册只需一次授权；中途拒绝即停止并汇报已完成数量） */
async function saveMany(filePaths, type) {
  let saved = 0
  let denied = false
  for (let i = 0; i < filePaths.length; i++) {
    try {
      await saveToAlbum(filePaths[i], type)
      saved++
    } catch (e) {
      if (e && e.code === 'PERMISSION_DENIED') {
        denied = true
        break
      }
    }
  }
  return { saved, total: filePaths.length, denied }
}

/** 复制文本到剪贴板（FR-G-06：不加任何推广文案） */
function copy(text) {
  return new Promise((resolve, reject) => {
    wx.setClipboardData({
      data: String(text),
      success: () => resolve(true),
      fail: (e) => reject({ code: 'TASK_FAILED', message: error.message('TASK_FAILED', { reason: '复制失败' }), raw: e })
    })
  })
}

/** 把 media/平台错误转成契约错误对象 {code,message,extra} */
function asContractError(e, fallbackCode) {
  const code = (e && e.code) || fallbackCode || 'TASK_FAILED'
  const msg = (e && e.message) || error.message(code, e && e.extra)
  return { code, message: typeof msg === 'string' && msg ? msg : error.message(code), extra: e && e.extra }
}

/** #RRGGBB → {r,g,b} ；非法返回 null */
function parseHex(hex) {
  const s = String(hex || '').trim().replace('#', '')
  if (!/^[0-9a-fA-F]{6}$/.test(s) && !/^[0-9a-fA-F]{3}$/.test(s)) return null
  const t = s.length === 3 ? s.split('').map((c) => c + c).join('') : s
  return {
    r: parseInt(t.slice(0, 2), 16),
    g: parseInt(t.slice(2, 4), 16),
    b: parseInt(t.slice(4, 6), 16)
  }
}

/** rgba 字符串 */
function rgba(hex, alpha) {
  const c = parseHex(hex) || { r: 255, g: 255, b: 255 }
  const a = alpha === undefined || alpha === null ? 1 : alpha
  return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + a + ')'
}

/** 数值夹取 */
function clamp(v, min, max, def) {
  const n = Number(v)
  if (!isFinite(n)) return def === undefined ? min : def
  return Math.min(max, Math.max(min, n))
}

module.exports = {
  ID,
  MAX_PIXELS,
  formatBytes,
  formatKB: (bytes) => Math.round(Number(bytes) / 1024),
  fitWithin,
  planSize,
  getCanvas,
  readInfo,
  release,
  drawFit,
  render,
  openCanvas,
  decode,
  exportCanvas,
  compress,
  runSerial,
  saveToAlbum,
  saveMany,
  copy,
  asContractError,
  parseHex,
  rgba,
  clamp
}
