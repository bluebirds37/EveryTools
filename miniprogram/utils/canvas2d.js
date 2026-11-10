/**
 * utils/canvas2d.js —— Canvas 2D 底座原语（由 utils/media.js 拆分，C1 单文件 ≤400 行）
 *
 * 离屏画布来源（按可用性降级）：
 *  1. wx.createOffscreenCanvas({type:'2d'})：基础库 2.16.1+，无需页面放节点；
 *  2. 页面里的 <canvas type="2d" id="tb-offscreen">（wx.createSelectorQuery 取 node）；
 *  3. 组件内 canvas：makeOffscreen(id, this) 带 scope，或 registerOffscreen(node) 注册。
 * 内存纪律：像素上限 16_000_000；导出后 canvas 置 1×1 释放。
 */

const error = require('./error')

const MAX_PIXELS = 16000000
const DEFAULT_OFFSCREEN = 'tb-offscreen'
const FILE_TYPES = { jpg: 'jpg', jpeg: 'jpg', png: 'png', webp: 'webp' }
const QUALITY_MIN = 10
const QUALITY_MAX = 95
const LOAD_TIMEOUT = 25000

const offscreenCache = {}

function hasWx() {
  return typeof wx !== 'undefined'
}

function unavailable(what) {
  return Promise.reject(error.make(error.CODES.ENGINE_UNAVAILABLE, { reason: what }))
}

function normalizeFileType(ft) {
  const key = FILE_TYPES[String(ft || 'jpg').replace(/^\./, '').toLowerCase()]
  if (key) return key
  throw error.make(error.CODES.UNSUPPORTED_FORMAT, { format: ft })
}

function extension(path) {
  const m = /\.([a-z0-9]+)(\?|$)/i.exec(String(path || ''))
  return m ? m[1].toLowerCase() : ''
}

/**
 * 归一到 10–95 的 JPEG 质量刻度。
 * 入参允许两种写法：0–1 分数（各工具页 `quality/100`）或 10–95 整数。
 * ⚠️ 不能只做 `Math.round`：0.75 会被压成 1，随后 `qualityParam(1)` 当作 1.0（最高质量），
 *    这正是「100KB 图片压缩后变 400KB」的根因（media.compressToJpeg 走的就是这条路）。
 */
function clampQuality(q, def) {
  const raw = Number(q)
  if (!isFinite(raw)) return def == null ? 80 : def
  const n = raw > 0 && raw <= 1 ? raw * 100 : raw
  return Math.min(QUALITY_MAX, Math.max(QUALITY_MIN, Math.round(n)))
}

/** canvasToTempFilePath 的 quality 是 0–1；兼容调用方传 0–95 或 0–1 */
function qualityParam(q) {
  const n = Number(q)
  if (!isFinite(n)) return 0.9
  if (n <= 1) return Math.min(1, Math.max(0.01, n))
  return clampQuality(n, 90) / 100
}

/** 像素超上限时返回缩放系数（<1），否则 1 */
function pixelScale(width, height) {
  const px = Math.max(1, width) * Math.max(1, height)
  if (px <= MAX_PIXELS) return 1
  const s = Math.sqrt(MAX_PIXELS / px)
  console.warn('[media] 像素 ' + width + '×' + height + ' 超上限 ' + MAX_PIXELS + '，降采样至 ' + (s * 100).toFixed(0) + '%')
  return s
}

/** 按 maxSide（0=不变）求等比缩放后的尺寸 */
function fitInside(width, height, maxSide) {
  const side = Number(maxSide) || 0
  const long = Math.max(width, height)
  const s = side > 0 && long > side ? side / long : 1
  return { width: Math.max(1, Math.round(width * s)), height: Math.max(1, Math.round(height * s)), scale: s }
}

function setSize(canvas, width, height) {
  const w = Math.max(1, Math.round(width))
  const h = Math.max(1, Math.round(height))
  canvas.width = w
  canvas.height = h
  return { width: w, height: h }
}

/** 用完释放位图内存（node 仍保留，下次 setSize 会重新分配） */
function release(canvas) {
  if (!canvas) return
  try {
    canvas.width = 1
    canvas.height = 1
  } catch (e) {
    /* 只读节点，忽略 */
  }
}

/** 页面/组件把自己已有的 canvas 节点注册进来，避免重复查询 */
function registerOffscreen(node, name) {
  if (node) offscreenCache[name || DEFAULT_OFFSCREEN] = node
  return node
}

function queryNode(key, scope) {
  if (!hasWx() || !wx.createSelectorQuery) return unavailable('无 createOffscreenCanvas')
  return new Promise(function (resolve, reject) {
    try {
      const q = scope && typeof scope.createSelectorQuery === 'function' ? scope.createSelectorQuery() : wx.createSelectorQuery()
      q.select('#' + key)
        .fields({ node: true, size: true })
        .exec(function (res) {
          const node = res && res[0] && res[0].node
          if (!node) {
            reject(error.make(error.CODES.ENGINE_UNAVAILABLE, { reason: '页面缺少 canvas#' + key }))
            return
          }
          offscreenCache[key] = node
          resolve(node)
        })
    } catch (e) {
      reject(error.normalize(e, error.CODES.ENGINE_UNAVAILABLE))
    }
  })
}

/**
 * 取离屏 canvas 节点
 * @param {string} [name='tb-offscreen']
 * @param {object} [scope] 自定义组件实例（this）
 * @returns {Promise<any>} canvas node
 */
function makeOffscreen(name, scope) {
  const key = name || DEFAULT_OFFSCREEN
  if (offscreenCache[key]) return Promise.resolve(offscreenCache[key])
  if (!hasWx()) return unavailable('canvas')
  if (wx.createOffscreenCanvas) {
    try {
      const c = wx.createOffscreenCanvas({ type: '2d', width: 1, height: 1 })
      if (c && typeof c.getContext === 'function') {
        offscreenCache[key] = c
        return Promise.resolve(c)
      }
    } catch (e) {
      console.warn('[media] createOffscreenCanvas 不可用，改用页面 canvas：' + ((e && e.errMsg) || e))
    }
  }
  return queryNode(key, scope)
}

/**
 * 解码图片为可 drawImage 的节点
 * @returns {Promise<{width:number,height:number,node:any}>}
 */
function loadImage(canvas, src) {
  if (!src) return Promise.reject(error.make(error.CODES.INPUT_EMPTY))
  if (!canvas || typeof canvas.createImage !== 'function') {
    return makeOffscreen().then(function (c) {
      return loadImage(c, src)
    })
  }
  return new Promise(function (resolve, reject) {
    const timer = setTimeout(function () {
      reject(error.make(error.CODES.IMAGE_TOO_BIG, { reason: '解码超时' }))
    }, LOAD_TIMEOUT)
    const settle = function (fn, arg) {
      clearTimeout(timer)
      fn(arg)
    }
    let img
    try {
      img = canvas.createImage()
    } catch (e) {
      clearTimeout(timer)
      reject(error.make(error.CODES.UNSUPPORTED_FORMAT, { reason: 'createImage' }))
      return
    }
    img.onload = function () {
      if (!img.width || !img.height) {
        settle(reject, error.make(error.CODES.IMAGE_TOO_BIG, { reason: '尺寸无效' }))
        return
      }
      settle(resolve, { width: img.width, height: img.height, node: img })
    }
    img.onerror = function () {
      settle(reject, error.make(error.CODES.IMAGE_TOO_BIG, { reason: '解码失败' }))
    }
    img.src = src
  })
}

/** 文件体积（wx.getFileInfo，失败回落 FileSystemManager；拿不到返回 0） */
function fileSize(path) {
  return new Promise(function (resolve) {
    if (!path) {
      resolve(0)
      return
    }
    const viaManager = function () {
      if (!hasWx() || !wx.getFileSystemManager) {
        resolve(0)
        return
      }
      try {
        wx.getFileSystemManager().getFileInfo({
          filePath: path,
          success: function (r) {
            resolve(Number(r && r.size) || 0)
          },
          fail: function () {
            resolve(0)
          }
        })
      } catch (e) {
        resolve(0)
      }
    }
    if (hasWx() && wx.getFileInfo) {
      wx.getFileInfo({
        filePath: path,
        success: function (r) {
          resolve(Number(r && r.size) || 0)
        },
        fail: viaManager
      })
      return
    }
    viaManager()
  })
}

/**
 * 本地探测图片信息（不解码进 canvas）
 * @returns {Promise<{path,width,height,size,format}>}
 */
function readImage(src) {
  if (!src) return Promise.reject(error.make(error.CODES.INPUT_EMPTY))
  if (!hasWx() || !wx.getImageInfo) return unavailable('getImageInfo')
  return new Promise(function (resolve, reject) {
    wx.getImageInfo({
      src: src,
      success: function (r) {
        fileSize(src).then(function (size) {
          resolve({
            path: r.path || src,
            width: Number(r.width) || 0,
            height: Number(r.height) || 0,
            size: Number(size) || 0,
            format: String(r.type || extension(src) || 'unknown').toLowerCase()
          })
        })
      },
      fail: function (e) {
        const n = error.normalize(e, error.CODES.IMAGE_TOO_BIG)
        if (n.code === error.INTERNAL_CODES.CANCELED) {
          reject(n)
          return
        }
        const ext = extension(src)
        // 扩展名在支持表内却解码失败 → 更可能是尺寸/损坏；否则才提示格式不支持
        reject(FILE_TYPES[ext] ? error.make(error.CODES.IMAGE_TOO_BIG, { reason: n.message }) : error.make(error.CODES.UNSUPPORTED_FORMAT, { format: ext }))
      }
    })
  })
}

/** 视频本地探测（FR-V-00.1）：{path,duration,width,height,size,bitrate,format} */
function readVideo(src) {
  if (!src) return Promise.reject(error.make(error.CODES.INPUT_EMPTY))
  if (!hasWx() || !wx.getVideoInfo) return unavailable('getVideoInfo')
  return new Promise(function (resolve, reject) {
    wx.getVideoInfo({
      src: src,
      success: function (r) {
        fileSize(src).then(function (size) {
          resolve({
            path: src,
            duration: Number(r.duration) || 0,
            width: Number(r.width) || 0,
            height: Number(r.height) || 0,
            size: Number(size) || Number(r.size) || 0,
            bitrate: Number(r.bitrate) || 0,
            format: extension(src) || 'mp4'
          })
        })
      },
      fail: function (e) {
        reject(error.normalize(e, error.CODES.UNSUPPORTED_FORMAT))
      }
    })
  })
}

/** 设尺寸 + 清屏 + 抗锯齿/铺底 */
function prepare(canvas, width, height, bg) {
  const size = setSize(canvas, width, height)
  const ctx = canvas.getContext('2d')
  if (typeof ctx.setTransform === 'function') ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, size.width, size.height)
  if (bg) {
    ctx.fillStyle = bg
    ctx.fillRect(0, 0, size.width, size.height)
  }
  ctx.imageSmoothingEnabled = true
  try {
    ctx.imageSmoothingQuality = 'high'
  } catch (e) {
    /* 部分机型不支持 */
  }
  return { ctx: ctx, width: size.width, height: size.height }
}

module.exports = {
  MAX_PIXELS: MAX_PIXELS,
  DEFAULT_OFFSCREEN: DEFAULT_OFFSCREEN,
  QUALITY_MIN: QUALITY_MIN,
  QUALITY_MAX: QUALITY_MAX,
  FILE_TYPES: Object.keys(FILE_TYPES).filter(function (k) { return k !== 'jpeg' }),
  hasWx: hasWx,
  unavailable: unavailable,
  normalizeFileType: normalizeFileType,
  extension: extension,
  clampQuality: clampQuality,
  qualityParam: qualityParam,
  pixelScale: pixelScale,
  fitInside: fitInside,
  setSize: setSize,
  release: release,
  registerOffscreen: registerOffscreen,
  makeOffscreen: makeOffscreen,
  loadImage: loadImage,
  fileSize: fileSize,
  readImage: readImage,
  readVideo: readVideo,
  prepare: prepare
}
