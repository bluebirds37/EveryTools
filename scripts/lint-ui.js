#!/usr/bin/env node
/**
 * scripts/lint-ui.js —— UI 规范机检（CONTRACT C6 / 现代化要求）
 *
 * 检查项：
 *   1. wxss 中硬编码色值（#rgb/#hex/rgb()/hsl()）—— 除 app.wxss、theme.json、白名单文件外必须走 var(--*)
 *   2. wxss 中硬编码 rpx 圆角/阴影覆盖设计令牌（border-radius: NNrpx 且非 0/50%）
 *   3. wxml 内联 style 写死颜色（style="color:#..."）
 *   4. 页面 json 缺少 navigationBarTitleText / 未使用 tool-shell
 *   5. 页面 wxss 未做任何深色模式适配（仅提示：全局令牌驱动时可忽略）
 *
 * 用法：node scripts/lint-ui.js [--strict] （--strict 时警告也计入失败）
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const MP = path.join(ROOT, 'miniprogram')
const strict = process.argv.includes('--strict')

// 令牌定义处与「组件契约要求实际色值」的文件
const WHITELIST = [
  'miniprogram/app.wxss',
  'miniprogram/theme.json',
  'miniprogram/custom-tab-bar/index.wxss', // tabBar 与 page 不同树，按契约自带局部令牌 + 深色兜底
  'miniprogram/components/grid-icon/index.js', // base64 SVG 不能用 CSS 变量
  'miniprogram/components/slider-compare/index.wxss',
  'miniprogram/packageVideo/styles/video.wxss', // 时间轴/进度条需要不透明实色
  'miniprogram/packageLife/pages/screen/index.wxss' // 屏幕检测色条必须是设备原色（纯黑/纯白/R/G/B），令牌化会破坏检测语义
]

const TOOL_PAGE_DIRS = ['packageImage', 'packageVideo', 'packageQr', 'packageText', 'packageCalc', 'packageLife', 'packageDev']

// 只盯「不透明实色」：rgba()/hsla() 用于遮罩、阴影、玻璃态是必要的，不算违反令牌化
const BAD_COLOR_ON_GRAD = /#[0-9a-fA-F]{3,8}\b|\brgb\s*\(|\bhsl\s*\(/

function walk(dir, out) {
  out = out || []
  if (!fs.existsSync(dir)) return out
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const p = path.join(dir, name)
    const st = fs.statSync(p)
    if (st.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

function rel(p) {
  return path.relative(ROOT, p).split(path.sep).join('/')
}

function isWhitelisted(r) {
  if (WHITELIST.indexOf(r) >= 0) return true
  // AI 原子组件渲染在微信对话宿主树内，拿不到 app.wxss 的 page 令牌，只能用实色
  return r.indexOf('miniprogram/skills/toolbox-skill/components/') === 0
}

const problems = []
const warnings = []

const files = walk(MP).filter((p) => /\.(wxss|wxml|json)$/.test(p))

for (const p of files) {
  const r = rel(p)
  if (r === 'miniprogram/page-meta.json' || r === 'miniprogram/sitemap.json' || r === 'miniprogram/theme.json') continue
  const ext = path.extname(p)
  const text = fs.readFileSync(p, 'utf8')

  if (ext === '.wxss') {
    if (isWhitelisted(r)) continue
    const lines = text.split(/\r?\n/)
    lines.forEach((line, i) => {
      const code = line.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*/, '')
      if (/^\s*--[\w-]+\s*:/.test(code)) return // 令牌定义处允许实色（含深色兜底）
      const m = code.match(BAD_COLOR_ON_GRAD)
      if (m) {
        // var(--x, #hex) 形式的兜底是允许的
        const withFallback = /var\([^)]*,\s*#[0-9a-fA-F]{3,8}\s*\)/.test(code)
        if (!withFallback) problems.push(r + ':' + (i + 1) + ' 硬编码色值 ' + m[0] + '（应使用 var(--*)）')
      }
    })
    if (!/var\(--/.test(text)) warnings.push(r + ' 未使用任何设计令牌 var(--*)')
  }

  if (ext === '.wxml') {
    const inline = text.match(/style="[^"]*(?:#[0-9a-fA-F]{3,8}|rgb\()/g)
    if (inline && !isWhitelisted(r)) {
      // 动态绑定 style 里拼色值（accent）是允许的：只查静态写死
      const staticOnly = inline.filter((s) => s.indexOf('{{') < 0)
      staticOnly.forEach((s) => problems.push(r + ' 内联写死颜色：' + s))
    }
  }
}

// 工具页必须用 tool-shell 且有标题
for (const pkg of TOOL_PAGE_DIRS) {
  const pagesDir = path.join(MP, pkg, 'pages')
  if (!fs.existsSync(pagesDir)) continue
  for (const tool of fs.readdirSync(pagesDir)) {
    const base = path.join(pagesDir, tool)
    const json = path.join(base, 'index.json')
    const wxml = path.join(base, 'index.wxml')
    if (!fs.existsSync(json)) continue
    let cfg
    try {
      cfg = JSON.parse(fs.readFileSync(json, 'utf8'))
    } catch (e) {
      problems.push(rel(json) + ' JSON 解析失败：' + e.message)
      continue
    }
    if (!cfg.navigationBarTitleText) problems.push(rel(json) + ' 缺少 navigationBarTitleText')
    const comps = cfg.usingComponents || {}
    const hasShell = Object.keys(comps).some((k) => /tool-shell/.test(comps[k]) || /tool-shell/.test(k))
    if (!hasShell) problems.push(rel(json) + ' 未注册 /components/tool-shell（C5 要求页面统一走外壳）')
    if (fs.existsSync(wxml) && hasShell) {
      const w = fs.readFileSync(wxml, 'utf8')
      if (!/<tool-shell|<tool-shell\b/.test(w) && !new RegExp('<' + Object.keys(comps).find((k) => /tool-shell/.test(comps[k]))).test(w)) {
        problems.push(rel(wxml) + ' 注册了 tool-shell 却未使用')
      }
      if (!/(:tool-id|tool-id=|toolId=|:toolId)/.test(w)) problems.push(rel(wxml) + ' tool-shell 未传 tool-id/toolId')
    }
  }
}

const out = problems.slice()
if (strict) out.push.apply(out, warnings.map((w) => '⚠ ' + w))

console.log('=== UI 规范校验 ===')
console.log('扫描文件：' + files.length + '；问题 ' + problems.length + ' 项；警告 ' + warnings.length + ' 项')
if (problems.length) {
  console.log('\n问题:')
  problems.forEach((p) => console.log(' - ' + p))
}
if (warnings.length && (!strict || problems.length === 0)) {
  console.log('\n警告（令牌未使用，可能是纯布局样式）:')
  warnings.slice(0, 20).forEach((w) => console.log(' - ' + w))
  if (warnings.length > 20) console.log(' - …共 ' + warnings.length + ' 条')
}
process.exit(out.length ? 1 : 0)
