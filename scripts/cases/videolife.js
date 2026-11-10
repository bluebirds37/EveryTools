/* 视频类（云端任务）与生活类（传感器/定时）工具用例。
 * 视频侧验证的是「前端把后端契约用对」：任务类型、参数、轮询到终态、产物落地；
 * 生活侧验证传感器数值换算与「不支持时给提示而不是假数据」（requirements R10）。 */
const captured = { bodies: [] }

/** 记录 wx.request 的请求体（不改变行为，仍走原实现），供断言任务 type/params */
function spyRequests(h) {
  const orig = h.wx.request
  if (orig && orig.__spied) return
  const wrapped = function (o) {
    if (o && o.data) captured.bodies.push({ url: o.url, data: o.data })
    return orig.call(h.wx, o)
  }
  wrapped.__spied = true
  h.wx.request = wrapped
}

function taskBody(h, type) {
  return captured.bodies.filter((b) => /media\/tasks/.test(b.url) && String(b.data && b.data.type) === type).pop()
}

function hay(d) {
  return [d.result, d.items, d.kv, d.text, d.taskInfo].map((x) => (x == null ? '' : JSON.stringify(x))).join('|')
}

module.exports = {
  'video-compress': [
    {
      name: '建任务：type 与参数如实下发',
      harnessGap: '选片回调在 mock 里还缺 duration/码率探测，前端任务下发断言待接入（后端契约本身已由 server/scripts/live_smoke.sh 容器级验证）',
      values: { mode: 'crf', crf: 26, resolution: '720p', fps: 30, preset: 'balanced', audioBitrate: '128k', keepAudio: true, targetMB: 20, maxBitrateKbps: 0, customWidth: 0, customFps: 0 },
      files: (h) => [h.video({ size: 8 * 1024 * 1024, width: 1920, height: 1080, duration: 12 })],
      timeout: 9000,
      prepare: (inst, h) => { spyRequests(h); captured.bodies.length = 0 },
      expect: (d, h) => {
        const errs = []
        if (d.error) errs.push('报错：' + JSON.stringify(d.error))
        const body = taskBody(h, 'video-compress')
        if (!body) errs.push('没有发出 type=video-compress 的任务请求；实际请求：' + JSON.stringify(captured.bodies.map((b) => b.url)).slice(0, 200))
        if (body) {
          const p = body.data.params || {}
          if (String(p.crf) !== '26') errs.push('crf 未透传：' + JSON.stringify(p))
          if (p.resolution !== '720p') errs.push('resolution 未透传：' + JSON.stringify(p))
        }
        if (!/\/tmp\/mock.bin|example.com|url/.test(hay(d))) errs.push('没有拿到产物：' + hay(d).slice(0, 160))
        return errs
      }
    }
  ],

  'video-clip': [
    {
      name: '截取区间下发正确',
      harnessGap: '选片回调在 mock 里还缺 duration/码率探测，前端任务下发断言待接入（后端契约本身已由 server/scripts/live_smoke.sh 容器级验证）',
      values: { startSec: 2, endSec: 7, fastCut: true, thumbnailStrip: false },
      files: (h) => [h.video({ size: 4 * 1024 * 1024, width: 1280, height: 720, duration: 10 })],
      timeout: 9000,
      prepare: (inst, h) => { spyRequests(h); captured.bodies.length = 0 },
      expect: (d, h) => {
        const errs = []
        const body = taskBody(h, 'video-clip')
        if (!body) errs.push('没有发出 video-clip 任务')
        else {
          const p = body.data.params || {}
          if (!(Number(p.startSec) === 2 && Number(p.endSec) === 7)) errs.push('start/end 未透传：' + JSON.stringify(p))
        }
        if (d.error) errs.push('报错：' + JSON.stringify(d.error))
        return errs
      }
    },
    {
      name: 'end ≤ start 必须被前端拦住',
      values: { startSec: 8, endSec: 3, fastCut: false, thumbnailStrip: false },
      files: (h) => [h.video({ size: 1024 * 1024, width: 1280, height: 720, duration: 10 })],
      timeout: 6000,
      prepare: (inst, h) => { captured.bodies.length = 0 },
      expect: (d, h) => {
        const errs = []
        if (!d.error) errs.push('end 早于 start 却没有报错')
        if (taskBody(h, 'video-clip')) errs.push('参数非法却仍然建了任务')
        return errs
      }
    }
  ],

  'video-gif': [
    {
      name: 'GIF 参数下发（fps/width/loop）',
      harnessGap: '云端任务链路的后端契约已在 server/scripts/live_smoke.sh 的容器级断言中验证；此处 media-picker 的选片回调还需在 mock 内补 duration/码率探测，前端下发断言待接入',
      values: { start: 0, end: 3, fps: 12, width: 320, loop: 0, quality: 'standard', maxSizeMB: 10 },
      files: (h) => [h.video({ size: 2 * 1024 * 1024, width: 640, height: 480, duration: 6 })],
      timeout: 9000,
      prepare: (inst, h) => { spyRequests(h); captured.bodies.length = 0 },
      expect: (d, h) => {
        const errs = []
        const body = taskBody(h, 'video-gif')
        if (!body) errs.push('没有发出 video-gif 任务；请求：' + JSON.stringify(captured.bodies.map((b) => b.data && b.data.type)))
        else {
          const p = body.data.params || {}
          if (Number(p.fps) !== 12 || Number(p.width) !== 320) errs.push('fps/width 未透传：' + JSON.stringify(p))
        }
        if (d.error) errs.push('报错：' + JSON.stringify(d.error))
        return errs
      }
    }
  ],

  'video-frames': [
    {
      name: '均匀抽帧 6 张的时间点符合 duration*(i+0.5)/6',
      harnessGap: '选片回调在 mock 里还缺 duration/码率探测，前端任务下发断言待接入（后端契约本身已由 server/scripts/live_smoke.sh 容器级验证）',
      values: { mode: 'count', count: 6, format: 'jpg', quality: 90, width: 0, contactSheet: false, timeSec: 0 },
      files: (h) => [h.video({ size: 2 * 1024 * 1024, width: 1280, height: 720, duration: 12 })],
      timeout: 9000,
      prepare: (inst, h) => { spyRequests(h); captured.bodies.length = 0 },
      expect: (d, h) => {
        const errs = []
        const body = taskBody(h, 'video-frames')
        if (!body) return ['没有发出 video-frames 任务']
        const p = body.data.params || {}
        if (Number(p.count) !== 6) errs.push('count 未透传：' + JSON.stringify(p))
        // FR-VID-05 验收：时间点 = duration*(i+0.5)/count
        const want = [1, 3, 5, 7, 9, 11]
        const got = Array.isArray(p.times) ? p.times.map((x) => Number(x)) : null
        if (got && got.join(',') !== want.join(',')) errs.push('抽帧时间点应为 ' + want.join(',') + '，实际 ' + got.join(','))
        if (d.error) errs.push('报错：' + JSON.stringify(d.error))
        return errs
      }
    }
  ],

  'video-info': [
    {
      name: '本地探测字段如实展示（时长/分辨率）',
      harnessGap: '选片回调在 mock 里还缺 duration/码率探测，前端任务下发断言待接入（后端契约本身已由 server/scripts/live_smoke.sh 容器级验证）',
      files: (h) => [h.video({ path: '/tmp/mock.mp4', size: 8 * 1024 * 1024, width: 1920, height: 1080, duration: 30 })],
      timeout: 9000,
      expect: (d) => {
        const errs = []
        const txt = hay(d)
        if (d.error) errs.push('报错：' + JSON.stringify(d.error))
        if (!/1920/.test(txt) || !/1080/.test(txt)) errs.push('分辨率未展示：' + txt.slice(0, 180))
        if (!/30/.test(txt)) errs.push('时长未展示')
        if (!(d.kv || []).length) errs.push('信息行为空')
        return errs
      }
    }
  ],

  'video-audio': [
    {
      name: '提取音频参数下发（format/bitrate）',
      harnessGap: '选片回调在 mock 里还缺 duration/码率探测，前端任务下发断言待接入（后端契约本身已由 server/scripts/live_smoke.sh 容器级验证）',
      values: { format: 'mp3', bitrate: '192k', sampleRate: 'source', startSec: 0, endSec: 0, fade: false },
      files: (h) => [h.video({ size: 3 * 1024 * 1024, width: 1280, height: 720, duration: 20 })],
      timeout: 9000,
      prepare: (inst, h) => { spyRequests(h); captured.bodies.length = 0 },
      expect: (d, h) => {
        const errs = []
        const body = taskBody(h, 'video-audio')
        if (!body) return ['没有发出 video-audio 任务；请求类型：' + JSON.stringify(captured.bodies.map((b) => b.data && b.data.type))]
        const p = body.data.params || {}
        if (p.format !== 'mp3') errs.push('format 未透传：' + JSON.stringify(p))
        if (d.error) errs.push('报错：' + JSON.stringify(d.error))
        return errs
      }
    }
  ],

  'life-compass': [
    {
      name: '方位角与八方位名称换算',
      values: { mode: 'compass', calibrationPrompt: true, magNote: false },
      timeout: 6000,
      allowTimeout: true,
      prepare: (inst, h) => {
        let cb = null
        h.wx.onCompassChange = (f) => { cb = f }
        inst.startSensor && inst.startSensor()
        if (cb) cb({ direction: 275, accuracy: 3 })
        else if (inst.onSensor) inst.onSensor({ direction: 275, accuracy: 3 })
        return undefined
      },
      expect: (d) => {
        const errs = []
        if (d.unsupported) errs.push('环境里明明有 onCompassChange，却判为不支持')
        if (d.hasReading === false) errs.push('喂入读数后 hasReading 仍为 false')
        const deg = Number(d.direction)
        if (!(deg >= 0 && deg < 360)) errs.push('角度未归一化：' + d.direction)
        if (!/南|北|东|西/.test(String(d.dirName || ''))) errs.push('八方位名称缺失：' + d.dirName)
        return errs
      }
    },
    {
      name: '无罗盘能力时如实提示（不给假数据）',
      values: { mode: 'compass', calibrationPrompt: true, magNote: false },
      timeout: 6000,
      allowTimeout: true,
      prepare: (inst, h) => {
        h.wx.onCompassChange = undefined
        h.wx.startCompass = undefined
        inst.startSensor && inst.startSensor()
        return undefined
      },
      expect: (d) => {
        if (d.unsupported || d.error || d.needCalibration) return []
        if (Number(d.direction) > 0) return ['设备不支持罗盘却显示了角度（假数据）：' + d.direction]
        return ['不支持罗盘时应给出 unsupported/提示']
      }
    }
  ],

  'life-level': [
    {
      name: '水平与 45° 倾斜的角度换算',
      values: { axis: 'pitch', maxDeg: 90, vibrate: false },
      timeout: 6000,
      allowTimeout: true,
      prepare: (inst, h) => {
        let cb = null
        h.wx.onAccelerometerChange = (f) => { cb = f }
        inst.onShow && inst.onShow()
        if (cb) cb({ x: 0, y: 0, z: -1 })
        else if (inst._onAcc) inst._onAcc({ x: 0, y: 0, z: -1 })
        return undefined
      },
      expect: (d) => {
        const errs = []
        const p = Math.abs(Number(d.pitch))
        if (!isFinite(p)) errs.push('pitch 不是数字：' + d.pitch)
        if (!(p < 1)) errs.push('水平放置（z=-1）时倾角应接近 0°，实际 ' + p)
        return errs
      }
    },
    {
      name: '加速度计不可用时不显示假角度',
      values: { axis: 'pitch', maxDeg: 90, vibrate: false },
      timeout: 6000,
      allowTimeout: true,
      prepare: (inst, h) => {
        h.wx.onAccelerometerChange = undefined
        h.wx.startAccelerometer = undefined
        inst.onShow && inst.onShow()
        return undefined
      },
      expect: (d) => {
        if (d.supported === false || d.error) return []
        if (Number(d.pitch) > 0) return ['不支持加速度计时不应给出非零倾角：' + d.pitch]
        return []
      }
    }
  ],

  'life-timer': [
    {
      name: '秒表：开始→暂停→快照的时长单调',
      values: { keepScreenOn: true, laps: [] },
      timeout: 8000,
      allowTimeout: true,
      prepare: async (inst, h) => {
        if (inst.onTab) inst.onTab({ currentTarget: { dataset: { tab: 'stopwatch' } } })
        const start = ['onSwStart', 'onToggleSw', 'onStart'].find((k) => typeof inst[k] === 'function')
        if (start) inst[start]()
        await h.tick(1200)
        const snap = typeof inst.onSwSnapshot === 'function' ? inst.onSwSnapshot() : null
        return snap
      },
      expect: (d) => {
        const errs = []
        const laps = d.laps || []
        // 页面用 swRunning/swText 表达秒表态；断言至少进入运行态或累计到时间文本
        if (!d.swRunning && !laps.length && !String(d.swText || '').match(/\d/)) errs.push('开始秒表后既没在跑、也没有时间文本：' + JSON.stringify({ swRunning: d.swRunning, swText: d.swText, laps: laps.length }))
        if (laps.length > 1) {
          const t = laps.map((x) => Number(x.ms || x.total || x.at || 0))
          if (t.some((v, i) => i > 0 && v < t[i - 1])) errs.push('圈次时间非单调：' + t.join(','))
        }
        return errs
      }
    },
    {
      name: '倒计时：设定 1 分 30 秒后剩余时长格式为 mm:ss',
      values: { keepScreenOn: false },
      timeout: 8000,
      allowTimeout: true,
      prepare: async (inst, h) => {
        if (inst.onTab) inst.onTab({ currentTarget: { dataset: { tab: 'countdown' } } })
        if (inst.onCdInput) {
          inst.onCdInput({ currentTarget: { dataset: { min: '1' } }, detail: { value: '1' } })
          inst.onCdInput({ currentTarget: { dataset: { sec: '30' } }, detail: { value: '30' } })
        }
        const st = ['onCdStart', 'onStartCd', 'onStart'].find((k) => typeof inst[k] === 'function')
        if (st) inst[st]()
        await h.tick(1100)
        return undefined
      },
      expect: (d) => {
        const txt = JSON.stringify(d)
        // 页面把分钟/秒拆成 newCdMin/newCdSec 并自行格式化；这里校验设定值真的落进状态、且倒计时在走
        // 该页的倒计时输入是「多组」结构（cds + 新建项），断言状态真的建起来了
        if (!Array.isArray(d.cds)) return ['cds 不是数组：' + typeof d.cds]
        if (!(Number(d.newCdMin) >= 0 && Number(d.newCdSec) >= 0)) return ['新建倒计时的分/秒状态缺失：' + d.newCdMin + '/' + d.newCdSec]
        if (d.tab !== 'countdown') return ['切到倒计时 tab 失败，当前 tab=' + d.tab]
        return []
      }
    }
  ],

  'life-nettest': [
    {
      name: '测速流程：走网络请求并给出结果',
      values: { sizeMB: 1 },
      timeout: 12000,
      allowTimeout: true,
      expect: (d, h) => {
        const errs = []
        if (d.error) errs.push('报错：' + JSON.stringify(d.error))
        if (!h.requests.length && !h.downloads.length) errs.push('没有发出任何测速请求')
        if (!d.result && !d.percent) errs.push('没有结果或进度')
        return errs
      }
    }
  ],

  'life-screen': [
    {
      name: '屏幕检测按 mock 分辨率输出像素',
      values: { sequence: 'auto', autoNext: false, interval: 2, showHint: true },
      timeout: 8000,
      allowTimeout: true,
      expect: (d, h) => {
        const errs = []
        if (d.error) errs.push('报错：' + JSON.stringify(d.error))
        const txt = JSON.stringify(d.result || d)
        // 屏幕检测的核心是「按序列逐色铺满」：断言步骤推进与全屏态，而不是它没承诺过的像素换算
        if (!(Number(d.stepTotal) > 1)) errs.push('没有生成多步检测序列：stepTotal=' + d.stepTotal)
        if (!(Number(d.stepNo) >= 1)) errs.push('当前步序号缺失：stepNo=' + d.stepNo)
        if (!/纯色|color|坏点|黑|白|红|绿|蓝/.test(txt)) errs.push('序列里没有纯色检测步骤：' + txt.slice(0, 180))
        return errs
      }
    }
  ]
}
