const registry = require('../../../tools/registry')
const store = require('../../../utils/store')
const track = require('../../../utils/track')
const error = require('../../../utils/error')
const env = require('../../../utils/env')
const net = require('../../../utils/request')
const h = require('../../utils/http')

const TOOL_ID = 'dev-http'
const HISTORY_KEY = 'dev_http_history'
const HISTORY_MAX = 20

const METHODS = [
  { value: 'GET', label: 'GET' },
  { value: 'POST', label: 'POST' },
  { value: 'PUT', label: 'PUT' },
  { value: 'DELETE', label: 'DELETE' },
  { value: 'HEAD', label: 'HEAD' }
]

function defaults() {
  return { method: 'GET', url: '', query: '', headers: '', body: '', timeout: 15, proxy: false }
}

function buildSchema() {
  return [
    { key: 'method', label: '方法', type: 'segment', def: 'GET', options: METHODS },
    { key: 'query', label: 'Query 参数', type: 'textarea', def: '', rows: 2, placeholder: 'a=1&b=中文（自动 encodeURIComponent，禁止未编码拼接）', hint: '留空则直接用上方地址' },
    { key: 'headers', label: '请求头', type: 'textarea', def: '', rows: 3, placeholder: 'Content-Type: application/json\nAuthorization: Bearer …（也支持 JSON 写法）' },
    { key: 'body', label: '请求体', type: 'textarea', def: '', rows: 4, placeholder: '{ "key": "value" }', showIf: { key: 'method', in: ['POST', 'PUT', 'DELETE', 'PATCH'] }, hint: '上限 ' + h.MAX_BODY_CHARS + ' 字符；Content-Type 为 JSON 时先校验合法性' },
    { key: 'timeout', label: '超时', type: 'slider', def: 15, min: 2, max: 30, step: 1, unit: ' 秒' },
    { key: 'proxy', label: '后端代理（跨域/非白名单域名）', type: 'switch', def: false, hint: '关闭时走小程序本机请求，仅允许已配置的合法域名' }
  ]
}

function validate(v) {
  if (!String(v.url || '').trim()) return { code: 'INPUT_EMPTY', message: error.message('INPUT_EMPTY') }
  const u = h.normalizeUrl(v.url)
  if (!u.ok) return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { field: u.field, reason: u.reason }) }
  const hd = h.parseHeaders(v.headers)
  if (!hd.ok) return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { field: hd.field, reason: hd.reason }) }
  const bd = h.prepareBody(v.body, hd.headers, v.method)
  if (!bd.ok) return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { field: bd.field, reason: bd.reason }) }
  const t = Number(v.timeout)
  if (!isFinite(t) || t < 2 || t > 30) return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { field: '超时', range: '2–30 秒' }) }
  return null
}

function networkAlive() {
  return new Promise(function (resolve) {
    if (typeof wx === 'undefined' || !wx.getNetworkType) return resolve(true)
    try {
      wx.getNetworkType({
        success: function (res) {
          resolve(!res || res.networkType !== 'none')
        },
        fail: function () {
          resolve(true)
        }
      })
    } catch (e) {
      resolve(true)
    }
  })
}

/** 本机请求：wx.request + 全部原始响应字段（不自动 JSON 解析，交给展示层美化） */
function directRequest(job) {
  return new Promise(function (resolve, reject) {
    if (typeof wx === 'undefined' || !wx.request) {
      reject(error.make(error.CODES.ENGINE_UNAVAILABLE, { reason: '当前环境无 wx.request' }))
      return
    }
    const t0 = Date.now()
    const task = wx.request({
      url: job.url,
      method: job.method,
      data: job.body === undefined ? undefined : job.body,
      header: Object.assign({ 'content-type': 'application/json' }, job.headers),
      timeout: job.timeout,
      dataType: 'text',
      responseType: 'text',
      success: function (res) {
        resolve({ statusCode: res.statusCode, header: res.header || {}, bodyText: typeof res.data === 'string' ? res.data : JSON.stringify(res.data), duration: Date.now() - t0, engine: 'client' })
      },
      fail: function (e) {
        const msg = String((e && e.errMsg) || '')
        let code = error.normalize(e, error.CODES.SERVER_UNREACHABLE).code
        if (/domain list|url not in|invalid request/i.test(msg)) code = error.CODES.ENGINE_UNAVAILABLE
        else if (/timeout/i.test(msg)) code = error.CODES.NETWORK_OFFLINE
        const err = error.make(code, { reason: msg.replace(/^request:fail\s*/, '').slice(0, 28) })
        err.suggestProxy = code === error.CODES.ENGINE_UNAVAILABLE
        reject(err)
      }
    })
    job.abort = function () {
      try {
        if (task && task.abort) task.abort()
      } catch (e2) {
        /* 已结束 */
      }
    }
  })
}

/** 后端代理：C8 `POST /dev/proxy` → {status,statusText,headers,bodyText,bodyBytes,elapsedMs,truncated} */
function proxyRequest(job) {
  const payload = { method: job.method, url: job.url, headers: job.headers, body: job.body === undefined ? '' : job.body, timeoutMs: job.timeout }
  return net
    .request({ url: '/dev/proxy', method: 'POST', data: payload, auth: true, timeout: job.timeout + 5000 })
    .then(function (data) {
      const d = data && typeof data === 'object' ? data : {}
      if (d.status === undefined && d.statusCode === undefined && d.bodyText === undefined && d.body === undefined) {
        throw error.make(error.INTERNAL_CODES.INVALID_RESPONSE, { reason: '代理未返回 status/body' })
      }
      const raw = d.bodyText === undefined ? d.body : d.bodyText
      const bodyText = typeof raw === 'string' ? raw : raw === undefined ? '' : JSON.stringify(raw)
      return {
        statusCode: Number(d.status || d.statusCode || 0),
        header: d.headers || d.header || {},
        bodyText: bodyText,
        truncated: d.truncated === true,
        duration: Number(d.elapsedMs || d.durationMs || d.elapsed || 0),
        engine: 'server',
        upstream: d.finalUrl || d.url || ''
      }
    })
}

function shapeResponse(res) {
  const shaped = h.shapeBody(null, res.bodyText)
  const headerObj = res.header || {}
  const declared = Number(headerObj['Content-Length'] || headerObj['content-length'] || 0)
  const bytes = declared > 0 ? declared : shaped.totalBytes
  const rows = h.headerRows(headerObj)
  return {
    statusCode: res.statusCode,
    tone: h.statusTone(res.statusCode),
    durationText: h.formatMs(res.duration),
    sizeText: h.formatSize(bytes),
    truncated: shaped.truncated,
    isJson: shaped.isJson,
    bodyText: shaped.text,
    headerRows: rows.slice(0, 40),
    headerCount: rows.length,
    engine: res.engine,
    upstream: res.upstream || ''
  }
}

Page({
  data: {
    tool: null,
    values: defaults(),
    schema: buildSchema(),
    busy: false,
    result: null,
    error: null,
    history: [],
    apiBase: '',
    curl: '',
    tips: [
      '本机请求走 wx.request，微信只放行小程序后台配置过的合法域名；跨域或临时调试域名请打开「后端代理」由服务端转发',
      '后端代理会做 SSRF 防护：禁止内网地址与 10/172.192/192 段、限制响应 5MB，超限时本页会给出服务器话术',
      '响应展示状态码、耗时、大小、全部响应头与响应体，Content-Type 或内容形似 JSON 时自动缩进美化',
      '为保护凭证：只记忆方法/地址/Query/超时/代理开关，请求头与请求体不写入本地参数记忆',
      '历史记录只保存方法、地址、状态码与耗时等指标，不保存请求体和响应体正文',
      '响应超过安全展示长度会截断并提示，避免超长正文占用内存'
    ],
    samples: [
      { name: '在线 JSON', v: { method: 'GET', url: 'https://jsonplaceholder.typicode.com/todos/1', query: '', proxy: false } },
      { name: '带 Query 参数', v: { method: 'GET', url: 'https://restcountries.com/v3.1/name/china', query: 'fields=name,capital,population&fullText=false', proxy: false } },
      { name: 'POST JSON', v: { method: 'POST', url: 'https://jsonplaceholder.typicode.com/posts', headers: 'Content-Type: application/json', body: '{ "title": "工具箱", "body": "hello", "userId": 1 }', proxy: false } },
      { name: '走后端代理', v: { method: 'GET', url: 'http://127.0.0.1:8080/healthz', proxy: true } }
    ]
  },

  onLoad(query) {
    const tool = registry.get(TOOL_ID)
    const saved = store.params(TOOL_ID) || {}
    const remembered = { method: saved.method || 'GET', url: saved.url || '', query: saved.query || '', timeout: saved.timeout || 15, proxy: saved.proxy === true }
    this.setData({ tool: tool, values: Object.assign(defaults(), remembered), history: store.get(HISTORY_KEY, []) || [], apiBase: env.BASE_URL })
    track.track('tool_open', { toolId: TOOL_ID, from: query.from || 'menu' })
  },

  onUnload() {
    this.abortCurrent()
  },

  abortCurrent() {
    const job = this._job
    if (job && typeof job.abort === 'function') job.abort()
    this._job = null
  },

  onParamChange(e) {
    const values = Object.assign({}, this.data.values, { [e.detail.key]: e.detail.value })
    this.setData({ values: values })
    store.saveParams(TOOL_ID, { method: values.method, url: values.url, query: values.query, timeout: values.timeout, proxy: values.proxy })
    if (this.data.result) this.setData({ result: null })
  },

  onUrlInput(e) {
    const values = Object.assign({}, this.data.values, { url: e.detail.value })
    this.setData({ values: values })
    store.saveParams(TOOL_ID, { method: values.method, url: values.url, query: values.query, timeout: values.timeout, proxy: values.proxy })
  },

  onRun() {
    if (this.data.busy) return
    const v = this.data.values
    const invalid = validate(v)
    if (invalid) return this.setData({ error: invalid, result: null })
    this.setData({ busy: true, error: null, result: null })
    track.track('tool_run_start', { toolId: TOOL_ID, engine: v.proxy ? 'server' : 'client' })
    const t0 = Date.now()
    const hd = h.parseHeaders(v.headers)
    const url = h.appendQuery(h.normalizeUrl(v.url).url, v.query)
    const bd = h.prepareBody(v.body, hd.headers, v.method)
    const job = { method: String(v.method).toUpperCase(), url: url, headers: hd.headers, body: bd.body, timeout: Math.round(Number(v.timeout) * 1000) }
    this._job = job
    this.setData({ curl: h.toCurl(job) })
    networkAlive().then((alive) => {
      if (!alive) {
        const err = error.make(error.CODES.NETWORK_OFFLINE)
        err.engineHint = true
        throw err
      }
      return v.proxy ? proxyRequest(job) : directRequest(job)
    })
      .then((res) => {
        const shaped = shapeResponse(res)
        const cost = Date.now() - t0
        this.pushHistory({ method: job.method, url: job.url, status: shaped.statusCode, cost: shaped.duration || cost, size: shaped.sizeText, engine: shaped.engine, at: Date.now() })
        track.track('tool_run_success', { toolId: TOOL_ID, costMs: cost, engine: shaped.engine })
        store.bumpUsage(TOOL_ID)
        this.setData({
          busy: false,
          result: Object.assign(shaped, {
            requestLine: job.method + ' ' + job.url,
            costText: h.formatMs(cost),
            headerCount: shaped.headerCount,
            meta: shaped.statusCode + ' · ' + shaped.durationText + ' · ' + shaped.sizeText + ' · ' + (shaped.engine === 'server' ? '后端代理' : '本机请求')
          })
        })
      })
      .catch((e) => {
        const norm = error.normalize(e, error.CODES.SERVER_UNREACHABLE)
        track.track('tool_run_fail', { toolId: TOOL_ID, code: norm.code, engine: v.proxy ? 'server' : 'client' })
        const extra = {}
        if (v.proxy && (norm.code === error.CODES.SERVER_UNREACHABLE || norm.code === error.INTERNAL_CODES.INVALID_RESPONSE)) extra.reason = '代理端点 ' + env.BASE_URL + ' 不可用'
        else if (e && e.message) extra.reason = ''
        this.setData({
          busy: false,
          error: {
            code: norm.code,
            message: error.message(norm.code, Object.keys(extra).length ? extra : undefined),
            suggestProxy: !v.proxy && !!(e && e.suggestProxy),
            hint: !v.proxy ? '该地址可能不在小程序合法域名内，可打开「后端代理」重试' : '代理需后端 ' + env.API_PREFIX + '/dev/proxy 就绪，或在「我的-接口地址」里切换 api_base'
          }
        })
      })
      .then(() => {
        this._job = null
      })
  },

  onSample(e) {
    const idx = Number(e.currentTarget.dataset.index)
    const s = this.data.samples[idx]
    if (!s) return
    const values = Object.assign(defaults(), this.data.values, s.v)
    this.setData({ values: values, result: null, error: null })
    store.saveParams(TOOL_ID, { method: values.method, url: values.url, query: values.query, timeout: values.timeout, proxy: values.proxy })
  },

  pushHistory(item) {
    const list = (this.data.history || []).filter(function (x) {
      return !!x && (x.url !== item.url || x.method !== item.method)
    })
    list.unshift(item)
    const next = list.slice(0, HISTORY_MAX)
    store.set(HISTORY_KEY, next)
    this.setData({ history: next })
  },

  onPickHistory(e) {
    const idx = Number(e.currentTarget.dataset.index)
    const item = this.data.history[idx]
    if (!item) return
    const values = Object.assign({}, this.data.values, { method: item.method, url: item.url, proxy: item.engine === 'server' })
    this.setData({ values: values, result: null, error: null })
    store.saveParams(TOOL_ID, { method: values.method, url: values.url, query: values.query, timeout: values.timeout, proxy: values.proxy })
  },

  onClearHistory() {
    store.set(HISTORY_KEY, [])
    this.setData({ history: [] })
    wx.showToast({ title: '已清空历史', icon: 'none' })
  },

  onRetryProxy() {
    const values = Object.assign({}, this.data.values, { proxy: true })
    this.setData({ values: values, error: null })
    track.track('engine_fallback', { toolId: TOOL_ID, from: 'client', to: 'server' })
    this.onRun()
  },

  copy(text, label) {
    if (!text) return
    wx.setClipboardData({
      data: text,
      success: function () {
        wx.showToast({ title: label || '已复制', icon: 'success' })
        track.track('result_copy', { toolId: TOOL_ID })
      }
    })
  },

  onCopyBody() {
    this.copy(this.data.result ? this.data.result.bodyText : '', '已复制响应体')
  },

  onCopy(e) {
    const text = (e.detail && e.detail.text) || (this.data.result ? this.data.result.bodyText : '')
    this.copy(text, '已复制响应体')
  },

  onCopyHeaders() {
    const r = this.data.result
    if (!r) return
    this.copy(r.headerRows.map(function (x) {
      return x.key + ': ' + x.value
    }).join('\n'), '已复制响应头')
  },

  onCopyCurl() {
    this.copy(this.data.curl || '', '已复制 cURL')
  },

  onShareAppMessage() {
    return { title: 'HTTP 调试 · 状态码/耗时/响应一目了然', path: '/packageDev/pages/http/index?toolId=' + TOOL_ID + '&from=share' }
  }
})
