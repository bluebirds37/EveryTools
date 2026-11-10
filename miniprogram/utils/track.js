/**
 * utils/track.js —— 埋点 + 统一跳转（CONTRACT C3）
 *
 * 队列：本地 Storage 键 tb_events（{i,e,p,t}），≥10 条或 30s 定时 POST /usage/batch。
 * 失败处理：保留队列、不重发丢失、绝不弹窗（无网络时静默堆积，最多 MAX_QUEUE 条后丢最旧）。
 * 隐私：props 里禁止出现用户内容 —— 正文/文件名/本地路径一律脱敏后才入队。
 */

const store = require('./store')
const error = require('./error')

const QUEUE_KEY = 'events' // → tb_events
const FLUSH_SIZE = 10
const FLUSH_INTERVAL = 30000
const MAX_QUEUE = 200

/** 事件白名单（超出只记 console，不入库，避免脏数据） */
const EVENTS = [
  'tool_expose',
  'tool_open',
  'tool_run_start',
  'tool_run_done',
  'tool_run_success',
  'tool_run_fail',
  'engine_fallback',
  'result_save',
  'result_copy',
  'result_share',
  'task_created',
  'task_failed',
  'ai_card_click',
  'ai_handoff_enter'
]

/** 明显承载用户内容的字段：直接丢弃 */
const DENY_KEYS = {
  content: 1,
  text: 1,
  body: 1,
  raw: 1,
  input: 1,
  output: 1,
  draft: 1,
  sql: 1,
  html: 1,
  json: 1,
  srt: 1,
  regex: 1,
  filename: 1,
  fname: 1,
  name: 1,
  title: 1,
  password: 1,
  phone: 1,
  email: 1,
  address: 1,
  keyword: 1,
  kw: 1,
  q: 1,
  query: 1
}

/** 看起来像本地/临时文件路径的值 → 替换成 '[local]'（页面路径 '/pages/...' 不受影响） */
const LOCAL_PATH_RE = /^(wxfile:|file:|http:\/\/tmp\/|http:\/\/usr\/|\/var\/|\/data\/|\/storage\/|\/tmp\/|mini:\/\/)/i

let mem = null
let inFlight = null
let timer = null
let seq = 0

function load() {
  if (mem) return mem
  const raw = store.get(QUEUE_KEY, [])
  mem = Array.isArray(raw) ? raw.filter(function (x) { return x && x.e }) : []
  return mem
}

function persist() {
  store.set(QUEUE_KEY, load().slice(-MAX_QUEUE))
}

function redact(v) {
  if (typeof v === 'string') {
    if (LOCAL_PATH_RE.test(v)) return '[local]'
    return v.length > 120 ? v.slice(0, 120) : v
  }
  if (Array.isArray(v)) return v.length
  if (v && typeof v === 'object') return Object.keys(v).length
  return v
}

function cleanProps(props) {
  const out = {}
  if (!props || typeof props !== 'object') return out
  Object.keys(props).forEach(function (k) {
    if (DENY_KEYS[k]) return
    const v = props[k]
    if (typeof v === 'function' || v === undefined || v === null) return
    out[k] = redact(v)
  })
  return out
}

/**
 * 记一个事件（同步入本地队列，异步上报）
 * @param {string} event EVENTS 之一
 * @param {object} [props] 只允许指标类字段（toolId/costMs/engine/percent…）
 */
function track(event, props) {
  const name = String(event || '')
  if (!name) return false
  if (EVENTS.indexOf(name) < 0) {
    if (require('./env').isDev()) console.warn('[track] 未登记事件名：' + name)
    return false
  }
  const q = load()
  q.push({ i: ++seq + '-' + Date.now(), e: name, p: cleanProps(props), t: Date.now() })
  if (q.length > MAX_QUEUE) q.splice(0, q.length - MAX_QUEUE)
  persist()
  if (q.length >= FLUSH_SIZE) flush()
  else arm()
  return true
}

function queueSize() {
  return load().length
}

function arm() {
  if (timer || typeof setTimeout !== 'function') return
  // 30s 定时上报：模块级 setTimeout，页面卸载不影响（app.js onShow/onHide 也会补一次 flush）
  timer = setTimeout(function () {
    timer = null
    flush()
  }, FLUSH_INTERVAL)
}

/**
 * 上报本地队列
 * @returns {Promise<boolean>} 是否真正发出并清空了这批事件
 */
function flush() {
  const q = load()
  if (!q.length) return Promise.resolve(false)
  if (inFlight) return inFlight

  const batch = q.slice(0)
  const ids = {}
  batch.forEach(function (x) {
    ids[x.i] = 1
  })
  const request = require('./request')
  const job = request
    .request({ url: '/usage/batch', method: 'POST', data: { events: batch.map(toServerShape) }, timeout: 12000 })
    .then(function () {
      mem = load().filter(function (x) { return !ids[x.i] })
      persist()
      inFlight = null
      if (mem.length >= FLUSH_SIZE) flush()
      return true
    })
    .catch(function () {
      // 失败保留队列，等下一次定时/阈值触发
      inFlight = null
      return false
    })

  inFlight = job
  return job
}

function toServerShape(x) {
  return { event: x.e, props: x.p, at: x.t }
}

/** app.json tabBar 的三个主页面：跳这些必须用 switchTab */
const TAB_PAGES = ['/pages/home/home', '/pages/category/category', '/pages/mine/mine']

function normalizePath(p) {
  const s = String(p || '')
  return s.charAt(0) === '/' ? s : '/' + s
}

function isTabPath(p) {
  return TAB_PAGES.indexOf(normalizePath(p)) >= 0
}

function withQuery(path, toolId, from) {
  const q = []
  if (path.indexOf('toolId=') < 0) q.push('toolId=' + encodeURIComponent(toolId))
  q.push('from=' + encodeURIComponent(String(from || 'menu')))
  return path + (path.indexOf('?') >= 0 ? '&' : '?') + q.join('&')
}

function navigate(path, tab) {
  return new Promise(function (resolve) {
    if (typeof wx === 'undefined') {
      resolve({ ok: false, code: error.CODES.ENGINE_UNAVAILABLE })
      return
    }
    const done = function (res) {
      resolve(res || { ok: true })
    }
    const fail = function (e) {
      const msg = String((e && e.errMsg) || '')
      // 误用 API 的兜底：navigateTo 撞上 tabBar 页 → switchTab，反之亦然
      if (/tabbar|tab bar/i.test(msg)) {
        if (wx.switchTab) wx.switchTab({ url: path, success: function () { done({ ok: true }) }, fail: function () { done({ ok: false, code: error.INTERNAL_CODES.UNKNOWN }) } })
        else done({ ok: false, code: error.INTERNAL_CODES.UNKNOWN })
        return
      }
      done({ ok: false, code: error.normalize(e, error.INTERNAL_CODES.UNKNOWN).code })
    }
    if (tab && wx.switchTab) wx.switchTab({ url: path, success: function () { done({ ok: true }) }, fail: fail })
    else if (wx.navigateTo) wx.navigateTo({ url: path, success: function () { done({ ok: true }) }, fail: fail })
    else if (wx.redirectTo) wx.redirectTo({ url: path, success: function () { done({ ok: true }) }, fail: fail })
    else done({ ok: false, code: error.CODES.ENGINE_UNAVAILABLE })
  })
}

/** registry 懒加载：tools/index.js 由他人负责，缺失时也不能把调用方（点击回调）炸掉 */
function loadRegistry() {
  try {
    return require('../tools/registry')
  } catch (e) {
    if (require('./env').isDev()) console.warn('[track] registry 不可用：' + ((e && e.message) || ''))
    return null
  }
}

/**
 * 跳转失败必须让用户看见（2026-10-14 首页点击「没反应」的根因之一是失败被静默吞掉）。
 * 话术统一走 error.message，不展示 errMsg 原文（C3）。
 */
function notifyFail(res) {
  if (typeof wx === 'undefined' || !wx.showToast) return
  const code = res && res.code
  const offline = code === error.INTERNAL_CODES.TOOL_OFFLINE
  wx.showToast({ title: offline ? '该工具暂未开放' : '打开失败，请稍后重试', icon: 'none' })
  if (!offline && require('./env').isDev()) {
    console.warn('[track] openTool 失败：' + JSON.stringify({ code: code, path: res && res.path }))
  }
}

/**
 * 统一跳转：校验 status → 埋点 → 记 recents/usage → navigateTo/switchTab
 * @param {string} toolId
 * @param {string} [from] 来源标识（menu|search|hot|share|ai|…）
 * @param {{notify?:boolean}} [opts] notify=false 时由调用方自行处理失败提示
 * @returns {Promise<{ok:boolean, code?:string, message?:string, path?:string}>} 永不 reject
 */
function openTool(toolId, from, opts) {
  const notify = !opts || opts.notify !== false
  const registry = loadRegistry()
  const fail = function (code) {
    const res = { ok: false, code: code, message: error.message(code) }
    if (notify) notifyFail(res)
    return Promise.resolve(res)
  }
  if (!registry) return fail(error.INTERNAL_CODES.TOOL_OFFLINE)
  let entry = null
  let path = ''
  try {
    entry = registry.get(toolId)
    path = registry.entryPath(toolId) || ''
  } catch (e) {
    return fail(error.INTERNAL_CODES.TOOL_OFFLINE)
  }
  if (!entry || !path || !registry.isOnline(toolId)) return fail(error.INTERNAL_CODES.TOOL_OFFLINE)
  store.touchRecent(toolId)
  store.bumpUsage(toolId)
  track('tool_open', { toolId: toolId, from: from || 'menu', engine: entry.engine })
  const target = normalizePath(path)
  return navigate(target.indexOf('?') >= 0 ? target : withQuery(target, toolId, from || 'menu'), isTabPath(target)).then(function (r) {
    if (r && r.ok) return r
    const res = Object.assign({ ok: false, path: target }, r || {})
    if (notify) notifyFail(res)
    return res
  })
}

module.exports = {
  EVENTS: EVENTS,
  FLUSH_SIZE: FLUSH_SIZE,
  FLUSH_INTERVAL: FLUSH_INTERVAL,
  track: track,
  flush: flush,
  openTool: openTool,
  queueSize: queueSize,
  isTabPath: isTabPath
}
