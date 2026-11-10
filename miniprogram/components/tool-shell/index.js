// components/tool-shell —— 工具页统一外壳（C4）
// attached 时用 registry 校验 status：offline → 展示「暂未开放」空态并阻断 slot 内容（页面拿不到 ready 即不发请求）；
// 其余状态 triggerEvent('ready')。分享按钮用 open-type="share"，onShareAppMessage 仍由页面实现。
const registry = require('../../tools/registry')
const store = require('../../utils/store')
const track = require('../../utils/track')
const error = require('../../utils/error')

Component({
  options: { styleIsolation: 'apply-shared', multipleSlots: true },
  properties: {
    toolId: { type: String, value: '' },
    title: { type: String, value: '' },
    desc: { type: String, value: '' },
    tips: { type: Array, value: [] }, // 使用说明条目（默认折叠）
    showFavorite: { type: Boolean, value: true }
  },
  data: {
    ready: false,
    offline: false,
    beta: false,
    fav: false,
    tipsOpen: false,
    tipCount: 0,
    icon: 'info',
    accent: '#3B5BFE',
    name: '',
    sub: '',
    status: 'online',
    errorMsg: ''
  },
  lifetimes: {
    attached() {
      const id = this.properties.toolId
      const tool = id ? registry.get(id) : null
      const status = tool ? tool.status : 'online'
      const offline = status === 'offline'
      const tips = this.properties.tips || []
      this.setData({
        ready: !offline,
        offline: offline,
        beta: status === 'beta',
        status: status,
        icon: (tool && tool.icon) || 'info',
        accent: (tool && tool.accent) || '#3B5BFE',
        name: this.properties.title || (tool && tool.name) || '',
        sub: this.properties.desc || (tool && tool.desc) || '',
        fav: id ? store.isFavorite(id) : false,
        tipCount: tips.length,
        errorMsg: offline ? error.message(error.INTERNAL_CODES.TOOL_OFFLINE) : ''
      })
      track.track('tool_expose', { toolId: id, status: status })
      if (!offline) this.triggerEvent('ready', { toolId: id, status: status, tool: tool })
    }
  },
  methods: {
    onToggleFavorite() {
      const id = this.properties.toolId
      if (!id) return
      const on = store.toggleFavorite(id)
      this.setData({ fav: on })
      this.triggerEvent('favorite', { toolId: id, favorite: on })
    },
    onToggleTips() {
      this.setData({ tipsOpen: !this.data.tipsOpen })
    },
    onShare() {
      // open-type="share" 由系统接管，这里只补埋点
      track.track('result_share', { toolId: this.properties.toolId, from: 'shell' })
    }
  }
})
