const tools = require('./index')

const CATEGORY_META = [
  { id: 'image', name: '图片', icon: 'crop', accent: '#3B5BFE' },
  { id: 'video', name: '视频', icon: 'video', accent: '#8B5CF6' },
  { id: 'qr', name: '条码', icon: 'qr', accent: '#06A44A' },
  { id: 'text', name: '文本', icon: 'json', accent: '#F97316' },
  { id: 'calc', name: '换算', icon: 'unit', accent: '#0EA5E9' },
  { id: 'life', name: '生活', icon: 'compass', accent: '#EC4899' },
  { id: 'dev', name: '开发', icon: 'http', accent: '#14B8A6' }
]

const byId = {}
for (let i = 0; i < tools.length; i++) {
  const t = tools[i]
  if (byId[t.id]) throw new Error('[registry] 工具 id 重复: ' + t.id)
  byId[t.id] = t
}

function normalizeKeyword(kw) {
  return String(kw || '').trim().toLowerCase()
}

function score(tool, kw) {
  if (!kw) return 1
  const name = tool.name.toLowerCase()
  const desc = (tool.desc || '').toLowerCase()
  let s = 0
  if (name === kw) s += 100
  if (name.indexOf(kw) >= 0) s += 40
  if (tool.id.indexOf(kw) >= 0) s += 20
  if (desc.indexOf(kw) >= 0) s += 10
  const kws = tool.keywords || []
  for (let i = 0; i < kws.length; i++) {
    const k = String(kws[i]).toLowerCase()
    if (k === kw) s += 30
    else if (k.indexOf(kw) >= 0 || kw.indexOf(k) >= 0) s += 12
  }
  if (!s) return 0
  if (tool.hot) s += 2
  return s
}

function flags() {
  const store = require('../utils/store')
  const f = store.get('tool_flags')
  return f && typeof f === 'object' ? f : {}
}

// 后端开关：enabled=false 直接隐藏；sort（数字，小者靠前）优先于本地排序
function flagOf(id) {
  const f = flags()[id]
  return f && typeof f === 'object' ? f : null
}

function isShown(tool) {
  if (!tool || tool.status === 'offline') return false
  const f = flagOf(tool.id)
  return !(f && f.enabled === false)
}

function bySort(a, b) {
  const fa = flagOf(a.id)
  const fb = flagOf(b.id)
  const sa = fa && typeof fa.sort === 'number' ? fa.sort : null
  const sb = fb && typeof fb.sort === 'number' ? fb.sort : null
  if (sa === null && sb === null) return 0
  if (sa === null) return 1
  if (sb === null) return -1
  return sa - sb
}

module.exports = {
  all() {
    return tools
  },

  online() {
    return tools.filter(isShown)
  },

  flags() {
    return flags()
  },

  get(id) {
    return byId[id] || null
  },

  isOnline(id) {
    return isShown(byId[id])
  },

  entryPath(id) {
    const t = byId[id]
    return isShown(t) ? t.entry : null
  },

  byCategory(category) {
    return this.online()
      .filter((t) => t.category === category)
      .sort((a, b) => {
        const s = bySort(a, b)
        if (s) return s
        if (!!b.hot !== !!a.hot) return b.hot ? 1 : -1
        if (b.status === 'online' && a.status === 'beta') return -1
        if (a.status === 'online' && b.status === 'beta') return 1
        return a.name.localeCompare(b.name, 'zh-Hans-CN')
      })
  },

  search(keyword) {
    const kw = normalizeKeyword(keyword)
    if (!kw) return this.online()
    return this.online()
      .map((t) => ({ t, s: score(t, kw) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => (b.s - a.s) || (b.t.hot ? 1 : 0) - (a.t.hot ? 1 : 0))
      .map((x) => x.t)
  },

  categories() {
    return CATEGORY_META.map((c) => ({
      id: c.id,
      name: c.name,
      icon: c.icon,
      accent: c.accent,
      count: this.byCategory(c.id).length
    }))
  },

  categoryMeta(id) {
    for (let i = 0; i < CATEGORY_META.length; i++) {
      if (CATEGORY_META[i].id === id) return CATEGORY_META[i]
    }
    return null
  },

  // 首页「常用」：hot + 使用次数加权
  recommended(limit) {
    const store = require('../utils/store')
    return this.online()
      .map((t) => {
        const u = store.usage(t.id)
        return { t, w: (t.hot ? 50 : 0) + Math.min(u.count || 0, 20) * 6 }
      })
      .sort((a, b) => b.w - a.w)
      .slice(0, limit || 8)
      .map((x) => x.t)
  },

  aiApis() {
    return this.online()
      .filter((t) => t.ai && t.ai.api)
      .map((t) => Object.assign({ toolId: t.id, name: t.name, desc: t.desc, entry: t.entry }, t.ai))
  }
}
