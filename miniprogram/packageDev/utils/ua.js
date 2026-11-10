/* packageDev/utils/ua.js —— User-Agent 规则解析（FR-DEV-06 纯逻辑，无 wx 依赖）
 * 输出：浏览器 / 内核 / 系统 / 设备类别 + 移动端判定 + 微信内置浏览器与小程序 webview 特判 + 命中规则列表。 */

const BOTS = [
  { re: /googlebot/i, name: 'Googlebot' },
  { re: /bingbot/i, name: 'Bingbot' },
  { re: /baiduspider/i, name: 'Baiduspider' },
  { re: /sogou[\s-]web[\s-]spider/i, name: 'Sogou Spider' },
  { re: /360spider|so\.com/i, name: '360 Spider' },
  { re: /yisouSpider/i, name: 'YisouSpider' },
  { re: /bytespider/i, name: 'ByteSpider' },
  { re: /twitterbot|facebookexternalhit|slackbot|telegrambot|whatsapp/i, name: '社交抓取器' },
  { re: /^\s*(curl|wget|python-requests|go-http-client|java\/|okhttp|axios|node-fetch|httpie)\//i, name: '脚本/客户端库' }
]

const BROWSER_RULES = [
  { re: /MicroMessenger\/([\d.]+)/i, name: '微信内置浏览器', version: 1, priority: 5 },
  { re: /WeChat\(App\)/i, name: '微信内置浏览器', version: 0, priority: 5 },
  { re: /wxwork\/([\d.]+)/i, name: '企业微信', version: 1, priority: 4 },
  { re: /MiniProgram/i, name: '微信小程序 webview', version: 0, priority: 1 },
  { re: /MQQBrowser\/([\d.]+)|qqbrowser\/([\d.]+)/i, name: 'QQ 浏览器', version: 1, priority: 6 },
  { re: /QQ\/([\d.]+)/i, name: 'QQ 客户端', version: 1, priority: 6 },
  { re: /UCBrowser\/([\d.]+)|UCBrowser/i, name: 'UC 浏览器', version: 1, priority: 6 },
  { re: /Quark\/([\d.]+)/i, name: '夸克浏览器', version: 1, priority: 6 },
  { re: /BIDUBrowser|BaiduApp|baidu/i, name: '百度浏览器', version: 0, priority: 7 },
  { re: /360SE|360EE|Chrome\/[\d.]+[\s\S]*360/i, name: '360 浏览器', version: 0, priority: 7 },
  { re: /LBBROWSER/i, name: '猎豹浏览器', version: 0, priority: 7 },
  { re: /EdgA?\\\v?([\d.]+)|EdgA?\/([\d.]+)/i, name: 'Microsoft Edge', version: 1, priority: 8 },
  { re: /OPiOS\/([\d.]+)/i, name: 'Opera Mini (iOS)', version: 1, priority: 8 },
  { re: /OPR\/([\d.]+)/i, name: 'Opera', version: 1, priority: 8 },
  { re: /CriOS\/([\d.]+)/i, name: 'Chrome (iOS)', version: 1, priority: 8 },
  { re: /FxiOS\/([\d.]+)/i, name: 'Firefox (iOS)', version: 1, priority: 8 },
  { re: /SamsungBrowser\/([\d.]+)/i, name: 'Samsung Internet', version: 1, priority: 9 },
  { re: /HuaweiBrowser\/([\d.]+)|HonorBrowser\/([\d.]+)/i, name: '华为/荣耀浏览器', version: 1, priority: 9 },
  { re: /VivoBrowser\/([\d.]+)/i, name: 'vivo 浏览器', version: 1, priority: 9 },
  { re: /\bMiuiBrowser\/([\d.]+)/i, name: '小米浏览器', version: 1, priority: 9 },
  { re: /Chrome\/([\d.]+)/i, name: 'Chrome', version: 1, priority: 20 },
  { re: /Firefox\/([\d.]+)/i, name: 'Firefox', version: 1, priority: 20 },
  { re: /Version\/([\d.]+)[\s\S]*Safari/i, name: 'Safari', version: 1, priority: 25 },
  { re: /Safari\/[\d.]+/i, name: 'Safari（或伪装 Safari 的容器）', version: 0, priority: 40 },
  { re: /MSIE\s([\d.]+)|Trident\/([\d.]+)/i, name: 'Internet Explorer', version: 1, priority: 30 }
]

const ENGINE_RULES = [
  { re: /Edg\//, name: 'Blink (Chromium)', hint: 'Edge Chromium' },
  { re: /OPR\/|OPiOS\//, name: 'Blink (Chromium)', hint: 'Opera' },
  { re: /MQQBrowser|MicroMessenger[\s\S]*XWEB\/(\d+)/i, name: 'XWEB (Chromium/Blink)', hint: '安卓微信 XWEB 内核' },
  { re: /UCBrowser|Quark/, name: 'U4 (Blink 系)', hint: '阿里 U4 内核' },
  { re: /Chrome\/|CriOS\/|SamsungBrowser|HuaweiBrowser|VivoBrowser|MiuiBrowser/, name: 'Blink (Chromium)', hint: 'Chromium 系' },
  { re: /Firefox\/|FxiOS\//, name: 'Gecko', hint: 'Firefox 系' },
  { re: /Trident\/|MSIE\s/, name: 'MSHTML (Trident)', hint: 'IE 内核' },
  { re: /AppleWebKit|Safari|Version\//, name: 'WebKit', hint: 'Safari / WKWebView' }
]

const OS_RULES = [
  { re: /HarmonyOS[\s\/]?([\d.]*)|hongmeng/i, name: 'HarmonyOS', version: 1 },
  { re: /CPU (?:iPhone )?OS ([\d_]+)/i, name: 'iOS', version: 1, underscore: true },
  { re: /(?:iPhone|iPad|iPod)/i, name: 'iOS', version: 0 },
  { re: /Android[\s\-]?([\d.]+)/i, name: 'Android', version: 1 },
  { re: /Windows NT (10\.0)/i, name: 'Windows 10/11', version: 0 },
  { re: /Windows NT (6\.3)/i, name: 'Windows 8.1', version: 0 },
  { re: /Windows NT (6\.2)/i, name: 'Windows 8', version: 0 },
  { re: /Windows NT (6\.1)/i, name: 'Windows 7', version: 0 },
  { re: /Windows NT ([\d.]+)/i, name: 'Windows', version: 1 },
  { re: /Windows/i, name: 'Windows', version: 0 },
  { re: /iPhone|iPad|iPod/, name: 'iOS', version: 0 },
  { re: /Mac OS X ([\d_.]+)/i, name: 'macOS', version: 1, underscore: true },
  { re: /Macintosh|MacPowerPC|Mac OS/i, name: 'macOS', version: 0 },
  { re: /CrOS/i, name: 'ChromeOS', version: 0 },
  { re: /Ubuntu|Debian|Fedora|Linux/i, name: 'Linux', version: 0 },
  { re: /OpenBSD|FreeBSD|NetBSD/i, name: 'BSD', version: 0 }
]

function versionOf(re, text, idx, underscore) {
  const m = re.exec(text)
  if (!m) return ''
  let v = ''
  for (let i = idx; i < m.length; i++) {
    if (m[i]) {
      v = m[i]
      break
    }
  }
  if (!v) return ''
  return underscore ? v.replace(/_/g, '.') : v
}

function pickBrowser(ua) {
  const sorted = BROWSER_RULES.slice().sort(function (a, b) {
    return a.priority - b.priority
  })
  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i]
    if (r.re.test(ua)) {
      return { name: r.name, version: r.version ? versionOf(r.re, ua, 1, false) : '', rule: String(r.re) }
    }
  }
  return { name: '未知浏览器', version: '', rule: '' }
}

function pickEngine(ua, browser) {
  for (let i = 0; i < ENGINE_RULES.length; i++) {
    const r = ENGINE_RULES[i]
    if (r.re.test(ua)) {
      if (r.name.indexOf('XWEB') === 0 && !/XWEB/i.test(ua)) continue
      if (/iOS|iPhone|iPad|iPod/.test(ua) && /Chromium|Blink/.test(r.name) && !/CriOS|Chrome\//i.test(ua)) {
        return { name: 'WebKit (WKWebView)', hint: 'iOS 上所有浏览器均为 WebKit', rule: String(r.re) }
      }
      if (browser === '微信内置浏览器' && /iPhone|iPad|iPod/.test(ua)) {
        return { name: 'WebKit (WKWebView)', hint: 'iOS 微信使用 WKWebView', rule: String(r.re) }
      }
      return { name: r.name, hint: r.hint || '', rule: String(r.re) }
    }
  }
  return { name: '未知内核', hint: '', rule: '' }
}

function pickOS(ua) {
  for (let i = 0; i < OS_RULES.length; i++) {
    const r = OS_RULES[i]
    if (r.re.test(ua)) {
      return { name: r.name, version: r.version ? versionOf(r.re, ua, 1, !!r.underscore) : '', rule: String(r.re) }
    }
  }
  return { name: '未知系统', version: '', rule: '' }
}

function pickDevice(ua, os) {
  const robot = BOTS.filter(function (b) {
    return b.re.test(ua)
  })[0]
  if (robot) return { type: 'robot', label: '爬虫/自动化：' + robot.name, rule: String(robot.re) }
  const mobile = /Mobile|Android|iPhone|iPod|Windows Phone|MicroMessenger|miniProgram/i.test(ua) && !/(iPad|Tablet|PlayBook|Silk)/i.test(ua)
  const tablet = /(iPad|Tablet|Silk|SM-[TP]|Pixel Slate|MatePad|MediaPad)/i.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua))
  let model = ''
  const GENERIC = /^(linux|android|mac\s?os|windows|x11|iphone|ipad|ipod|freebsd|kdesktop|u$|wv$|mobile$|tablet$|build)/i
  const paren = /\(([^)]*)\)/.exec(ua)
  if (paren) {
    const segs = paren[1]
      .split(';')
      .map(function (x) {
        return x.replace(/Build\/.*/i, '').trim()
      })
      .filter(function (x) {
        return x && !GENERIC.test(x)
      })
    if (/Android|HarmonyOS|Linux/i.test(ua)) model = segs[segs.length - 1] || ''
  }
  if (/iPhone/.test(ua)) model = model || 'iPhone'
  if (/iPad/.test(ua)) model = model || 'iPad'
  if (/iPod/.test(ua)) model = model || 'iPod touch'
  const console_ = /(PlayStation|Xbox|Nintendo|Switch)/i.test(ua)
  const tv = /(SmartTV|Tizen|BRAVIA|PhilipsTV|Android TV|VIDAA)/i.test(ua)
  let type = 'desktop'
  if (console_) type = 'console'
  else if (tv) type = 'tv'
  else if (tablet) type = 'tablet'
  else if (mobile) type = 'mobile'
  const labels = { desktop: '桌面设备', mobile: '移动手机', tablet: '平板', tv: '智能电视', console: '游戏主机', robot: '爬虫/机器人' }
  return { type: type, label: labels[type] + (model ? ' · ' + model : ''), model: model, mobile: type === 'mobile' || type === 'tablet', rule: '' }
}

function pickWechat(ua) {
  const inWechat = /MicroMessenger|WeChat\(App\)/i.test(ua)
  const wxVersion = inWechat ? versionOf(/MicroMessenger\/([\d.]+)/i, ua, 1, false) : ''
  const miniProgram = /miniProgram|wxwork-webview|MPAPP/i.test(ua) || (inWechat && /MiniProgramEnv/i.test(ua))
  const work = /wxwork\/([\d.]+)/i.test(ua)
  const xweb = versionOf(/XWEB\/(\d+)/i, ua, 1, false)
  return {
    inWechat: inWechat,
    wxVersion: wxVersion,
    miniProgram: !!miniProgram,
    work: work,
    xweb: xweb,
    note: miniProgram ? '微信小程序内 webview：JS-SDK 能力受 web-view 组件限制，登录态与域名白名单由小程序控制' : inWechat ? '微信内置浏览器：可用 JS-SDK，分享/支付需在公众号域名白名单内' : '非微信环境'
  }
}

function tokens(ua) {
  const out = []
  const sys = /\(([^)]*)\)/.exec(ua)
  if (sys) out.push({ label: '系统注释段', value: sys[1] })
  const app = /^[^\s]+\s[^\s(]+/.exec(ua)
  if (app) out.push({ label: 'Mozilla 兼容头', value: app[0] })
  const prod = /AppleWebKit\/([\d.]+)([\s\S]*)/.exec(ua)
  if (prod) out.push({ label: 'WebKit/后缀产品标记', value: prod[0].trim() })
  return out
}

/**
 * @param {string} ua
 * @returns {{ok:boolean, error?:object, browser, engine, os, device, wechat, mobile, matched, parts, summary}}
 */
function parseUA(ua) {
  const raw = String(ua == null ? '' : ua).trim()
  if (!raw) return { ok: false, error: { field: 'UA 字符串', reason: '未输入 User-Agent' } }
  if (raw.length > 1000) return { ok: false, error: { field: 'UA 字符串', reason: 'UA 长度 ' + raw.length + ' 超出 1000 字符上限' } }
  if (!/[A-Za-z]/.test(raw)) return { ok: false, error: { field: 'UA 字符串', reason: '不像 User-Agent（没有可识别的产品标记）' } }

  const browser = pickBrowser(raw)
  const engine = pickEngine(raw, browser.name)
  const os = pickOS(raw)
  const device = pickDevice(raw, os)
  const wechat = pickWechat(raw)
  const matched = []
  if (browser.rule) matched.push({ cat: '浏览器', rule: browser.rule })
  if (engine.rule) matched.push({ cat: '内核', rule: engine.rule })
  if (os.rule) matched.push({ cat: '系统', rule: os.rule })
  if (device.rule) matched.push({ cat: '设备', rule: device.rule })

  const summary = [browser.name + (browser.version ? ' ' + browser.version : ''), os.name + (os.version ? ' ' + os.version : ''), engine.name, device.label].filter(Boolean).join(' · ')

  return {
    ok: true,
    raw: raw,
    browser: browser,
    engine: engine,
    os: os,
    device: device,
    wechat: wechat,
    mobile: device.type === 'mobile' || device.type === 'tablet',
    matched: matched,
    parts: tokens(raw),
    summary: summary
  }
}

module.exports = {
  parseUA: parseUA,
  BROWSER_RULES: BROWSER_RULES,
  ENGINE_RULES: ENGINE_RULES,
  OS_RULES: OS_RULES,
  BOTS: BOTS
}
