/**
 * utils/store.js —— 本地数据层（CONTRACT C3）
 *
 * 所有键统一加 'tb_' 前缀（app.js 里 store.set('tool_flags', …) 实际写 'tb_tool_flags'）。
 * 值一律 JSON 序列化；读取容错：解析失败/结构不符返回默认值，绝不抛异常。
 * 语义：
 *   tb_favorites  { [toolId]: addedAt }        收藏（数组输出按时间倒序）
 *   tb_recents    [{toolId,at}]                最近使用（内部保留 30 条，读取可 limit）
 *   tb_params     { [toolId]: {…} }            FR-COM-11 参数记忆
 *   tb_usage      { [toolId]: {count,lastAt} } 使用次数
 */

const PREFIX = 'tb_'

const FAV_KEY = 'favorites'
const RECENT_KEY = 'recents'
const PARAM_KEY = 'params'
const USAGE_KEY = 'usage'

const RECENT_KEEP = 30
const PARAM_KEEP = 120

function hasWx() {
  return typeof wx !== 'undefined' && !!wx.getStorageSync && !!wx.setStorageSync
}

function parseOr(raw, def) {
  if (raw === '' || raw == null) return def
  if (typeof raw !== 'string') return raw
  try {
    const v = JSON.parse(raw)
    return v == null ? def : v
  } catch (e) {
    return raw
  }
}

function stringify(val) {
  // 始终 JSON 包裹：纯字符串若不转义，读回时 JSON.parse 会抛错并退化成默认值
  try {
    return JSON.stringify(val === undefined ? null : val)
  } catch (e) {
    return 'null'
  }
}

function get(key, def) {
  if (!hasWx()) return def
  let raw
  try {
    raw = wx.getStorageSync(PREFIX + key)
  } catch (e) {
    return def
  }
  const v = parseOr(raw, def)
  return v === undefined ? def : v
}

function set(key, val) {
  if (!hasWx()) return false
  try {
    wx.setStorageSync(PREFIX + key, stringify(val))
    return true
  } catch (e) {
    console.warn('[store] 写入失败 ' + PREFIX + key, e && e.errMsg)
    return false
  }
}

function remove(key) {
  if (!hasWx()) return false
  try {
    if (wx.removeStorageSync) wx.removeStorageSync(PREFIX + key)
    else wx.setStorageSync(PREFIX + key, '')
    return true
  } catch (e) {
    return false
  }
}

/* ---------------- 结构化读写（带类型容错） ---------------- */

function readMap(key) {
  const v = get(key, {})
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
}

function readList(key) {
  const v = get(key, [])
  return Array.isArray(v) ? v : []
}

/** 收藏 map：{ [toolId]: addedAt }，给「一次读取批量判断」的场景用 */
function favoritesMap() {
  return readMap(FAV_KEY)
}

/** 收藏的工具 id 列表（新收藏在前） */
function favorites() {
  const map = favoritesMap()
  return Object.keys(map)
    .sort(function (a, b) {
      return (Number(map[b]) || 0) - (Number(map[a]) || 0)
    })
    .filter(function (id) {
      return !!map[id]
    })
}

function isFavorite(toolId) {
  return !!favoritesMap()[toolId]
}

/** @returns {boolean} 切换后的收藏状态 */
function toggleFavorite(toolId) {
  if (!toolId) return false
  const map = favoritesMap()
  if (map[toolId]) delete map[toolId]
  else map[toolId] = Date.now()
  set(FAV_KEY, map)
  return !!map[toolId]
}

/** 最近使用的记录 [{toolId,at}]，页面自行 registry.get(toolId) */
function recentsDetail(limit) {
  const list = readList(RECENT_KEY).filter(function (x) {
    return x && x.toolId
  })
  return typeof limit === 'number' ? list.slice(0, limit) : list
}

/** 最近使用的工具 id 列表（最近在前） */
function recents(limit) {
  return recentsDetail(typeof limit === 'number' ? limit : 12).map(function (x) {
    return x.toolId
  })
}

function touchRecent(toolId) {
  if (!toolId) return recents()
  const list = readList(RECENT_KEY).filter(function (x) {
    return x && x.toolId && x.toolId !== toolId
  })
  list.unshift({ toolId: toolId, at: Date.now() })
  set(RECENT_KEY, list.slice(0, RECENT_KEEP))
  return recents()
}

function clearRecents() {
  return set(RECENT_KEY, [])
}

/** 上次的参数（FR-COM-11），无记录返回 {} */
function params(toolId) {
  const v = readMap(PARAM_KEY)[toolId]
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
}

function saveParams(toolId, obj) {
  if (!toolId || !obj || typeof obj !== 'object') return false
  const all = readMap(PARAM_KEY)
  all[toolId] = obj
  const keys = Object.keys(all)
  if (keys.length > PARAM_KEEP) {
    keys.slice(0, keys.length - PARAM_KEEP).forEach(function (k) {
      delete all[k]
    })
  }
  return set(PARAM_KEY, all)
}

function usage(toolId) {
  const u = readMap(USAGE_KEY)[toolId]
  return u && typeof u === 'object' ? { count: Number(u.count) || 0, lastAt: Number(u.lastAt) || 0 } : { count: 0, lastAt: 0 }
}

function bumpUsage(toolId) {
  if (!toolId) return usage(toolId)
  const all = readMap(USAGE_KEY)
  const cur = all[toolId] && typeof all[toolId] === 'object' ? all[toolId] : { count: 0, lastAt: 0 }
  cur.count = (Number(cur.count) || 0) + 1
  cur.lastAt = Date.now()
  all[toolId] = cur
  set(USAGE_KEY, all)
  return usage(toolId)
}

/** 总使用次数（首页「你已经用了 N 次」） */
function usageTotal() {
  const all = readMap(USAGE_KEY)
  return Object.keys(all).reduce(function (n, k) {
    return n + (Number(all[k] && all[k].count) || 0)
  }, 0)
}

/** 清空用户本地数据（「我的」页设置项）；保留 token 与埋点队列 */
function clearUserData() {
  remove(FAV_KEY)
  remove(RECENT_KEY)
  remove(PARAM_KEY)
  remove(USAGE_KEY)
  return true
}

module.exports = {
  PREFIX: PREFIX,
  get: get,
  set: set,
  remove: remove,
  favorites: favorites,
  favoritesMap: favoritesMap,
  isFavorite: isFavorite,
  toggleFavorite: toggleFavorite,
  recents: recents,
  recentsDetail: recentsDetail,
  touchRecent: touchRecent,
  clearRecents: clearRecents,
  params: params,
  saveParams: saveParams,
  usage: usage,
  usageTotal: usageTotal,
  bumpUsage: bumpUsage,
  clearUserData: clearUserData
}
