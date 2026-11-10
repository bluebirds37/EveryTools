// 自定义 tabBar：三项与 app.json 的 tabBar.list 顺序一致（工具 / 分类 / 我的）
// 图标 key 取自 CONTRACT C7：qr（工具宫格）/ stats（分类聚合）/ settings（我的与设置）
const LIST = [
  { pagePath: '/pages/home/home', text: '工具', icon: 'qr' },
  { pagePath: '/pages/category/category', text: '分类', icon: 'stats' },
  { pagePath: '/pages/mine/mine', text: '我的', icon: 'settings' }
]

Component({
  data: {
    selected: 0,
    list: LIST
  },

  methods: {
    onTap(e) {
      const dataset = e.currentTarget.dataset || {}
      const index = Number(dataset.index)
      if (index === this.data.selected) return
      wx.switchTab({
        url: dataset.path,
        fail: () => wx.showToast({ title: '页面切换失败，请重试', icon: 'none' })
      })
    }
  }
})
