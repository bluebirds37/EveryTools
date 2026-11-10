/**
 * utils/request.js —— 网络层（CONTRACT C3 / C8）
 *
 * 后端响应包固定：{ ok:true, data } | { ok:false, error:{ code, message } }
 * request() 负责解包：成功 resolve(data)，失败 reject(Error)，Error.code ∈ error.js 的码表，
 * Error.message 已是中文用户话术（页面可直接展示，禁止再拼 errMsg）。
 *
 * 行为：
 *  - auth=true 时带 Authorization: Bearer <token>
 *  - 401 → auth.refresh() 成功后重试 1 次（refresh 失败则原样抛出鉴权错误，不弹窗）
 *  - 网络失败/超时 → SERVER_UNREACHABLE / NETWORK_OFFLINE
 *  - method 一律大写；GET 参数经 encodeURIComponent 编码后再拼 query
 */

const env = require('./env')
const error = require('./error')
const store = require('./store')

const METHODS = { GET: 'GET', POST: 'POST', PUT: 'PUT', DELETE: 'DELETE', HEAD: 'HEAD' }
const AUTH_QUERY_KEYS = { token: 1, access_token: 1 }
/** 这些码不再重试（业务失败由页面处理），其余网络类错误可原样抛出 */
const JSON_TYPE = 'application/json'

function hasWx() {
  return typeof wx !== 'undefined' && !!wx.request
}

function authHeader() {
  const token = store.get('token', '')
  return typeof token === 'string' && token ? 'Bearer ' + token : ''
}

function encodeQuery(data) {
  if (!data || typeof data !== 'object') return ''
  const parts = []
  Object.keys(data).forEach(function (k) {
    const v = data[k]
    if (v === undefined || v === null || v === '') return
    if (AUTH_QUERY_KEYS[k] && !env.isDev()) return // 前端不把 token 塞进 query（后端走 header）
    const val = typeof v === 'object' ? JSON.stringify(v) : String(v)
    parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(val))
  })
  return parts.join('&')
}

/** 拼完整地址；GET 时把参数编码后附加 */
function buildUrl(url, method, data) {
  let full = env.url(url)
  if (method === 'GET') {
    const qs = encodeQuery(data)
    if (qs) full += (full.indexOf('?') >= 0 ? '&' : '?') + qs
  }
  return full
}

function pickError(body, statusCode) {
  const e = body && body.error ? body.error : {}
  let code = error.serverCode(e.code || '')
  if (!e.code) {
    // 无错误包时按 HTTP 状态兜底映射，保证话术仍然来自 message()
    if (statusCode === 401 || statusCode === 403) code = error.INTERNAL_CODES.AUTH_EXPIRED
    else if (statusCode === 404) code = error.INTERNAL_CODES.NOT_FOUND
    else if (statusCode === 408) code = error.CODES.TASK_TIMEOUT
    else if (statusCode === 413) code = error.CODES.FILE_TOO_LARGE
    else if (statusCode === 429) code = error.CODES.QUOTA_EXCEEDED
    else if (statusCode >= 500) code = error.INTERNAL_CODES.SERVER_ERROR
    else code = error.INTERNAL_CODES.UNKNOWN
  }
  const err = error.make(code, e.message ? { reason: String(e.message).slice(0, 30) } : undefined)
  err.status = statusCode
  err.serverCode = e.code || ''
  return err
}

function unwrap(res, reqId) {
  const body = res.data
  const type = typeof body
  if (res.statusCode === 401 || (body && type === 'object' && body.ok === false && body.error && /UNAUTHORIZED|TOKEN_EXPIRED/i.test(String(body.error.code)))) {
    const err = pickError(body, 401)
    err.needRefresh = true
    throw err
  }
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw pickError(type === 'object' ? body : null, res.statusCode)
  }
  if (type === 'string') {
    // 网关/代理返回 HTML 或纯文本时，绝不展示原文
    if (/^\s*</.test(body)) throw error.make(error.INTERNAL_CODES.INVALID_RESPONSE, { reason: 'HTML' })
    throw error.make(error.INTERNAL_CODES.INVALID_RESPONSE)
  }
  if (!body || type !== 'object') throw error.make(error.INTERNAL_CODES.INVALID_RESPONSE)
  if (body.ok === true) return body.data === undefined ? {} : body.data
  if (body.ok === false) throw pickError(body, res.statusCode)
  // 兼容不带响应包的接口（如 /auth/silent 直接返回对象）
  if (body.data !== undefined) return body.data
  return body
}

/**
 * 网络状态：小程序只有异步 wx.getNetworkType，没有同步接口，
 * 所以模块加载时取一次 + 监听变化，本地缓存最近状态，用于区分「无网络」与「连不上服务器」。
 */
let netType = ''
function cacheNetworkType() {
  try {
    if (typeof wx === 'undefined' || !wx.getNetworkType) return
    wx.getNetworkType({
      success: function (res) {
        netType = (res && res.networkType) || ''
      }
    })
    if (wx.onNetworkStatusChange) {
      wx.onNetworkStatusChange(function (res) {
        netType = res && res.isConnected ? res.networkType || 'unknown' : 'none'
      })
    }
  } catch (e) {
    /* 监听失败不影响请求，只是少一个离线判定 */
  }
}
cacheNetworkType()

function offlineKnown() {
  return netType === 'none'
}

function netFail(errMsg, reqId) {
  const s = String(errMsg || '')
  const code = /cancel/i.test(s) ? error.INTERNAL_CODES.CANCELED : offlineKnown() ? error.CODES.NETWORK_OFFLINE : error.CODES.SERVER_UNREACHABLE
  const err = error.make(code, { reason: s ? s.replace(/^fail\s+/, '').slice(0, 24) : '' })
  err.reqId = reqId
  return err
}

let reqSeq = 0

/** 一次原始 wx.request，带超时保护（超时后 abort 并 reject） */
function rawRequest(opt) {
  const reqId = ++reqSeq
  return new Promise(function (resolve, reject) {
    if (!hasWx()) {
      reject(error.make(error.CODES.ENGINE_UNAVAILABLE, { reason: 'no wx.request' }))
      return
    }
    let settled = false
    let task = null
    const timer = setTimeout(function () {
      if (settled) return
      settled = true
      try {
        if (task && task.abort) task.abort()
      } catch (e) {
        /* abort 失败忽略 */
      }
      reject(netFail('timeout', reqId))
    }, opt.timeout || env.TIMEOUT)

    const finish = function (fn, arg) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn(arg)
    }

    task = wx.request({
      url: opt.url,
      method: opt.method,
      data: opt.data || {},
      header: opt.header,
      timeout: opt.timeout || env.TIMEOUT,
      dataType: 'json',
      responseType: 'text',
      success: function (res) {
        finish(resolve, res)
      },
      fail: function (e) {
        finish(reject, netFail(e && e.errMsg, reqId))
      }
    })
  })
}

/**
 * 统一请求入口
 * @param {{url:string, method?:string, data?:object, auth?:boolean, timeout?:number, header?:object, silent?:boolean}} options
 * @returns {Promise<any>} resolve 解包后的 data；reject Error（带 code/message）
 */
function request(options) {
  const opt = options || {}
  const method = METHODS[String(opt.method || 'GET').toUpperCase()] || 'GET'
  const useAuth = opt.auth !== false
  const timeout = typeof opt.timeout === 'number' ? opt.timeout : env.TIMEOUT
  const url = buildUrl(opt.url, method, method === 'GET' ? opt.data : null)
  const header = Object.assign({ 'content-type': JSON_TYPE }, opt.header || {})
  if (useAuth) {
    const a = authHeader()
    if (a) header.Authorization = a
  }
  const cfg = { url: url, method: method, data: method === 'GET' ? {} : opt.data || {}, header: header, timeout: timeout }

  return rawRequest(cfg)
    .then(function (res) {
      return unwrap(res)
    })
    .catch(function (err) {
      if (!err || !err.needRefresh || !useAuth || opt._retried) throw err
      // 401：静默续期后只重试 1 次
      return require('./auth')
        .refresh()
        .then(function (ok) {
          if (!ok) throw err
          const next = Object.assign({}, opt, { _retried: true })
          return request(next)
        })
    })
}

/** 解析 uploadFile / downloadFile 这类返回字符串 body 的响应包 */
function unwrapTextBody(dataString, statusCode) {
  let body = null
  try {
    body = typeof dataString === 'string' ? JSON.parse(dataString) : dataString
  } catch (e) {
    body = null
  }
  return unwrap({ statusCode: statusCode, data: body })
}

/**
 * 分片/文件上传（multipart，字段名与 C8 的 POST /files/upload 一致）
 * @param {{url:string, filePath:string, name?:string, formData?:object, timeout?:number, auth?:boolean, onProgress?:(p:{loaded,total,percent})=>void}} options
 */
function uploadChunk(options) {
  const opt = options || {}
  const timeout = typeof opt.timeout === 'number' ? opt.timeout : 60000
  const full = env.url(opt.url)
  const formData = opt.formData || {}
  const header = {}
  if (opt.auth !== false) {
    const a = authHeader()
    if (a) header.Authorization = a
  }
  return new Promise(function (resolve, reject) {
    if (!hasWx() || !wx.uploadFile) {
      reject(error.make(error.CODES.ENGINE_UNAVAILABLE, { reason: 'no uploadFile' }))
      return
    }
    let settled = false
    const timer = setTimeout(function () {
      if (settled) return
      settled = true
      reject(netFail('timeout', 'upload'))
    }, timeout)
    const task = wx.uploadFile({
      url: full,
      filePath: opt.filePath,
      name: opt.name || 'chunk',
      formData: formData,
      header: header,
      timeout: timeout,
      success: function (res) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        try {
          resolve(unwrapTextBody(res.data, res.statusCode))
        } catch (e) {
          reject(e)
        }
      },
      fail: function (e) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(netFail(e && e.errMsg, 'upload'))
      }
    })
    if (task && typeof opt.onProgress === 'function') {
      task.onProgressUpdate(function (p) {
        try {
          opt.onProgress({ loaded: p.totalBytesSent, total: p.totalBytesExpectedToSend, percent: p.progress })
        } catch (e2) {
          /* 进度回调异常不影响上传 */
        }
      })
    }
  })
}

/**
 * 下载到临时文件（结果 URL 为后端一次性签名地址，故不再附加 Authorization）
 * @param {string} url
 * @param {{timeout?:number, header?:object}} [opts]
 * @returns {Promise<string>} tempFilePath
 */
function downloadToTemp(url, opts) {
  const o = opts || {}
  const timeout = typeof o.timeout === 'number' ? o.timeout : 60000
  const full = env.url(url)
  return new Promise(function (resolve, reject) {
    if (!hasWx() || !wx.downloadFile) {
      reject(error.make(error.CODES.ENGINE_UNAVAILABLE, { reason: 'no downloadFile' }))
      return
    }
    let settled = false
    const timer = setTimeout(function () {
      if (settled) return
      settled = true
      try {
        if (task && task.abort) task.abort()
      } catch (e) {
        /* ignore */
      }
      reject(netFail('timeout', 'download'))
    }, timeout)
    const task = wx.downloadFile({
      url: full,
      header: o.header || {},
      timeout: timeout,
      success: function (res) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (res.statusCode === 401 || res.statusCode === 403 || res.statusCode === 410) {
          reject(error.make(res.statusCode === 401 ? error.INTERNAL_CODES.AUTH_EXPIRED : error.INTERNAL_CODES.FILE_EXPIRED))
          return
        }
        if (res.statusCode !== 200 || !res.tempFilePath) {
          reject(error.make(error.CODES.SERVER_UNREACHABLE, { reason: 'HTTP ' + res.statusCode }))
          return
        }
        resolve(res.tempFilePath)
      },
      fail: function (e) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(netFail(e && e.errMsg, 'download'))
      }
    })
  })
}

module.exports = {
  request: request,
  uploadChunk: uploadChunk,
  downloadToTemp: downloadToTemp,
  buildUrl: buildUrl,
  encodeQuery: encodeQuery,
  METHODS: METHODS
}
