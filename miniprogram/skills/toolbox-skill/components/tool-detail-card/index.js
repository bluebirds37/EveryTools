// tool-detail-card —— getToolDetail 的工具详情原子组件
// 小微当前不渲染；保留 componentPath。渲染数据取 structuredContent（Agent 可见精简结构）。
Component({
  data: {
    tool: null
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
        const tool = meta.tool && meta.tool.toolId ? meta.tool : (sc.toolId ? sc : null)
        this.setData({ tool })
        if (tool && tool.toolId) {
          this._viewCtx.setRelatedPage({ query: `toolId=${tool.toolId}` })
        }
      })
    }
  },
  methods: {
    engineText(engine) {
      return engine === 'client' ? '纯本地处理' : (engine === 'server' ? '云端处理' : '本地优先·超限走云端')
    },
    onTapUse() {
      const tool = this.data.tool
      if (!tool || !tool.aiApi || !this._modelCtx) return
      this._modelCtx.sendFollowUpMessage({
        content: [
          { type: 'text', text: `使用${tool.name}` },
          { type: 'api/call', data: { name: tool.aiApi, arguments: {} } }
        ]
      })
    },
    onTapEntry() {
      if (this._viewCtx && this.data.tool) this._viewCtx.openDetailPage({ url: this.data.tool.entry })
    }
  }
})
