const registry = require('../../tools/registry')
const store = require('../../utils/store')
const track = require('../../utils/track')

const HOT_LIMIT = 8
const SECTION_LIMIT = 8
const RECENT_LIMIT = 8

/* ---------- registry 静态数据缓存（首屏 0 网络请求，纯本地同步计算） ---------- */
let sectionCache = null

function hexA(hex, alpha) {
  const h = String(hex || '').replace('#', '')
  const num = /^[0-9a-fA-F]{6}$/.test(h) ? parseInt(h, 16) : 0x3b5bfe
  return 'rgba(' + ((num >> 16) & 255) + ',' + ((num >> 8) & 255) + ',' + (num & 255) + ',' + alpha + ')'
}

function idOf(raw) {
  if (typeof raw === 'string') return raw
  if (raw && typeof raw === 'object') return raw.toolId || raw.id || ''
  return ''
}

function decorate(tool) {
  return {
    id: tool.id,
    name: tool.name,
    desc: tool.desc,
    icon: tool.icon,
    accent: tool.accent,
    accentSoft: hexA(tool.accent, 0.12),
    beta: tool.status === 'beta',
    fav: false
  }
}

function cachedSections() {
  if (!sectionCache) {
    sectionCache = registry
      .categories()
      .filter((c) => c.count > 0)
      .map((c) => ({
        id: c.id,
        name: c.name,
        icon: c.icon,
        accent: c.accent,
        accentSoft: hexA(c.accent, 0.14),
        count: c.count,
        hasMore: c.count > SECTION_LIMIT,
        items: registry.byCategory(c.id).slice(0, SECTION_LIMIT).map(decorate)
      }))
  }
  return sectionCache
}

function markFav(items, favIds) {
  return items.map((it) => Object.assign({}, it, { fav: favIds.indexOf(it.id) >= 0 }))
}

/* ---------- 本地用户态读取（store 返回值形态兼容 id 字符串与对象） ---------- */
function readFavIds() {
  const list = store.favorites() || []
  const out = []
  for (let i = 0; i < list.length; i++) {
    const id = idOf(list[i])
    const tool = id ? registry.get(id) : null
    if (tool && tool.status !== 'offline' && out.indexOf(id) < 0) out.push(id)
  }
  return out
}

function recentTimeMap() {
  const raw = store.get('recents', [])
  const map = {}
  if (Array.isArray(raw)) {
    for (let i = 0; i < raw.length; i++) {
      const x = raw[i]
      if (x && x.toolId) map[x.toolId] = Number(x.at) || 0
    }
  }
  return map
}

function readRecents() {
  const ids = store.recents(RECENT_LIMIT) || []
  const times = recentTimeMap()
  const out = []
  for (let i = 0; i < ids.length && out.length < RECENT_LIMIT; i++) {
    const id = idOf(ids[i])
    const tool = id ? registry.get(id) : null
    if (!tool || tool.status === 'offline') continue
    const at = times[id] || (store.usage(id) || {}).lastAt || 0
    out.push(Object.assign(decorate(tool), { timeText: relativeTime(at) }))
  }
  return out
}

function relativeTime(at) {
  const ts = Number(at) || 0
  if (!ts) return '最近'
  const diff = Math.max(0, Date.now() - ts)
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return min + ' 分钟前'
  const hour = Math.floor(min / 60)
  if (hour < 24) return hour + ' 小时前'
  const day = Math.floor(hour / 24)
  if (day < 30) return day + ' 天前'
  return '更早'
}

function greetingText() {
  const hour = new Date().getHours()
  if (hour < 6) return '夜深了，今天想处理点什么？'
  if (hour < 11) return '早上好，今天想处理点什么？'
  if (hour < 14) return '中午好，今天想处理点什么？'
  if (hour < 18) return '下午好，今天想处理点什么？'
  return '晚上好，今天想处理点什么？'
}

/* ---------- 常用工具：收藏优先 + registry.recommended 加权补足 ---------- */
function buildHot(favIds) {
  const picked = []
  const seen = {}
  for (let i = 0; i < favIds.length && picked.length < HOT_LIMIT; i++) {
    const tool = registry.get(favIds[i])
    if (tool) {
      seen[tool.id] = true
      picked.push(tool)
    }
  }
  const recommended = registry.recommended(HOT_LIMIT) || []
  for (let i = 0; i < recommended.length && picked.length < HOT_LIMIT; i++) {
    const tool = recommended[i]
    if (tool && !seen[tool.id]) {
      seen[tool.id] = true
      picked.push(tool)
    }
  }
  return picked.map(decorate)
}

Page({
  data: {
    greeting: '',
    onlineCount: 0,
    hot: [],
    recents: [],
    showRecents: false,
    sections: []
  },

  onLoad() {
    this.stateSig = ''
    this.setData(this.compose())
    this.preloadSubpackage()
  },

  onShow() {
    const tabBar = typeof this.getTabBar === 'function' ? this.getTabBar() : null
    if (tabBar && tabBar.setData) tabBar.setData({ selected: 0 })
    const sig = this.signature()
    if (sig !== this.stateSig) this.setData(this.compose())
  },

  onPullDownRefresh() {
    this.setData(this.compose())
    setTimeout(() => wx.stopPullDownRefresh(), 200)
  },

  /* 用户态签名：收藏 + 最近使用变化时才重算，避免 onShow 重复做重活 */
  signature() {
    const fav = readFavIds()
    const rec = this.data.recents.map((r) => r.id)
    return fav.join(',') + '|' + rec.join(',')
  },

  compose() {
    const favIds = readFavIds()
    const recents = readRecents()
    const hot = markFav(buildHot(favIds), favIds)
    const sections = cachedSections().map((sec) =>
      Object.assign({}, sec, { items: markFav(sec.items, favIds) })
    )
    this.stateSig = favIds.join(',') + '|' + recents.map((r) => r.id).join(',')
    return {
      greeting: greetingText(),
      onlineCount: registry.online().length,
      hot: hot,
      recents: recents,
      showRecents: recents.length > 0,
      sections: sections
    }
  },

  preloadSubpackage() {
    if (!wx.preSubpackage) return
    wx.preSubpackage({ name: 'image', fail() {} })
  },

  goSearch() {
    wx.navigateTo({ url: '/pages/search/search' })
  },

  goCategory(e) {
    const id = (e.currentTarget.dataset && e.currentTarget.dataset.id) || ''
    // store 对纯字符串键值不做 JSON 包裹，这里用对象保证 pending_category 可靠往返
    if (id) store.set('pending_category', { id: id, at: Date.now() })
    wx.switchTab({ url: '/pages/category/category' })
  },

  onToolTap(e) {
    const id = e.currentTarget.dataset.id
    if (!id) {
      // data-id 取不到＝wxml 绑定写错（如 template 未用 data 传参导致作用域为空），必须留下痕迹
      console.error('[home] onToolTap 缺少 data-id，点击无目标')
      return
    }
    track.openTool(id, 'home')
  },

  onToolLongPress(e) {
    const id = e.currentTarget.dataset.id
    const tool = id ? registry.get(id) : null
    if (!tool) return
    const faved = !!store.isFavorite(tool.id)
    wx.showActionSheet({
      itemList: faved ? ['取消收藏「' + tool.name + '」', '查看详情'] : ['收藏「' + tool.name + '」', '查看详情'],
      success: (res) => {
        if (res.tapIndex === 0) this.toggleFavorite(tool.id)
        else if (res.tapIndex === 1) this.openDetail(tool.id)
      },
      fail() {}
    })
  },

  toggleFavorite(toolId) {
    store.toggleFavorite(toolId)
    const now = !!store.isFavorite(toolId)
    this.setData(this.compose())
    wx.showToast({ title: now ? '已加入收藏' : '已取消收藏', icon: 'none' })
    track.track('tool_expose', { toolId: toolId, from: 'home_card' })
  },

  openDetail(toolId) {
    wx.navigateTo({ url: '/pages/tool-detail/tool-detail?toolId=' + toolId })
  }
})
