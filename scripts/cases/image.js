/* 图片类工具功能用例（runner 见 scripts/verify-tools.js）
 * 断言只写「功能事实」：体积/尺寸/数量/字段形状，不依赖 UI 细节。
 */
const KB = 1024

module.exports = {
  'image-compress': [
    {
      name: '大图压到目标体积',
      values: { mode: 'size', targetKB: 200 },
      files: (h) => [h.photo({ size: 8 * 1024 * KB, width: 3000, height: 4000 })],
      expect: (d, h) => {
        const errs = []
        const it = (d.items || [])[0]
        if (d.error) errs.push('返回错误：' + JSON.stringify(d.error))
        if (!it || it.failed) errs.push('没有压缩结果项：' + JSON.stringify(d.items))
        if (it) {
          if (it.afterSize > 200 * KB) errs.push(`结果 ${it.afterSize} 字节超过目标 200KB（验收要求 ≤目标 110%）`)
          if (it.afterSize >= it.beforeSize) errs.push(`结果(${it.afterSize}) 没比原图(${it.beforeSize}) 小`)
          if (!(it.width > 0 && it.height > 0)) errs.push('结果尺寸无效：' + it.width + '×' + it.height)
        }
        if (!d.summary || d.summary.reachedTarget !== true) errs.push('summary.reachedTarget 应为 true：' + JSON.stringify(d.summary))
        if (d.summary && d.summary.overTarget) errs.push('达标却标记 overTarget')
        // 二分搜索必须真的动过质量，否则就是「7 次同样输出」的回归（100KB→400KB 事故根因）
        const qs = [...new Set(h.canvasExports.map((e) => e.quality))].sort()
        if (qs.length < 2) errs.push('导出质量只有 ' + JSON.stringify(qs) + '，二分搜索没有生效')
        if (h.canvasExports.length > 7) errs.push('编码次数 ' + h.canvasExports.length + ' 次，超过 7 次上限')
        return errs
      }
    },
    {
      name: '原图已够小时不得变大（用户实报场景）',
      values: { mode: 'size', targetKB: 200 },
      files: (h) => [h.photo({ size: 100 * KB, width: 1200, height: 1600 })],
      expect: (d) => {
        const errs = []
        const it = (d.items || [])[0]
        if (!it) return ['没有结果项']
        if (it.afterSize > it.beforeSize) errs.push(`压缩后 ${it.afterSize} > 原图 ${it.beforeSize}（「压缩」不允许让文件变大）`)
        if (!it.keptOriginal) errs.push('原图已小于目标时应保留原文件，keptOriginal 未置位')
        if (!d.summary || d.summary.kept !== 1) errs.push('summary.kept 应为 1：' + JSON.stringify(d.summary && d.summary.kept))
        if (d.summary && d.summary.grew) errs.push('保留了原图却仍报 grew')
        if (d.result && d.result.meta && d.result.meta.indexOf('节省 -') >= 0) errs.push('meta 出现负节省百分比：' + d.result.meta)
        return errs
      }
    },
    {
      name: '质量优先模式同样不得变大',
      values: { mode: 'quality', quality: 90 },
      files: (h) => [h.photo({ size: 100 * KB, width: 1200, height: 1600 })],
      expect: (d, h) => {
        const errs = []
        const it = (d.items || [])[0]
        if (!it) return ['没有结果项']
        if (it.afterSize > it.beforeSize) errs.push(`quality 模式结果变大：${it.beforeSize} → ${it.afterSize}`)
        const last = h.canvasExports[h.canvasExports.length - 1]
        if (last && last.fileType !== 'jpg') errs.push('默认输出应为 jpg，实际 ' + last.fileType)
        return errs
      }
    },
    {
      name: '限边长',
      values: { mode: 'dimension', maxSide: 600 },
      files: (h) => [h.photo({ size: 3 * 1024 * KB, width: 2400, height: 1800 })],
      expect: (d) => {
        const it = (d.items || [])[0]
        if (!it) return ['没有结果项']
        if (Math.max(it.width, it.height) > 600) return [`限边长 600 未生效，实际 ${it.width}×${it.height}`]
        return []
      }
    },
    {
      name: '批量 3 张逐张出结果',
      values: { mode: 'size', targetKB: 300 },
      files: (h) => [
        h.photo({ size: 2 * 1024 * KB, width: 2000, height: 1500 }),
        h.photo({ size: 3 * 1024 * KB, width: 2400, height: 1600 }),
        h.photo({ size: 1024 * KB, width: 1200, height: 900 })
      ],
      expect: (d) => {
        const errs = []
        if ((d.items || []).length !== 3) errs.push('批量应产出 3 条结果，实际 ' + (d.items || []).length)
        for (const it of d.items || []) {
          if (it.failed) errs.push('第 ' + it.index + ' 张失败：' + it.code + ' ' + it.message)
          else if (it.afterSize > it.beforeSize) errs.push(`第 ${it.index} 张变大：${it.beforeSize} → ${it.afterSize}`)
        }
        if (d.progress && d.progress.percent !== 100) errs.push('进度未走到 100%：' + JSON.stringify(d.progress))
        if (d.result && d.result.kind !== 'images') errs.push('批量结果 kind 应为 images，实际 ' + d.result.kind)
        return errs
      }
    },
    {
      // 守住 2026-10-14 事故的根因：共享层若把 0–1 的质量当成 10–95 刻度做四舍五入，
      // 0.75 会变成 1、再被 qualityParam 当成 1.0（最高质量）→ 输出反而比原图更大。
      name: '共享层质量单位契约',
      noRun: true,
      allowTimeout: true,
      files: (h) => [h.photo({ size: 300 * KB, width: 1600, height: 1200 })],
      prepare: async (inst, h) => {
        const media = h.lib('utils/media.js')
        const p = inst.data.files[0].path
        const size = {}
        for (const q of [20, 50, 90, 0.2, 0.5, 0.9]) {
          const r = await media.compressToJpeg({ path: p, quality: q, canvasId: 'tb-offscreen' })
          size[String(q)] = r.size
        }
        inst.setData({ __q: size, __err: null })
      },
      expect: (d) => {
        const s = d.__q || {}
        const errs = []
        for (const pair of [['0.2', '20'], ['0.5', '50'], ['0.9', '90']]) {
          if (s[pair[0]] !== s[pair[1]]) errs.push(`质量 0–1 与 10–95 刻度不等价：${pair[0]}→${s[pair[0]]} vs ${pair[1]}→${s[pair[1]]}`)
        }
        if (!(s['20'] < s['50'] && s['50'] < s['90'])) errs.push('质量↑体积必须单调↑，实际 ' + JSON.stringify(s))
        if (!(s['20'] > 0)) errs.push('质量 0.2 的输出体积为 0（等于最高质量回归）：' + JSON.stringify(s))
        return errs
      }
    }
  ]
}
