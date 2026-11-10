/* 小程序运行时 mock：让页面/组件能在 Node 中被 require 并调用生命周期。
 *
 * 关键设计（2026-10-15 加固）：**体积/尺寸必须随参数真实变化**。
 * 旧版 canvasToTempFilePath 永远返回同一路径、getFileInfo 永远报 512KB，
 * 于是「100KB 图片压缩后变 400KB」这类质量/体积缺陷在 harness 里不可见
 * （对应 utils/canvas2d.js::clampQuality 的单位回归，见 scripts/cases/image.js 的「共享层质量单位契约」场景）。
 * 现在：
 *  · 虚拟文件表 files[path] = {size,width,height,type}，getImageInfo/getFileInfo/stat/readFile/copyFile 共用它；
 *  · canvasToTempFilePath 按 fileType + quality(0–1) + destWidth/destHeight 算体积并登记新文件；
 *  · 画布没有任何绘制操作时导出失败（模拟真机空画布），避免「没画也导出」的假成功。
 */
const store = {}
const nav = []
const requests = []
const uploads = []
const downloads = []

/* ---------- 虚拟文件表 ---------- */
const files = {}
let exportSeq = 0
let lastDraw = null
let paintOps = 0

function putFile(p, meta) {
  files[p] = Object.assign({ size: 1024, width: 64, height: 64, type: 'jpeg' }, meta || {})
  return p
}
function getFile(p) {
  return files[p] || null
}

/** JPEG 体积经验模型：每像素字节数随质量单调上升（10→0.02，50→0.10，95→0.47 bpp） */
function jpegBytesPerPixel(q) {
  const p = Math.min(95, Math.max(10, Number(q) || 80))
  return 0.02 + 0.45 * Math.pow((p - 10) / 85, 1.5)
}

/** PNG 体积与 quality 无关 */
function pngBytesPerPixel() {
  return 0.9
}

/** canvasToTempFilePath 的 quality 是 0–1；模型内部按 10–95 计算，先归一 */
function qualityToScale(q) {
  const n = Number(q)
  if (!isFinite(n)) return 80
  if (n > 0 && n <= 1) return Math.round(n * 100)
  return Math.round(n)
}

function exportSize(fileType, quality, width, height) {
  const px = Math.max(1, (width | 0) * (height | 0))
  const q = qualityToScale(quality)
  const bpp = fileType === 'png' ? pngBytesPerPixel() : fileType === 'webp' ? jpegBytesPerPixel(q) * 0.85 : jpegBytesPerPixel(q)
  return Math.max(256, Math.round(px * bpp) + 220)
}

/** 默认样例文件：未显式注入时页面也能拿到「一张 512KB / 3000×4000 的照片」 */
function seedFiles() {
  putFile('/tmp/mock.jpg', { size: 1024 * 512, width: 3000, height: 4000, type: 'jpeg' })
  putFile('/tmp/mock.png', { size: 1024 * 900, width: 1200, height: 1600, type: 'png' })
  putFile('/tmp/mock.mp4', { size: 1024 * 8 * 1024, width: 1920, height: 1080, type: 'mp4' })
  putFile('/tmp/sample.mp3', { size: 1024 * 640, type: 'mp3' })
}

/* ---------- canvas ---------- */
function createImageNode() {
  const img = { width: 0, height: 0, onload: null, onerror: null, _src: '' }
  Object.defineProperty(img, 'src', {
    get() { return this._src },
    set(v) {
      this._src = v
      const f = getFile(v)
      setTimeout(() => {
        if (f) {
          this.width = f.width || 1200
          this.height = f.height || 1600
          if (this.onload) this.onload()
        } else if (/^https?:/.test(String(v))) {
          this.width = 800
          this.height = 600
          if (this.onload) this.onload()
        } else if (this.onerror) {
          this.onerror({ errMsg: 'createImage:fail no such file ' + v })
        }
      }, 0)
    }
  })
  return img
}

function makeCanvas(width, height) {
  const ctx = {
    fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1, font: '', textAlign: '', textBaseline: '',
    imageSmoothingQuality: 'high', shadowColor: '', shadowBlur: 0, shadowOffsetX: 0, shadowOffsetY: 0,
    lineCap: 'butt', lineJoin: 'miter',
    save() {}, restore() {}, beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, arc() {}, rect() {},
    fill() { paintOps++ }, stroke() { paintOps++ }, clearRect() {}, fillRect() { paintOps++ },
    fillText() { paintOps++ }, strokeText() { paintOps++ },
    translate() {}, rotate() {}, scale() {}, setTransform() {}, transform() {},
    // 记录最近一次 drawImage 的源尺寸：断言「画布确实画进了原图」
    drawImage(img, ...rest) {
      paintOps++
      lastDraw = { image: img, args: rest, sw: img && img.width, sh: img && img.height }
    },
    measureText(t) { return { width: String(t == null ? '' : t).length * 8 } },
    createLinearGradient() { return { addColorStop() {} } },
    createRadialGradient() { return { addColorStop() {} } },
    getImageData(x, y, w, h) {
      const len = Math.max(1, (w | 0) * (h | 0) * 4)
      // 伪像素：确定且非零，取色类工具可以反推期望值
      const data = new Uint8ClampedArray(len)
      for (let i = 0; i < len; i += 4) {
        data[i] = (i * 7) % 251
        data[i + 1] = (i * 13) % 197
        data[i + 2] = (i * 29) % 173
        data[i + 3] = 255
      }
      return { width: w | 0, height: h | 0, data }
    },
    putImageData() { paintOps++ },
    createImageData(w, h) { return { width: w | 0, height: h | 0, data: new Uint8ClampedArray(Math.max(1, (w | 0) * (h | 0) * 4)) } }
  }
  const node = { width: width || 300, height: height || 300, getContext: () => ctx, node: null }
  node.createImage = createImageNode
  return node
}

function queryStub() {
  let wantsNode = false
  const chain = {
    select() { return chain },
    selectAll() { return chain },
    in() { return chain },
    // fields({node:true}).exec(cb) 是取页面 canvas 节点的唯一路径：exec 必须回交节点，
    // 否则 utils/canvas2d.makeOffscreen 的 Promise 永不 settle（图片类工具会挂住）
    fields() { wantsNode = true; return chain },
    boundingClientRect(cb) {
      setTimeout(() => { if (cb) cb({ width: 375, height: 375, left: 0, top: 0 }) }, 0)
      return chain
    },
    node(cb) {
      setTimeout(() => { if (cb) cb({ node: makeCanvas() }) }, 0)
      return chain
    },
    exec(cb) {
      if (typeof cb !== 'function') return
      setTimeout(() => cb(wantsNode ? [{ node: makeCanvas(), width: 300, height: 300 }] : [{}]), 0)
    }
  }
  return chain
}

const canvasExports = []
const toast = []
const modal = []
const log = []

const wx = {
  // 基础
  getSystemInfoSync: () => ({ platform: 'devtools', SDKVersion: '3.5.0', windowWidth: 375, windowHeight: 700, pixelRatio: 2, statusBarHeight: 20, screenHeight: 700, screenWidth: 375 }),
  getDeviceInfo: () => ({ platform: 'devtools', system: 'mock' }),
  getWindowInfo: () => ({ windowWidth: 375, windowHeight: 700, pixelRatio: 2, safeArea: { bottom: 700 } }),
  getAppBaseInfo: () => ({ SDKVersion: '3.5.0', host: { env: 'mock' } }),
  // 登录与网络
  login: (o) => { requests.push('wx.login'); setTimeout(() => { if (o && o.success) o.success({ code: 'mock_code_123' }) }, 0) },
  request: (o) => {
    requests.push((o.method || 'GET') + ' ' + o.url)
    setTimeout(() => {
      if (o && o.success) o.success({ statusCode: 200, data: { ok: true, data: mockPayload(o.url) }, header: {} })
      else if (o && o.fail) o.fail({ errMsg: 'request:fail mock' })
    }, 0)
  },
  uploadFile: (o) => {
    uploads.push(o.url)
    setTimeout(() => { if (o && o.success) o.success({ statusCode: 200, data: JSON.stringify({ ok: true, data: { index: 0, received: true } }) }) }, 0)
  },
  downloadFile: (o) => {
    downloads.push(o.url)
    // 下载落地的临时文件必须登记进虚拟表，否则 getFileInfo 拿不到体积，测速/产物下载类工具会误判失败
    setTimeout(() => {
      putFile('/tmp/mock.bin', { size: 1024 * 1024, type: 'bin' })
      if (o && o.success) o.success({ statusCode: 200, tempFilePath: '/tmp/mock.bin' })
    }, 0)
  },
  // 存储
  setStorageSync: (k, v) => { store[k] = v },
  getStorageSync: (k) => (k in store ? store[k] : ''),
  removeStorageSync: (k) => { delete store[k] },
  clearStorageSync: () => { Object.keys(store).forEach((k) => delete store[k]) },
  // 媒体
  getImageInfo: (o) => {
    const f = getFile(o.src) || { width: 3000, height: 4000, type: 'jpeg' }
    setTimeout(() => { if (o && o.success) o.success({ width: f.width, height: f.height, path: o.src, type: f.type, orientation: 'up' }) }, 0)
  },
  getVideoInfo: (o) => {
    const f = getFile(o.src) || {}
    setTimeout(() => { if (o && o.success) o.success({ duration: f.duration || 30, width: f.width || 1920, height: f.height || 1080, bitrate: 4000, fps: 30 }) }, 0)
  },
  getFileInfo: (o) => {
    const f = getFile(o.filePath)
    setTimeout(() => {
      if (f && o.success) o.success({ size: f.size })
      else if (o.fail) o.fail({ errMsg: 'getFileInfo:fail no such file' })
    }, 0)
  },
  chooseMedia: (o) => setTimeout(() => {
    if (o && o.success) o.success({ type: 'image', tempFiles: [{ tempFilePath: '/tmp/mock.jpg', size: 1024 * 512, width: 3000, height: 4000, duration: 0, fileType: 'image' }] })
  }, 0),
  chooseImage: (o) => setTimeout(() => { if (o && o.success) o.success({ tempFilePaths: ['/tmp/mock.jpg'], sizeType: ['original'] }) }, 0),
  canvasToTempFilePath: (o) => {
    const canvas = o.canvas || {}
    const w = Math.round(o.destWidth || o.width || canvas.width || 0) || 1
    const h = Math.round(o.destHeight || o.height || canvas.height || 0) || 1
    const fileType = o.fileType === 'png' ? 'png' : o.fileType === 'webp' ? 'webp' : 'jpg'
    // 真机：画布空白时导出失败。不挡住的话，「画布被提前 release 成 1×1 / 根本没画」就测不出来
    if (paintOps === 0 || w <= 1 || h <= 1) {
      setTimeout(() => { if (o && o.fail) o.fail({ errMsg: 'canvasToTempFilePath:fail empty canvas' }) }, 0)
      return
    }
    const size = exportSize(fileType, o.quality, w, h)
    const ext = fileType === 'jpg' ? 'jpg' : fileType
    const p = '/tmp/out-' + ++exportSeq + '.' + ext
    putFile(p, { size: size, width: w, height: h, type: fileType === 'png' ? 'png' : fileType === 'webp' ? 'webp' : 'jpeg' })
    canvasExports.push({ path: p, fileType: fileType, quality: Number(o.quality), width: w, height: h, size: size })
    setTimeout(() => { if (o && o.success) o.success({ tempFilePath: p, width: w, height: h }) }, 0)
  },
  saveImageToPhotosAlbum: (o) => setTimeout(() => { if (o && o.success) o.success({}) }, 0),
  saveVideoToPhotosAlbum: (o) => setTimeout(() => { if (o && o.success) o.success({}) }, 0),
  compressImage: (o) => {
    const src = getFile(o.src) || { width: 1024, height: 1024, size: 1024 * 100 }
    const level = Number(o.compressLevel) || 0.5
    const size = Math.max(256, Math.round((src.width || 1024) * (src.height || 1024) * jpegBytesPerPixel(level * 95)))
    putFile('/tmp/c.jpg', { size: size, width: src.width, height: src.height, type: 'jpeg' })
    setTimeout(() => { if (o && o.success) o.success({ tempFilePath: '/tmp/c.jpg', size: size }) }, 0)
  },
  previewImage: () => {},
  getBackgroundAudioManager: () => ({ play() {}, pause() {}, stop() {}, seek() {} }),
  // 交互
  showToast: (o) => toast.push(o && o.title),
  hideToast: () => {},
  showLoading: () => {},
  hideLoading: () => {},
  showModal: (o) => { modal.push(o && o.title); setTimeout(() => { if (o && o.success) o.success({ confirm: true, cancel: false }) }, 0) },
  showActionSheet: (o) => setTimeout(() => { if (o && o.success) o.success({ tapIndex: 0 }) }, 0),
  setNavigationBarTitle: () => {},
  // 路由
  navigateTo: (o) => { nav.push(o.url); setTimeout(() => { if (o && o.success) o.success({}) }, 0) },
  redirectTo: (o) => { nav.push(o.url); setTimeout(() => { if (o && o.success) o.success({}) }, 0) },
  switchTab: (o) => { nav.push(o.url); setTimeout(() => { if (o && o.success) o.success({}) }, 0) },
  navigateBack: () => {},
  reLaunch: (o) => nav.push(o.url),
  // 其它能力
  createSelectorQuery: queryStub,
  createOffscreenCanvas: (opt) => makeCanvas(opt && opt.width, opt && opt.height),
  getLastDraw: () => lastDraw,
  getFileSystemManager: () => ({
    readFile: (o) => {
      const f = getFile(o.filePath)
      if (!f) {
        setTimeout(() => { if (o && o.fail) o.fail({ errMsg: 'readFile:fail no such file' }) }, 0)
        return
      }
      const len = Math.min(Number(o.length) || f.size, f.size)
      setTimeout(() => { if (o && o.success) o.success({ data: new ArrayBuffer(len) }) }, 0)
    },
    readFileSync: (p) => new ArrayBuffer((getFile(p) || { size: 1024 }).size),
    writeFile: (o) => {
      const buf = o.data
      const len = buf instanceof ArrayBuffer ? buf.byteLength : Buffer.byteLength(String(buf || ''))
      putFile(o.filePath, { size: len })
      setTimeout(() => { if (o && o.success) o.success({}) }, 0)
    },
    getFileInfo: (o) => {
      const f = getFile(o.filePath)
      setTimeout(() => {
        if (f && o.success) o.success({ size: f.size })
        else if (o.fail) o.fail({ errMsg: 'getFileInfo:fail' })
      }, 0)
    },
    stat: (o) => {
      const f = getFile(o.path)
      setTimeout(() => {
        if (f && o.success) o.success({ stats: { size: f.size, isFile: () => true } })
        else if (o.fail) o.fail({ errMsg: 'stat:fail' })
      }, 0)
    },
    statSync: (p) => ({ size: (getFile(p) || { size: 0 }).size, isFile: () => true }),
    unlink: (o) => {
      delete files[o.filePath]
      setTimeout(() => { if (o && o.success) o.success({}) }, 0)
    },
    access: (o) => setTimeout(() => {
      if (files[o.path]) { if (o.success) o.success({}) } else if (o.fail) o.fail({ errMsg: 'access:fail' })
    }, 0),
    mkdir: (o) => setTimeout(() => { if (o && o.success) o.success({}) }, 0),
    copyFile: (o) => {
      const f = getFile(o.srcPath) || { size: 0 }
      putFile(o.destPath, { size: f.size, width: f.width, height: f.height, type: f.type })
      setTimeout(() => { if (o && o.success) o.success({}) }, 0)
    }
  }),
  setClipboardData: (o) => setTimeout(() => { if (o && o.success) o.success({}) }, 0),
  getClipboardData: (o) => setTimeout(() => { if (o && o.success) o.success({ data: '' }) }, 0),
  vibrateShort: () => {},
  setKeepAlive: (o) => setTimeout(() => { if (o && o.success) o.success({}) }, 0),
  onCompassChange: () => {}, offCompassChange: () => {},
  startCompass: (o) => { if (o && o.success) o.success({}) }, stopCompass: (o) => { if (o && o.success) o.success({}) },
  onAccelerometerChange: () => {}, offAccelerometerChange: () => {},
  startAccelerometer: (o) => { if (o && o.success) o.success({}) }, stopAccelerometer: (o) => { if (o && o.success) o.success({}) },
  onNetworkStatusChange: () => {}, getNetworkType: (o) => { if (o && o.success) o.success({ networkType: 'wifi' }) },
  startRecord: () => {}, stopRecord: () => {},
  getRecorderManager: () => ({ start() {}, stop() {}, onPause() {}, onResume() {}, onStop() {}, onError() {}, onFrameRecorded() {} }),
  createInnerAudioContext: () => ({ play() {}, pause() {}, stop() {}, destroy() {}, onCanplay() {}, onEnded() {}, onError() {}, seek() {} }),
  createWorker: () => ({ postMessage() {}, onMessage() {} }),
  getUpdateManager: () => ({ onCheckForUpdate() {} }),
  setTabBarBadge: () => {}, removeTabBarBadge: () => {},
  onAgentHandoff: null,
  modelContext: null,
  canIUse: () => true,
  nextTick: (cb) => setTimeout(cb, 0),
  env: {},
  onError: () => {}, onUnhandledRejection: () => {}
}

/** wx.request 的按端点回包（契约形状，供云端类工具级联调用） */
function mockPayload(url) {
  if (/auth\/silent/.test(url)) return { accessToken: 'mock.access.token', refreshToken: 'mock.refresh', userId: 'u_mock_1', isNew: true }
  if (/auth\/refresh/.test(url)) return { accessToken: 'mock.access.token2', refreshToken: 'mock.refresh2' }
  if (/tools\/flags/.test(url)) return { flags: {} }
  if (/files\/init/.test(url)) return { fileId: 'f_mock', chunkSize: 4194304, uploaded: [], chunked: false }
  if (/files\/.*\/complete/.test(url)) return { fileId: 'f_mock', ready: true }
  if (/media\/tasks/.test(url)) return { id: 't_mock', taskId: 't_mock', status: 'succeeded', progress: 100, stage: 'done', result: { url: 'https://example.com/out.mp4', kind: 'video', items: [{ url: 'https://example.com/1.jpg' }], sizeMB: 8.2, meta: '720p · CRF26' } }
  if (/usage\/batch/.test(url)) return { ok: true, received: 1 }
  if (/fx\/rates/.test(url)) return { rates: { USD: 0.14, EUR: 0.13 }, updatedAt: '2026-10-13T00:00:00Z' }
  if (/ip-info/.test(url)) return { ip: '1.1.1.1', isp: 'mock', city: '杭州' }
  return { ok: true, items: [], list: [] }
}

const storage = store

global.wx = wx
global.getApp = () => ({ globalData: { userInfo: null, isLoggedIn: true, systemInfo: wx.getSystemInfoSync(), agentHandoffs: {}, takeAgentHandoff: () => null } })
global.getCurrentPages = () => []
global.Page = (cfg) => { global.__lastPage = cfg }
global.Component = (cfg) => { global.__lastComponent = cfg }
global.App = (cfg) => { global.__lastApp = cfg }
global.Behavior = (cfg) => cfg
global.console = console

seedFiles()

module.exports = {
  wx,
  store,
  storage,
  nav,
  requests,
  uploads,
  downloads,
  toast,
  modal,
  log,
  files,
  canvasExports,
  lastDrawInfo: () => lastDraw,
  paintOpsInfo: () => paintOps,
  putFile,
  getFile,
  exportSize,
  qualityToScale,
  jpegBytesPerPixel,
  reset() {
    nav.length = 0
    requests.length = 0
    uploads.length = 0
    downloads.length = 0
    toast.length = 0
    modal.length = 0
    canvasExports.length = 0
    lastDraw = null
    paintOps = 0
    exportSeq = 0
    Object.keys(files).forEach((k) => delete files[k])
    Object.keys(store).forEach((k) => delete store[k])
    seedFiles()
  }
}
