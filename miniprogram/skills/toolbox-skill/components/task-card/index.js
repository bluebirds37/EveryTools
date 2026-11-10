// task-card —— start* / generateQrcode 类「任务已准备」卡片原子组件
// 小微当前不渲染；保留 componentPath。展示归一化后的参数摘要，提醒「选择文件在接力页内完成」。
Component({
  data: {
    card: null,
    params: []
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
        const card = meta.card || null
        const params = []
        const p = sc.params || {}
        const keys = Object.keys(p)
        for (let i = 0; i < keys.length; i++) {
          params.push({ key: keys[i], value: String(p[keys[i]]) })
        }
        this.setData({
          card: card || { title: sc.toolId || '任务', desc: '', pagePath: sc.pagePath || '' },
          params
        })
        const handoff = result.handoff
        if (handoff && handoff.query && this._viewCtx) {
          this._viewCtx.setRelatedPage({ query: handoff.query })
        }
      })
    }
  },
  methods: {
    onTapOpen() {
      if (this._viewCtx && this.data.card && this.data.card.pagePath) {
        this._viewCtx.openDetailPage({ url: this.data.card.pagePath })
      }
    }
  }
})
