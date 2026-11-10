const registry = require('../../tools/registry')
const store = require('../../utils/store')
const track = require('../../utils/track')

const RELATED_LIMIT = 4

function hexA(hex, alpha) {
  const h = String(hex || '').replace('#', '')
  const num = /^[0-9a-fA-F]{6}$/.test(h) ? parseInt(h, 16) : 0x3b5bfe
  return 'rgba(' + ((num >> 16) & 255) + ',' + ((num >> 8) & 255) + ',' + (num & 255) + ',' + alpha + ')'
}

function formatMB(bytes) {
  const n = Number(bytes) || 0
  if (!n) return ''
  if (n >= 1024 * 1024) {
    const mb = n / (1024 * 1024)
    return (mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10) + ' MB'
  }
  return Math.max(1, Math.round(n / 1024)) + ' KB'
}

function engineText(engine, fallback) {
  if (engine === 'client') return { label: '本机处理', detail: '全部在你手机内完成，文件与文本不上传服务器。' }
  if (engine === 'server') return { label: '云端处理', detail: '文件加密上传处理，服务器 24 小时后自动删除。' }
  return {
    label: '本机优先',
    detail: fallback === 'server' ? '默认本机处理，超出能力或无网络时自动切换云端。' : '默认本机处理，必要时自动切换云端。'
  }
}

function privacyText(list) {
  const map = { album: '相册', camera: '摄像头', record: '录音', location: '位置' }
  return (list || []).map((k) => map[k] || k).filter(Boolean)
}

function limitRows(tool) {
  const rows = []
  const limits = tool.limits || {}
  if (Number(limits.maxBytes) > 0) rows.push({ key: '单个文件大小', value: formatMB(limits.maxBytes) })
  if (Number(limits.batchSize) > 0) rows.push({ key: '单次处理数量', value: limits.batchSize + ' 个' })
  if (Number(limits.maxChars) > 0) rows.push({ key: '单次文本长度', value: limits.maxChars + ' 字符以内' })
  if (Number(limits.maxSeconds) > 0) rows.push({ key: '单次时长', value: limits.maxSeconds + ' 秒以内' })
  const formats = (tool.keywords || []).filter((k) => /^[a-zA-Z0-9]{2,5}$/.test(String(k)))
  if (formats.length) rows.push({ key: '常见支持格式', value: formats.join(' / ').toUpperCase() })
  rows.push({ key: '需要登录', value: tool.requiresLogin ? '是（仅限额功能）' : '否' })
  rows.push({ key: '工具版本', value: tool.version || '1.0.0' })
  return rows
}

function categoryOf(categoryId) {
  const tabs = registry.categories()
  for (let i = 0; i < tabs.length; i++) {
    if (tabs[i].id === categoryId) return tabs[i]
  }
  return null
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

Page({
  data: {
    loaded: false,
    tool: null,
    heroSoft: '',
    categoryName: '',
    categoryAccent: '',
    engine: { label: '', detail: '' },
    limits: [],
    keywords: [],
    privacyList: [],
    usageSteps: [],
    fav: false,
    offline: false,
    related: []
  },

  onLoad(query) {
    const toolId = (query && query.toolId) || ''
    const tool = toolId ? registry.get(toolId) : null
    if (!tool) {
      this.setData({ loaded: true, tool: null })
      wx.setNavigationBarTitle({ title: '工具不存在' })
      return
    }
    this.toolId = tool.id
    const meta = categoryOf(tool.category)
    const offline = tool.status === 'offline'
    this.setData({
      loaded: true,
      tool: Object.assign(decorate(tool), {
        accentSoftStrong: hexA(tool.accent, 0.18),
        idText: tool.id
      }),
      heroSoft: hexA(tool.accent, 0.16),
      categoryName: meta ? meta.name : '',
      categoryAccent: meta ? meta.accent : tool.accent,
      engine: engineText(tool.engine, tool.fallback),
      limits: limitRows(tool),
      keywords: tool.keywords || [],
      privacyList: privacyText(tool.requiresPrivacy),
      usageSteps: [
        '点击「立即使用」进入' + tool.name + '页面。',
        offline ? '该工具当前已下线，暂不可用。' : '按页面提示选择文件或填写参数，先校验再处理。',
        '处理结果可预览，并支持保存、复制或分享。',
        '长按任意工具卡片可收藏或再次查看详情。'
      ],
      fav: !!store.isFavorite(tool.id),
      offline: offline,
      related: registry
        .byCategory(tool.category)
        .filter((t) => t.id !== tool.id)
        .slice(0, RELATED_LIMIT)
        .map(decorate)
    })
    wx.setNavigationBarTitle({ title: tool.name })
    track.track('tool_expose', { toolId: tool.id, from: (query && query.from) || 'detail' })
  },

  onShow() {
    if (!this.data.tool) return
    const fav = !!store.isFavorite(this.data.tool.id)
    if (fav !== this.data.fav) this.setData({ fav: fav })
  },

  onToggleFavorite() {
    const id = this.data.tool ? this.data.tool.id : ''
    if (!id) return
    store.toggleFavorite(id)
    const fav = !!store.isFavorite(id)
    this.setData({ fav: fav })
    wx.showToast({ title: fav ? '已加入收藏' : '已取消收藏', icon: 'none' })
  },

  onUse() {
    const tool = this.data.tool
    if (!tool) return
    track.openTool(tool.id, 'detail')
  },

  onRelatedTap(e) {
    const id = e.currentTarget.dataset.id
    if (!id || !registry.get(id)) return
    wx.redirectTo({ url: '/pages/tool-detail/tool-detail?toolId=' + id })
  },

  onCopyId() {
    const tool = this.data.tool
    if (!tool) return
    wx.setClipboardData({
      data: tool.idText,
      success: () => wx.showToast({ title: '工具编号已复制', icon: 'none' })
    })
  },

  goCategory() {
    const tabs = registry.categories()
    const current = this.data.tool ? this.data.tool.category : ''
    const meta = tabs.filter((c) => c.id === current)[0]
    if (meta) store.set('pending_category', { id: meta.id, at: Date.now() })
    wx.switchTab({ url: '/pages/category/category' })
  },

  goHome() {
    wx.switchTab({ url: '/pages/home/home' })
  },

  onBack() {
    const pages = getCurrentPages()
    if (pages.length > 1) wx.navigateBack()
    else wx.switchTab({ url: '/pages/home/home' })
  }
})
