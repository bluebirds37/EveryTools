// components/grid-icon —— C7 矢量图标渲染（内联 SVG → base64 dataURI）
// 不用 CSS mask / 内联 <svg>：小程序跨机型支持不可靠；base64 dataURI 最稳。
// 载体用 view 的 background-image 而不是 <image src>：<image> 走的是原生图片解码管线，
// 对 dataURI SVG 的支持在不同基础库/模拟器上不一致（表现为图标整块空白），
// 而 CSS background 由渲染内核直接处理，跨机型/模拟器都可靠。
// 因此 color 必须是实际色值（十六进制），组件内不依赖 CSS 变量；未传时按当前主题取 --text-2 的同值色。
const icons = require('../../utils/icons')

Component({
  // virtualHost：组件标签不参与布局，图标节点直接成为父 flex/grid 的子项，
  // 否则外层虚拟标签在 grid 单元格里会吃掉尺寸。
  options: { styleIsolation: 'apply-shared', virtualHost: true },
  properties: {
    name: { type: String, value: '' },
    size: { type: Number, value: 44 }, // 单位 rpx
    color: { type: String, value: '' }, // 空 → 主题默认色
    strokeWidth: { type: Number, value: 1.8 }
  },
  data: {
    style: ''
  },
  observers: {
    'name, size, color, strokeWidth': function (name, size, color) {
      this.render(name, size, color)
    }
  },
  lifetimes: {
    ready() {
      this.render(this.data.name, this.data.size, this.data.color)
    }
  },
  methods: {
    render(name, size, color) {
      if (!name) {
        if (this.data.style !== '') this.setData({ style: '' })
        return
      }
      const rpx = Number(size) > 0 ? Number(size) : 44
      const hex = color || this.themeColor()
      const src = icons.dataUri(name, {
        color: hex,
        size: Math.max(24, Math.round((rpx / 750) * (this.windowWidth() || 375) * 3)),
        strokeWidth: Number(this.data.strokeWidth) > 0 ? Number(this.data.strokeWidth) : 1.8
      })
      // base64 字母表不含空白与 ')'，url() 可不加引号
      const style = 'width:' + rpx + 'rpx;height:' + rpx + 'rpx;background-image:url(' + src + ')'
      if (style !== this.data.style) this.setData({ style: style })
    },
    windowWidth() {
      try {
        const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
        return Number(info && info.windowWidth) || 375
      } catch (e) {
        return 375
      }
    },
    themeColor() {
      try {
        const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
        return info && info.theme === 'dark' ? '#a2a9b8' : icons.DEFAULT_COLOR
      } catch (e) {
        return icons.DEFAULT_COLOR
      }
    }
  }
})
