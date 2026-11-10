# 功能需求详规（FR Spec）· 通用工具箱小程序

> 配套：`docs/requirements.md`（架构、约束、里程碑）。本文件是**功能需求唯一细化来源**，编码与验收以此为准。
> 约定：
> - 「参数」列格式 `名称 (类型) = 默认值 | 取值范围` —— 前端 `<param-form>` 由此 schema 渲染，AI 接口由此生成 `inputSchema`。
> - 「引擎」`端` / `云` / `端→云`（超阈值自动降级，用户无感知，失败原因回传）。
> - 每个工具默认继承 requirements.md §4.4 的 FR-COM-01~12 通用需求，本文件不再重复。
> - 「验收」为可测断言，QA 用例直接引用 FR 编号。

---

## 0. 全局交互与数据规范（所有工具共用）

### 0.1 输入选择规范
| 编号 | 需求 |
|---|---|
| FR-G-01 | 图片选择：`wx.chooseMedia({mediaType:['image']})`，单次上限 20（批量类 50）；支持相册与相机；返回 `tempFiles` 后**立即**读取 size/type 做校验 |
| FR-G-02 | 视频选择：`wx.chooseMedia({mediaType:['video'], maxDuration: 600})`；`sourceType:['album','camera']`；选中即取 `size/duration/width/height`（`size` 超过 200MB 直接拒绝并提示上限） |
| FR-G-03 | 文本输入：`<textarea>` + 粘贴按钮（`wx.getClipboardData`）+ 清空 + 字数计数；超过 200KB 文本提示改用文件类工具 |
| FR-G-04 | 输出保存：图片/视频用 `wx.saveImageToPhotosAlbum` / `wx.saveVideoToPhotosAlbum`；首次触发隐私与授权提示，拒绝后保留结果在页内并提供「重新授权」 |
| FR-G-05 | 分享出口：`onShareAppMessage` 带工具深链（`?toolId=&from=share`），分享卡片标题为工具名 + 结果摘要（不含用户内容） |
| FR-G-06 | 复制出口：`wx.setClipboardData`，复制成功给 toast，且禁止在复制内容里追加推广文案 |

### 0.2 参数控件规范（`<param-form>`）
| 控件 | 适用 | 规则 |
|---|---|---|
| slider | 数值区间（质量 10–95、宽度 100–4096） | 显示当前值 + 单位；松手才触发重算 |
| number-input | 体积/时长/像素 | 失焦即校验范围，越界自动夹取并提示 |
| segment | 枚举（比例、模式） | ≤5 个选项用分段器，>5 用选择器 |
| switch | 布尔 | 关闭态隐藏依赖子参数 |
| color-picker | 前/背景色 | HEX 输入 + 常用色板；含透明度 |
| file-list | 批量输入 | 缩略图网格、单项删除、拖拽排序、总大小显示 |
| preset-chip | 预设（证件照、目标体积） | 点击填充参数，可取消选中回到自定义 |

### 0.3 校验与错误码规范
| 码 | 用户话术 | 触发 |
|---|---|---|
| `INPUT_EMPTY` | 请先选择内容 | 无输入点击执行 |
| `FILE_TOO_LARGE` | 文件超过 xxMB，请拆分或换小文件 | 超过工具 `limits.maxBytes` |
| `UNSUPPORTED_FORMAT` | 暂不支持 xx 格式 | magic number 判定不在白名单 |
| `IMAGE_TOO_BIG` | 图片过大，处理失败，正在改用云端处理 / 请选择较小图片 | Canvas 内存不足、解码失败 |
| `PERMISSION_DENIED` | 未获得相册/录音权限，无法继续 | 授权被拒 |
| `QUOTA_EXCEEDED` | 今日云端处理次数已用完，明天再来 | 后端 429 |
| `TASK_TIMEOUT` | 处理超时，已保留参数，可重试 | 后端任务超时 |
| `TASK_FAILED` | 处理失败（原因摘要），可重试或调整参数 | 后端 ffmpeg 非零退出 |
| `NETWORK_OFFLINE` | 当前无网络，该工具需要联网 | server 类工具断网 |
| `PARAM_INVALID` | 参数不合法：具体字段与范围 | 客户端校验失败 |

### 0.4 结果面板规范
每个工具结果区必须给出：**结果主体（预览/文本）+ 关键指标（前后对比、节省比例、耗时、引擎）+ 出口按钮（保存/复制/分享/继续处理）**。文本类结果统一提供「复制」「换行显示开关」；媒体类提供「对比滑杆」（原图 vs 结果）。

---

## 1. 图片工具（image）

### FR-IMG-01 图片压缩
- **引擎**：端→云。触发降级：单图 >15MB、批量 >50 张、连续 2 次解码失败、HEIC/webp 解码失败。
- **输入**：相册/相机图片，批量（多选），可追加。
- **参数**
  - `mode (segment) = 'size'` | `size` 目标体积 / `quality` 质量优先 / `dimension` 限边长
  - `targetKB (number) = 200` | 20–5120（mode=size）
  - `quality (slider) = 75` | 10–95（mode=quality）
  - `maxSide (number) = 0` | 0=不变, 100–8192（mode=dimension）
  - `keepExif (switch) = false`；`stripGps 提示`：开启保留 EXIF 时提示可能含位置信息
  - `format (segment) = 'jpg'` | `jpg`/`webp`（png 透明图默认保留 png 并提示）
- **处理规则**
  1. 解码 → 计算原始像素与体积；
  2. mode=size 用二分搜索质量（10–95，≤7 次迭代）+ 必要时降采样，逼近目标体积；结果 >目标值时以 `OVER_TARGET_NOT_REACHABLE` 返回最小 achievable 值并说明；
  3. 单张超过 2048px 先按 `maxSide` 缩放再压缩（`imageSmoothingQuality=high`）；
  4. 批量逐张串行处理，每完成一张更新进度与结果列表；
  5. 全程在 Worker/异步中执行，不阻塞交互；输出后主动释放 canvas 引用。
- **验收**
  - 3000×4000 JPEG（8MB）→ 目标 200KB 成功率 ≥98%，耗时 ≤3s/张（中端安卓真机）；
  - 结果体积 ≤目标值 110%（达不到时给出提示而非静默超）；
  - 批量 50 张不 OOM、不丢进度；
  - 压缩前后对比滑杆可用，节省比例数值正确（(in-out)/in）。

### FR-IMG-02 图片裁剪
- **引擎**：端。
- **输入**：单张图片。
- **参数**
  - `ratio (segment) = 'free'` | `free/1:1/4:3/3:4/16:9/9:16/原图`
  - `presetSize (chip) = none` | `头像 200×200 / 公众号封面 900×383 / 一寸 295×413 / 二寸 413×579 / 自定义`
  - `rotate (slider) = 0` | -180~180，步进 1；`flipH/flipV (switch) = false`
  - `showGrid (switch) = true`；`outputFormat = 'jpg'`；`quality = 90`
- **处理规则**：双指缩放 + 单指拖动框选；框选边界与旋转联动；确定后按输出像素精确渲染（避免屏宽缩放导致失真）；`presetSize` 选中后锁定比例并限制最小裁剪区。
- **验收**：1:1 裁剪输出宽高比误差 ≤1px；自定义 200×200 输出尺寸必须恰为 200×200；旋转 90° 后裁剪结果不出现黑边。

### FR-IMG-03 图片格式转换
- **引擎**：端→云（webp/bmp 解码在部分机型失败时降级）。
- **参数**：`toFormat (segment) = 'png'` | `jpg/png/webp`；`bgColor (color) = #FFFFFF`（透明转 jpg 的填充色）；`quality = 90`。
- **处理规则**：透明像素 → jpg 时按 `bgColor` 铺底（可选「保留透明→强制输出 png」提示）；文件名后缀同步更新；转换后展示体积变化。
- **异常**：源格式不支持解码 → `UNSUPPORTED_FORMAT` + 提示可用云端。
- **验收**：png(带透明)→jpg 结果无黑底；jpg→png 体积增长有提示；webp→png 在 iOS/Android 真机各 5 台通过。

### FR-IMG-04 图片拼接
- **引擎**：端。
- **参数**
  - `layout (segment) = 'vertical'` | `vertical/horizontal/grid/nine`
  - `gridCols (number) = 2` | 1–4（layout=grid）
  - `gap (number) = 10` | 0–100 px；`bgColor = #FFFFFF`；`padding = 0` | 0–100
  - `align (segment) = 'center'` | `start/center/end`（横排按高对齐、竖排按宽对齐）
  - `maxSide (number) = 4096` | 输出长边上限（防内存）
- **处理规则**：以最短边为基准等比缩放；总输出像素超阈值时逐级降 `maxSide` 重试；失败提示减少图片数量。
- **验收**：9 张不同尺寸竖拼无变形、无黑边；输出长边不超过 `maxSide`；顺序与拖拽排序一致。

### FR-IMG-05 批量水印
- **引擎**：端→云（批量 >50 或含高分辨率长图）。
- **参数**
  - `type (segment) = 'text'` | `text/logo`
  - `text = ''` | ≤60 字；`fontSize (slider) = 32` | 10–200（按输出像素比例换算）；`color = #FFFFFF`；`opacity (slider) = 60%` | 10–100
  - `stroke (switch) = true`；`strokeWidth = 2`；`shadow = false`
  - `position (9-grid) = 'br'`；`margin = 24` | 0–200
  - `tile (switch) = false`；`tileAngle = -30°` | -90~90；`tileGap = 120`
  - `logoPath`（type=logo）；`logoScale = 20%` | 5–60（相对图宽）
- **处理规则**：水印按「原图短边百分比」计算，保证不同尺寸图片观感一致；批量应用同一套参数，可单张覆盖位置。
- **验收**：50 张批量成功率 ≥95%；平铺水印边缘无接缝空缺；透明度与设置偏差 ≤5%。

### FR-IMG-06 九宫格切图
- **引擎**：端。**参数**：`cols/rows = 3/3` | 2–4；`fillEdge (switch) = true`（边比不足时居中裁切）。
- **验收**：切出的每张子图尺寸一致（≤1px 误差）；顺序导出为朋友圈九宫格顺序（行优先）。

### FR-IMG-07 证件照尺寸
- **引擎**：端。**参数**：`spec (chip) = 一寸` | 小一寸/一寸/大二寸/护照/签证(美/日)/简历照/自定义(px+mm+dpi)；`bg (segment) = white` | white/blue/red/custom；`autoFaceCenter (switch) = false`（无模型时按人脸不可用，改为手动取景框，需明示）。
- **处理规则**：底色替换采用「边缘区域取样 + 色距阈值」而非全图替换，避免染色主体；输出 mm 与 px 双标注（默认 300dpi）。
- **验收**：一寸输出 295×413px@300dpi；换蓝底后人物发丝边缘无明显色块（主观抽样 20 例可接受率 ≥80%，若达不到则文档降级为「仅纯色背景照片可用」并在工具说明中写明限制）。

### FR-IMG-08 图片改尺寸/DPI
- **参数**：`by (segment) = pixel` | pixel/percent；`width/height`（锁定比例开关）；`percent = 50%`；`dpi (number) = 72` | 72–600（写入 jpg 元信息或说明为打印尺寸换算）。
- **验收**：放大 300% 结果清晰可见插值但不产生错误尺寸；缩小后尺寸精确匹配。

### FR-IMG-09 圆角/描边/背景填充
- **参数**：`radius = 24` | 0–200（px 或百分比模式）；`borderWidth = 0` | 0–60；`borderColor = #000000`；`canvasExpand (switch) = false`；`pad = 40`；`bgColor = #FFFFFF`。
- **验收**：透明 png 圆角结果四角为透明而非白色；加边框后输出尺寸 = 原尺寸 + 2×(pad+border)。

### FR-IMG-10 图片信息 & EXIF
- **引擎**：端（基础字段 + 自研 JPEG APP1 解析）→ 云（TIFF/HEIF 完整解析、GPS 反查地名）。
- **展示**：文件名、格式、宽高、体积、色彩空间；EXIF：拍摄时间、相机机型、镜头、焦距/光圈/ISO/快门、GPS（默认脱敏，用户点击「查看位置」才展开）、方向标记。
- **验收**：`Orientation` 非 1 的图片在预览时按正确方向显示；无 EXIF 图片显示「无拍摄信息」而非空白。

### FR-IMG-11 取色器 / 调色板
- **参数**：`mode (segment) = pick` | pick/palette/contrast；`magnifier = true`；`paletteN = 6` | 3–10；`zoom = 4x`。
- **输出**：HEX/RGB/HSL/HSV 四值同屏、点击任一带复制；`palette` 用 Median-Cut 提取主色并给出色阶；`contrast` 给两色 WCAG 比值与 AA/AAA 判定。
- **验收**：取色值与系统截图取色一致（±2 通道值）；对比度比值与权威计算一致（±0.05）。

### FR-IMG-12 画面调节
- **参数**：`brightness = 0` | -100~100；`contrast = 0`；`saturation = 0`；`sharpness = 0` | 0–100；`blur = 0` | 0–20；`grayscale (switch)`；`preset (chip)`：胶片/清透/黑白/暖阳。
- **实现**：矩阵式调色 + 3×3 卷积锐化/盒式模糊，超 4096px 先降采样预览、导出全尺寸。
- **验收**：参数组合无 NaN/黑图；预览与导出结果一致（同参数 ΔE 主观可接受）。

### FR-IMG-13 马赛克 / 涂抹打码
- **参数**：`mode (segment) = brush` | brush/rect/pixelate-auto；`brushSize = 40`；`pixelBlock = 12` | 4–40；`style`：马赛克/高斯模糊/纯色。
- **规则**：撤销栈 ≥10 步；`pixelate-auto` 尝试定位图中的二维码/条码区域（基于定位点黑白比例启发式，不涉人脸）并提示一键打码。
- **验收**：涂抹路径连续无断点；打码后的二维码用 FR-QR-02 无法识别（关键断言）。

### FR-IMG-14 图片加文字
- **参数**：`layers (array, ≤5)`：`text`、`fontSize`、`color`、`stroke`、`bg`、`rotation`、`x/y(拖拽)`；`align`。
- **验收**：文字可拖拽与双指缩放；导出位置与屏幕所见一致（考虑 DPR）。

### FR-IMG-15 图片转 Base64
- **参数**：`output (segment) = dataURI` | dataURI/raw；`urlSafe (switch) = false`。
- **规则**：结果 >100KB 时只展示前 2000 字符 + 「复制到剪贴板/保存到文件」；给出长度与体积膨胀率（+33%）。
- **验收**：Base64 复制回 FR-TXT-03 可还原为等价图片。

### FR-IMG-16 图片对比
- **参数**：`mode` = slider/blend/side-by-side/diff；`opacity = 50%`；`diffThreshold = 8`。
- **规则**：两图尺寸不同时以第一张为基准缩放，并显式提示「已缩放，非原始尺寸对比」；`diff` 高亮差异像素数与百分比。
- **验收**：相同图片 diff 结果为 0 差异像素。

### FR-IMG-17 图片转 PDF（云）
- **参数**：`fileIds (array ≤30)`、`pageSize = A4` | A4/A5/Letter/auto（按图）；`orientation = auto` | portrait/landscape；`margin = 10mm` | 0–20mm；`fit = contain` | cover；`quality = 85`；`fileName`。
- **流程**：`files/init→upload→complete` → `POST /media/tasks {type:'image2pdf'}` → 轮询 → 下载（`wx.downloadFile`+`openDocument` 预览）。
- **验收**：10 张混合方向图片生成的 PDF 每页无裁切、可预览可转发；单文件 ≤20MB。

### FR-IMG-18 图片去背景（云，P3）
- **参数**：`bgOutput = transparent` | transparent/color/blur；`edgeRefine = true`；`format = png`。
- **前置**：需选定模型服务并过合规评估（不涉人脸属性识别）；未接入时 `status: offline` 且首页不展示。
- **验收**：（接入后）主体边缘无明显残留；失败必须返回可读原因，不得返回原图。

---

## 2. 视频 / 动图工具（video）

### 2.1 通用上传与任务规范（所有视频工具继承）
| 编号 | 需求 |
|---|---|
| FR-V-00.1 | 选择视频后立即本地探测（`wx.getVideoInfo` / `wx.getFileInfo`）展示时长、尺寸、体积；不合规则拒绝并说明 |
| FR-V-00.2 | 分片上传：分片 4MB、并发 2（低端机 1）、失败重试 2 次；服务端 `files/:id/complete` 校验 sha256 |
| FR-V-00.3 | 进度反馈三段式：上传 % → 排队（前方 N 个）→ 处理 %（来自 ffmpeg `out_time_ms/总时长`）；文案区分「正在上传/正在处理」 |
| FR-V-00.4 | 任务落库并本地缓存 `taskId`；用户退出小程序后重进，「我的任务」可继续查询与下载（24h 内） |
| FR-V-00.5 | 取消：客户端调 `POST /media/tasks/:id/cancel`，UI 立刻置 canceled；服务端 kill ffmpeg 进程并清临时文件 |
| FR-V-00.6 | 结果出口：预览播放（`<video>` 临时 URL）、保存到相册、转发；结果 URL 一次性签名，24h 过期后展示「已过期，请重新处理」 |
| FR-V-00.7 | 限额：登录用户 20 次/天、并发 2；游客禁用全部云端视频工具并引导静默登录（自动完成，无按钮） |

### FR-VID-01 视频压缩
- **模式**：`mode (segment) = target` | `target` 目标体积 / `crf` 画质档位 / `bitrate` 指定码率。
- **参数**：`targetMB = 20` | 5–200；`crf = 26` | 18–36；`maxBitrateKbps`；`resolution = 720p` | source/1080p/720p/480p/360p/自定义宽；`fps = source` | 24/30/60/自定义 ≤60；`preset = medium` | ultrafast…veryslow；`audioBitrate = 128k` | 64k/96k/128k/192k；`keepAudio = true`。
- **规则**：`target` 模式服务端先 `ffprobe` 取时长，反算视频码率 = `(targetMB*8192/duration) - 音频码率`，并向下取安全余量 5%；预估结果在执行前展示「约 xxMB / 预计耗时 xx 秒」；两遍编码（2pass）用于 target 模式。
- **限制**：源 ≤200MB、时长 ≤600s、分辨率 ≤4K；超出直接 `FILE_TOO_LARGE` 并说明可用「先截取再压缩」。
- **验收**：target=20MB 输出体积在 18–21MB 区间成功率 ≥90%；720p 输出宽度精确 1280（竖屏按比例）；画质主观抽检无明显块状失真；P95 端到端 ≤90s（60s/1080p 输入）。

### FR-VID-02 视频截取
- **参数**：`startSec = 0` | 0~duration；`endSec = min(15,duration)`；`precision` = 拖动/秒针输入；`thumbnailStrip = true`（服务端返回 6–10 帧雪碧图）；`mode = 重编码` | 关键帧快切（`fastCut`）。
- **规则**：默认重编码保证帧精确（`-ss/-to` 精确定位）；`fastCut` 走 `-c copy`，UI 明示「起止点会吸附到最近关键帧，可能有 ±2s 偏差」；`end-start` 上限 600s。
- **验收**：截取 5.00–10.00s 结果时长 5.0±0.15s；起始画面与时间轴指示一致；无音画不同步。

### FR-VID-03 画面裁剪
- **参数**：`rect (x,y,w,h 比例值)` 或 `ratio (segment) = free/1:1/9:16/16:9/4:3`；`rotate = 0` | 90/180/270；`flipH/V`。
- **规则**：交互复用 `<crop-canvas>`，但坐标系以百分比存储（跨分辨率稳定）；服务端 `crop=in_w*w:in_h*h:x*in_w:y*in_h`。
- **验收**：9:16 竖屏裁剪输出宽高比误差 ≤2%；旋转 90° 后画面正立且分辨率互换。

### FR-VID-04 视频转 GIF
- **参数**：`start/end = 0~5s`（上限 15s）；`fps = 12` | 5–25；`width = 480` | 240–720；`loop = 0(无限)` | 0–10；`quality = 标准` | 高/标准/省体积（调色板 `stats_mode`）；`maxSizeMB = 8`。
- **规则**：`fps palettegen + paletteuse` 两步；超 `maxSizeMB` 时自动逐级降 fps/width 重试一次并在结果中说明调整项；平台限制提示（GIF 保存相册后不循环的机型需说明）。
- **验收**：结果可保存到相册并正常播放；1080p/30s 片段转 5s GIF ≤8MB 且无严重色带；P95 ≤60s。

### FR-VID-05 提取封面 / 抽帧
- **参数**：`mode (segment) = at` | `at` 指定时间 / `count` 均匀 N 帧 / `first` 首帧；`timeSec = 0`；`count = 6` | 1–30；`format = jpg` | jpg/png；`quality = 90`；`width = source`；`contactSheet = false`（拼成一张索引图）。
- **验收**：`count=6` 抽帧时间点为 duration*(i+0.5)/6，误差 ≤0.5s；`contactSheet` 图片标注时间戳；导出图片可直接进 FR-IMG-01 继续压缩（工具间串联）。

### FR-VID-06 视频信息
- **引擎**：端（`wx.getVideoInfo`）→ 云（`ffprobe -print_format json`）。
- **展示**：容器/编码（h264/hevc/av1）、时长、宽×高、帧率、总码率、音频流（编码/采样率/声道）、体积、旋转元数据、是否含 HDR 元信息。
- **规则**：前端探测失败（部分安卓）自动转服务端；「复制诊断信息」输出结构化文本；提供「一键去云端压缩」跳转（串联 VID-01，参数继承）。
- **验收**：与 `ffprobe` 本地结果一致（时长 ±0.1s、码率 ±3%）。

### FR-VID-07 提取音频
- **参数**：`format = mp3` | mp3/aac/m4a/wav；`bitrate = 192k` | 96k/128k/192k/320k；`sampleRate = source` | 44.1k/48k；`startSec/endSec`；`fade = false`。
- **限制**：无音频流时返回 `NO_AUDIO_STREAM` 并提示。
- **验收**：导出 mp3 时长与截取区间一致，可被 `wx.createInnerAudioContext` 正常播放。

### FR-VID-08 视频加水印
- **参数**：`type = text` | text/logo；`text`；`fontSize (%高) = 5`；`color/opacity/border`；`position = br` | 9 宫格；`margin = 3%`；`startSec/endSec`（时段水印，0=全程）；`tiling = false`。
- **规则**：文字用 `drawtext` + 容器内字体文件（须打包 CJK 字体子集，评估体积）；logo 用 `overlay` 且按输出高度缩放。
- **验收**：中文水印无豆腐块；时段水印在指定区间外消失；1080p 输出体积增幅 ≤15%。

### FR-VID-09 视频转格式
- **参数**：`container = mp4` | mp4/mov/mkv/webm/gif；`codec = copy` | copy/libx264/libx265/vp9（copy 仅同编码族允许，否则自动降级重编码并提示）；`faststart = true`（mp4 网络播放）。
- **验收**：mov→mp4 后画质无损（copy 模式 md5 视频流一致）；webm 可在小程序 `<video>` 播放（不支持则结果页提示仅可下载）。

### FR-VID-10 旋转 / 翻转
- **参数**：`rotate = 90` | 90/180/270；`flipH/flipV`；`reencode = true`（元数据旋转仅 mp4 有效，说明差异）。
- **验收**：输出后在相册显示方向正确（不依赖元数据）。

### FR-VID-11 倍速 / 静音 / 音量
- **参数**：`speed = 1.0` | 0.5–2.0（步进 0.25，`setpts`+`atempo` 级联）；`mute = false`；`volume = 100%` | 0–400%；`pitchKeep = true`。
- **验收**：2x 输出时长 ≈ 输入/2（±2%）；atempo 组合后声音无失真、音画同步。

### FR-VID-12 多段拼接
- **参数**：`fileIds (2–10)`；`normalize = auto`（统一分辨率/帧率/SAR，取最小公共档）；`transition = none` | fade 0.5s；`audioAlign = 保留各自` | 统一静音。
- **规则**：分辨率不一致时明示归一化目标并预览告知；总时长 ≤600s。
- **验收**：拼接处无花屏、无时间戳断裂；各段音频顺序正确。

### FR-VID-13 硬字幕压制
- **参数**：`srtText`（文本粘贴或从相册 .srt 文件读取）；`fontPreset = 16px 白字黑边`；`fontSize/fontColor/outlineY`；`position = bottom`；`marginV`。
- **规则**：时间轴校验（缺失序号/时间格式错误 → 定位到第 N 条）；仅支持 srt（ass 列 P4）。
- **验收**：字幕与音画同步（±0.3s），中文正常渲染，超出安全区时提示。

### FR-VID-14 GIF 编辑
- **参数**：`op (segment)` = 删除帧/裁剪时长/压缩/转序列帧；`frameIndexes`；`fpsOut`；`maxColors`。
- **验收**：删除帧后动画连续；GIF 压缩后体积下降 ≥20% 且可播放。

### FR-VID-15 图片合成视频
- **参数**：`fileIds ≤20`；`perImageSec = 2` | 0.5–10；`transition = crossfade` | none/fade/slide；`bgFit = cover` | contain(blur 背景)；`audioFileId?`；`resolution = 1080x1920` | 常用档位；`loop = false`。
- **验收**：总时长 = 图片数×perImageSec ±0.2s；BGM 与视频等长并淡出。

---

## 3. 二维码 / 条码（qr）

### FR-QR-01 二维码生成
- **参数**
  - `type (segment) = text` | `text/url/wifi/vcard/sms/tel/geo`
  - `content`（text/url）；`url` 带 scheme 校验
  - `wifi`：`ssid`、`password`、`security = WPA` | WPA/WEP/open、`hidden = false`
  - `vcard`：`name/phone/org/title/email/company/address`（≤10 字段）
  - `sms`：`number`、`body`；`tel`：`number`
  - `geo`：`lat(-90~90)`、`lng(-180~180)`
  - `size (number) = 512` | 128–2048；`ecc (segment) = M` | L/M/Q/H
  - `fgColor = #000000`；`bgColor = #FFFFFF`；`quietZone = 4 模块`
  - `logo (file) = none`；`logoRatio = 15%` | 5–25（超过 25% 提示可能不可扫）
  - `label (text) = ''`（图下方说明文字）
- **规则**：自研 QR 编码（版本 1–40、掩码 0–7、Byte/Alphanumeric/Numeric 模式自动选择）；生成后**必须**用 jsQR 自检回读，不一致则报错；对比度不足（fg/bg 相对亮度差 <0.4）拒绝生成并提示。
- **验收**：生成的码可被系统相机与 FR-QR-02 成功识别（≥20 台机型抽样 100%）；带 logo 时 ecc 自动升到 H；内容含中文按 UTF-8 编码正确。

### FR-QR-02 相册二维码识别
- **参数**：`images (≤9)`；`tryInverted = true`；`downscale = true`（大图先降采样到 1024 长边）；`autoOpenUrl = false`。
- **规则**：jsQR 解码，支持最多 3 次预处理（灰度→二值化阈值扫描→反色）；识别结果按图片顺序列表展示，标注「成功/未识别」；URL 结果不自动跳转（安全），提供「复制」「生成二维码」出口。
- **验收**：清晰相册截图识别率 ≥95%；未识别必须明确提示而非空白；批量 9 张耗时 ≤6s。

### FR-QR-03 二维码内容解析
- **需求**：输入原始文本，识别协议格式并结构化：URL（scheme/host/path/query 表格）、`WIFI:T:...`、`MECARD`/`vCard`、`SMSTO:`、`geo:`、`otpauth://`；未知格式显示原文 + 字符数 + 编码猜测（UTF-8/GBK）。
- **验收**：WiFi 串解析出的 ssid/密码与原生成值一致（与 FR-QR-01 往返一致）。

### FR-QR-04 条形码生成
- **参数**：`symbology = code128` | code128/code39/ean13/itf；`value`（ean13 支持 12 位自动算校验位并显示）；`height = 80`；`moduleWidth = 2` | 1–6；`showText = true`；`addQuiet = true`。
- **验收**：ean13 校验位计算正确（对照样例 5 组）；生成的条码可被 `wx.scanCode` 识别。

### FR-QR-05 二维码批量生成
- **参数**：`source (segment) = lines` | lines/csv；`dataText`（≤200 行）；`namePattern = {index}-{content}`；`size = 300`；`packing (segment) = album` | album/zip(云端)；`withLabel = true`。
- **规则**：本地批量 ≤200 张，逐张保存相册（`needAuth` 一次授权，中途拒绝则停止并报告已完成数）；zip 打包走后端（P2）；CSV 支持 UTF-8 与 GBK（BOM 检测）。
- **验收**：200 张成功率 ≥98%，失败项列出行号与原因；命名符合 pattern。

### FR-QR-06 二维码美化
- **参数**：`style (chip)` = 标准/圆角点阵/渐变/描边；`dotShape = square` | round/rounded；`gradient (2 colors)`；`posterBg (file)`；`qrRatio = 60%`；`title/subtitle`。
- **规则**：任何美化必须通过「回读自检」（FR-QR-01 同源）后才允许保存；渐变与背景图需保证码点区域对比度阈值。
- **验收**：美化码抽样识别率 ≥95%；未通过自检时禁止导出并提示改用更高 ecc。

---

## 4. 文本 / 编码（text）

> 本类工具共用：输入区（textarea + 粘贴）、输出区、`清空/交换/复制` 三键，参数条可折叠。以下只列差异项。

### FR-TXT-01 JSON 格式化
- **参数**：`indent = 2` | 2/4/tab；`sortKeys = false`；`ensureAscii = false`（中文转 \u）；`collapseDepth = -1`（树视图折叠层级）；`mode = pretty` | pretty/minify/validate/tree。
- **规则**：解析失败必须给出 `行:列 + 期望符号 + 出错上下文片段`；支持 JSON5 宽松模式（注释/尾逗号，开关 `lenient=false`）；树视图节点可折叠、路径点击复制 JSON Pointer；1MB JSON 处理不卡死（Worker + 分帧渲染，>2MB 提示精简）。
- **验收**：错误定位与主流编辑器一致；格式化往返无损（deep-equal 通过）。

### FR-TXT-02 时间戳 ⇄ 日期
- **参数**：`value`（自动识别 10/13 位）；`timezone = 本地` | 本地/UTC/指定偏移；`format = YYYY-MM-DD HH:mm:ss` | 常用几种；`rangeCalc = false`（+/- 天数得日期）。
- **规则**：显示秒/毫秒双值 + 相对时间（「3 天前」）+ 日期快捷（今天 0 点、现在）；非法日期（如 2026-02-30）明确提示。
- **验收**：与系统时间换算一致（含跨时区样例 5 组）。

### FR-TXT-03 Base64 编解码
- **参数**：`dir = encode` | encode/decode；`charset = utf8` | utf8/latin1；`variant = std` | std/urlsafe；`lineWrap = false`；`asImage = none`（选图片文件 → base64 / base64 → 图片）。
- **规则**：解码失败（非法字符/长度）提示具体位置；二进制安全（不用 `atob` 直连，需处理 UTF-8）；图片模式展示 dataURI 与体积膨胀率。
- **验收**：中文往返无损；与 Python `base64` 输出一致（含 padding 差异说明）。

### FR-TXT-04 URL 编解码
- **参数**：`component` | component/fullURL；`mode = encode` | encode/decode；`keepSafe = false`。
- **规则**：fullURL 模式解析出 scheme/host/path/params 表格，参数可增删改后重建；重复参数保留；中文参数编解码正确。
- **验收**：`a=中文&b=1 2` 往返一致；重建 URL 与原语义等价。

### FR-TXT-05 哈希计算
- **参数**：`algo (segment) = md5` | md5/sha1/sha256/sha512；`inputMode = text` | text/file；`text`；`key`（HMAC，可空）；`encoding = utf8`；`upper = false`。
- **规则**：文本 ≤2MB 主线程，>2MB 用 Worker 分块计算；文件哈希走本地读流分块（≤200MB）；结果与 `md5sum`/`openssl` 对照。
- **验收**：已知向量（"abc" 的 sha256、空串 md5）全部匹配；HMAC-SHA256 与 RFC4231 用例匹配。

### FR-TXT-06 UUID / 随机串
- **参数**：`type = uuidv4` | uuidv4/snowflake/nanoid/自定义字符集；`count = 5` | 1–1000；`hyphens = true`；`length = 21`；`charset = A-Za-z0-9`；`excludeAmbiguous = false`。
- **规则**：随机源用 `wx.getRandomValues`（可用时）否则密码学安全的混合种子；批量结果可整体复制、可去重校验；生成密码展示强度等级。
- **验收**：1000 个 UUID 无重复、格式合法（正则校验版本位）；分布均匀（抽样 χ² 通过）。

### FR-TXT-07 正则测试
- **参数**：`pattern`；`flags = g` | g/i/m/s/u/y 组合；`sampleText`；`mode = match` | match/replace；`replacement = '$1'`。
- **规则**：实时高亮匹配区间与分组（分组表列出每组值与索引）；执行超时保护（1s 内未返回判定为灾难性回溯并提示，禁止卡死）；内置 8 条常用正则模板（手机/邮箱/身份证格式/URL/IPv4/邮编/车牌/金额）。
- **验收**：与 V8 语义一致；`(a+)+b` 类灾难样例不冻结 UI 且给出提示。

### FR-TXT-08 字数统计
- **输出**：字符数（含/不含空白）、中文字数、英文单词数、数字串数、标点、行数、段落数、UTF-8 字节数、GBK 字节数。
- **验收**：中英混排样例各项与人工核对一致；emoji（代理对）计为 1 字符。

### FR-TXT-09 文本对比 diff
- **参数**：`left/right`；`granularity = line` | line/word/char；`ignoreCase/ignoreWhitespace = false`；`contextLines = 3`。
- **规则**：Myers diff；左右分栏 +  unified 文本视图（可复制补丁）；统计新增/删除/修改行数与相似度百分比。
- **验收**：样例集（含空行、纯新增、纯删除）结果与 `diff` 命令语义一致。

### FR-TXT-10 命名风格转换
- **参数**：`from = auto` | auto/snake/camel/pascal/kebab/constant/sentence；`to = camelCase`；`input`（多行按行处理）。
- **验收**：`user_nameHTTPCode` 等边界输入结果稳定；往返转换幂等。

### FR-TXT-11 大小写转换
- **参数**：`mode` = upper/lower/title/alternate/invert；`localeSafe = false`（i/İ 说明）。
- **验收**：中文与 emoji 不受影响；首字母大写对连字符/空格边界正确。

### FR-TXT-12 多行文本处理
- **参数**：`ops`（可组合、按序执行）：`trimBlank`、`dedup`、`sort(asc/desc/len)`、`trim`、`prefix`、`suffix`、`number(start/step)`、`shuffle`、`reverse`、`slice(from/to)`、`join(分隔符)`、`split(按长度)`、`replace(find/regex?)`。
- **规则**：预览显示处理前后行数变化；`dedup` 保留首次出现顺序；`sort` 支持自然数字排序。
- **验收**：10 万行文本处理 ≤3s、无截断；组合操作顺序可视化。

### FR-TXT-13 进制转换
- **参数**：`base = 10` | 2/8/10/16/自定义(2–36)；`value`；`width = 64` | 32/64；`signed = false`。
- **输出**：四种常用进制同屏 + 位运算面板（AND/OR/XOR/NOT/移位）。
- **验收**：`2^63-1`、负数补码、超范围溢出提示均正确。

### FR-TXT-14 Unicode / 转义
- **参数**：`mode` = unicode_escape/json_escape/html_entity/base64_of_bytes；`dir = to` | to/from；`onlyNonAscii = true`。
- **验收**：`\u4e2d\u6587` 往返正确；HTML 实体与浏览器表现一致。

### FR-TXT-15 繁简 / 全半角转换
- **参数**：`dir = s2t` | s2t/t2s；`phrases = true`（词组优先于逐字，避免「皇后/後」类错误）；`half↔full` 模式；`keepPunct = true`。
- **实现**：本地字典 ≤120KB（分包内），不联网。
- **验收**：抽样 100 句转换准确率 ≥98%（简↔繁）；全角数字/标点与半角互转无遗漏。

### FR-TXT-16 CSV ⇄ JSON
- **参数**：`dir = csv2json` | csv2json/json2csv；`delimiter = ,` | ,/;/tab/|；`hasHeader = true`；`quote = "`；`skipEmpty = false`；`flattenDepth = 1`（json2csv）。
- **规则**：正确处理引号内分隔符与换行、BOM、CRLF；错误定位到行/列。
- **验收**：RFC4180 样例集全部通过；往返一致。

### FR-TXT-17 XML / YAML ⇄ JSON
- **参数**：`dir`、`preserveAttr = '@'` 前缀策略、`arrayKeys`（强制数组的节点）、`indent = 2`。
- **规则**：YAML 仅支持子集（锚点/多文档不支持并提示）；解析错误给出行列。
- **验收**：常见配置样例无损往返。

### FR-TXT-18 Markdown 预览
- **参数**：`flavor = gfm` | gfm/commonmark；`codeHighlight = true`；`table = true`；`allowHtml = false`（默认关闭，防注入）。
- **规则**：渲染用原生 `rich-text` 白名单节点，禁止任意 HTML；图片外链需 https。
- **验收**：代码块、表格、嵌套列表、任务列表渲染正确；无 HTML 注入路径。

### FR-TXT-19 拼音 & 首字母
- **参数**：`mode = full` | full/initials/polyphone；`toneMark = none` | numeric/diacritic；`separator = ''`。
- **规则**：本地字典 + 姓氏/常用词优先；多音字标注候选。
- **验收**：常用 3500 字准确率 ≥97%；「重庆/银行」类词组读音正确。

---

## 5. 计算 / 换算（calc）

### FR-CAL-01 单位换算
- **参数**：`group (segment)` = 长度/重量/面积/体积/温度/速度/时间/数据存储/功率/压力；`fromUnit`、`toUnit`、`value`；`precision = 6` | 0–10 有效位；`swap`。
- **规则**：温度非线性单独公式；数据存储区分 1024 与 1000 进制（可切换并标注 KiB/kB）；实时双向显示 + 换算公式提示；历史值记忆。
- **验收**：与权威换算表核对，各组 10 项断言误差 ≤1e-9 相对值。

### FR-CAL-02 日期计算
- **参数**：`mode (segment)` = 间隔/加减/倒数日/工作日/周次与季度；`dateA/dateB`；`delta + 单位(day/week/month/year)`；`excludeWeekend = false`；`holidays = none` | 内置中国法定节假日(后端下发)/自定义；`repeat = yearly`。
- **输出**：X 年 X 月 X 天 + 总天数 + 总周数；倒数日支持「已过去/还有」双态与重复年；周次给 ISO 周与年中第几周。
- **验收**：闰年 2/29 加减、跨月末日、月末回退策略明示；节假日表与当年国务院通知一致。

### FR-CAL-03 房贷计算
- **参数**：`type` = commercial/provident/mixed；`principal`；`downPayRatio`；`years`；`rate (可编辑, 默认后端下发 LPR) `；`method` = equalPrincipalInterest/equalPrincipal；`startMonth`；`providerCity`（公积金上限提示）。
- **输出**：首月还款、总利息、月供曲线、逐期明细表（可导出/复制）；两法对比一行结论。
- **验收**：等额本息月供与银行公式误差 <0.01 元；明细求和 = 本金+利息。

### FR-CAL-04 个税计算
- **参数**：`mode` = salary_month/salary_annual/bonus_separate；`income`；`social`、`housingFund`；`specialDeductions[]`（子女教育/继续教育/住房贷款/住房租金/赡养老人/3 岁以下婴幼儿）；`startMonth`。
- **规则**：内置年度累计预扣预缴算法与 7 级税率表；年终奖单独计税与并入综合所得两种方案给对比建议。
- **验收**：与官方样例（含跨档跳档案例）一致；税率表版本号展示并可后端更新。

### FR-CAL-05 折扣 / 比价
- **参数**：`mode` = discount/fullReduction/taxReverse/multiCompare；`price`、`discount(折)`；`threshold/reduce`；`taxRate`、`priceWithTax`；`options[]`（多档满减对比）。
- **验收**：多档优惠给出最优档位与到手价；含税反算不含税与税额一致。

### FR-CAL-06 百分比 & 比例
- **参数**：`mode` = percent/growth/share/multiple；`a/b`；`total`；`weights[]`（比例分配）。
- **验收**：比例分配结果和 = 总量（末项吸收舍入差）。

### FR-CAL-07 随机数 / 决策
- **参数**：`mode` = int/unique/coin/wheel/group/pickName；`min/max`；`count`；`list`（名单，≤200 项）；`groupSize`；`noRepeatAcrossRounds = true`；`exclude`。
- **规则**：转盘动画 ≥1.5s 且结果与展示一致（不可「先算后骗」）；分组给可视化名单；结果可复制。
- **验收**：1–10 抽 10 万次频率均匀（±2%）；不重复抽取 100 项无冲突。

### FR-CAL-08 汇率换算
- **参数**：`base`、`quote`、`amount`；`showRateTime = true`。
- **规则**：后端 `/fx/rates` 代理，15min 缓存；上游失败返回上次成功值并标注「数据时间 xx」；明确「仅供参考，非交易价」。
- **验收**：断网/上游故障时不白屏，展示缓存与提示；常用币种 ≥30。

### FR-CAL-09 身体指标
- **参数**：`height/weight/age/sex`；`neck/waist/hip`（体脂，US Navy 公式）；`activityLevel`；`goal` = lose/maintain/gain。
- **输出**：BMI（含中国标准分级）、体脂率与区间、BMR（Mifflin-St Jeor）、TDEE、建议热量与蛋白质克数。
- **规则**：文案不得构成医疗建议，含「参考值，请咨询专业人士」。
- **验收**：BMI/BMR 与公式手算一致；输入越界（身高 50cm）拒绝并提示。

### FR-CAL-10 复利 / 存款
- **参数**：`mode` = compound/dca/deposit；`principal`、`rate(年化)`、`periods`、`frequency`；`monthlyInvest`；`depositType` = 整存整取/零存整取，`term`。
- **验收**：复利终值与公式一致；定投含期末与投入本金对比收益。

### FR-CAL-11 油费 / 出行成本
- **参数**：`distanceKm`、`fuelPer100km`、`fuelPrice`；`tollFee`；`compareTaxi`（`taxiPerKm`）。
- **验收**：每公里成本与总成本一致，含高速费。

### FR-CAL-12 实用计算器
- **参数/能力**：表达式输入 + 按键面板；科学函数（sin/cos/ln/log/^/%/括号）；历史记录（本地 ≤50 条，可复用）；角度/弧度切换；千分位显示。
- **规则**：自研 tokenizer + 递归下降解析，禁止 `eval`。
- **验收**：`2+3*4=14`、括号嵌套、除零提示、精度 1e-12 内。

---

## 6. 生活 / 设备（life）

| 编号 | 工具 | 输入/参数 | 关键规则 | 验收 |
|---|---|---|---|---|
| FR-LIF-01 | 指南钟 | `mode` = 罗盘/方位角；`calibrationPrompt` | 精度 <5° 前展示「请水平晃动校准」；关闭时 `stopCompass` 释放传感器 | 与系统指南针偏差 ≤10°；页面卸载无传感器泄漏 |
| FR-LIF-02 | 水平仪 | `axis` = pitch/roll；`bubbleSensitivity` | 水平锁定阈值 ±0.5°；加速度计 `startAccelerometer(interval:'game')`，页面隐藏即停 | 静止时读数抖动 ≤0.3°；耗电抽样可接受 |
| FR-LIF-03 | 秒表&倒计时 | `countdown(h/m/s)`、`label`、`multi(≤5)`、`laps` | 用 `Date.now()` 基准而非 setInterval 计数（防漂移）；`wx.setKeepAlive` + 切后台恢复校准；结束震动 | 10 分钟倒计时误差 ≤1s；后台 3 分钟恢复后正确 |
| FR-LIF-04 | 番茄钟 | `work=25`、`break=5`、`longBreak=15`、`cycles=4`、`autoStart=false` | 状态机可中断；当日轮次本地统计；不含订阅消息推送 | 轮次切换正确；重启后可恢复当前轮次 |
| FR-LIF-05 | 尺子 | `unit` = cm/inch；`calibObjectLen` | 用已知尺寸物体（身份证 85.6mm）校准比例后展示误差范围；不校准不显示刻度值 | 真机抽样误差 ≤5% 并明示 |
| FR-LIF-06 | 噪音计 | `interval=250ms`；`range` | 首次触发录音授权（属主动授权，非登录）；RMS→相对 dB 标定说明；不上传音频 | 授权拒绝时优雅降级；关闭页面即停止录音 |
| FR-LIF-07 | 网速测试 | `size` = 1/5/10MB（后端提供静态文件） | 测下载带宽、TTFB、抖动；结果标注测试时间与节点 | 与 speedtest 抽样同数量级（±20%） |
| FR-LIF-08 | 网络信息 | 无入参 | 后端返回 IP/归属地/运营商，不记录用户请求日志超 30 天 | 结果与实际出口一致；隐私提示 |
| FR-LIF-09 | 万年历 | `date`、`mode` = 公历→农历/农历→公历/节假日 | 农历算法本地表（1900–2100）；节假日数据后端下发缓存 | 抽样 20 个农历日期正确；断网可用 |
| FR-LIF-10 | 屏幕检测 | `sequence` = 白/黑/红/绿/蓝/渐变；`interval` | 全屏纯色 + 点击切换/退出；不申请额外权限 | 纯色无过渡残留；退出即恢复 |
| FR-LIF-11 | 手电筒 | `<camera>` + `torch="on"`；亮度提示 | 需真机验证机型占比；不支持则下架并置 `status: offline` | 支持机型 ≥90% 可开关补光 |
| FR-LIF-12 | 快递单号识别 | `trackingNo` | 规则库（正则+长度+前缀）判承运商，返回名称与官方查询链接（不展示他人轨迹） | 抽样 30 单号识别准确率 ≥90% |
| FR-LIF-13 | 密码强度 | `password`（仅本地） | 强度 = 长度×字符类×字典命中；**明文不发送网络**；生成建议复用 FR-TXT-06 | 网络面板断言无密码外发 |

---

## 7. 开发者工具（dev）

| 编号 | 工具 | 输入/参数 | 关键规则 | 验收 |
|---|---|---|---|---|
| FR-DEV-01 | HTTP 请求调试 | `method/url/headers/body/query`；`timeout`；`proxy=false`；`history` | 前端仅可请求已配置合法域名 → 跨域/调试场景走后端代理（禁内网地址、禁 10/172/192 内网段 SSRF）；展示状态/耗时/大小/头/体（自动 JSON 美化） | SSRF 防护用例通过；5MB 响应不 OOM |
| FR-DEV-02 | 颜色工具 | `color`（HEX/RGB/HSL/HSV 任一）；`base2`；`compare` | 四格式实时互转、色阶生成、WCAG 对比度与 AA/AAA 判定、复制到任意格式 | 与规范换算一致；对比度值 ±0.05 |
| FR-DEV-03 | JWT 解析 | `token` | base64url 解 header/payload，展示 `exp/iat` 相对时间与「未验证签名」红字提示 | 非法 token 明确报错；不发送 token 到后端 |
| FR-DEV-04 | Cron 表达式 | `expr`；`tz`；`count=5` | 5/6/7 段兼容；给最近 N 次触发时间与可读描述 | 与 crontab.guru 语义一致（10 条样例） |
| FR-DEV-05 | SQL 格式化 | `sql`；`dialect=generic`；`keywordCase=upper`；`indent=2` | 仅语法层美化，不执行 SQL；超长语句分段渲染 | 100 行 SQL 格式化 ≤500ms |
| FR-DEV-06 | User-Agent 解析 | `ua` | 规则表（浏览器/内核/平台/设备类别/移动端）+ 命中规则展示 | 30 条主流 UA 抽样识别正确 |
| FR-DEV-07 | 代码格式化 | `code`；`indent`；`printWidth` | 仅 JS/TS，本地打包轻量 formatter；体积计入分包预算 | 分包 ≤1.9MB；格式错误不崩溃 |
| FR-DEV-08 | JSON Schema 生成 | `sample JSON` | 推断类型/必填/可空/数组元素 union，输出 draft-07 | 对 5 组样例的推断与人工一致 |
| FR-DEV-09 | 时区换算 | `date`；`zones[]`（≤8） | 支持 DST 展示差异；「会议推荐时段」取交集工作时间 | 与 IANA 数据一致抽样 |

---

## 8. AI 模式原子接口 —— 功能需求（对应 requirements.md §7）

| 编号 | 需求 |
|---|---|
| FR-AI-01 | `mcp.json` 每条原子接口的 `inputSchema` 字段须与工具参数 schema 同源生成（禁止两处手写），取值范围/枚举/默认值一致 |
| FR-AI-02 | 文件相关工具（图片/视频/GIF）的原子接口**只准备参数并出卡**，用户选文件必须发生在接力页内；接口返回 `handoff.query` 携带参数与 `orderId=taskId` |
| FR-AI-03 | 纯计算类（FR-TXT-01 JSON、FR-CAL-01 单位、FR-CAL-02 日期）原子接口在对话内直接返回结构化结果文本，不出卡、不 handoff |
| FR-AI-04 | `searchTools` 无关键词时返回全部在线工具（按分类分组），关键词命中 `name/keywords/shortDesc` 任一字段 |
| FR-AI-05 | 所有接口遵循 demo 返回体：`content` + `structuredContent` + `_meta` + 顶层 `handoff`；失败 `isError:true` 且文案含唯一正确出口并明确「禁止编造参数重试」 |
| FR-AI-06 | 超出 13 条接口能力的用户请求，必须回复「该能力暂不支持」，禁止错误套用接口（写入 `SKILL.md` 能力边界章节） |
| FR-AI-07 | 接力页 `onLoad` 必须处理三种进入路径：AI handoff（query + payload）、普通导航、分享深链；三者行为一致且不报错 |
| FR-AI-08 | 基础库不支持 `wx.onAgentHandoff`/`wx.modelContext` 时静默跳过注册（`console.warn`），主流程零影响 |
| FR-AI-09 | 用户未登录（游客）时，云端工具类原子接口 handoff 到接力页后由页面自动触发静默登录，不在对话侧提示授权 |
| FR-AI-10 | `page-meta.json` 由 `tools/registry` 自动生成（含工具名与描述），构建期校验与清单条目数一致 |

---

## 9. 需求覆盖矩阵（实现时逐条对照，避免遗漏）

每个工具页交付时必须能指出以下 8 项落点：

```
1 清单注册   tools/registry/<category>/<tool>.js（含 ai 映射）
2 页面       <subpackage>/pages/<tool>/index.{js,wxml,wxss,json}
3 引擎       client.js / server.js（同 run() 契约）+ limits 与降级条件
4 参数 schema 驱动 <param-form> 与 AI inputSchema
5 校验       输入前置校验清单 + 错误码映射（§0.3）
6 结果出口   <result-panel>：保存/复制/分享/串联跳转
7 埋点       open/run_start/run_success/run_fail(engineUsed)
8 用例       3 条正向 + 2 条异常/边界（写入 QA 清单，引用 FR 编号）
```
