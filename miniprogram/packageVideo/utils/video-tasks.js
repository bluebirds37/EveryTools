/**
 * packageVideo/utils/video-tasks.js —— 视频任务本地持久化（FR-V-00.4，键 'video_tasks' → tb_video_tasks）
 * 由 video-common.js 聚合导出；24h 内保留 taskId+paramsSnapshot，供页面 onShow 恢复轮询与历史抽屉。
 * 拆分原因：C1 单文件 ≤400 行。
 */

const store = require('../../utils/store')
const est = require('./video-estimate')

const TASKS_KEY = 'video_tasks'
const TASKS_KEEP = 30
const TASK_TTL = 24 * 60 * 60 * 1000
const HISTORY_SHOW = 10

const STATUS_LABEL = { pending: '进行中', done: '已完成', failed: '失败', canceled: '已取消' }
const STAGE_LABEL = { upload: '上传中', queue: '排队中', process: '处理中', done: '已完成', failed: '失败', canceled: '已取消' }

function readTasks() {
  const v = store.get(TASKS_KEY, [])
  if (!Array.isArray(v)) return []
  const now = Date.now()
  const alive = v.filter(function (t) {
    return t && t.taskId && now - (Number(t.createdAt) || 0) <= TASK_TTL
  })
  if (alive.length !== v.length) store.set(TASKS_KEY, alive.slice(0, TASKS_KEEP))
  return alive
}

/** 新增/覆盖一条任务记录（按创建时间倒序 = 最新在前，最多保留 TASKS_KEEP 条） */
function addTask(task) {
  if (!task || !task.taskId) return
  const list = readTasks().filter(function (t) {
    return t.taskId !== task.taskId
  })
  list.unshift(task)
  list.sort(function (a, b) {
    return (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0)
  })
  store.set(TASKS_KEY, list.slice(0, TASKS_KEEP))
}

/** 局部更新任务状态/阶段/进度/结果 */
function updateTask(taskId, patch) {
  if (!taskId) return
  const list = readTasks()
  let hit = false
  for (let i = 0; i < list.length; i++) {
    if (list[i].taskId === taskId) {
      list[i] = Object.assign({}, list[i], patch || {})
      hit = true
      break
    }
  }
  if (hit) store.set(TASKS_KEY, list)
}

function removeTask(taskId) {
  store.set(TASKS_KEY, readTasks().filter(function (t) {
    return t.taskId !== taskId
  }))
}

/** 本页是否有可恢复的未完成任务（onShow 继续轮询用） */
function pendingTask(toolId) {
  const list = readTasks()
  for (let i = 0; i < list.length; i++) {
    if (list[i].toolId === toolId && list[i].status === 'pending') return list[i]
  }
  return null
}

function statusLabel(task) {
  if (task.status === 'pending') return STAGE_LABEL[task.stage] || '进行中'
  return STATUS_LABEL[task.status] || '未知状态'
}

function formatTaskTime(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  const pad = function (x) { return x < 10 ? '0' + x : '' + x }
  return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}

/** 历史任务（compress 页抽屉）：最近 limit 条，附展示字段；params 保留供「再处理一次」 */
function history(limit, toolId) {
  const n = typeof limit === 'number' && isFinite(limit) ? limit : HISTORY_SHOW
  return readTasks()
    .filter(function (t) {
      return !toolId || t.toolId === toolId
    })
    .slice(0, n)
    .map(function (t) {
      return Object.assign({}, t, {
        statusText: statusLabel(t),
        timeText: formatTaskTime(Number(t.createdAt) || 0),
        sizeText: t.sizeBytes ? est.formatSize(t.sizeBytes) : '',
        resultSizeText: t.result && typeof t.result.sizeMB === 'number' && isFinite(t.result.sizeMB) ? est.formatSize(t.result.sizeMB * 1048576) : ''
      })
    })
}

module.exports = {
  TASKS_KEY: TASKS_KEY,
  TASKS_KEEP: TASKS_KEEP,
  TASK_TTL: TASK_TTL,
  HISTORY_SHOW: HISTORY_SHOW,
  readTasks: readTasks,
  addTask: addTask,
  updateTask: updateTask,
  removeTask: removeTask,
  pendingTask: pendingTask,
  statusLabel: statusLabel,
  history: history
}
