const registry = require('../../../tools/registry')
const store = require('../../../utils/store')
const track = require('../../../utils/track')
const error = require('../../../utils/error')
const uautil = require('../../utils/ua')

const TOOL_ID = 'dev-ua'
const MAX_UA_CHARS = 1000

const SAMPLES = {
  wechatIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.40(0x18002832) NetType/WIFI Language/zh_CN',
  miniProgram: 'Mozilla/5.0 (Linux; Android 13; SM-A515F Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/107.0.5304.141 Mobile Safari/537.36 XWEB/5004117 MMWEBSDK/20231002 MMWEBID/1234 MicroMessenger/8.0.40.2460(0x28002835) WeChat/arm64 Weixin NetType/5G Language/zh_CN ABI/arm64 MiniProgramEnv/android',
  chromeWin: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
  safariMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
  androidChrome: 'Mozilla/5.0 (Linux; Android 12; Pixel 6 Build/SD1A.210817.023; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/119.0.0.0 Mobile Safari/537.36',
  robot: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'
}

function defaults() {
  return { ua: '', showRaw: true }
}

function buildSchema() {
  return [
    { key: 'ua', label: 'User-Agent', type: 'textarea', def: '', rows: 5, placeholder: '粘贴完整 UA 字符串（上限 ' + MAX_UA_CHARS + ' 字符）', hint: '规则表离线解析，不联网；小程序运行时读不到宿主 UA，请从浏览器/网页里复制' },
    { key: 'showRaw', label: '展示 UA 分段与命中规则', type: 'switch', def: true }
  ]
}

function validate(v) {
  const text = String(v.ua || '').trim()
  if (!text) return { code: 'INPUT_EMPTY', message: error.message('INPUT_EMPTY') }
  if (text.length > MAX_UA_CHARS) return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { field: 'UA 长度', range: '≤ ' + MAX_UA_CHARS + ' 字符（当前 ' + text.length + '）' }) }
  const parsed = uautil.parseUA(text)
  if (!parsed.ok) return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { field: parsed.error.field, reason: parsed.error.reason }) }
  return null
}

/** 本机运行环境：wx.getSystemInfo 优先，缺失时退回同步接口 */
function readEnv(callback) {
  const finish = function (info, source) {
    const rows = []
    const push = function (k, val) {
      if (val === undefined || val === null || val === '') return
      rows.push({ key: k, value: String(val) })
    }
    push('品牌', info.brand)
    push('机型', info.model)
    push('制造商', info.manufacturer)
    push('系统', info.system)
    push('平台', info.platform)
    push('微信版本', info.version)
    push('基础库', info.SDKVersion)
    push('语言', info.language)
    push('屏幕', info.screenWidth && info.screenHeight ? info.screenWidth + ' × ' + info.screenHeight + ' px' : '')
    push('可用窗口', info.windowWidth && info.windowHeight ? info.windowWidth + ' × ' + info.windowHeight + ' px' : '')
    push('像素比', info.pixelRatio)
    push('主题', info.theme === 'dark' ? '深色' : info.theme === 'light' ? '浅色' : '')
    push('微信运行环境', info.host && info.host.env ? info.host.env : '')
    callback({ rows: rows, source: source, note: '小程序运行时不提供 navigator.userAgent，以上是本机环境实际读数；UA 请在网页/浏览器内复制' })
  }
  if (typeof wx === 'undefined') {
    finish({}, 'none')
    return
  }
  if (wx.getSystemInfo) {
    try {
      wx.getSystemInfo({
        success: function (info) {
          finish(info || {}, 'getSystemInfo')
        },
        fail: function () {
          finish(pickSync(), 'getSystemInfoSync')
        }
      })
      return
    } catch (e) {
      /* 落到同步接口 */
    }
  }
  finish(pickSync(), 'getSystemInfoSync')
}

function pickSync() {
  try {
    if (wx.getSystemInfoSync) return wx.getSystemInfoSync() || {}
    const info = {}
    if (wx.getDeviceInfo) Object.assign(info, wx.getDeviceInfo() || {})
    if (wx.getWindowInfo) Object.assign(info, wx.getWindowInfo() || {})
    if (wx.getAppBaseInfo) Object.assign(info, wx.getAppBaseInfo() || {})
    return info
  } catch (e) {
    return {}
  }
}

function run(v) {
  const r = uautil.parseUA(String(v.ua).trim())
  if (!r.ok) throw error.make('PARAM_INVALID', { field: r.error.field, reason: r.error.reason })
  const kv = [
    { key: '浏览器', value: r.browser.name + (r.browser.version ? ' ' + r.browser.version : '') },
    { key: '渲染内核', value: r.engine.name },
    { key: '操作系统', value: r.os.name + (r.os.version ? ' ' + r.os.version : '') },
    { key: '设备类别', value: r.device.label },
    { key: '移动端', value: r.mobile ? '是' : '否' },
    { key: 'UA 长度', value: r.raw.length + ' 字符' }
  ]
  const wechat = []
  if (r.wechat.inWechat) {
    wechat.push({ key: '微信版本', value: r.wechat.wxVersion || '未标注' })
    wechat.push({ key: '安卓 XWEB', value: r.wechat.xweb ? 'XWEB/' + r.wechat.xweb : '未标注（iOS 微信走 WKWebView）' })
    wechat.push({ key: '环境判定', value: r.wechat.miniProgram ? '微信小程序 webview' : r.wechat.work ? '企业微信' : '微信内置浏览器' })
    wechat.push({ key: '接入提示', value: r.wechat.note })
  }
  const lines = [r.summary, '']
  lines.push('浏览器：' + r.browser.name + (r.browser.version ? ' ' + r.browser.version : ''))
  lines.push('内核：' + r.engine.name + (r.engine.hint ? '（' + r.engine.hint + '）' : ''))
  lines.push('系统：' + r.os.name + (r.os.version ? ' ' + r.os.version : ''))
  lines.push('设备：' + r.device.label + ' · ' + (r.mobile ? '移动端' : '桌面端'))
  if (r.wechat.inWechat) lines.push('微信：' + (r.wechat.miniProgram ? '小程序 webview' : '内置浏览器') + ' ' + (r.wechat.wxVersion || ''))
  lines.push('')
  lines.push('原始 UA：')
  lines.push(r.raw)
  if (v.showRaw !== false && r.matched.length) {
    lines.push('')
    lines.push('命中规则：')
    r.matched.forEach(function (m) {
      lines.push('  ' + m.cat + ' → ' + m.rule)
    })
  }
  return {
    kv: kv,
    wechat: wechat,
    wechatIn: r.wechat.inWechat,
    summary: r.summary,
    matched: r.matched,
    parts: r.parts,
    raw: r.raw,
    mobile: r.mobile,
    engineUsed: 'client',
    text: lines.join('\n'),
    meta: ''
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
    env: null,
    tips: [
      '识别维度：浏览器/客户端、渲染内核（Blink/WebKit/Gecko/Trident/XWEB/U4）、操作系统与版本、设备类别（手机/平板/桌面/电视/主机/爬虫）',
      '特判：含 MicroMessenger 判为微信内置浏览器，再按 MiniProgramEnv / miniProgram 标记细分「小程序 webview」，并给出接入注意事项；wxwork 判为企业微信',
      'iOS 上所有浏览器都是 WebKit（CriOS/FxiOS 只是外壳），内核列会按平台校正，避免误报 Blink',
      '「读取本机环境」调用 wx.getSystemInfo 展示小程序宿主真实读数；小程序运行时拿不到宿主 UA，UA 需从网页端复制',
      '识别基于规则表匹配（结果里会展示命中的正则），未覆盖的新 UA 可能只给出「未知」，不会编造'
    ],
    samples: [
      { name: 'iPhone 微信', v: { ua: SAMPLES.wechatIos } },
      { name: '安卓小程序 webview', v: { ua: SAMPLES.miniProgram } },
      { name: 'Edge / Windows', v: { ua: SAMPLES.chromeWin } },
      { name: 'Safari / macOS', v: { ua: SAMPLES.safariMac } },
      { name: 'Chrome / Android', v: { ua: SAMPLES.androidChrome } },
      { name: 'Googlebot', v: { ua: SAMPLES.robot } }
    ]
  },

  onLoad(query) {
    const tool = registry.get(TOOL_ID)
    const saved = store.params(TOOL_ID) || {}
    // UA 属于设备标识内容，只做参数记忆里的展示开关
    this.setData({ tool: tool, values: Object.assign(defaults(), { showRaw: saved.showRaw === undefined ? true : saved.showRaw }) })
    track.track('tool_open', { toolId: TOOL_ID, from: query.from || 'menu' })
  },

  onShow() {
    if (!this.data.env) this.loadEnv()
  },

  loadEnv() {
    readEnv((env) => {
      this.setData({ env: env })
    })
  },

  onParamChange(e) {
    const values = Object.assign({}, this.data.values, { [e.detail.key]: e.detail.value })
    this.setData({ values: values })
    store.saveParams(TOOL_ID, { showRaw: values.showRaw })
    if (this.data.result) this.setData({ result: null })
  },

  onRun() {
    if (this.data.busy) return
    const v = this.data.values
    const invalid = validate(v)
    if (invalid) return this.setData({ error: invalid, result: null })
    this.setData({ busy: true, error: null })
    track.track('tool_run_start', { toolId: TOOL_ID })
    const t0 = Date.now()
    try {
      const result = run(v)
      result.meta = '耗时 ' + Math.max(1, Date.now() - t0) + ' ms · 规则表离线识别 · 引擎 client'
      track.track('tool_run_success', { toolId: TOOL_ID, costMs: Date.now() - t0, engine: 'client' })
      store.bumpUsage(TOOL_ID)
      this.setData({ result: result, busy: false })
    } catch (e) {
      track.track('tool_run_fail', { toolId: TOOL_ID, code: e.code || 'TASK_FAILED' })
      this.setData({ error: { code: e.code || 'TASK_FAILED', message: error.message(e.code || 'TASK_FAILED', e.extra) }, busy: false })
    }
  },

  onSample(e) {
    const idx = Number(e.currentTarget.dataset.index)
    const values = Object.assign({}, this.data.values, this.data.samples[idx].v)
    this.setData({ values: values, result: null, error: null })
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

  onCopy(e) {
    this.copy((e.detail && e.detail.text) || (this.data.result && this.data.result.text) || '')
  },

  onCopyEnv() {
    const env = this.data.env
    if (!env || !env.rows.length) return
    this.copy(env.rows.map(function (r) {
      return r.key + ': ' + r.value
    }).join('\n'), '已复制环境信息')
  },

  onShareAppMessage() {
    return { title: 'UA 解析 · 浏览器/内核/设备识别', path: '/packageDev/pages/ua/index?toolId=' + TOOL_ID + '&from=share' }
  }
})
