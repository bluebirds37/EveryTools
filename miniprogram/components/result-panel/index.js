// components/result-panel —— 统一结果区（C4：kind 六态 + meta + 出口按钮）
// 只做展示与事件派发：复制/保存/分享的具体动作由页面实现（页面才知道内容语义）。
Component({
  options: { styleIsolation: 'apply-shared' },
  properties: {
    kind: { type: String, value: 'none' }, // image|images|video|text|kv|none
    images: { type: Array, value: [] }, // [{url,label}]
    video: { type: String, value: '' },
    text: { type: String, value: '' },
    kv: { type: Array, value: [] }, // [{key,value}]
    meta: { type: String, value: '' }, // 「节省 62% · 1.2s」
    compareBefore: { type: String, value: '' }, // 原图：有值且 kind=image 时启用对比滑杆
    showCopy: { type: Boolean, value: false },
    showSave: { type: Boolean, value: false },
    showShare: { type: Boolean, value: false },
    actions: { type: Array, value: [] }, // [{toolId,label}] 工具串联 → bind:action {action:'use-tool',toolId}
    loading: { type: Boolean, value: false }
  },
  data: {
    wrap: true,
    primary: null,
    list: [],
    rows: [],
    compare: false
  },
  observers: {
    'kind, images, kv, text': function (kind, images, kv) {
      const list = (Array.isArray(images) ? images : [])
        .map(function (x) {
          if (!x) return null
          return typeof x === 'string' ? { url: x, label: '' } : { url: x.url || x.path || '', label: x.label || '' }
        })
        .filter(function (x) {
          return x && x.url
        })
      const rows = (Array.isArray(kv) ? kv : [])
        .map(function (x) {
          if (!x) return null
          const key = x.key != null ? String(x.key) : ''
          const val = x.value != null ? x.value : x.val
          return key || val ? { key: key, value: String(val == null ? '' : val) } : null
        })
        .filter(Boolean)
      const next = { list: list, rows: rows, primary: list[0] || null, compare: !!this.data.compareBefore && list.length === 1 }
      const cur = this.data
      if (cur.list.length !== next.list.length || cur.rows.length !== next.rows.length || !!cur.primary !== !!next.primary || cur.compare !== next.compare) {
        this.setData(next)
      }
    }
  },
  methods: {
    payload() {
      const d = this.data
      return { kind: d.kind, text: d.text, images: d.list, video: d.video, kv: d.rows, meta: d.meta }
    },
    onCopy() {
      this.triggerEvent('copy', this.payload())
    },
    onSave() {
      this.triggerEvent('save', this.payload())
    },
    onShare() {
      this.triggerEvent('share', this.payload())
    },
    onAction(e) {
      const toolId = e.currentTarget.dataset.tool
      if (!toolId) return
      this.triggerEvent('action', { action: 'use-tool', toolId: toolId })
    },
    onPreview(e) {
      const url = e.currentTarget.dataset.url
      const urls = this.data.list.map(function (x) {
        return x.url
      })
      if (!urls.length) return
      if (wx.previewImage) wx.previewImage({ current: url || urls[0], urls: urls })
    },
    onToggleWrap() {
      this.setData({ wrap: !this.data.wrap })
    }
  }
})
