// listHistory —— 查看最近使用 / 收藏（requirements §7.3；接力页 /pages/mine/mine）
// 数据源：主包 utils/store.js 的本地存储键 tb_recents / tb_favorites（存储全局共享，只读不写）。
// 无 query（§7.3 定为空），scope 经 payload 传递；接力页在页内完成查看与管理。
const catalog = require('../data/catalog.js')
const PAGE_PATH = '/pages/mine/mine'

function readStorage(key) {
  try {
    if (typeof wx === 'undefined' || !wx.getStorageSync) return null
    const raw = wx.getStorageSync(key)
    if (raw === '' || raw == null) return null
    if (typeof raw !== 'string') return raw
    try { return JSON.parse(raw) } catch (e) { return raw }
  } catch (e) {
    return null
  }
}

function collectRecents(limit) {
  const list = readStorage('tb_recents')
  if (!Array.isArray(list)) return []
  const out = []
  for (let i = 0; i < list.length && out.length < limit; i++) {
    const rec = list[i]
    const tool = rec && rec.toolId ? catalog.get(rec.toolId) : null
    if (tool && tool.status !== 'offline') {
      out.push({ toolId: tool.id, name: tool.name, desc: tool.desc, category: tool.category, at: rec.at || null })
    }
  }
  return out
}

function collectFavorites(limit) {
  const map = readStorage('tb_favorites')
  if (!map || typeof map !== 'object') return []
  const entries = Object.keys(map).map((id) => ({ id, at: map[id] })).sort((a, b) => (b.at || 0) - (a.at || 0))
  const out = []
  for (let i = 0; i < entries.length && out.length < limit; i++) {
    const tool = catalog.get(entries[i].id)
    if (tool && tool.status !== 'offline') {
      out.push({ toolId: tool.id, name: tool.name, desc: tool.desc, category: tool.category, at: entries[i].at })
    }
  }
  return out
}

async function listHistory({ scope } = {}) {
  try {
    const s = scope === 'recent' || scope === 'favorites' ? scope : 'all'
    const limit = 20
    const recents = s === 'favorites' ? [] : collectRecents(limit)
    const favorites = s === 'recent' ? [] : collectFavorites(limit)

    if (!recents.length && !favorites.length) {
      return {
        isError: false,
        content: [{
          type: 'text',
          text: '用户还没有使用记录或收藏。请用一句简短话术引导用户点击下方小程序卡片进入「我的」页面，并告知可以直接从首页挑选工具（或调用 searchTools 浏览全部在线工具）。禁止编造历史记录。'
        }],
        structuredContent: { scope: s, recents: [], favorites: [], total: 0 },
        handoff: { query: '', payload: { scope: s, recents: [], favorites: [] } },
        _meta: { pagePath: PAGE_PATH }
      }
    }

    const total = recents.length + favorites.length
    return {
      isError: false,
      content: [{
        type: 'text',
        text: `已取到最近使用 ${recents.length} 条、收藏 ${favorites.length} 条。请用一句简短话术引导用户点击下方小程序卡片进入「我的」页面查看与管理，禁止以文本逐条罗列记录内容。`
      }],
      structuredContent: { scope: s, recents, favorites, total },
      handoff: { query: '', payload: { scope: s, recents, favorites } },
      _meta: { pagePath: PAGE_PATH, recents, favorites }
    }
  } catch (err) {
    console.error('[listHistory] error', err)
    return {
      isError: true,
      content: [{ type: 'text', text: `读取使用记录失败：${err.message || '未知错误'}。请引导用户在小程序「我的」页面查看。` }]
    }
  }
}

module.exports = listHistory
