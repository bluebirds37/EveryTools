/**
 * utils/query.js —— handoff query 拼装与参数归一化纯函数
 *
 * 约定（对齐 ai-mode-demo）：
 * - handoff.query 必须是 string（key=value&key2=value2，值做 URL 编码）；
 *   接力页 onLoad 收到的是框架解析后的对象。
 * - ':' 是 query 值中的合法字符（如 ratio=1:1、videoToGif 时间戳），编码后还原，
 *   保持与 docs/requirements.md §7.3 映射表字面一致。
 */

/**
 * 拼装 handoff.query。跳过 undefined / null / ''。
 * @param {Object} params
 * @returns {string}
 */
function buildQuery(params) {
  const parts = []
  const keys = Object.keys(params || {})
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]
    const v = params[k]
    if (v === undefined || v === null || v === '') continue
    const encoded = String(encodeURIComponent(v)).replace(/%3A/gi, ':')
    parts.push(encodeURIComponent(k) + '=' + encoded)
  }
  return parts.join('&')
}

/**
 * 数值夹取：非法/缺省时返回 def，越界时夹取到 [min, max]。
 * @returns {number}
 */
function clampNumber(value, min, max, def) {
  let n = typeof value === 'number' ? value : Number(value)
  if (value === undefined || value === null || value === '' || !isFinite(n)) return def
  if (n < min) return min
  if (n > max) return max
  return n
}

/** 整数夹取（四舍五入） */
function clampInt(value, min, max, def) {
  const n = clampNumber(value, min, max, def)
  return Math.round(n)
}

/**
 * 枚举取值：不在 options 中时返回 def。大小写不敏感匹配。
 * @param {string} value
 * @param {string[]} options
 * @param {string} def
 * @returns {string|null} 命中值；def 也不在枚举中时返回 null（调用方走错误分支）
 */
function pickEnum(value, options, def) {
  if (value === undefined || value === null || value === '') return options.indexOf(def) >= 0 ? def : null
  const v = String(value).trim().toLowerCase()
  for (let i = 0; i < options.length; i++) {
    if (options[i].toLowerCase() === v) return options[i]
  }
  return options.indexOf(def) >= 0 ? def : null
}

/**
 * handoff 关联 ID：与 demo `LOCAL_ + Date.now()` 同思路，代表「一次 AI 发起的处理意图」，
 * 接力页可据此在 storage 中找回 payload 参数（orderId=taskId 的对话侧占位，非后端任务 ID）。
 */
function genHandoffId(prefix) {
  const p = prefix || 'AI'
  const ts = Date.now().toString(36).toUpperCase()
  let rand = Math.floor(Math.random() * 46656).toString(36).toUpperCase()
  while (rand.length < 3) rand = '0' + rand
  return p + ts + rand
}

module.exports = { buildQuery, clampNumber, clampInt, pickEnum, genHandoffId }
