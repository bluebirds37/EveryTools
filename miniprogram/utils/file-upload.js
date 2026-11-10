/**
 * utils/file-upload.js —— 大文件上传（由 utils/video-task.js 拆分，C1 单文件 ≤400 行）
 *
 * 平台现实与两条路径（都实现）：
 *  A. 单文件直传：wx.uploadFile 整文件 multipart（formData 带 fileId）。
 *     小程序的 uploadFile 只接受 filePath、不能塞内存分片，直传是稳的兜底，
 *     也是 chunked=false / 小文件 / 低端机的默认选择。
 *  B. 真·分片：POST /files/init 返回 chunked=true 时启用。
 *     FileSystemManager.readFile({position,length}) 读 ArrayBuffer 分片
 *     → ① 首选：writeFile 落临时分片文件 + wx.uploadFile（对齐 C8 的 multipart POST /files/upload）
 *        ② 兜底：wx.request 以 ArrayBuffer 作 body（服务端需接受 application/octet-stream）
 *     分片 4MB、并发 2、失败重试 2 次、跳过服务端已收到的分片（FR-V-00.2 断点续传）。
 */

const request = require('./request')
const error = require('./error')
const media = require('./media')

const CHUNK_SIZE = 4 * 1024 * 1024
const MIN_CHUNK_SIZE = 2 * 1024 * 1024
const CONCURRENCY = 2
const RETRY = 2

const MIME = {
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  m4v: 'video/x-m4v',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  gif: 'image/gif',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png'
}

function hasWx() {
  return typeof wx !== 'undefined'
}

function fsManager() {
  if (!hasWx() || !wx.getFileSystemManager) return null
  try {
    return wx.getFileSystemManager()
  } catch (e) {
    return null
  }
}

function userDir() {
  try {
    if (hasWx() && wx.env && wx.env.USER_DATA_PATH) return wx.env.USER_DATA_PATH
  } catch (e) {
    /* 非小程序环境 */
  }
  return ''
}

/** 上传文件名不带用户原始名（隐私：只保留扩展名） */
function safeName(path) {
  return 'tb_' + Date.now().toString(36) + '.' + (media.extension(path) || 'bin')
}

function mimeOf(path) {
  return MIME[media.extension(path)] || 'application/octet-stream'
}

function statFile(filePath) {
  if (!filePath) return Promise.reject(error.make(error.CODES.INPUT_EMPTY))
  return media.fileSize(filePath).then(function (size) {
    if (!size) throw error.make(error.CODES.INPUT_EMPTY, { reason: '文件不可读' })
    return size
  })
}

/** C8: POST /files/init {name,size,sha256,mime} → {fileId,chunkSize,uploaded,chunked?} */
function initFile(filePath, size, sha256) {
  return request.request({
    url: '/files/init',
    method: 'POST',
    data: {
      name: safeName(filePath),
      size: size,
      // 前端无摘要能力（不引 npm 依赖），传空由服务端落地后自校验 sha256 + magic number
      sha256: sha256 || '',
      mime: mimeOf(filePath)
    },
    timeout: 20000
  })
}

function completeFile(fileId) {
  return request.request({ url: '/files/' + encodeURIComponent(fileId) + '/complete', method: 'POST', data: {}, timeout: 30000 })
}

/** 路径 A：整文件直传 */
function uploadDirect(filePath, fileId, onProgress) {
  return request.uploadChunk({
    url: '/files/upload',
    filePath: filePath,
    name: 'chunk',
    formData: { fileId: fileId, index: '0', mode: 'single' },
    timeout: 300000,
    onProgress: function (p) {
      if (typeof onProgress === 'function') onProgress(p.loaded, p.total, fileId)
    }
  })
}

function readChunk(filePath, position, length) {
  const m = fsManager()
  if (!m || typeof m.readFile !== 'function') return Promise.reject(error.make(error.CODES.ENGINE_UNAVAILABLE, { reason: '无 readFile 分片能力' }))
  return new Promise(function (resolve, reject) {
    m.readFile({
      filePath: filePath,
      position: position,
      length: length,
      success: function (res) {
        if (res && res.data) resolve(res.data)
        else reject(error.make(error.CODES.TASK_FAILED, { reason: '分片为空' }))
      },
      fail: function (e) {
        reject(error.normalize(e, error.CODES.TASK_FAILED))
      }
    })
  })
}

function writeChunkTemp(buffer, index) {
  const m = fsManager()
  const dir = userDir()
  if (!m || !dir || typeof m.writeFile !== 'function') return Promise.reject(error.make(error.CODES.ENGINE_UNAVAILABLE, { reason: '无法写临时分片' }))
  const path = dir + '/tb_chunk_' + Date.now().toString(36) + '_' + index
  return new Promise(function (resolve, reject) {
    m.writeFile({
      filePath: path,
      data: buffer,
      success: function () {
        resolve(path)
      },
      fail: function (e) {
        reject(error.normalize(e, error.CODES.ENGINE_UNAVAILABLE))
      }
    })
  })
}

function removeTemp(path) {
  const m = fsManager()
  if (!m || !path || typeof m.unlink !== 'function') return Promise.resolve(false)
  return new Promise(function (resolve) {
    m.unlink({
      filePath: path,
      success: function () {
        resolve(true)
      },
      fail: function () {
        resolve(false)
      }
    })
  })
}

/** 分片走 multipart（对齐 C8）：写临时文件 → uploadFile → 删临时文件 */
function uploadChunkViaFile(buffer, meta) {
  return writeChunkTemp(buffer, meta.index).then(function (tempPath) {
    const send = function () {
      return request.uploadChunk({
        url: '/files/upload',
        filePath: tempPath,
        name: 'chunk',
        formData: { fileId: meta.fileId, index: String(meta.index), mode: 'chunk' },
        timeout: 120000
      })
    }
    return send().then(
      function (r) {
        return removeTemp(tempPath).then(function () {
          return r
        })
      },
      function (e) {
        return removeTemp(tempPath).then(function () {
          throw e
        })
      }
    )
  })
}

/** 分片以 ArrayBuffer 作请求体直发（服务端需接受 application/octet-stream） */
function uploadChunkViaBuffer(buffer, meta) {
  if (!hasWx() || !wx.request) return Promise.reject(error.make(error.CODES.ENGINE_UNAVAILABLE))
  const store = require('./store')
  const token = store.get('token', '')
  const query = 'fileId=' + encodeURIComponent(meta.fileId) + '&index=' + encodeURIComponent(String(meta.index)) + '&mode=chunk'
  return new Promise(function (resolve, reject) {
    wx.request({
      url: request.buildUrl('/files/upload?' + query, 'POST', null),
      method: 'POST',
      header: { 'content-type': 'application/octet-stream', Authorization: token ? 'Bearer ' + token : '' },
      data: buffer,
      responseType: 'text',
      timeout: 120000,
      success: resolve,
      fail: function (e) {
        reject(error.normalize(e, error.CODES.SERVER_UNREACHABLE))
      }
    })
  })
}

/** 单片上传（含重试 2 次） */
function putChunk(filePath, meta, index, size, preferMultipart) {
  const attempt = function (n) {
    return readChunk(filePath, index * size, size)
      .then(function (buffer) {
        if (!preferMultipart) return uploadChunkViaBuffer(buffer, meta)
        return uploadChunkViaFile(buffer, meta).catch(function (e) {
          const why = String((e && e.code) || '') + String((e && e.message) || '')
          // 写临时文件/ uploadFile 不可用时退回 ArrayBuffer 直发
          if (/UNAVAILABLE/i.test(why)) return uploadChunkViaBuffer(buffer, meta)
          throw e
        })
      })
      .catch(function (e) {
        if (typeof meta.isCanceled === 'function' && meta.isCanceled()) throw e && e.code === error.INTERNAL_CODES.TASK_CANCELED ? e : error.make(error.INTERNAL_CODES.TASK_CANCELED)
        if (n < RETRY) return attempt(n + 1)
        throw error.normalize(e, error.CODES.SERVER_UNREACHABLE)
      })
  }
  return attempt(0)
}

/** 路径 B：分片上传（并发 2、跳过已传分片） */
function uploadInChunks(filePath, init, meta) {
  const total = Number(meta.totalBytes) || 0
  const raw = Number(init.chunkSize) || CHUNK_SIZE
  const size = Math.max(MIN_CHUNK_SIZE, Math.round(raw / MIN_CHUNK_SIZE) * MIN_CHUNK_SIZE)
  const count = Math.max(1, Math.ceil(total / size))
  const doneFlags = {}
  const uploadedList = Array.isArray(init.uploaded) ? init.uploaded : []
  uploadedList.forEach(function (i) {
    doneFlags[Number(i)] = 1
  })
  const queue = []
  for (let i = 0; i < count; i++) {
    if (!doneFlags[i]) queue.push(i)
  }
  let sent = Object.keys(doneFlags).reduce(function (n, k) {
    const idx = Number(k)
    return n + Math.min(size, total - idx * size)
  }, 0)
  const concurrency = Number(meta.concurrency) > 0 ? Number(meta.concurrency) : CONCURRENCY
  const preferMultipart = init.multipart !== false
  let failed = null

  const worker = function () {
    if (failed || (typeof meta.isCanceled === 'function' && meta.isCanceled())) return Promise.resolve()
    const index = queue.shift()
    if (index == null) return Promise.resolve()
    return putChunk(filePath, meta, index, size, preferMultipart)
      .then(function () {
        if (typeof meta.isCanceled === 'function' && meta.isCanceled()) {
          failed = error.make(error.INTERNAL_CODES.TASK_CANCELED)
          return
        }
        sent += Math.min(size, total - index * size)
        if (typeof meta.onProgress === 'function') meta.onProgress(sent, total, meta.fileId)
        return worker()
      })
      .catch(function (e) {
        failed = error.normalize(e, error.CODES.SERVER_UNREACHABLE)
      })
  }

  const workers = []
  const n = Math.min(concurrency, Math.max(1, queue.length))
  for (let i = 0; i < n; i++) workers.push(worker())
  return Promise.all(workers).then(function () {
    if (failed) throw failed
    if (typeof meta.isCanceled === 'function' && meta.isCanceled()) throw error.make(error.INTERNAL_CODES.TASK_CANCELED)
    return { chunks: count, bytes: sent }
  })
}

/**
 * 高层入口：init → 选择路径 A/B → 返回 fileId
 * @param {{filePath:string, chunked?:boolean, concurrency?:number, sha256?:string,
 *          isCanceled?:()=>boolean, onProgress?:(loaded:number,total:number)=>void}} opt
 * @returns {Promise<{fileId:string,size:number,init:object,mode:string}>}
 */
function uploadMediaFile(opt) {
  const o = opt || {}
  if (!o.filePath) return Promise.reject(error.make(error.CODES.INPUT_EMPTY))
  let size = 0
  let init = null
  return statFile(o.filePath)
    .then(function (bytes) {
      size = bytes
      return initFile(o.filePath, size, o.sha256)
    })
    .then(function (res) {
      init = res || {}
      if (!init.fileId) throw error.make(error.CODES.SERVER_UNREACHABLE, { reason: 'init 无 fileId' })
      const wantChunks = (o.chunked === true || (o.chunked !== false && init.chunked === true)) && size > CHUNK_SIZE
      if (!wantChunks) {
        return uploadDirect(o.filePath, init.fileId, o.onProgress).then(function () {
          return { fileId: init.fileId, size: size, init: init, mode: 'single' }
        })
      }
      return uploadInChunks(o.filePath, init, {
        fileId: init.fileId,
        totalBytes: size,
        concurrency: o.concurrency,
        isCanceled: o.isCanceled,
        onProgress: o.onProgress
      }).then(function () {
        return { fileId: init.fileId, size: size, init: init, mode: 'chunk' }
      })
    })
}

module.exports = {
  CHUNK_SIZE: CHUNK_SIZE,
  MIN_CHUNK_SIZE: MIN_CHUNK_SIZE,
  CONCURRENCY: CONCURRENCY,
  RETRY: RETRY,
  statFile: statFile,
  initFile: initFile,
  completeFile: completeFile,
  uploadDirect: uploadDirect,
  uploadInChunks: uploadInChunks,
  uploadChunkViaFile: uploadChunkViaFile,
  uploadChunkViaBuffer: uploadChunkViaBuffer,
  readChunk: readChunk,
  writeChunkTemp: writeChunkTemp,
  removeTemp: removeTemp,
  safeName: safeName,
  mimeOf: mimeOf,
  uploadMediaFile: uploadMediaFile
}
