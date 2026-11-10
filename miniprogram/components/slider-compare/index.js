// components/slider-compare —— 处理前/后对比滑杆（C4：properties before/after）
// 用 touch 事件算百分比（比 movable-view 更可控：需要「裁切上层的绝对定位图」，movable 轴语义不匹配）
Component({
  options: { styleIsolation: 'apply-shared' },
  properties: {
    before: { type: String, value: '' },
    after: { type: String, value: '' },
    beforeLabel: { type: String, value: '原图' },
    afterLabel: { type: String, value: '结果' },
    height: { type: Number, value: 420 } // rpx
  },
  data: {
    percent: 50,
    boxW: 0,
    boxH: 0,
    imgW: '100%' // 测到宽度前用 100%，测到后用实际 px：被裁切的上层图不能跟着变窄
  },
  lifetimes: {
    ready() {
      this.measure()
    }
  },
  observers: {
    'before, after': function () {
      this.measure()
    }
  },
  methods: {
    measure() {
      const q = this.createSelectorQuery ? this.createSelectorQuery() : null
      if (!q) return
      q.select('.sc')
        .boundingClientRect()
        .exec((res) => {
          const r = res && res[0]
          if (!r || !r.width) return
          if (r.width !== this.data.boxW || Math.abs(r.height - (this.data.boxH || 0)) > 1) {
            this.setData({ boxW: r.width, boxH: r.height, imgW: Math.round(r.width) + 'px' })
          }
          this._rect = r
        })
    },
    onStart(e) {
      this._track = true
      this.apply(e)
    },
    onMove(e) {
      if (!this._track) return
      this.apply(e)
    },
    onEnd() {
      if (!this._track) return
      this._track = false
      this.triggerEvent('change', { percent: this.data.percent })
    },
    apply(e) {
      const t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0])
      if (!t) return
      const rect = this._rect
      if (!rect || !rect.width) {
        this.measure()
        return
      }
      const x = t.clientX != null ? t.clientX : t.pageX
      let pct = ((x - rect.left) / rect.width) * 100
      pct = Math.min(98, Math.max(2, Math.round(pct)))
      if (pct !== this.data.percent) this.setData({ percent: pct })
    }
  }
})
