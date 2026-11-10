// packageVideo/components/task-drawer —— 「历史任务」抽屉（FR-V-00.4/00.6，compress 页顶部入口）
// 数据源为本地 tb_video_tasks（video-common.history），24h 内可预览/下载/删除/再处理一次。
Component({
  // 允许 app.wxss 的全局类（.tag/.btn/.t-sm/.fade-up 等）作用于本组件（C6：不重复实现通用样式）
  options: { addGlobalClass: true },
  properties: {
    visible: { type: Boolean, value: false },
    // [{taskId,statusText,timeText,sizeText,resultSizeText,result,…}] 由 video-common.history 装饰
    tasks: { type: Array, value: [] },
    title: { type: String, value: '历史任务' }
  },
  methods: {
    onClose() {
      this.triggerEvent('close')
    },
    onPreview(e) {
      this.triggerEvent('preview', { task: e.currentTarget.dataset.task })
    },
    onDownload(e) {
      this.triggerEvent('download', { task: e.currentTarget.dataset.task })
    },
    onDelete(e) {
      this.triggerEvent('delete', { task: e.currentTarget.dataset.task })
    },
    onRerun(e) {
      this.triggerEvent('rerun', { task: e.currentTarget.dataset.task })
    },
    // 阻止遮罩滚动穿透（catchtouchmove / catchtap 绑定，无需逻辑）
    noop() {
      return true
    }
  }
})
