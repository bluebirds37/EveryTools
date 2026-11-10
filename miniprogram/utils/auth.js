/**
 * utils/auth.js —— 静默登录（CONTRACT C3 + requirements §6）
 *
 * 时序：wx.login → POST /auth/silent {code, appId} → 本地存 tb_token / tb_refresh / tb_user_id / tb_login_at
 * 关键约束：
 *  1. 前端不接收、不保存 openid（后端只下发内部 userId/accessToken）。
 *  2. 失败一律 resolve({ guest:true })：绝不 reject、绝不弹窗、绝不 wx.showToast（游客可用全部本地工具）。
 *  3. 并发去重：同一时刻多处 ensureLogin()/refresh() 共用同一个 Promise，避免重复 wx.login 与重复续期。
 */

const store = require('./store')
const error = require('./error')

const ACCESS_TTL = 2 * 60 * 60 * 1000 // 后端 access 2h
const REFRESH_BEFORE = 10 * 60 * 1000 // 提前 10 分钟续期
const KEY_TOKEN = 'token' // → tb_token
const KEY_REFRESH = 'refresh' // → tb_refresh
const KEY_USER = 'user_id' // → tb_user_id
const KEY_LOGIN_AT = 'login_at' // → tb_login_at

let pendingLogin = null
let pendingRefresh = null

function hasWx() {
  return typeof wx !== 'undefined' && !!wx.login && !!wx.request
}

function getToken() {
  const t = store.get(KEY_TOKEN, '')
  return typeof t === 'string' ? t : ''
}

function getRefreshToken() {
  const t = store.get(KEY_REFRESH, '')
  return typeof t === 'string' ? t : ''
}

function getUserId() {
  const t = store.get(KEY_USER, '')
  return typeof t === 'string' ? t : ''
}

function isLoggedIn() {
  return !!getToken()
}

function tokenAge() {
  const at = Number(store.get(KEY_LOGIN_AT, 0)) || 0
  return at ? Date.now() - at : Infinity
}

function isFresh() {
  return !!getToken() && tokenAge() < ACCESS_TTL - REFRESH_BEFORE
}

function appId() {
  try {
    if (typeof wx !== 'undefined' && wx.getAccountInfoSync) {
      const info = wx.getAccountInfoSync()
      return (info && info.miniProgram && info.miniProgram.appId) || ''
    }
  } catch (e) {
    /* 非小程序环境 */
  }
  return ''
}

function wxLoginCode() {
  return new Promise(function (resolve, reject) {
    if (!hasWx()) {
      reject(error.make(error.CODES.ENGINE_UNAVAILABLE, { reason: 'no wx.login' }))
      return
    }
    const timer = setTimeout(function () {
      reject(error.make(error.CODES.NETWORK_OFFLINE, { reason: 'wx.login 超时' }))
    }, 10000)
    wx.login({
      success: function (res) {
        clearTimeout(timer)
        if (res && res.code) resolve(res.code)
        else reject(error.make(error.INTERNAL_CODES.AUTH_EXPIRED, { reason: '无 code' }))
      },
      fail: function (e) {
        clearTimeout(timer)
        const n = error.normalize(e, error.CODES.SERVER_UNREACHABLE)
        // 用户取消/基础库拒绝：按静默失败处理，交给上层 resolve({guest:true})
        reject(n.code === error.INTERNAL_CODES.CANCELED ? error.make(error.INTERNAL_CODES.CANCELED) : error.make(error.CODES.SERVER_UNREACHABLE))
      }
    })
  })
}

/** 只保存后端下发的字段；openid/session_key 不在前端出现 */
function saveSession(data) {
  const d = data || {}
  if (!d.accessToken) return false
  store.set(KEY_TOKEN, d.accessToken)
  store.set(KEY_REFRESH, d.refreshToken || '')
  store.set(KEY_USER, d.userId || '')
  store.set(KEY_LOGIN_AT, Date.now())
  return true
}

function clearSession() {
  store.remove(KEY_TOKEN)
  store.remove(KEY_REFRESH)
  store.remove(KEY_USER)
  store.remove(KEY_LOGIN_AT)
}

/** wx.login → /auth/silent，任何异常都不抛出（返回 false） */
function silentLogin() {
  return wxLoginCode()
    .then(function (code) {
      const request = require('./request')
      return request.request({
        url: '/auth/silent',
        method: 'POST',
        data: { code: code, appId: appId(), env: require('./env').envVersion() },
        auth: false,
        timeout: 10000
      })
    })
    .then(function (data) {
      return saveSession(data)
    })
    .catch(function (e) {
      if (require('./env').isDev()) console.warn('[auth] 静默登录未完成：' + ((e && e.code) || 'UNKNOWN'))
      return false
    })
}

function sessionResult() {
  return { userId: getUserId(), accessToken: getToken(), guest: false }
}

function guestResult() {
  return { guest: true, userId: '', accessToken: '' }
}

/**
 * 确保有登录态（并发去重）
 * @param {boolean} [force] 忽略本地有效期，强制走一次续期/登录
 * @returns {Promise<{userId:string, accessToken:string, guest?:boolean}>}
 */
function ensureLogin(force) {
  if (pendingLogin) return pendingLogin
  if (!force && isFresh()) return Promise.resolve(sessionResult())

  const job = (hasWx() ? continueLogin(force) : Promise.resolve(false))
    .then(function (ok) {
      pendingLogin = null
      return ok ? sessionResult() : guestResult()
    })
    .catch(function () {
      pendingLogin = null
      return guestResult()
    })

  pendingLogin = job
  return job
}

/** access 还有效直接用；否则 refresh；refresh 失败再走一次静默登录 */
function continueLogin(force) {
  if (!force && getToken() && isFresh()) return Promise.resolve(true)
  if (getRefreshToken()) {
    return refresh().then(function (ok) {
      return ok ? true : silentLogin()
    })
  }
  return silentLogin()
}

/**
 * 用 refreshToken 换新的 access/refresh（并发去重；失败回落到静默登录）
 * @returns {Promise<boolean>} 是否拿到新的 access token
 */
function refresh() {
  if (pendingRefresh) return pendingRefresh
  const rt = getRefreshToken()
  if (!rt) return Promise.resolve(!!getToken())

  const job = Promise.resolve()
    .then(function () {
      const request = require('./request')
      return request.request({ url: '/auth/refresh', method: 'POST', data: { refreshToken: rt }, auth: false, timeout: 10000 })
    })
    .then(function (data) {
      pendingRefresh = null
      return saveSession(data)
    })
    .catch(function () {
      pendingRefresh = null
      clearSession()
      return false
    })

  pendingRefresh = job
  return job
}

function logout() {
  clearSession()
  return true
}

module.exports = {
  ensureLogin: ensureLogin,
  isLoggedIn: isLoggedIn,
  getToken: getToken,
  getRefreshToken: getRefreshToken,
  getUserId: getUserId,
  refresh: refresh,
  logout: logout,
  isFresh: isFresh
}
