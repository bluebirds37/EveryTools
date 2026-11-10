// tool-list-card —— searchTools / listHistory 的工具结果列表原子组件
// 说明：小微当前阶段对话内不渲染原子组件（只出「文本 + 小程序卡片」），本组件代码与
// componentPath 保留，供小程序内 Agent 场景复用；渲染数据来自 structuredContent，
// accent 等纯渲染字段从 _meta.viewItems 补充（Agent 不可见）。
Component({
  data: {
    title: '工具清单',
    keyword: null,
    items: [],
    total: 0
  },
  lifetimes: {
    created() {
      if (typeof wx === 'undefined' || !wx.modelContext) return
      this._modelCtx = wx.modelContext.getContext(this)
      this._viewCtx = wx.modelContext.getViewContext(this)
      const { NotificationType } = wx.modelContext
      if (!this._modelCtx || !NotificationType) return
      this._modelCtx.on(NotificationType.Result, (data) => {
        const result = data && data.result ? data.result : {}
        const sc = result.structuredContent || {}
        const meta = result._meta || {}
        const viewItems = meta.viewItems || sc.items || []
        const recents = sc.recents || []
        const favorites = sc.favorites || []
        const items = viewItems.length ? viewItems : recents.concat(favorites)
        this.setData({
          items: items.slice(0, 8),
          total: sc.total || items.length,
          keyword: sc.keyword || null,
          title: sc.keyword ? `「${sc.keyword}」的搜索结果` : (sc.scope ? '最近使用与收藏' : '全部在线工具')
        })
        if (sc.keyword) {
          this._viewCtx.setRelatedPage({ query: `keyword=${encodeURIComponent(sc.keyword)}` })
        }
      })
    }
  },
  methods: {
    onTapItem(e) {
      const item = e.currentTarget.dataset.item
      if (!item || !this._modelCtx) return
      this._modelCtx.sendFollowUpMessage({
        content: [
          { type: 'text', text: `查看${item.name}的详情` },
          { type: 'api/call', data: { name: 'getToolDetail', arguments: { toolId: item.toolId } } }
        ]
      })
    },
    onTapMore() {
      if (this._viewCtx) this._viewCtx.openDetailPage({ url: '/pages/home/home' })
    }
  }
})
