// calc-result-card —— formatJson / convertUnit / calcDateRange 纯计算结果原子组件
// 小微当前不渲染（结果直接在对话文本中给出）；保留 componentPath 供小程序内 Agent 场景复用。
Component({
  data: {
    title: '',
    rows: [],
    body: '',
    canCopy: false
  },
  lifetimes: {
    created() {
      if (typeof wx === 'undefined' || !wx.modelContext) return
      this._modelCtx = wx.modelContext.getContext(this)
      const { NotificationType } = wx.modelContext
      if (!this._modelCtx || !NotificationType) return
      this._modelCtx.on(NotificationType.Result, (data) => {
        const result = data && data.result ? data.result : {}
        const sc = result.structuredContent || {}
        const meta = result._meta || {}
        const rows = []
        let title = '计算结果'
        let body = ''
        if (sc.result !== undefined) {
          title = '单位换算'
          rows.push({ key: '结果', value: `${sc.value} ${sc.from} = ${sc.result} ${sc.to}` })
          if (sc.formula) rows.push({ key: '公式', value: sc.formula })
        } else if (sc.days !== undefined) {
          title = '日期间隔'
          rows.push({ key: '相差', value: sc.days + ' 天' })
          rows.push({ key: '约', value: sc.breakdown ? sc.breakdown.text : '' })
          rows.push({ key: '含首尾', value: sc.inclusiveDays + ' 天' })
        } else if (sc.valid !== undefined) {
          title = sc.valid ? 'JSON 处理完成' : 'JSON 解析失败'
          body = sc.valid ? (meta.fullOutput || sc.formatted || '') : (sc.error ? `第 ${sc.error.line} 行 ${sc.error.col} 列` : '')
        }
        this.setData({ title, rows, body, canCopy: !!body })
      })
    }
  },
  methods: {
    onTapCopy() {
      if (!this.data.body) return
      wx.setClipboardData({
        data: this.data.body,
        success() { wx.showToast({ title: '已复制', icon: 'none' }) }
      })
    }
  }
})
