// components/task-progress —— 云端任务进度（C4：upload|queue|process|done|failed|canceled + bind:cancel）
const STAGE_META = {
  upload: { icon: 'download', label: '正在上传', active: true, tone: '' },
  queue: { icon: 'cloud', label: '排队中', active: true, tone: '' },
  process: { icon: 'settings', label: '正在处理', active: true, tone: '' },
  done: { icon: 'check', label: '处理完成', active: false, tone: 'ok' },
  failed: { icon: 'alert', label: '处理失败', active: false, tone: 'err' },
  canceled: { icon: 'close', label: '已取消', active: false, tone: 'dim' }
}

Component({
  options: { styleIsolation: 'apply-shared' },
  properties: {
    visible: { type: Boolean, value: false },
    stage: { type: String, value: 'upload' },
    percent: { type: Number, value: 0 },
    message: { type: String, value: '' },
    eta: { type: String, value: '' },
    showCancel: { type: Boolean, value: true }
  },
  data: {
    icon: 'download',
    label: '正在上传',
    active: true,
    tone: '',
    pct: 0
  },
  observers: {
    'stage, percent, message': function (stage, percent, message) {
      const meta = STAGE_META[String(stage || 'upload')] || STAGE_META.upload
      const pct = Math.min(100, Math.max(0, Math.round(Number(percent) || 0)))
      const next = {
        icon: meta.icon,
        label: meta.label,
        active: meta.active,
        tone: meta.tone,
        pct: pct,
        text: message || meta.label
      }
      const cur = this.data
      if (cur.icon !== next.icon || cur.pct !== next.pct || cur.text !== next.text || cur.tone !== next.tone || cur.active !== next.active) {
        this.setData(next)
      }
    }
  },
  methods: {
    onCancel() {
      this.triggerEvent('cancel', { stage: this.data.stage })
    }
  }
})
