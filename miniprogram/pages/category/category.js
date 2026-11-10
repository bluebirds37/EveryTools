const registry = require('../../tools/registry')
const store = require('../../utils/store')
const track = require('../../utils/track')

const decorateCache = {}

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
    engine: tool.engine,
    beta: tool.status === 'beta',
    fav: false
  }
}

function decoratedList(categoryId) {
  if (!decorateCache[categoryId]) {
    decorateCache[categoryId] = registry.byCategory(categoryId).map(decorate)
  }
  return decorateCache[categoryId]
}

function readFavIds() {
  const list = store.favorites() || []
  const out = []
  for (let i = 0; i < list.length; i++) {
    const id = idOf(list[i])
    if (id && out.indexOf(id) < 0) out.push(id)
  }
  return out
}

function engineLabel(engine) {
  if (engine === 'client') return '本机'
  if (engine === 'server') return '云端'
  return '自动'
}

Page({
  data: {
    tabs: [],
    activeIndex: 0,
    activeId: '',
    activeName: '',
    activeIcon: '',
    activeAccent: '',
    activeAccentSoft: '',
    total: 0,
    tools: [],
    scrollToTab: ''
  },

  onLoad(query) {
    const tabs = registry.categories()
    this.setData({ tabs: tabs, total: registry.online().length })
    const want = (query && query.category) || ''
    this.activate(want && this.indexOfCategory(want) >= 0 ? want : tabs[0].id)
  },

  onShow() {
    const tabBar = typeof this.getTabBar === 'function' ? this.getTabBar() : null
    if (tabBar && tabBar.setData) tabBar.setData({ selected: 1 })
    const pendingId = this.takePendingCategory()
    if (pendingId) {
      if (this.indexOfCategory(pendingId) >= 0) {
        this.activate(pendingId)
        return
      }
      store.remove('pending_category')
    }
    // 仅当收藏变化时重算当前分类，避免 onShow 重复做重活
    const favIds = readFavIds()
    if (favIds.join(',') !== (this.favSig || '')) this.activate(this.data.activeId)
  },

  /* 首页「查看全部」写入的跳板参数：{ id, at }，10 分钟内有效 */
  takePendingCategory() {
    const raw = store.get('pending_category', null)
    if (!raw) return ''
    const id = typeof raw === 'string' ? raw : raw.id
    const at = raw && typeof raw === 'object' ? Number(raw.at) || 0 : 0
    if (at && Date.now() - at > 10 * 60 * 1000) {
      store.remove('pending_category')
      return ''
    }
    store.remove('pending_category')
    return id || ''
  },

  indexOfCategory(categoryId) {
    const tabs = this.data.tabs
    for (let i = 0; i < tabs.length; i++) {
      if (tabs[i].id === categoryId) return i
    }
    return -1
  },

  activate(categoryId) {
    const index = this.indexOfCategory(categoryId)
    if (index < 0) return
    const tab = this.data.tabs[index]
    const favIds = readFavIds()
    const tools = decoratedList(tab.id).map((it) =>
      Object.assign({}, it, {
        fav: favIds.indexOf(it.id) >= 0,
        engineText: engineLabel(it.engine)
      })
    )
    this.favSig = favIds.join(',')
    this.setData({
      activeIndex: index,
      activeId: tab.id,
      activeName: tab.name,
      activeIcon: tab.icon,
      activeAccent: tab.accent,
      activeAccentSoft: hexA(tab.accent, 0.14),
      tools: tools,
      scrollToTab: 'tab-' + index
    })
  },

  onTabTap(e) {
    const id = e.currentTarget.dataset.id
    if (id === this.data.activeId) return
    this.activate(id)
  },

  onToolTap(e) {
    const id = e.currentTarget.dataset.id
    if (!id) {
      console.error('[category] onToolTap 缺少 data-id，点击无目标')
      return
    }
    track.openTool(id, 'category')
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
        else if (res.tapIndex === 1) wx.navigateTo({ url: '/pages/tool-detail/tool-detail?toolId=' + tool.id })
      },
      fail() {}
    })
  },

  toggleFavorite(toolId) {
    store.toggleFavorite(toolId)
    const now = !!store.isFavorite(toolId)
    this.activate(this.data.activeId)
    wx.showToast({ title: now ? '已加入收藏' : '已取消收藏', icon: 'none' })
  },

  goSearch() {
    wx.navigateTo({ url: '/pages/search/search' })
  }
})
