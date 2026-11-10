const registry = require('../../tools/registry')
const store = require('../../utils/store')
const track = require('../../utils/track')

const HISTORY_KEY = 'search_history'
const HISTORY_MAX = 10
const DEBOUNCE_MS = 150
const FEEDBACK_TEMPLATE =
  '【通用工具箱 · 工具需求反馈】\n' +
  '我想要的工具：\n' +
  '使用场景：\n' +
  '期望的输出结果：\n' +
  '（以上内容已复制到剪贴板，可直接粘贴到小程序「我的-帮助与反馈」或客服会话）'

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

/* 把 text 按关键词切成片段，命中片段 hl=true（name / keywords / desc 三处都高亮） */
function highlight(text, keyword, keyPrefix) {
  const source = String(text == null ? '' : text)
  const kw = String(keyword || '').trim().toLowerCase()
  const parts = []
  if (!source) return parts
  if (!kw) {
    parts.push({ k: keyPrefix + '0', t: source, hl: false })
    return parts
  }
  const lower = source.toLowerCase()
  let cursor = 0
  let index = 0
  let found = lower.indexOf(kw, cursor)
  while (found >= 0) {
    if (found > cursor) {
      parts.push({ k: keyPrefix + index, t: source.slice(cursor, found), hl: false })
      index++
    }
    parts.push({ k: keyPrefix + index, t: source.slice(found, found + kw.length), hl: true })
    index++
    cursor = found + kw.length
    found = lower.indexOf(kw, cursor)
  }
  if (cursor < source.length) {
    parts.push({ k: keyPrefix + index, t: source.slice(cursor), hl: false })
  }
  return parts
}

function decorateHit(tool, keyword) {
  return {
    id: tool.id,
    name: tool.name,
    desc: tool.desc,
    icon: tool.icon,
    accent: tool.accent,
    accentSoft: hexA(tool.accent, 0.12),
    beta: tool.status === 'beta',
    nameParts: highlight(tool.name, keyword, tool.id + '_n'),
    descParts: highlight(tool.desc, keyword, tool.id + '_d'),
    keywordParts: (tool.keywords || [])
      .map((kw, i) => ({ raw: String(kw), parts: highlight(String(kw), keyword, tool.id + '_k' + i) }))
      .filter((x) => x.parts.length > 0)
  }
}

function engineLabel(engine) {
  if (engine === 'client') return '本机处理'
  if (engine === 'server') return '云端处理'
  return '本机优先'
}

function buildGroups(list, keyword) {
  const tabs = registry.categories()
  const buckets = {}
  for (let i = 0; i < tabs.length; i++) {
    const c = tabs[i]
    buckets[c.id] = {
      id: c.id,
      name: c.name,
      icon: c.icon,
      accent: c.accent,
      accentSoft: hexA(c.accent, 0.14),
      items: []
    }
  }
  // 防御分支：registry 固定 7 个分类；若出现未知分类，按其自身 accent 单独成组
  let fallback = null
  for (let i = 0; i < list.length; i++) {
    const tool = list[i]
    const decorated = Object.assign(decorateHit(tool, keyword), { engineText: engineLabel(tool.engine) })
    const group = buckets[tool.category]
    if (group) {
      group.items.push(decorated)
    } else {
      if (!fallback) {
        fallback = {
          id: 'other',
          name: '其他工具',
          icon: tool.icon,
          accent: tool.accent,
          accentSoft: hexA(tool.accent, 0.14),
          items: []
        }
      }
      fallback.items.push(decorated)
    }
  }
  const groups = []
  const keys = Object.keys(buckets)
  for (let i = 0; i < keys.length; i++) {
    if (buckets[keys[i]].items.length > 0) groups.push(buckets[keys[i]])
  }
  if (fallback && fallback.items.length > 0) groups.push(fallback)
  return groups
}

function readHistory() {
  const list = store.get(HISTORY_KEY, [])
  if (!Array.isArray(list)) return []
  const out = []
  for (let i = 0; i < list.length && out.length < HISTORY_MAX; i++) {
    const word = typeof list[i] === 'string' ? list[i].trim() : idOf(list[i])
    if (word && out.indexOf(word) < 0) out.push(word)
  }
  return out
}

Page({
  data: {
    keyword: '',
    mode: 'idle',
    focusInput: false,
    groups: [],
    hitCount: 0,
    noResult: false,
    history: [],
    hot: []
  },

  onLoad() {
    this.timer = null
    this.loadIdle()
  },

  onReady() {
    this.setData({ focusInput: true })
  },

  onUnload() {
    if (this.timer) clearTimeout(this.timer)
  },

  loadIdle() {
    const hot = registry
      .online()
      .filter((t) => t.hot)
      .slice(0, 12)
      .map((t) => ({
        id: t.id,
        name: t.name,
        icon: t.icon,
        accent: t.accent,
        accentSoft: hexA(t.accent, 0.12)
      }))
    this.setData({ mode: 'idle', groups: [], hitCount: 0, noResult: false, hot: hot, history: readHistory() })
  },

  onInput(e) {
    const value = e.detail.value || ''
    this.setData({ keyword: value })
    if (this.timer) clearTimeout(this.timer)
    const keyword = value.trim()
    if (!keyword) {
      this.loadIdle()
      return
    }
    this.timer = setTimeout(() => this.runSearch(keyword), DEBOUNCE_MS)
  },

  onConfirm(e) {
    const keyword = String((e.detail && e.detail.value) || this.data.keyword).trim()
    if (!keyword) return
    if (this.timer) clearTimeout(this.timer)
    this.runSearch(keyword)
  },

  runSearch(rawKeyword) {
    const keyword = String(rawKeyword || '').trim()
    if (!keyword) {
      this.loadIdle()
      return
    }
    const list = registry.search(keyword) || []
    const groups = buildGroups(list, keyword)
    this.setData({
      mode: 'result',
      keyword: keyword,
      groups: groups,
      hitCount: list.length,
      noResult: list.length === 0
    })
  },

  onTapHistory(e) {
    const word = e.currentTarget.dataset.word
    this.setData({ keyword: word })
    if (this.timer) clearTimeout(this.timer)
    this.runSearch(word)
  },

  onDeleteHistory(e) {
    const word = e.currentTarget.dataset.word
    const next = readHistory().filter((w) => w !== word)
    store.set(HISTORY_KEY, next)
    this.setData({ history: next })
  },

  onClearHistory() {
    if (readHistory().length === 0) return
    wx.showModal({
      title: '清除搜索历史',
      content: '将删除本机保存的全部搜索记录，不影响收藏与最近使用。',
      confirmText: '清除',
      cancelText: '取消',
      success: (res) => {
        if (!res.confirm) return
        store.remove(HISTORY_KEY)
        this.setData({ history: [] })
        wx.showToast({ title: '已清除', icon: 'none' })
      }
    })
  },

  pushHistory(word) {
    const keyword = String(word || '').trim()
    if (!keyword) return
    const next = [keyword].concat(readHistory().filter((w) => w !== keyword)).slice(0, HISTORY_MAX)
    store.set(HISTORY_KEY, next)
    this.setData({ history: next })
  },

  onResultTap(e) {
    const id = e.currentTarget.dataset.id
    if (!id) {
      console.error('[search] onResultTap 缺少 data-id，点击无目标')
      return
    }
    this.pushHistory(this.data.keyword)
    track.openTool(id, 'search')
  },

  onResultLongPress(e) {
    const id = e.currentTarget.dataset.id
    const tool = id ? registry.get(id) : null
    if (!tool) return
    wx.navigateTo({ url: '/pages/tool-detail/tool-detail?toolId=' + tool.id })
  },

  onFeedback() {
    wx.setClipboardData({
      data: FEEDBACK_TEMPLATE,
      success: () => {
        wx.showToast({ title: '反馈模板已复制', icon: 'none' })
        track.track('result_copy', { from: 'search_feedback' })
      },
      fail: () => wx.showToast({ title: '复制失败，请稍后再试', icon: 'none' })
    })
  },

  onClearKeyword() {
    if (this.timer) clearTimeout(this.timer)
    this.setData({ keyword: '' })
    this.loadIdle()
  },

  onCancel() {
    if (this.timer) clearTimeout(this.timer)
    const pages = getCurrentPages()
    if (pages.length > 1) wx.navigateBack()
    else wx.switchTab({ url: '/pages/home/home' })
  }
})
