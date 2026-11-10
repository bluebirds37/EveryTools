const auth = require('./utils/auth')
const registry = require('./tools/registry')
const track = require('./utils/track')
const store = require('./utils/store')

App({
  globalData: {
    userInfo: null,
    isLoggedIn: false,
    agentHandoffs: {},
    systemInfo: null,
    onlineCount: 0
  },

  onLaunch() {
    this.registerAgentHandoff()
    try {
      this.globalData.systemInfo = wx.getDeviceInfo
        ? Object.assign({}, wx.getDeviceInfo(), wx.getWindowInfo())
        : wx.getSystemInfoSync()
    } catch (e) {
      this.globalData.systemInfo = {}
    }
    registry.online()
    this.globalData.onlineCount = registry.online().length
    auth.ensureLogin().then((res) => {
      this.globalData.isLoggedIn = !!(res && res.accessToken)
      this.globalData.userInfo = res && res.userId ? { userId: res.userId } : null
      if (this.globalData.isLoggedIn) syncRemote()
    })
    track.flush()
  },

  // 小微 handoff：必须在 onLaunch 注册，早于 onBeforeAppRoute
  registerAgentHandoff() {
    if (!wx.onAgentHandoff) {
      console.warn('[App] 当前基础库不支持 wx.onAgentHandoff，AI 接力不可用')
      return
    }
    wx.onAgentHandoff(({ pageId, path, query, payload }) => {
      const map = this.globalData.agentHandoffs || {}
      map[pageId] = { path, query, payload }
      this.globalData.agentHandoffs = map
      track.track('ai_handoff_enter', { path })
    })
  },

  takeAgentHandoff(pageId) {
    const map = this.globalData.agentHandoffs || {}
    const handoff = map[pageId]
    if (handoff) delete map[pageId]
    return handoff || null
  },

  onShow() {
    track.flush()
  },

  onHide() {
    track.flush()
  }
})

function syncRemote() {
  const request = require('./utils/request')
  request.request({ url: '/tools/flags', auth: false, method: 'GET' })
    .then((data) => {
      if (data && data.flags) store.set('tool_flags', data.flags)
    })
    .catch(() => {})
}
