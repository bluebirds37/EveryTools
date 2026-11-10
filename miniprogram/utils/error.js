/**
 * utils/error.js —— 错误码 → 用户话术（CONTRACT C3 / tools-spec §0.3）
 *
 * 硬性规则：任何面向用户的提示必须经 message()；禁止把 res.errMsg 原文展示给用户。
 * CODES 只包含契约规定的 13 个业务码；框架内部还会用到 INTERNAL_CODES 里的补充码
 * （同样走 message()，不会把技术串直接抛给 UI）。
 */

const CODES = {
  INPUT_EMPTY: 'INPUT_EMPTY',
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  UNSUPPORTED_FORMAT: 'UNSUPPORTED_FORMAT',
  IMAGE_TOO_BIG: 'IMAGE_TOO_BIG',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  TASK_TIMEOUT: 'TASK_TIMEOUT',
  TASK_FAILED: 'TASK_FAILED',
  NETWORK_OFFLINE: 'NETWORK_OFFLINE',
  PARAM_INVALID: 'PARAM_INVALID',
  NO_AUDIO_STREAM: 'NO_AUDIO_STREAM',
  SERVER_UNREACHABLE: 'SERVER_UNREACHABLE',
  ENGINE_UNAVAILABLE: 'ENGINE_UNAVAILABLE'
}

/** 框架补充码（不属于业务错误码表，但同样有中文话术） */
const INTERNAL = {
  AUTH_EXPIRED: 'AUTH_EXPIRED',
  INVALID_RESPONSE: 'INVALID_RESPONSE',
  NOT_FOUND: 'NOT_FOUND',
  SERVER_ERROR: 'SERVER_ERROR',
  TASK_CANCELED: 'TASK_CANCELED',
  FILE_EXPIRED: 'FILE_EXPIRED',
  TOOL_OFFLINE: 'TOOL_OFFLINE',
  OVER_TARGET_NOT_REACHABLE: 'OVER_TARGET_NOT_REACHABLE',
  DEVICE_UNSUPPORTED: 'DEVICE_UNSUPPORTED',
  CANCELED: 'CANCELED',
  UNKNOWN: 'UNKNOWN'
}

const TEMPLATES = {
  INPUT_EMPTY: function (extra) {
    // 各页面传的 reason 本身就是完整话术（「请输入待摘要的文本」「右侧文本为空」「输入过长…」），
    // 再拼一次「请输入」会变成「请输入输入过长」这种病句；丢了则退化成笼统提示。
    return extra && extra.reason ? String(extra.reason) : '请先选择内容'
  },
  FILE_TOO_LARGE: function (extra) {
    const mb = sizeMB(extra)
    return mb ? '文件超过 ' + mb + 'MB，请拆分或换小文件' : '文件太大了，请换个小一点的文件'
  },
  UNSUPPORTED_FORMAT: function (extra) {
    const f = fmt(extra)
    return f ? '暂不支持 ' + f + ' 格式，请换成 JPG、PNG 或 MP4' : '暂不支持该格式，请换成常见图片、视频格式'
  },
  IMAGE_TOO_BIG: '图片过大，处理失败，正在改用云端处理 / 请选择较小图片',
  PERMISSION_DENIED: function (extra) {
    return '未获得' + (extra && extra.scope ? scopeName(extra.scope) : '相关') + '权限，无法继续'
  },
  QUOTA_EXCEEDED: function (extra) {
    return extra && extra.limit
      ? '今日云端处理次数已用完（' + extra.limit + ' 次/天），明天再来'
      : '今日云端处理次数已用完，明天再来'
  },
  TASK_TIMEOUT: function (extra) {
    return '处理超时（' + ((extra && extra.seconds) || 600) + ' 秒），已保留参数，可重试'
  },
  TASK_FAILED: function (extra) {
    return extra && extra.reason ? '处理失败（' + clip(extra.reason, 28) + '），可重试或调整参数' : '处理失败，可重试或调整参数'
  },
  NETWORK_OFFLINE: '当前无网络，该工具需要联网',
  PARAM_INVALID: function (extra) {
    if (!extra) return '参数不合法，请检查后重试'
    if (extra.field && extra.range) return '参数不合法：' + extra.field + ' 应在 ' + extra.range
    if (extra.field) return '参数不合法：' + extra.field
    return '参数不合法：' + clip(extra.reason || '', 28)
  },
  NO_AUDIO_STREAM: '这个视频没有声音，无法提取音频',
  SERVER_UNREACHABLE: function (extra) {
    return extra && extra.reason ? '连不上服务器（' + clip(extra.reason, 24) + '），请稍后重试' : '连不上服务器，请检查网络后重试'
  },
  ENGINE_UNAVAILABLE: function (extra) {
    return extra && extra.reason ? '该功能暂不可用（' + clip(extra.reason, 24) + '）' : '该功能暂不可用，请稍后重试或改用其他工具'
  },
  AUTH_EXPIRED: '登录状态已过期，正在重新登录',
  INVALID_RESPONSE: '服务器返回的数据无法识别，请稍后重试',
  NOT_FOUND: '要找的内容不存在，请返回后重试',
  SERVER_ERROR: '服务器开了个小差，请稍后重试',
  TASK_CANCELED: '任务已取消',
  FILE_EXPIRED: '文件已过期（云端保留 24 小时），请重新处理',
  TOOL_OFFLINE: '该工具暂未开放，敬请期待',
  OVER_TARGET_NOT_REACHABLE: function (extra) {
    const mb = sizeMB(extra)
    return mb ? '已到最小体积 ' + mb + 'MB，无法再压更小，可尝试裁剪或降低分辨率' : '已经压到最小可达体积，无法再小'
  },
  DEVICE_UNSUPPORTED: '当前设备系统不支持该能力，可换设备再试',
  CANCELED: '已取消',
  UNKNOWN: '操作未完成，请稍后重试'
}

function clip(s, n) {
  const str = String(s || '')
  return str.length > n ? str.slice(0, n) + '…' : str
}

function sizeMB(extra) {
  if (!extra) return 0
  const bytes = extra.size != null ? extra.size : extra.max
  if (bytes == null) return 0
  return +(Number(bytes) / 1048576).toFixed(1)
}

function fmt(extra) {
  if (!extra) return ''
  const f = extra.format || extra.ext || ''
  return String(f).replace(/^\./, '').toUpperCase()
}

function scopeName(scope) {
  const map = { album: '相册', camera: '相机', record: '录音', location: '位置', writePhotosAlbum: '相册写入', clipboard: '剪贴板' }
  return map[scope] || scope || '相关'
}

/**
 * code → 中文话术
 * @param {string} code CODES / INTERNAL 的值，或后端下发的错误码
 * @param {{max?:number,size?:number,reason?:string,field?:string,range?:string,format?:string,ext?:string,scope?:string,limit?:number,seconds?:number}} [extra]
 * @returns {string} 永不为空的中文文案
 */
function message(code, extra) {
  const key = String(code || '').toUpperCase()
  const tpl = TEMPLATES[key]
  if (typeof tpl === 'function') return tpl(extra || {}) || TEMPLATES.UNKNOWN
  if (typeof tpl === 'string') return tpl
  if (extra && extra.reason) return clip('操作未完成：' + String(extra.reason), 40)
  return TEMPLATES.UNKNOWN
}

/** 生成带 code 的 Error，message 已是用户可读中文，页面可直接展示 */
function make(code, extra) {
  const err = new Error(message(code, extra))
  err.code = String(code || 'UNKNOWN').toUpperCase()
  if (extra) err.extra = extra
  return err
}

function isCode(x) {
  return !!(x && CODES[String(x).toUpperCase()])
}

const WX_CODE_MAP = [
  [/cancel/i, 'CANCELED'],
  [/auth deny|auth denied|permission|privacy/i, 'PERMISSION_DENIED'],
  [/timeout/i, 'NETWORK_OFFLINE'],
  [/fail(ed)? to load image|decode/i, 'IMAGE_TOO_BIG'],
  [/url not in domain list|invalid request/i, 'ENGINE_UNAVAILABLE'],
  [/network|net::|ERR_/i, 'SERVER_UNREACHABLE'],
  [/not support|unsupport/i, 'UNSUPPORTED_FORMAT']
]

/**
 * wx 的 errMsg / 任意异常 → 统一的 { code, message }
 * 返回的是 Error 实例（业务层可以直接 throw），code/message/extra 三个字段齐备，
 * 保证页面只需要 `setData({ error: e })` 或 `wx.showToast({ title: e.message })`。
 * @param {Error|{errMsg:string}|string} err
 * @param {string} [fallbackCode]
 * @returns {{code:string, message:string, extra?:object}} Error 实例
 */
function normalize(err, fallbackCode) {
  const out = function (code, extra) {
    const key = String(code || INTERNAL.UNKNOWN).toUpperCase()
    return make(key, extra)
  }
  if (!err) return out(fallbackCode || INTERNAL.UNKNOWN)
  if (typeof err === 'string') {
    const code = fromWxCode(err) || fallbackCode || INTERNAL.UNKNOWN
    return out(code, { reason: clip(err, 20) })
  }
  if (err.errMsg) {
    const code = fromWxCode(err.errMsg) || String(err.code || fallbackCode || INTERNAL.UNKNOWN).toUpperCase()
    return out(code, { reason: clip(err.errMsg, 20) })
  }
  const code = String(err.code || fallbackCode || INTERNAL.UNKNOWN).toUpperCase()
  // 已经是带 code 的 Error：原样透出（保留 reqId 等附加字段），否则按码重建话术
  if (err instanceof Error && err.code === code && err.message && /[\u4e00-\u9fa5]/.test(err.message)) return err
  const extra = err.extra || (err.message && code === INTERNAL.UNKNOWN ? { reason: clip(err.message, 28) } : undefined)
  return out(code, extra)
}

function fromWxCode(errMsg) {
  const s = String(errMsg || '')
  for (let i = 0; i < WX_CODE_MAP.length; i++) {
    if (WX_CODE_MAP[i][0].test(s)) return WX_CODE_MAP[i][1]
  }
  return ''
}

/** 后端错误码 → 前端错误码（后端用语义接近的码名时自动对齐） */
const SERVER_CODE_MAP = {
  UNAUTHORIZED: INTERNAL.AUTH_EXPIRED,
  TOKEN_EXPIRED: INTERNAL.AUTH_EXPIRED,
  FORBIDDEN: INTERNAL.AUTH_EXPIRED,
  NOT_FOUND: INTERNAL.NOT_FOUND,
  VALIDATION_ERROR: CODES.PARAM_INVALID,
  RATE_LIMITED: CODES.QUOTA_EXCEEDED,
  TIMEOUT: CODES.TASK_TIMEOUT,
  UPLOAD_FAILED: CODES.TASK_FAILED,
  DECODE_FAILED: CODES.IMAGE_TOO_BIG,
  EXPIRED: INTERNAL.FILE_EXPIRED
}

function serverCode(code) {
  const key = String(code || '').toUpperCase()
  if (CODES[key]) return key
  if (INTERNAL[key]) return key
  if (SERVER_CODE_MAP[key]) return SERVER_CODE_MAP[key]
  if (/NETWORK|UNREACH|DNS/.test(key)) return CODES.SERVER_UNREACHABLE
  if (/SERVER|5\d\d/.test(key)) return INTERNAL.SERVER_ERROR
  return INTERNAL.UNKNOWN
}

module.exports = {
  CODES: CODES,
  INTERNAL_CODES: INTERNAL,
  message: message,
  make: make,
  normalize: normalize,
  fromWxCode: fromWxCode,
  serverCode: serverCode,
  isCode: isCode
}
