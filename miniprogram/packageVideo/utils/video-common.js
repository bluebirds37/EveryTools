/**
 * packageVideo/utils/video-common.js —— 视频工具公共层（FR-V-00.1/00.2/00.3/00.4/00.5/00.6/00.7）
 *
 * 职责：本地探测与限额预检、登录预检、云端任务统一流程（createTask→pollTask→结果）、
 *       任务持久化（tb_video_tasks，页面 onShow 恢复轮询）、历史任务、预估大小/耗时纯函数、结果出口。
 * 依赖：CONTRACT C3 的 /utils/video-task.js、/utils/request.js、/utils/auth.js、/utils/store.js、
 *       /utils/track.js、/utils/error.js（由平台同事提供，本文件只按契约签名调用）。
 * 约定：所有面向用户的错误都转成 { code, message(经 error.message), retryable }，绝不展示 errMsg 原文；
 *       后端不可达时统一 SERVER_UNREACHABLE 话术 + 页面重试按钮，不白屏、不产生 unhandled reject。
 */

const videoTask = require('../../utils/video-task')
const auth = require('../../utils/auth')
const track = require('../../utils/track')
const error = require('../../utils/error')

/** FR-V-00 / FR-VID-01 统一限额：200MB、600s、4K */
const LIMITS = { maxMB: 200, maxDuration: 600, maxSide: 3840 }

/* ---------------- FR-V-00.4 任务持久化（拆分至 video-tasks.js，tb_video_tasks） ---------------- */

const tasks = require('./video-tasks')
const readTasks = tasks.readTasks
const addTask = tasks.addTask
const updateTask = tasks.updateTask
const removeTask = tasks.removeTask
const pendingTask = tasks.pendingTask
const history = tasks.history
const statusLabel = tasks.statusLabel

/* ---------------- 纯函数：格式化与预估（拆分至 video-estimate.js，C1 单文件 ≤400 行） ---------------- */

const est = require('./video-estimate')
const formatSize = est.formatSize
const formatDuration = est.formatDuration
const savePercent = est.savePercent
const kbpsSecToMB = est.kbpsSecToMB
const estimateTargetBitrate = est.estimateTargetBitrate
const estimateUploadSec = est.estimateUploadSec
const estimateProcessSec = est.estimateProcessSec
const estimateEtaText = est.estimateEtaText
const buildMeta = est.buildMeta

function isFiniteNum(v) {
  return typeof v === 'number' && isFinite(v)
}

/* ---------------- FR-V-00.1 本地探测 + 限额预检 ---------------- */

/**
 * 本地探测视频（wx.getVideoInfo 优先，size 以 wx.getFileInfo 为准）。
 * 部分安卓 getVideoInfo 失败时 resolve 出 chooseMedia 给的基础字段并标记 partial，页面据此走云端探测。
 * @returns {Promise<{path,size,duration,width,height,format,partial:boolean}>}
 */
function probeVideo(file) {
  const base = {
    path: (file && file.path) || '',
    size: Number(file && file.size) || 0,
    duration: Number(file && file.duration) || 0,
    width: Number(file && file.width) || 0,
    height: Number(file && file.height) || 0,
    format: (file && file.format) || 'mp4',
    partial: false
  }
  if (typeof wx === 'undefined' || !wx.getVideoInfo) return Promise.resolve(Object.assign(base, { partial: true }))
  return new Promise(function (resolve) {
    wx.getVideoInfo({
      src: base.path,
      success: function (info) {
        resolve({
          path: base.path,
          size: Number(info.size) || base.size,
          duration: Number(info.duration) || base.duration,
          width: Number(info.width) || base.width,
          height: Number(info.height) || base.height,
          format: base.format,
          fps: Number(info.fps) || 0,
          partial: false
        })
      },
      fail: function () {
        // 探测失败不阻断选择（FR-VID-06：失败自动转服务端）
        resolve(Object.assign({}, base, { partial: true }))
      }
    })
  })
}

/**
 * 限额预检（FR-V-00.1 / FR-VID-01 限制）。返回 null=放行，否则 { code, message, retryable:false }。
 */
function precheckLimits(video) {
  if (!video || !video.path) {
    return { code: 'INPUT_EMPTY', message: error.message('INPUT_EMPTY'), retryable: false }
  }
  const maxBytes = LIMITS.maxMB * 1048576
  if (isFiniteNum(video.size) && video.size > maxBytes) {
    return {
      code: 'FILE_TOO_LARGE',
      message: error.message('FILE_TOO_LARGE', { max: maxBytes, size: video.size }) + '，或先用「视频截取」拆短',
      retryable: false
    }
  }
  if (isFiniteNum(video.duration) && video.duration > LIMITS.maxDuration) {
    return {
      code: 'FILE_TOO_LARGE',
      message: '视频时长超过 ' + LIMITS.maxDuration + ' 秒，请先用「视频截取」剪短',
      retryable: false
    }
  }
  const side = Math.max(Number(video.width) || 0, Number(video.height) || 0)
  if (side > LIMITS.maxSide) {
    return { code: 'FILE_TOO_LARGE', message: '分辨率超过 4K，请先用「视频截取」或降低分辨率处理', retryable: false }
  }
  return null
}

/**
 * FR-V-00.7：云端视频工具需登录态。未登录先静默登录（无按钮、无感）；
 * 仍为游客时返回错误对象（统一话术），页面展示后可重试。
 * @returns {Promise<null|{code,message,retryable}>}
 */
function precheckLogin() {
  return auth.ensureLogin().then(function (session) {
    if (session && !session.guest && session.accessToken) return null
    return {
      code: 'ENGINE_UNAVAILABLE',
      message: error.message('ENGINE_UNAVAILABLE', { reason: '云端视频工具需登录后使用，登录未成功，请重试' }),
      retryable: true
    }
  })
}

/* ---------------- FR-V-00.2/00.3/00.5 统一任务流程 ---------------- */

/** 任意异常 → 页面可展示的 { code, message, retryable }（SERVER_UNREACHABLE 必可重试） */
function toPageError(err) {
  const n = error.normalize(err, 'TASK_FAILED')
  const retryable = ['SERVER_UNREACHABLE', 'NETWORK_OFFLINE', 'TASK_TIMEOUT', 'ENGINE_UNAVAILABLE', 'TASK_FAILED', 'AUTH_EXPIRED', 'UNKNOWN', 'SERVER_ERROR', 'INVALID_RESPONSE'].indexOf(n.code) >= 0
  return { code: n.code, message: n.message, retryable: retryable, extra: n.extra }
}

function isCancelCode(code) {
  return code === 'CANCELED' || code === 'TASK_CANCELED'
}

/**
 * 统一云端任务流程：登录预检 → createTask（内含分片上传，进度回调）→ 落库 → pollTask（upload/queue/process）→ 结果。
 * @param {{toolId:string,type:string,params:object,filePath:string,video?:object,
 *          onProgress:fn}} o  onProgress({stage,percent,message,eta,queue})
 * @returns {Promise<{taskId,status,result}>} 失败 reject 带 .code 的错误（页面 setData error）
 */
function runCloudTask(o) {
  const ctx = { taskId: '' }
  // o.taskId：createTask 成功后回写给调用方，页面「取消」按钮直接取用（FR-V-00.5）
  o.taskId = ''
  return precheckLogin()
    .then(function (blocked) {
      if (blocked) {
        const e = error.make(blocked.code, { reason: '需登录' })
        e.retryable = true
        throw e
      }
      return videoTask.createTask({
        toolId: o.toolId,
        type: o.type,
        params: o.params,
        filePath: o.filePath,
        onProgress: function (p) { forward(o, p) }
      })
    })
    .then(function (created) {
      ctx.taskId = created.taskId
      o.taskId = created.taskId
      addTask({
        taskId: ctx.taskId,
        toolId: o.toolId,
        type: o.type,
        params: o.params,
        status: 'pending',
        stage: 'queue',
        percent: 0,
        createdAt: Date.now(),
        sizeBytes: (o.video && o.video.size) || 0
      })
      track.track('task_created', { toolId: o.toolId, type: o.type, taskId: ctx.taskId, engine: 'server' })
      return videoTask.pollTask(ctx.taskId, {
        onProgress: function (p) {
          forward(o, p)
          updateTask(ctx.taskId, { stage: (p && p.stage) || 'process', percent: Number(p && p.percent) || 0 })
        }
      })
    })
    .then(function (r) {
      const result = (r && r.result) || {}
      updateTask(ctx.taskId, { status: 'done', stage: 'done', percent: 100, result: result, finishedAt: Date.now() })
      return { taskId: ctx.taskId, status: (r && r.status) || 'done', result: result }
    })
    .catch(function (err) {
      const n = toPageError(err)
      if (ctx.taskId) updateTask(ctx.taskId, { status: isCancelCode(n.code) ? 'canceled' : 'failed', errorCode: n.code })
      if (!isCancelCode(n.code)) track.track('task_failed', { toolId: o.toolId, type: o.type, taskId: ctx.taskId, code: n.code, engine: 'server' })
      const out = error.make(n.code, n.extra)
      out.retryable = n.retryable
      throw out
    })
}

function forward(o, p) {
  if (typeof o.onProgress === 'function') o.onProgress(p || {})
}

/** FR-V-00.5 取消：通知服务端 + 本地状态置 canceled（失败也置位，UI 以用户意图为准） */
function cancelTaskFlow(taskId) {
  if (!taskId) return Promise.resolve()
  updateTask(taskId, { status: 'canceled', stage: 'canceled' })
  return Promise.resolve(videoTask.cancelTask(taskId)).catch(function (e) {
    if (require('../../utils/env').isDev()) console.warn('[video] 取消请求未送达：' + ((e && e.code) || 'UNKNOWN'))
  })
}

/**
 * FR-V-00.4：页面 onShow 恢复未完成任务继续轮询。
 * 无可恢复任务 resolve(null)；网络类失败保留 pending 状态（下次进入还能续），其余落库终态。
 */
function resumePendingTask(toolId, onProgress) {
  const task = pendingTask(toolId)
  if (!task) return Promise.resolve(null)
  onProgress({ stage: task.stage || 'queue', percent: task.percent || 0, resumed: true })
  return videoTask
    .pollTask(task.taskId, {
      onProgress: function (p) {
        onProgress(p || {})
        updateTask(task.taskId, { stage: (p && p.stage) || 'process', percent: Number(p && p.percent) || 0 })
      }
    })
    .then(function (r) {
      const result = (r && r.result) || {}
      updateTask(task.taskId, { status: 'done', stage: 'done', percent: 100, result: result, finishedAt: Date.now() })
      return { taskId: task.taskId, status: (r && r.status) || 'done', result: result, paramsSnapshot: task.params || {} }
    })
    .catch(function (err) {
      const n = toPageError(err)
      const keepPending = ['SERVER_UNREACHABLE', 'NETWORK_OFFLINE', 'TASK_TIMEOUT'].indexOf(n.code) >= 0
      if (!keepPending) updateTask(task.taskId, { status: isCancelCode(n.code) ? 'canceled' : 'failed', errorCode: n.code })
      const out = error.make(n.code, n.extra)
      out.retryable = n.retryable
      throw out
    })
}

/* ---------------- FR-V-00.6 结果出口 ---------------- */

/** 保存单个结果（video/image 由 video-task.resultDownload 按 URL 后缀分派） */
function saveResult(result, toolId) {
  const url = result && (result.url || result.video)
  if (!url) return Promise.reject(error.make('FILE_EXPIRED'))
  return videoTask.resultDownload(url).then(function (p) {
    track.track('result_save', { toolId: toolId || '', engine: 'server' })
    return p
  })
}

/** 批量保存（抽帧 images）：串行避免相册并发写入冲突；返回 {saved, failed} */
function saveAll(items, toolId) {
  const list = Array.isArray(items) ? items : []
  let saved = 0
  let failed = 0
  const next = function (i) {
    if (i >= list.length) return Promise.resolve({ saved: saved, failed: failed })
    const url = list[i] && (list[i].url || list[i])
    if (!url) return next(i + 1)
    return videoTask.resultDownload(url).then(
      function () { saved++; track.track('result_save', { toolId: toolId || '', engine: 'server' }) },
      function () { failed++ }
    ).then(function () { return next(i + 1) })
  }
  return next(0)
}

/** 历史任务预览：下载到临时文件后交给 wx.previewMedia（过期/断网给话术） */
function previewResult(task) {
  const url = task && task.result && task.result.url
  if (!url) return Promise.reject(error.make('FILE_EXPIRED'))
  return videoTask.resultDownload(url).then(function (tempPath) {
    return new Promise(function (resolve, reject) {
      wx.previewMedia({
        sources: [{ url: tempPath, type: isGifUrl(url) ? 'image' : 'video' }],
        success: resolve,
        fail: function (e) { reject(error.normalize(e, 'TASK_FAILED')) }
      })
    })
  })
}

function isGifUrl(url) {
  return /\.gif(\?|#|$)/i.test(String(url || ''))
}

module.exports = {
  LIMITS: LIMITS,
  TASKS_KEY: tasks.TASKS_KEY,
  HISTORY_SHOW: tasks.HISTORY_SHOW,
  formatSize: formatSize,
  formatDuration: formatDuration,
  savePercent: savePercent,
  kbpsSecToMB: kbpsSecToMB,
  estimateTargetBitrate: estimateTargetBitrate,
  estimateUploadSec: estimateUploadSec,
  estimateProcessSec: estimateProcessSec,
  estimateEtaText: estimateEtaText,
  buildMeta: buildMeta,
  probeVideo: probeVideo,
  precheckLimits: precheckLimits,
  precheckLogin: precheckLogin,
  readTasks: readTasks,
  addTask: addTask,
  updateTask: updateTask,
  removeTask: removeTask,
  pendingTask: pendingTask,
  history: history,
  statusLabel: statusLabel,
  runCloudTask: runCloudTask,
  cancelTaskFlow: cancelTaskFlow,
  resumePendingTask: resumePendingTask,
  toPageError: toPageError,
  saveResult: saveResult,
  saveAll: saveAll,
  previewResult: previewResult
}
