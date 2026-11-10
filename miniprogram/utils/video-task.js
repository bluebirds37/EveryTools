/**
 * utils/video-task.js —— 云端媒体任务编排（CONTRACT C3 / tools-spec FR-V-00.*）
 *
 * 上传机制已拆到 utils/file-upload.js（C1 单文件 ≤400 行），本文件只负责：
 *  · 作业生命周期（jobId / 取消标志）
 *  · 进度三段式统一回调 { stage, percent, message, eta, jobId, fileId }（FR-V-00.3）
 *  · createTask：上传 → /files/:id/complete → POST /media/tasks
 *  · pollTask：2s 起、每次 +500ms 退避到 5s，总超时 600s
 *  · cancelTask / myTasks / resultDownload / 本地任务缓存（FR-V-00.4）
 *
 * 失败一定带 err.code：TASK_FAILED / TASK_TIMEOUT / QUOTA_EXCEEDED / SERVER_UNREACHABLE / TASK_CANCELED。
 */

const request = require('./request')
const error = require('./error')
const store = require('./store')
const media = require('./media')
const upload = require('./file-upload')

const TASK_CACHE_KEY = 'video_tasks'
const CACHE_KEEP = 20
const POLL_START = 2000
const POLL_STEP = 500
const POLL_MAX = 5000
const POLL_TIMEOUT = 600000
const VIDEO_EXT = ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi']

/** 阶段文案（task-progress 组件按同一套 stage 渲染） */
const STAGE_TEXT = { upload: '正在上传', queue: '排队中', process: '正在处理', done: '已完成', failed: '失败', canceled: '已取消' }

/** 服务端 status → 前端 stage（大小写不敏感，未知状态按进度推断） */
const STATUS_STAGE = {
  queued: 'queue', waiting: 'queue', pending: 'queue', uploaded: 'queue',
  processing: 'process', running: 'process', encoding: 'process',
  done: 'done', success: 'done', completed: 'done',
  failed: 'failed', error: 'failed', expired: 'failed',
  canceled: 'canceled', cancelled: 'canceled'
}

let jobSeq = 0
const activeJobs = {}

function hasWx() {
  return typeof wx !== 'undefined'
}
function newJobId() {
  jobSeq++
  return 'job-' + Date.now().toString(36) + '-' + jobSeq
}
function clampPercent(n) {
  const v = Number(n)
  return isFinite(v) ? Math.min(100, Math.max(0, Math.round(v))) : 0
}
function sleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms)
  })
}
function isCanceled(jobId) {
  const job = activeJobs[jobId]
  return !!(job && job.canceled)
}
function canceledError() {
  return error.make(error.INTERNAL_CODES.TASK_CANCELED)
}
function throwIfCanceled(jobId) {
  if (isCanceled(jobId)) throw canceledError()
}

/** 统一进度回调：整份 payload 都带 stage/percent/message/eta，附加字段按需给 */
function emit(onProgress, jobId, stage, percent, extra) {
  const x = extra || {}
  const payload = {
    stage: stage,
    percent: clampPercent(percent),
    message: x.message || STAGE_TEXT[stage] || '',
    eta: x.eta || '',
    jobId: jobId,
    fileId: x.fileId || '',
    queueAhead: x.queueAhead,
    queueCount: x.queueCount,
    totalBytes: x.totalBytes,
    uploadedBytes: x.uploadedBytes
  }
  if (typeof onProgress === 'function') {
    try {
      onProgress(payload)
    } catch (e) {
      console.warn('[video-task] onProgress 异常', e && (e.errMsg || e.message))
    }
  }
  return payload
}

/** 「约 1 分 20 秒」；0/无效返回空串（进度条不显示 eta） */
function fmtEta(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0))
  if (!s) return ''
  if (s < 60) return '约 ' + s + ' 秒'
  return '约 ' + Math.floor(s / 60) + ' 分 ' + (s % 60) + ' 秒'
}

/** 本地任务缓存：退出小程序后「我的任务」仍可回看（FR-V-00.4） */
function cacheTask(rec) {
  if (!rec || !rec.taskId) return rec
  const list = store.get(TASK_CACHE_KEY, [])
  const arr = Array.isArray(list) ? list.filter(function (x) { return x && x.taskId && x.taskId !== rec.taskId }) : []
  arr.unshift(rec)
  store.set(TASK_CACHE_KEY, arr.slice(0, CACHE_KEEP))
  return rec
}
function taskCache() {
  const list = store.get(TASK_CACHE_KEY, [])
  return Array.isArray(list) ? list : []
}
function taskById(taskId) {
  const hit = taskCache().filter(function (x) { return x.taskId === taskId })
  return hit[0] || null
}
function trackEvent(name, toolId, code) {
  try {
    require('./track').track(name, code ? { toolId: toolId, code: code } : { toolId: toolId })
  } catch (e) {
    /* 埋点异常不影响主流程 */
  }
}

function normalizeStage(data) {
  if (data.stage && STAGE_TEXT[data.stage]) return data.stage
  const s = String(data.status || '').toLowerCase()
  return STATUS_STAGE[s] || (Number(data.progress) >= 100 ? 'process' : 'queue')
}

function stageMessage(stage, data, percent) {
  if (stage === 'queue') {
    const ahead = Number(data.queueAhead != null ? data.queueAhead : data.ahead)
    return isFinite(ahead) && ahead > 0 ? '排队中，前方还有 ' + ahead + ' 个任务' : '排队中'
  }
  if (stage === 'process') return '正在处理 ' + clampPercent(percent) + '%'
  if (stage === 'done') return '处理完成'
  if (stage === 'failed') return '处理失败，可重试或调整参数'
  if (stage === 'canceled') return '任务已取消'
  return STAGE_TEXT[stage] || '正在上传'
}

/** 服务端没给 eta 就按已用时间线性外推 */
function etaOf(data, percent, startedAt) {
  if (data.eta) return String(data.eta)
  if (data.etaSeconds != null) return fmtEta(data.etaSeconds)
  const elapsed = (Date.now() - startedAt) / 1000
  if (percent > 2 && elapsed > 1) return fmtEta((elapsed * (100 - percent)) / percent)
  return ''
}

/**
 * 建任务：本地探测 → /files/init → 上传（直传或分片）→ /files/:id/complete → POST /media/tasks
 * @param {{toolId:string, type?:string, params?:object, filePath:string,
 *          onProgress?:(p:{stage,percent,message,eta,jobId,fileId})=>void,
 *          concurrency?:number, chunked?:boolean, jobId?:string, sha256?:string}} options
 * @returns {Promise<{taskId:string, fileId:string, status:string, jobId:string}>}
 */
function createTask(options) {
  const o = options || {}
  const jobId = o.jobId || newJobId()
  if (!o.filePath) return Promise.reject(error.make(error.CODES.INPUT_EMPTY))

  activeJobs[jobId] = { canceled: false, toolId: o.toolId || '', taskId: '', startedAt: Date.now() }
  const job = activeJobs[jobId]
  emit(o.onProgress, jobId, 'upload', 0, {})

  const progress = function (p) {
    emit(o.onProgress, jobId, 'upload', (p.loaded / Math.max(1, p.total || p.loaded)) * 100, {
      fileId: p.fileId || job.fileId || '',
      totalBytes: p.total || 0,
      uploadedBytes: p.loaded
    })
  }

  return upload
    .uploadMediaFile({
      filePath: o.filePath,
      chunked: o.chunked,
      concurrency: o.concurrency,
      sha256: o.sha256,
      isCanceled: function () {
        return isCanceled(jobId)
      },
      onProgress: function (loaded, total, fileId) {
        progress({ loaded: loaded, total: total, fileId: fileId })
      }
    })
    .then(function (res) {
      job.fileId = res.fileId
      throwIfCanceled(jobId)
      emit(o.onProgress, jobId, 'queue', 100, { fileId: res.fileId, message: '正在提交任务' })
      return upload.completeFile(res.fileId).then(function () {
        return res
      })
    })
    .then(function (res) {
      throwIfCanceled(jobId)
      return request
        .request({
          url: '/media/tasks',
          method: 'POST',
          timeout: 30000,
          data: { toolId: o.toolId, type: o.type || 'video', params: o.params || {}, fileIds: [res.fileId] }
        })
        .then(function (d) {
          const created = d || {}
          const taskId = created.taskId || created.id || ''
          if (!taskId) throw error.make(error.INTERNAL_CODES.INVALID_RESPONSE)
          job.taskId = taskId
          const status = created.status || 'queued'
          cacheTask({ taskId: taskId, toolId: o.toolId, fileId: res.fileId, status: status, createdAt: Date.now() })
          trackEvent('task_created', o.toolId)
          emit(o.onProgress, jobId, 'queue', 0, { fileId: res.fileId, message: '任务已创建，等待处理' })
          return { taskId: taskId, fileId: res.fileId, status: status, jobId: jobId }
        })
    })
    .catch(function (e) {
      const n = error.normalize(e, error.CODES.SERVER_UNREACHABLE)
      trackEvent('task_failed', o.toolId, n.code)
      throw n
    })
    .then(
      function (r) {
        delete activeJobs[jobId]
        return r
      },
      function (e) {
        delete activeJobs[jobId]
        throw e
      }
    )
}

/**
 * 轮询任务：2s 起 → 每次 +500ms（上限 5s），总超时 600s
 * 网络抖动/404 之外的临时错误继续重试，终态（done/failed/canceled）立即返回
 * @param {string} taskId
 * @param {{onProgress?:(p:{stage,percent,message,eta})=>void, jobId?:string, timeout?:number, toolId?:string}} [opts]
 * @returns {Promise<{status:string, result:object, progress:number, stage:string}>}
 */
function pollTask(taskId, opts) {
  const o = opts || {}
  if (!taskId) return Promise.reject(error.make(error.CODES.INPUT_EMPTY))
  const timeout = Number(o.timeout) > 0 ? Number(o.timeout) : POLL_TIMEOUT
  const jobId = o.jobId || taskId
  if (!activeJobs[jobId]) activeJobs[jobId] = { canceled: false, toolId: o.toolId || '', taskId: taskId, startedAt: Date.now() }

  const startedAt = Date.now()
  let delay = POLL_START

  const once = function () {
    if (isCanceled(jobId)) return Promise.reject(canceledError())
    if (Date.now() - startedAt > timeout) {
      return Promise.reject(error.make(error.CODES.TASK_TIMEOUT, { seconds: Math.round(timeout / 1000) }))
    }
    return request
      .request({ url: '/media/tasks/' + encodeURIComponent(taskId), method: 'GET', timeout: 15000 })
      .then(function (d) {
        const data = d || {}
        const stage = normalizeStage(data)
        const percent = clampPercent(data.progress)
        const payload = { status: data.status || stage, result: data.result || null, progress: percent, stage: stage }
        emit(o.onProgress, jobId, stage, percent, {
          message: stageMessage(stage, data, percent),
          eta: etaOf(data, percent, startedAt),
          queueAhead: data.queueAhead != null ? data.queueAhead : data.ahead,
          queueCount: data.queueCount
        })
        if (stage === 'done') {
          cacheTask({ taskId: taskId, toolId: o.toolId || data.toolId, status: 'done', result: payload.result, at: Date.now() })
          return payload
        }
        if (stage === 'failed') {
          throw error.make(error.CODES.TASK_FAILED, { reason: (data.result && data.result.meta) || data.reason || data.message || '' })
        }
        if (stage === 'canceled') throw canceledError()
        delay = Math.min(POLL_MAX, delay + POLL_STEP)
        return sleep(delay).then(once)
      })
      .catch(function (e) {
        const n = error.normalize(e, error.CODES.SERVER_UNREACHABLE)
        if (n.code === error.CODES.TASK_FAILED || n.code === error.INTERNAL_CODES.TASK_CANCELED) throw n
        if (n.code === error.INTERNAL_CODES.NOT_FOUND) {
          throw error.make(error.CODES.TASK_FAILED, { reason: '任务不存在或已过期' })
        }
        // 网络抖动：退避后继续轮询，直到 600s 总超时兜底
        delay = Math.min(POLL_MAX, delay + POLL_STEP)
        return sleep(delay).then(once)
      })
  }

  return once()
}

/** 取消：jobId（上传阶段还没有 taskId，只能本地中断）与 taskId（服务端取消）都支持 */
function cancelTask(id) {
  if (!id) return Promise.resolve({ ok: false, code: error.CODES.INPUT_EMPTY })
  const job = activeJobs[id]
  let taskId = id
  if (job) {
    job.canceled = true
    if (!job.taskId) return Promise.resolve({ ok: true, canceled: true, local: true })
    taskId = job.taskId
  }
  return request
    .request({ url: '/media/tasks/' + encodeURIComponent(taskId) + '/cancel', method: 'POST', data: {}, timeout: 15000 })
    .then(function () {
      cacheTask({ taskId: taskId, status: 'canceled', at: Date.now() })
      return { ok: true, canceled: true }
    })
    .catch(function (e) {
      const n = error.normalize(e, error.CODES.SERVER_UNREACHABLE)
      return { ok: false, code: n.code, message: n.message }
    })
}

/** 我的任务：GET /media/tasks；拉不到就退回本地缓存（离线也能看历史） */
function myTasks(opts) {
  const limit = (opts && Number(opts.limit)) || 20
  return request
    .request({ url: '/media/tasks?limit=' + encodeURIComponent(String(limit)), method: 'GET', timeout: 15000 })
    .then(function (d) {
      const items = d && Array.isArray(d.items) ? d.items : Array.isArray(d) ? d : []
      return items.slice(0, limit)
    })
    .catch(function (e) {
      const local = taskCache().slice(0, limit)
      if (local.length) return local
      throw error.normalize(e, error.CODES.SERVER_UNREACHABLE)
    })
}

/**
 * 结果下载 + 存相册（FR-V-00.6）
 * @param {string} url 一次性签名地址
 * @param {{kind?:'video'|'image', onSave?:(r:{path,kind})=>void}} [opts]
 * @returns {Promise<{path:string,kind:string}>}
 */
function resultDownload(url, opts) {
  const o = opts || {}
  if (!url) return Promise.reject(error.make(error.CODES.INPUT_EMPTY))
  return request.downloadToTemp(url).then(function (path) {
    const ext = media.extension(path) || media.extension(url)
    const kind = o.kind || (VIDEO_EXT.indexOf(ext) >= 0 ? 'video' : 'image')
    return saveToAlbum(path, kind).then(function (r) {
      if (typeof o.onSave === 'function') {
        try {
          o.onSave(r)
        } catch (e) {
          /* 回调异常不影响结果 */
        }
      }
      return r
    })
  })
}

/** 相册权限拒绝 → PERMISSION_DENIED；用户主动取消保留原码上抛 */
function saveToAlbum(path, kind) {
  if (!hasWx()) return Promise.reject(error.make(error.CODES.ENGINE_UNAVAILABLE))
  const api = kind === 'video' ? wx.saveVideoToPhotosAlbum : wx.saveImageToPhotosAlbum
  if (typeof api !== 'function') return Promise.reject(error.make(error.CODES.ENGINE_UNAVAILABLE, { reason: '无法保存到相册' }))
  return new Promise(function (resolve, reject) {
    api({
      filePath: path,
      success: function () {
        resolve({ path: path, kind: kind })
      },
      fail: function (e) {
        const n = error.normalize(e, error.CODES.PERMISSION_DENIED)
        reject(n.code === error.INTERNAL_CODES.CANCELED ? n : error.make(error.CODES.PERMISSION_DENIED, { scope: 'album' }))
      }
    })
  })
}

module.exports = {
  CHUNK_SIZE: upload.CHUNK_SIZE,
  CONCURRENCY: upload.CONCURRENCY,
  POLL_TIMEOUT: POLL_TIMEOUT,
  STAGE_TEXT: STAGE_TEXT,
  createTask: createTask,
  pollTask: pollTask,
  cancelTask: cancelTask,
  myTasks: myTasks,
  resultDownload: resultDownload,
  saveToAlbum: saveToAlbum,
  taskCache: taskCache,
  taskById: taskById,
  cacheTask: cacheTask,
  fmtEta: fmtEta,
  normalizeStage: normalizeStage
}
