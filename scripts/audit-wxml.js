#!/usr/bin/env node
/* WXML / 页面绑定静态审计：把「点了没反应」「按钮根本没出现」这类只在真机暴露的缺陷变成可 CI 拦截的断言。
 *
 * 检查项（每项都对应一次真实回归）：
 *  A 路由与文件：app.json 每个页面有 .js/.wxml；wx.navigateTo 的目标在路由表内
 *  B 事件处理器：bind/catch 绑定的方法名在页面 JS（或组件 methods）里存在
 *  C template 作用域：<template is> 必须用 data 传参 —— 写成 item="{{item}}" 会被忽略，
 *    结果是卡片空白 + data-id 取不到 → 点击无响应（2026-10-14 首页事故）
 *  D dataset 契约：方法体里读的 dataset key，必须出现在绑定该方法的所有节点上
 *  E 组件属性：<custom-comp foo="{{x}}> 的 foo 必须在组件 properties 里声明
 *    （例：result-panel 的开关是 showSave/showCopy/showShare，写成 save/copy/share 按钮就不出现）
 *  F wx:for 建议带 wx:key（警告）
 *
 * 用法：node scripts/audit-wxml.js [--json]；有问题时退出码 1
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const MP = path.join(ROOT, 'miniprogram')
const asJson = process.argv.indexOf('--json') >= 0

const problems = []
const warns = []
const bad = (rule, file, msg) => problems.push({ rule, file: rel(file), msg })
const warn = (rule, file, msg) => warns.push({ rule, file: rel(file), msg })
function rel(p) {
  return path.relative(ROOT, p)
}
function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch (e) {
    return null
  }
}
function walk(dir, ext, out) {
  out = out || []
  if (!fs.existsSync(dir)) return out
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name)
    if (fs.statSync(p).isDirectory()) walk(p, ext, out)
    else if (name.endsWith(ext)) out.push(p)
  }
  return out
}
const camel = (s) => String(s).replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase())
const kebab = (s) => String(s).replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())

/* ---------- WXML 轻量解析 ---------- */
function parseTags(src) {
  const body = src.replace(/<!--[\s\S]*?-->/g, '')
  const tags = []
  const re = /<([a-zA-Z][\w-]*)((?:\s[^>]*?)?)(\/?)>/g
  let m
  while ((m = re.exec(body))) {
    const [, name, attrText] = m
    const attrs = {}
    const ar = /([a-zA-Z_:][\w:.-]*)\s*=\s*"([^"]*)"|\b([a-zA-Z_:][\w:.-]+)(?=\s|$)/g
    let a
    while ((a = ar.exec(attrText || ''))) {
      if (a[1]) attrs[a[1]] = a[2]
      else if (a[3]) attrs[a[3]] = ''
    }
    tags.push({ name, attrs })
  }
  return tags
}

const NATIVE = new Set(('view text image button input textarea scroll-view swiper swiper-item block template slot ' +
  'navigator form label checkbox checkbox-group radio radio-group picker picker-view picker-view-column switch slider ' +
  'progress canvas video camera live-player audio map cover-view cover-image icon rich-text movable-area movable-view ' +
  'page-meta navigation-bar keyboard-accessory functional-page-navigator official-account open-data ad').split(' '))

const JS_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'do', 'else', 'try', 'new', 'typeof', 'await', 'then', 'map', 'filter', 'forEach', 'some', 'every', 'find', 'sort', 'reduce', 'push', 'slice', 'split', 'replace', 'test', 'exec', 'join', 'concat', 'catch2'])

/** 页面/组件 JS 里「可被 wxml 绑定的方法名」：顶层对象方法 + 函数声明 + 箭头函数常量 */
function definedMethods(src) {
  const names = new Set()
  for (const m of src.matchAll(/(?:^|[{,;\s])(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(([^()]*)\)\s*\{/gm)) {
    if (!JS_KEYWORDS.has(m[1])) names.add(m[1])
  }
  for (const m of src.matchAll(/(?:^|[{,;\s])(?:async\s+)?([A-Za-z_$][\w$]*)\s*:\s*(?:async\s*)?function/gm)) names.add(m[1])
  for (const m of src.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)) names.add(m[1])
  return names
}

/** 按大括号配对切出每个方法体，返回 Map(handler → Set(datasetKey)) */
function datasetNeedsByHandler(src) {
  const out = new Map()
  const re = /(?:^|\n)(\s{0,8})(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(([^()]*)\)\s*\{/g
  let m
  while ((m = re.exec(src))) {
    const name = m[2]
    if (JS_KEYWORDS.has(name)) continue
    const bodyStart = re.lastIndex - 1
    let depth = 0
    let i = bodyStart
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++
      else if (src[i] === '}') {
        depth--
        if (depth === 0) break
      }
    }
    const body = src.slice(bodyStart, Math.min(i + 1, bodyStart + 6000))
    const keys = new Set()
    for (const d of body.matchAll(/(?:currentTarget|target|e|event|evt|opt)\.dataset\.(\w+)/g)) keys.add(d[1])
    // 解构式：const { id } = e.currentTarget.dataset
    for (const d of body.matchAll(/dataset\s*=\s*(?:e|event|opt|evt)(?:\.currentTarget|\.target)?\.dataset\s*[\s\S]{0,200}?\{([^}]*)\}/g)) {
      d[1].split(',').forEach((k) => {
        const key = k.split(':')[0].trim()
        if (/^\w+$/.test(key)) keys.add(key)
      })
    }
    if (keys.size) out.set(name, keys)
  }
  return out
}

/* ---------- 路由表 ---------- */
const app = readJson(path.join(MP, 'app.json')) || { pages: [], subPackages: [] }
const routes = new Set(app.pages || [])
;(app.subPackages || app.subpackages || []).forEach((sp) => {
  const root = (sp.root || '').replace(/\/$/, '')
  ;(sp.pages || []).forEach((p) => routes.add(root + '/' + p))
})

for (const r of routes) {
  const base = path.join(MP, r)
  if (!fs.existsSync(base + '.js')) bad('A', base + '.js', 'app.json 声明的页面缺少 .js')
  if (!fs.existsSync(base + '.wxml')) bad('A', base + '.wxml', '页面缺少 .wxml（不会渲染）')
}

/* ---------- A：navigateTo 目标必须在路由表 ---------- */
for (const js of walk(MP, '.js')) {
  const src = fs.readFileSync(js, 'utf8')
  for (const m of src.matchAll(/wx\.(navigateTo|redirectTo|switchTab|reLaunch)\s*\(\s*\{([\s\S]{0,240}?)\}\s*\)/g)) {
    const um = /url\s*:\s*['"]([^'"]+)['"]/.exec(m[2])
    if (!um) continue
    const p = um[1].split('?')[0].replace(/^\//, '')
    if (um[1].includes('{{') || um[1].includes("' +") || um[1].includes('${')) continue
    if (!routes.has(p)) bad('A', js, `wx.${m[1]} 的目标不在 app.json 路由表：/${p}`)
  }
}

/* ---------- usingComponents 解析 + 组件属性表 ---------- */
const componentProps = {}
function componentDir(fromDir, spec) {
  const cand = spec.startsWith('/') ? path.join(MP, spec) : path.resolve(fromDir, spec)
  return fs.existsSync(cand + '.js') ? cand : null
}
function metaOf(absBase) {
  const absJs = absBase.endsWith('.js') ? absBase : absBase + '.js'
  if (componentProps[absJs]) return componentProps[absJs]
  const meta = { properties: new Set(), events: new Set() }
  const src = fs.readFileSync(absJs, 'utf8')
  const pr = /properties\s*:\s*\{/.exec(src)
  if (pr) {
    const start = pr.index + pr[0].length - 1
    let depth = 0
    let i = start
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++
      else if (src[i] === '}') {
        depth--
        if (depth === 0) break
      }
    }
    const block = src.slice(start, i + 1)
    for (const k of block.matchAll(/(?:^|\n)\s{2,}([A-Za-z_$][\w$]*)\s*:/g)) meta.properties.add(k[1])
  }
  for (const t of src.matchAll(/triggerEvent\(\s*['"]([^'"]+)['"]/g)) meta.events.add(t[1].toLowerCase())
  componentProps[absJs] = meta
  return meta
}
const registryByDir = {}
for (const jf of walk(MP, '.json')) {
  const cfg = readJson(jf)
  if (!cfg || !cfg.usingComponents) continue
  const dir = path.dirname(jf)
  registryByDir[dir] = {}
  for (const [tag, spec] of Object.entries(cfg.usingComponents)) {
    const hit = componentDir(dir, spec)
    if (!hit) {
      bad('A', jf, `usingComponents["${tag}"] 指向不存在的组件：${spec}`)
      continue
    }
    registryByDir[dir][tag] = hit
    metaOf(hit)
  }
}

/* ---------- 逐 wxml 审计 ---------- */
let boundCount = 0
const wxmls = walk(MP, '.wxml')
for (const wf of wxmls) {
  const dir = path.dirname(wf)
  const isComponent = /\/components\/[^/]+\/index\.wxml$/.test(wf) || /custom-tab-bar\/index\.wxml$/.test(wf)
  const sameBase = path.join(dir, path.basename(wf, '.wxml') + '.js')
  const jsFile = fs.existsSync(sameBase) ? sameBase : path.join(dir, 'index.js')
  if (!fs.existsSync(jsFile)) continue
  const js = fs.readFileSync(jsFile, 'utf8')
  const defined = definedMethods(js)
  const needs = datasetNeedsByHandler(js)
  const wxmlSrc = fs.readFileSync(wf, 'utf8')
  const tags = parseTags(wxmlSrc)
  const comps = registryByDir[dir] || {}

  const boundBy = {}
  for (const t of tags) {
    for (const [attr, val] of Object.entries(t.attrs)) {
      const em = /^(bind|catch|capture-bind|capture-catch)[:\-]?([a-zA-Z]+)$/i.exec(attr)
      if (!em) continue
      boundCount++
      if (!val || val.includes('{{')) continue
      if (!defined.has(val)) {
        bad('B', wf, `<${t.name}> ${attr}="${val}"：${rel(jsFile)} 里没有该方法 → 事件触发后什么都不发生`)
      }
      const data = {}
      for (const [k2, v2] of Object.entries(t.attrs)) {
        const dm = /^data-([a-zA-Z0-9-]+)$/.exec(k2)
        if (dm) data[camel(dm[1])] = v2
      }
      ;(boundBy[val] = boundBy[val] || []).push({ tag: t.name, data })
    }

    if (t.name === 'template' && t.attrs.is) {
      if (t.attrs.data === undefined) {
        bad('C', wf, `<template is="${t.attrs.is}"> 没有 data 属性：模板是独立作用域，其它属性（如 item="{{item}}"）不会传入 → 内容空白、data-* 取不到`)
      }
      const names = [...wxmlSrc.matchAll(/<template\s+name="([^"]+)"/g)].map((x) => x[1])
      if (!names.includes(t.attrs.is)) bad('C', wf, `<template is="${t.attrs.is}"> 找不到同名 <template name="…"> 声明`)
      for (const k of Object.keys(t.attrs)) {
        if (k !== 'is' && k !== 'data' && !k.startsWith('wx:') && !/^(bind|catch)/i.test(k)) {
          bad('C', wf, `<template is> 上的 ${k}="…" 会被忽略（模板只能用 data 传参）`)
        }
      }
    }

    if (!NATIVE.has(t.name) && comps[t.name]) {
      const meta = metaOf(comps[t.name])
      for (const [attr, val] of Object.entries(t.attrs)) {
        if (/^(bind|catch|capture-)/i.test(attr)) {
          const evt = attr.replace(/^(capture-)?(bind|catch)[:\-]?/i, '').toLowerCase()
          if (meta.events.size && !meta.events.has(evt)) warn('E', wf, `<${t.name}> 绑定了组件从未 triggerEvent 的事件 ${attr}="${val}"`)
          continue
        }
        if (/^(class|style|id|hidden|data-|wx:|hover-)/.test(attr)) continue
        const key = camel(attr)
        if (meta.properties.size && !meta.properties.has(key)) {
          const near = [...meta.properties].filter((p) => p.toLowerCase().includes(key.toLowerCase()) || key.toLowerCase().includes(p.toLowerCase())).sort((a, b) => a.length - b.length)
          bad('E', wf, `<${t.name}> 传了未声明的属性 ${attr}="${val}"${near.length ? `（组件实际暴露：${near.slice(0, 3).join(' / ')}）` : ''} → 该属性静默失效`)
        }
      }
    }

    if (t.attrs['wx:for'] !== undefined && t.attrs['wx:key'] === undefined) {
      warn('F', wf, `<${t.name} wx:for="${t.attrs['wx:for']}"> 缺少 wx:key`)
    }
  }

  for (const [handler, nodes] of Object.entries(boundBy)) {
    const keys = needs.get(handler)
    if (!keys || !nodes.length) continue
    for (const key of keys) {
      const missing = nodes.filter((n) => !(key in n.data))
      if (!missing.length) continue
      if (missing.length === nodes.length) {
        bad('D', wf, `${handler}() 读 dataset.${key}，但绑定它的 ${nodes.length} 个节点都没有 data-${kebab(key)} → 点击后拿不到 id，静默 return`)
      } else {
        warn('D', wf, `${handler}() 读 dataset.${key}，${missing.length}/${nodes.length} 个绑定节点缺 data-${kebab(key)}（若走条件渲染分支则属预期）`)
      }
    }
  }
}

const summary = { wxmlFiles: wxmls.length, routes: routes.size, eventBindings: boundCount, problems: problems.length, warns: warns.length }
if (asJson) console.log(JSON.stringify({ summary, problems, warns }, null, 2))
else {
  console.log('=== WXML / 绑定审计 ===')
  console.log(`路由 ${summary.routes} · wxml ${summary.wxmlFiles} · 事件绑定 ${summary.eventBindings} · 问题 ${summary.problems} · 警告 ${summary.warns}`)
  for (const p of problems) console.log(` ✗ [${p.rule}] ${p.file}\n     ${p.msg}`)
  for (const w of warns) console.log(` · [${w.rule}] ${w.file} ${w.msg}`)
}
process.exit(problems.length ? 1 : 0)
