const registry = require('../../tools/registry')
const store = require('../../utils/store')
const track = require('../../utils/track')
const auth = require('../../utils/auth')
const env = require('../../utils/env')

const RECENT_LIMIT = 12
const CACHE_KEY_PREFIXES = ['tb_cache', 'tb_events']

const PRIVACY_TEXT =
  '通用工具箱仅收集两类信息：\n' +
  '1. 微信 openid（用于静默登录与限额，不关联手机号、通讯录与位置）\n' +
  '2. 你主动点击「保存/上传」的工具文件\n\n' +
  '图片压缩、裁剪、二维码、文本与换算类工具在本机完成，内容不出设备；' +
  '云端处理的文件由服务器加密存放，24 小时自动删除，不做二次使用。\n' +
  '收藏、最近使用、搜索历史只保存在你的手机本地。'

function idOf(raw) {
  if (typeof raw === 'string') return raw
  if (raw && typeof raw === 'object') return raw.toolId || raw.id || ''
  return ''
}

function hexA(hex, alpha) {
  const h = String(hex || '').replace('#', '')
  const num = /^[0-9a-fA-F]{6}$/.test(h) ? parseInt(h, 16) : 0x3b5bfe
  return 'rgba(' + ((num >> 16) & 255) + ',' + ((num >> 8) & 255) + ',' + (num & 255) + ',' + alpha + ')'
}

function hash(str) {
  let h = 0
  const text = String(str || '')
  for (let i = 0; i < text.length; i++) {
    h = (h * 31 + text.charCodeAt(i)) >>> 0
  }
  return h
}

function palette() {
  const colors = registry.categories().map((c) => c.accent)
  return colors.length ? colors : ['#3B5BFE']
}

function clockTime(ts) {
  const tsNum = Number(ts) || 0
  if (!tsNum) return ''
  const d = new Date(tsNum)
  const pad = (n) => (n < 10 ? '0' + n : '' + n)
  const today = new Date()
  const sameDay = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate()
  if (sameDay) return pad(d.getHours()) + ':' + pad(d.getMinutes())
  return pad(d.getMonth() + 1) + '/' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}

function relativeTime(at) {
  const ts = Number(at) || 0
  if (!ts) return '最近使用'
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

function decorate(tool) {
  return {
    id: tool.id,
    name: tool.name,
    desc: tool.desc,
    icon: tool.icon,
    accent: tool.accent,
    accentSoft: hexA(tool.accent, 0.12),
    beta: tool.status === 'beta'
  }
}

function storageKeys() {
  try {
    const info = wx.getStorageInfoSync()
    return info && info.keys ? info.keys : []
  } catch (e) {
    return []
  }
}

function cacheKeyCount() {
  const keys = storageKeys()
  let count = 0
  for (let i = 0; i < keys.length; i++) {
    for (let j = 0; j < CACHE_KEY_PREFIXES.length; j++) {
      if (keys[i].indexOf(CACHE_KEY_PREFIXES[j]) === 0) {
        count++
        break
      }
    }
  }
  return count
}

function storageSizeKB() {
  try {
    const info = wx.getStorageInfoSync()
    return Number(info && info.currentSize) || 0
  } catch (e) {
    return 0
  }
}

function readFavorites() {
  const list = store.favorites() || []
  const out = []
  for (let i = 0; i < list.length; i++) {
    const id = idOf(list[i])
    const tool = id ? registry.get(id) : null
    if (tool && tool.status !== 'offline') out.push(decorate(tool))
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
    const at = times[id] || 0
    const usage = store.usage(tool.id) || {}
    out.push(
      Object.assign(decorate(tool), {
        timeText: relativeTime(at),
        clockText: clockTime(at),
        useText: (Number(usage.count) || 0) > 0 ? '用过 ' + (Number(usage.count) || 0) + ' 次' : tool.desc
      })
    )
  }
  return out
}

Page({
  data: {
    avatarChar: '游',
    avatarBg: '',
    avatarSoft: '',
    stateDesc: '无需手机号，工具全部免费使用',
    loggedIn: false,
    favorites: [],
    favCount: 0,
    recents: [],
    recentCount: 0,
    base: '',
    version: '',
    onlineCount: 0,
    canEditBase: false,
    cells: []
  },

  onLoad() {
    this.stateSig = ''
    this.setData({ version: env.VERSION, base: env.BASE_URL, canEditBase: !!env.isDev() })
    this.applyState()
  },

  onShow() {
    const tabBar = typeof this.getTabBar === 'function' ? this.getTabBar() : null
    if (tabBar && tabBar.setData) tabBar.setData({ selected: 2 })
    const sig = this.signature()
    if (sig !== this.stateSig) this.applyState()
  },

  signature() {
    const fav = readFavorites().map((f) => f.id).join(',')
    const rec = readRecents().map((r) => r.id).join(',')
    return fav + '|' + rec + '|' + (auth.isLoggedIn() ? 1 : 0)
  },

  applyState() {
    const favorites = readFavorites()
    const recents = readRecents()
    const loggedIn = !!auth.isLoggedIn()
    const userId = this.currentUserId()
    const colors = palette()
    const accent = userId ? colors[hash(userId) % colors.length] : colors[colors.length - 1]
    this.stateSig = favorites.map((f) => f.id).join(',') + '|' + recents.map((r) => r.id).join(',') + '|' + (loggedIn ? 1 : 0)
    this.setData({
      avatarChar: userId ? String(userId).charAt(0).toUpperCase() : '游',
      avatarBg: accent,
      avatarSoft: hexA(accent, 0.14),
      loggedIn: loggedIn,
      stateDesc: '无需手机号，工具全部免费使用',
      favorites: favorites,
      favCount: favorites.length,
      recents: recents,
      recentCount: recents.length,
      onlineCount: registry.online().length,
      cells: [
        { key: 'clear-cache', icon: 'close', title: '清除缓存', value: cacheKeyCount() + ' 项', hint: '临时文件与待上报事件' },
        { key: 'base', icon: 'cloud', title: '服务地址', value: this.data.base, hint: this.data.canEditBase ? '长按可修改（开发版）' : '正式版只读，点击复制' },
        { key: 'privacy', icon: 'lock', title: '隐私政策', value: '', hint: '本地优先，24 小时自动删除' },
        { key: 'version', icon: 'info', title: '版本与工具数', value: env.VERSION, hint: '在线工具 ' + registry.online().length + ' 个' }
      ]
    })
  },

  currentUserId() {
    const app = typeof getApp === 'function' ? getApp() : null
    const fromApp = app && app.globalData && app.globalData.userInfo ? app.globalData.userInfo.userId : ''
    if (fromApp) return String(fromApp)
    // store.get 对纯字符串走 JSON 解析，这里按 C3 约定键名直接读取原始值
    try {
      const raw = wx.getStorageSync('tb_user_id')
      if (typeof raw === 'string' && raw) return raw
    } catch (e) {
      console.warn('[mine] 读取 tb_user_id 失败')
    }
    return ''
  },

  onToolTap(e) {
    const id = e.currentTarget.dataset.id
    if (!id) {
      console.error('[mine] onToolTap 缺少 data-id，点击无目标')
      return
    }
    track.openTool(id, 'mine')
  },

  onToolLongPress(e) {
    const id = e.currentTarget.dataset.id
    const tool = id ? registry.get(id) : null
    if (!tool) return
    const faved = !!store.isFavorite(tool.id)
    wx.showActionSheet({
      itemList: faved ? ['取消收藏「' + tool.name + '」', '查看详情'] : ['收藏「' + tool.name + '」', '查看详情'],
      success: (res) => {
        if (res.tapIndex === 0) {
          store.toggleFavorite(tool.id)
          this.applyState()
          wx.showToast({ title: store.isFavorite(tool.id) ? '已加入收藏' : '已取消收藏', icon: 'none' })
        } else if (res.tapIndex === 1) {
          wx.navigateTo({ url: '/pages/tool-detail/tool-detail?toolId=' + tool.id })
        }
      },
      fail() {}
    })
  },

  goCategory() {
    wx.switchTab({ url: '/pages/category/category' })
  },

  onCellTap(e) {
    const key = e.currentTarget.dataset.key
    if (key === 'clear-cache') this.onClearCache()
    else if (key === 'base') this.showBase()
    else if (key === 'privacy') this.showPrivacy()
    else if (key === 'version') this.showVersion()
  },

  onCellLongPress(e) {
    const key = e.currentTarget.dataset.key
    if (key === 'base') this.editBase()
  },

  showBase() {
    if (this.data.canEditBase) {
      this.editBase()
      return
    }
    wx.setClipboardData({
      data: this.data.base,
      success: () => wx.showToast({ title: '服务地址已复制', icon: 'none' }),
      fail: () => wx.showToast({ title: this.data.base, icon: 'none' })
    })
  },

  editBase() {
    if (!this.data.canEditBase) {
      wx.showToast({ title: '仅开发版可修改服务地址', icon: 'none' })
      return
    }
    wx.showModal({
      title: '修改服务地址',
      editable: true,
      placeholderText: 'https://example.com/api/v1',
      content: this.data.base,
      success: (res) => {
        if (!res.confirm) return
        const raw = String(res.content || '').trim()
        if (!/^https?:\/\//.test(raw)) {
          wx.showToast({ title: '地址需以 http(s):// 开头', icon: 'none' })
          return
        }
        const url = raw.replace(/\/+$/, '')
        wx.setStorageSync('api_base', url)
        this.setData({ base: url })
        this.applyState()
        wx.showToast({ title: '已保存，重启生效', icon: 'none' })
      }
    })
  },

  onClearCache() {
    wx.showModal({
      title: '清除缓存',
      content: '将清除本机临时处理缓存与待上报事件队列，收藏、最近使用与搜索历史不受影响。',
      confirmText: '清除',
      cancelText: '取消',
      success: (res) => {
        if (!res.confirm) return
        const before = storageSizeKB()
        const keys = storageKeys()
        let removed = 0
        for (let i = 0; i < keys.length; i++) {
          const hit = CACHE_KEY_PREFIXES.some((p) => keys[i].indexOf(p) === 0)
          if (!hit) continue
          try {
            wx.removeStorageSync(keys[i])
            removed++
          } catch (e) {
            console.warn('[mine] 缓存项清理失败', keys[i])
          }
        }
        const freed = Math.max(0, before - storageSizeKB())
        this.applyState()
        wx.showToast({ title: '已清除 ' + removed + ' 项（' + freed + ' KB）', icon: 'none' })
      }
    })
  },

  showPrivacy() {
    wx.showModal({
      title: '隐私政策',
      content: PRIVACY_TEXT,
      showCancel: false,
      confirmText: '我知道了'
    })
  },

  showVersion() {
    wx.showModal({
      title: '版本信息',
      content:
        '版本 ' + env.VERSION + '\n' +
        '在线工具 ' + registry.online().length + ' 个 / 共 ' + registry.all().length + ' 项登记\n' +
        '服务地址 ' + this.data.base + '\n' +
        '工具结果默认只保存在本机。',
      showCancel: false,
      confirmText: '我知道了'
    })
  }
})
