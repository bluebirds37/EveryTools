// components/empty-state —— 通用空态/未开放态
Component({
  options: { styleIsolation: 'apply-shared' },
  properties: {
    icon: { type: String, value: 'cloud' },
    title: { type: String, value: '暂无内容' },
    desc: { type: String, value: '' },
    compact: { type: Boolean, value: false }
  }
})
