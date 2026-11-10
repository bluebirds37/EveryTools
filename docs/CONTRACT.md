# 实现契约 CONTRACT（所有模块必须严格遵守）

> 本文件是编码期唯一接口规范。任何页面/组件/工具实现都以此处签名为准，**不得自创同名不同参的 API**。
> 需求来源：`docs/requirements.md`、`docs/tools-spec.md`。

## C1. 工程约定
- 目录：小程序根 `miniprogram/`，CommonJS（`require/module.exports`），ES6 语法（基础库支持），**不使用 npm 依赖、不使用 TypeScript、不使用 eval**。
- 路径注册：`app.json` 的 pages/subPackages 是唯一真源，页面目录结构固定为
  `packageX/pages/<tool>/index.{js,wxml,wxss,json}`（json 内 `{"usingComponents": {"tool-shell": "/components/tool-shell/index"}}`，`"navigationBarTitleText"` 填工具名）。
- 分包与工具前缀映射（与 registry 的 `subpackage` 字段一致）：
  `packageImage` / `packageVideo` / `packageQr` / `packageText` / `packageCalc` / `packageLife` / `packageDev`
- 禁止：`wx.getUserProfile`、`getPhoneNumber`、`eval`、远程 HTML、`wx.request` 直接拼未编码参数。
- 每个 JS 文件不超过 ~400 行；超出则拆 `utils/`。

## C2. 工具清单 registry（`miniprogram/tools/`）
`tools/defs/<category>.js` 导出数组，每项：
```js
{
  id: 'image-compress',        // kebab-case，全局唯一，= registry 主键
  fr: 'FR-IMG-01',             // 对应 tools-spec.md 的需求编号
  name: '图片压缩',             // ≤6 汉字
  desc: '照片瘦身，可控目标大小', // ≤20 字，用于卡片副标题与 AI
  category: 'image',           // image|video|qr|text|calc|life|dev
  keywords: ['压缩','瘦身','KB','变小','体积'],  // 搜索 + AI 召回
  icon: 'compress',            // 图标 key，必须是 C7 图标表中的键（纯 CSS/SVG path 渲染，不用图片文件）
  accent: '#3B5BFE',           // 卡片强调色
  entry: '/packageImage/pages/compress/index',
  engine: 'client',            // client | server | hybrid
  fallback: '',                // engine=hybrid 时 'server'
  limits: { maxBytes: 15728640, batchSize: 50 },  // 无限制填 0
  requiresLogin: false,
  requiresPrivacy: [],         // ['album'|'camera'|'record'|'location']
  ai: { api: 'startImageCompress', args: { targetKB: 'number' } }, // 无则 ai: null
  status: 'online',            // online | beta | offline
  hot: true,                   // 首页「常用」推荐位
  version: '1.0.0'
}
```
`tools/index.js`：聚合 `defs/*` → `ALL`（数组）。
`tools/registry.js` 导出 API（**签名固定**）：
```js
all()                          // 全部条目（含 offline）
online()                      // status !== 'offline'
byCategory(category)          // 数组，按 hot 降序、name 升序
get(id)                        // 条目或 null
search(keyword)               // 命中 name/keywords/desc/id，返回数组；空 keyword 返回 online()
categories()                  // [{ id, name, icon, count }] 固定 7 项，顺序 image,video,qr,text,calc,life,dev
isOnline(id)
entryPath(id)                 // entry 或 null
```
分类中文名固定：image=图片、video=视频、qr=条码、text=文本、calc=换算、life=生活、dev=开发。

## C3. 能力封装 utils（`miniprogram/utils/`）
### utils/env.js
```js
module.exports = { BASE_URL, VERSION, TIMEOUT, isDev() }
// BASE_URL 默认 'http://127.0.0.1:8080'，可被 storage 的 'api_base' 覆盖
```
### utils/error.js
```js
CODES = { INPUT_EMPTY, FILE_TOO_LARGE, UNSUPPORTED_FORMAT, IMAGE_TOO_BIG, PERMISSION_DENIED,
          QUOTA_EXCEEDED, TASK_TIMEOUT, TASK_FAILED, NETWORK_OFFLINE, PARAM_INVALID,
          NO_AUDIO_STREAM, SERVER_UNREACHABLE, ENGINE_UNAVAILABLE }  // 值为字符串码
message(code, extra)   // 返回中文用户话术；extra 为 {max,size,reason} 等插值对象
```
规则：**任何面向用户的提示必须经 `message()`**；禁止把 `res.errMsg` 原文展示。
### utils/auth.js（静默登录，FR §6）
```js
ensureLogin()        // Promise<{ userId, accessToken }>；内部 wx.login→POST /auth/silent；失败 resolve({guest:true})
isLoggedIn()
getToken()           // access token 或 ''
refresh()            // Promise<boolean>
logout()
```
存储键：`tb_token`、`tb_refresh`、`tb_user_id`、`tb_login_at`。禁止把 openid 存到前端。
### utils/request.js
```js
request({ url, method='GET', data, auth=true, timeout=15000 })   // Promise<data>，解包 {ok,data,error}
uploadChunk({ url, filePath, name='chunk', formData })           // Promise
downloadToTemp(url)                                              // Promise<tempFilePath>
```
行为：`auth:true` 带 `Authorization: Bearer`；401 自动 `refresh()` 后重试 1 次；
网络失败 → reject `ENGINE_UNAVAILABLE/SERVER_UNREACHABLE` 话术 Error 对象（`err.code` 可用）；
`METHOD` 用大写。后端响应包固定 `{ ok:true, data } | { ok:false, error:{ code, message } }`。
### utils/store.js
```js
get(key, def) / set(key, val) / remove(key)          // JSON 序列化，键前缀 tb_
favorites() / toggleFavorite(toolId) / isFavorite(id)
recents(limit=12) / touchRecent(toolId)
params(toolId) / saveParams(toolId, obj)              // FR-COM-11 参数记忆
usage(toolId) -> {count, lastAt} / bumpUsage(toolId)
```
### utils/track.js
```js
track(event, props)  // 事件名：tool_expose/tool_open/tool_run_start/tool_run_success/tool_run_fail/
                     // engine_fallback/result_save/result_copy/result_share/task_created/task_failed/
                     // ai_card_click/ai_handoff_enter
openTool(toolId, from)   // 统一跳转（校验 status、埋点、recents）+ Promise
```
本地队列 `tb_events`（≥10 条或 30s flush 到 `POST /usage/batch`；无网络时静默保留，不弹窗）。
**禁止上报用户内容**（文本正文、文件名、路径）。
### utils/media.js（图片引擎，Canvas 2D）
```js
loadImage(canvas, src)              // Promise<{width,height,node}>，node 可直接 drawImage
readImage(src)                      // Promise<{path,width,height,size,format}>（wx.getImageInfo+getFileInfo）
compressToJpeg({ path, quality, maxSide, canvasId })   // Promise<{path,size,width,height}>
drawToCanvas({ path, width, height, maxSide, transform }, painter) // 通用：解码→离屏绘制→返回 canvas
exportCanvas(canvas, { fileType='jpg', quality=.9, width, height }) // Promise<{path,size}>
makeOffscreen(name='tb-offscreen')  // 获取隐藏 canvas 节点（页面需放置 <canvas type="2d" id="tb-offscreen">）
```
规则：处理完成后 `canvas.width=1; canvas.height=1;` 释放；单次像素上限 16_000_000，超出先降采样并 `console.warn`。
### utils/video-task.js（云端视频任务，FR-V-00.*）
```js
createTask({ toolId, type, params, filePath, onProgress })  // Promise<{taskId}>；内部 init→分片(4MB,并发2)→complete→POST /media/tasks
pollTask(taskId, { onProgress })                            // Promise<{status, result}>；2s→5s 退避，超时 600s
cancelTask(taskId)
myTasks({ limit=20 })                                        // GET /media/tasks
resultDownload(url)                                          // downloadToTemp + saveVideoToPhotosAlbum/saveImageToPhotosAlbum
```
失败必须抛 `err.code`（TASK_FAILED/TASK_TIMEOUT/QUOTA_EXCEEDED/SERVER_UNREACHABLE）。

## C4. 组件（`miniprogram/components/<name>/index.*`，properties 全用 `properties`，事件用 `bind:xxx`）
### tool-shell（每个工具页的外壳，必需）
```
properties: toolId(String), title(String), desc(String), tips(Array=使用说明条目), showFavorite(Boolean=true)
slots: 默认 slot = 参数区 + 结果区（内部纵向 stack）
行为: attached 时读 registry 校验 status==='offline' → 展示「暂未开放」空态并阻断执行；
      渲染标题栏（收藏星标 + 分享）、tips 折叠、底部安全区。
事件: bind:ready（可开始交互）
```
### param-form（schema 驱动参数区）
```
properties: schema(Array), values(Object)
schema 项: { key, label, type, def, min, max, step, unit, options:[{value,label}],
             showIf:{key, in:[..]} 可选依赖, precision }
type: 'slider' | 'number' | 'segment' | 'switch' | 'color' | 'chip' | 'select' | 'textarea'
事件: bind:change → { key, value }（页面据此更新 values 并 saveParams）
```
页面用法：`onParamChange(e){ const values={...this.data.values,[e.detail.key]:e.detail.value}; this.setData({values}); store.saveParams(toolId, values) }`
### media-picker
```
properties: mediaType('image'|'video'=Array/String), multiple(Boolean), maxCount(20), maxMB(Number),
            accept(Array, 如 ['jpg','png'])
事件: bind:change → { files: [{path,size,width,height,duration,format}] }（已校验，越界会 bind:error {code,message}）
渲染: 虚线加号卡片 + 已选缩略图网格（可单项删除、拖拽不支持）
```
### result-panel
```
properties: kind('image'|'images'|'video'|'text'|'kv'|'none'), images(Array of {url,label}),
            video(String), text(String), kv(Array of {key,value}), meta(String 如「节省 62% · 1.2s」),
            compareBefore(String 原图，用于对比滑杆), showCopy/save/share(Boolean)
事件: bind:copy / bind:save / bind:share / bind:action {action:'use-tool', toolId}（工具串联）
```
### task-progress
```
properties: visible(Boolean), stage('upload'|'queue'|'process'|'done'|'failed'|'canceled'),
            percent(Number 0-100), message(String), eta(String)
事件: bind:cancel
```
### 其他
`empty-state`：`properties{ icon, title, desc }`；`grid-icon`：`properties{ name, color, size }`（按 C7 渲染内联 SVG path）；
`slider-compare`：`properties{ before, after }`（图片前后对比滑杆）。

## C5. 工具页统一骨架（每个工具页必须如此组织）
```js
const registry = require('../../../tools/registry')
const store = require('../../../utils/store')
const track = require('../../../utils/track')
const error = require('../../../utils/error')

Page({
  data: { tool: null, values: {}, busy: false, result: null, error: null },
  onLoad(query) {
    const tool = registry.get(query.toolId || TOOL_ID)   // TOOL_ID 为本页常量
    this.setData({ tool, values: Object.assign(defaults(), store.params(TOOL_ID)) })
    track.track('tool_open', { toolId: TOOL_ID, from: query.from || 'menu' })
  },
  onParamChange(e) { /* C4 param-form */ },
  async onRun() {
    if (this.data.busy) return
    const v = this.data.values
    const invalid = validate(v)                      // 返回 null 或 { code, message }
    if (invalid) return this.setData({ error: invalid })
    this.setData({ busy: true, error: null })
    track.track('tool_run_start', { toolId: TOOL_ID })
    const t0 = Date.now()
    try {
      const result = await run(v)                     // 引擎实现
      track.track('tool_run_success', { toolId: TOOL_ID, costMs: Date.now() - t0, engine: result.engineUsed || 'client' })
      this.setData({ result, busy: false })
    } catch (e) {
      track.track('tool_run_fail', { toolId: TOOL_ID, code: e.code || 'TASK_FAILED' })
      this.setData({ error: { code: e.code || 'TASK_FAILED', message: error.message(e.code, e.extra) }, busy: false })
    }
  }
})
```
硬性要求：`validate()` 前置校验（不满足不发请求/不启动处理）；结果通过 `result-panel` 输出并带保存/复制出口；
纯计算类结果必须支持复制；长任务（>3s）要有进度或骨架屏；页面 wxss 只写本页特有样式，通用样式来自 `app.wxss`。

## C6. UI 现代化要求（不得退化）
- 全部用 `app.wxss` 的 CSS 变量，**不得硬编码色值**（accent 除外，来自 registry）。
- 卡片圆角 28/20rpx、柔和阴影、留白充足（间距只用 `--sp-*`）；主按钮为品牌渐变胶囊。
- 分类色相区分：image #3B5BFE、video #8B5CF6、qr #06A44A、text #F97316、calc #06A44A→用 #0EA5E9、life #EC4899、dev #14B8A6。
- 深色模式必须可用（禁止 `background:#fff` 硬写）。
- 交互反馈：按钮 `:active` 缩放、结果区 `.fade-up` 入场、处理中用 `.spinner` 或骨架。
- 触控目标 ≥ 88rpx 高；文字最小 22rpx；数字/代码用等宽字体类 `.t-mono`/`.code-block`。
- 列表/网格用 `grid-template` 或 flex wrap，两列工具卡片布局（首页 4 列小卡 + 分类页 3 列）。
- 不使用 emoji 作为图标；只用 C7 的矢量图标。

## C7. 图标表（`miniprogram/utils/icons.js`，`{ key: 'SVG path d 字符串' }`，viewBox 0 0 24 24，由 `grid-icon` 渲染）
必须包含（缺项则复用近义）：compress crop convert stitch watermark cut idphoto info colorpick
video clip gif frames audio qr barcode parse
json timestamp base64 url hash uuid regex stats diff naming multiline radix case
unit date loan tax discount percent random bmi compound calculator
compass level timer nettest screen
http color jwt cron sql ua
star starFill search close copy save share download chevron check alert plus heart settings cloud lock
实现要求：path 用简洁几何线条（stroke 由容器 CSS 处理不可行时，用填充路径亦可），单个 path ≤400 字符。

## C8. 后端契约（前端只用这些路径，详见 requirements §8.2）
`POST /auth/silent` `{code, appId}` → `{accessToken, refreshToken, userId, isNew}`
`POST /auth/refresh` `{refreshToken}` → `{accessToken, refreshToken}`
`GET /tools/flags` → `{flags:{[toolId]:{enabled,sort}}}`
`POST /files/init` `{name,size,sha256,mime}` → `{fileId, chunkSize, uploaded:[index]}`
`POST /files/upload` multipart(formdata: fileId,index,chunk) → `{index, received}`
`POST /files/:id/complete` → `{fileId, ready}`
`POST /media/tasks` `{toolId,type,params,fileIds}` → `{taskId,status}`
`GET /media/tasks/:id` → `{id,status,progress,stage,result:{url,kind,items[],sizeMB,meta}}`
`POST /media/tasks/:id/cancel` → `{ok}`
`GET /media/tasks` → `{items:[...]}`
`GET /files/:id/download?token=` → 二进制（一次性签名）
`POST /usage/batch` `{events:[...]}` → `{ok}`
`GET /fx/rates?base=CNY` → `{rates, updatedAt}`
`POST /dev/proxy` `{url,method,headers,body,timeoutMs}` → `{status,statusText,headers:{},bodyText,bodyBytes,elapsedMs,truncated}`（FR-DEV-01 跨域调试用；服务端仅 http/https、拒绝私网与链路本地地址、响应体上限 2MB 超限置 `truncated:true`、`Set-Cookie`/`Authorization` 等敏感响应头不透传）
`GET /static/speedtest-{1,5}m.bin` → 二进制（FR-LIF-07 测速，`Cache-Control: no-store`，由 `server/scripts/gen_speedtest_files.sh` 生成）

## C9. 交付质量门槛（Agent 自检后再回复完成）
1. 所有 JS 通过 `node --check`；所有 JSON 可 `JSON.parse`。
2. 页面文件四件套齐全（js/wxml/wxss/json），json 里 `usingComponents` 路径以 `/components/` 开头。
3. 每个工具页至少实现：参数 schema、validate、run、result 渲染、错误展示、参数记忆。
4. 无 `TODO`、无空函数体、无被注释掉的半成品。
5. 不修改他人负责的文件；需要公共改动时在回复中说明。
6. 每个纯计算类工具附 3 条以上内置自测样例（可在页面「示例」按钮一键填入）。
