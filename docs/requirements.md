# 通用工具箱微信小程序 · 需求文档（v1.1）

> 文档状态：v1.1 已确认关键决策（见 §2.4）
> 适用范围：产品、前端（微信小程序原生）、后端（Rust + PostgreSQL）
> 参考实现：`ai-mode-demo`（微信小程序官方 AI 模式 / 小微 SubAgent Handoff 示例）
> 配套文档：**`docs/tools-spec.md` —— 全部工具的逐条功能需求详规（FR 编号、输入、参数、规则、异常、验收）**。本文档描述目标、架构与约束；功能细节以 tools-spec.md 为准。

---

## 1. 项目概述

### 1.1 一句话定位
一个「打开即用、无需注册、无需手机号」的通用工具箱小程序：高频轻工具本地（客户端）完成，重资源处理（视频、图片批量、跨格式转码）走服务端，并接入微信小程序 AI 模式（小微）让用户用自然语言直接调用工具。

### 1.2 设计目标
1. **轻**：80% 工具纯前端实现，零网络、零上传，秒开秒用。
2. **快扩展**：工具以「插件化清单 + 统一契约」组织，新增一个工具 = 注册一条清单 + 一个页面/一个函数，不改动主干。
3. **无感登录**：静默登录（`wx.login` → code → openid），全程不索取手机号、不强制授权头像昵称。
4. **AI 原生**：核心工具同时以「原子接口 + 接力页」形式暴露给小微，符合官方推荐范式。
5. **后端非必要不建设**：只有客户端 API 无法覆盖的能力才上服务端。

### 1.3 目标用户与核心场景
| 用户 | 场景 | 典型诉求 |
|---|---|---|
| 普通微信用户 | 临时压缩照片发群、识别二维码、算日期/汇率、随机选人 | 快、不装 App、不注册 |
| 内容创作者/自媒体 | 视频压缩到目标大小、封面裁切、批量水印、抽帧做 GIF | 画质可控、批量、可后台跑 |
| 开发者/运营 | JSON 格式化、Base64、正则测试、二维码批量生成、单位换算 | 精确、可复制、可导出 |
| 办公人群 | 图片转 PDF 思路的多图拼接、长截图合成、身份证尺寸证件照 | 模板化、规格标准 |

### 1.4 交付范围（Phase 划分见 §10）
- **必做**：前端小程序（含工具框架、静默登录、核心工具集）、后端最小服务（登录、视频/图片重处理、任务队列）。
- **不做（v1 明确排除）**：手机号/地址等敏感授权、支付、社交分享裂变之外的营销体系、用户自定义工具编辑器、多语言（仅简体中文）。

---

## 2. 需求原则与关键决策

### 2.1 「前端优先」判定准则
每个工具在下清单前先按此顺序判定：

1. 微信原生 API / Canvas / Worker 能完成 → **纯前端**（0 后端）。
2. 前端能做但性能或内存受限（>10MB 输入、批量 >50 项）→ **前端优先 + 服务端兜底**（同一工具两种执行引擎，运行时择优降级）。
3. 微信端根本没有对应能力（视频剪辑/转码、格式转换、复杂 OCR、PDF 生成）→ **后端**（异步任务）。
4. 需要跨用户共享数据/配置/统计 → **后端**。

> 结论：v1 后端只承担 §7.3 列出的 4 类能力，其余一律前端。

### 2.2 能力边界（受微信小程序平台约束，必须写进设计）
| 约束 | 影响 | 设计应对 |
|---|---|---|
| 主包 2MB / 总包 30MB / 单分包 2MB | 工具数量多时必超 | 分类分包 + 组件按需 + 图片资源走 CDN（§5.5） |
| 无原生视频编解码 API | 视频处理不能纯前端 | 服务端 ffmpeg（Rust 侧 `tokio::process` 调用 CLI，或 `ffmpeg-next`） |
| `wx.getFileInfo` 等对本地临时文件可用，但不能任意读写文件系统 | 文件管理工具受限 | 只做「选择 → 处理 → 保存/分享」闭环，不做文件浏览器 |
| WebView 不能加载任意远程页（需业务域名白名单） | 不能内嵌现成 Web 工具 | 拒绝 WebView 方案，全部原生实现 |
| Canvas 2D 大图内存上限（约屏宽×倍率，实测 4096px 级别易 OOM） | 高清大图处理失败 | 分块/降采样 + Worker + 失败降级到服务端 |
| 后台任务需用户停留或 `wx.setKeepAlive` | 长任务被杀 | 任务持久化 + 服务端保存结果 24h + 回小程序续查 |
| 隐私协议必须声明用户信息用途 | 审核 | 无手机号、无通讯录；仅 openid + 用户主动选择的媒体文件 |

### 2.3 静默登录要求（明确不可破坏项）
1. 首次进入即自动登录，**无任何弹窗、无按钮**。
2. **禁止调用** `getPhoneNumber`、`wx.getUserProfile`、`chooseAddress` 等需用户手动同意的接口作为登录前置。
3. 未登录也能使用 100% 工具功能；登录态只用于「收藏/历史同步、用量限额、任务归属」。
4. 登录失败必须**静默降级**为本地游客模式（本地 uuid + 缓存），不阻断任何功能。

### 2.4 已确认决策（2026-10-13）
| 决策项 | 结论 | 对实现的影响 |
|---|---|---|
| 视频/重媒体处理方案 | **Rust 自研后端 + Docker 容器内 ffmpeg**（不使用微信云存储/云托管） | 必须完成自有域名的 ICP 备案与小程序后台 `uploadFile/downloadFile` 合法域名配置；后端交付物含 Dockerfile（基础镜像装 ffmpeg） |
| AI 模式（小微） | **AppID 已开通内测权限，M5 需真实对接验证** | `skills/toolbox-skill` 按 demo 四件套实现并在真机小微对话回归；仍保留能力探测降级（基础库不支持时静默跳过） |
| 起步范围 | **先完成文档，功能需求必须写全**，再进入编码 | 本轮交付 `requirements.md` + `tools-spec.md`；M1 之前不再产出代码 |
| 数据库 | PostgreSQL `127.0.0.1:15433`，`postgre/postgre`（已验证端口连通） | 迁移脚本 `server/migrations/`，开发库 `toolbox_dev` |

---

## 3. 功能架构总览

```
┌───────────────────────────── 小程序端（原生） ─────────────────────────────┐
│ 首页(工具发现) │ 分类页 │ 工具页(各分包) │ 我的(收藏/历史/设置) │ AI 接力页  │
├──────────────────────── 工具箱框架 (核心复用层) ─────────────────────────┤
│ ToolRegistry 工具清单 │ 统一契约 ToolSpec │ 搜索/推荐 │ 埋点 │ 错误中心      │
├──────────────────────── 能力封装层 utils/* (跨工具复用) ──────────────────┤
│ media: ImageEngine / VideoTaskClient │ io: FilePicker/Saver/Share          │
│ net: Request(retry/sign/upload) │ auth: SilentLogin/tokenStore             │
│ ui: 表单控件/进度/结果面板 │ store: 缓存/收藏/历史 │ worker: 计算线程       │
└───────────────────────────────┬───────────────────────────────────────────┘
                                │ HTTPS (JSON / 分片上传)
┌───────────────────────────── Rust 后端 ───────────────────────────────────┐
│ API 网关(axum) │ auth │ media task(ffmpeg) │ image pro │ config/usage │ admin │
│ PostgreSQL：users, sessions, tools, tool_usage, media_tasks, favorites ...   │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## 4. 工具清单（功能需求主体）

### 4.1 分类体系（7 类，可扩展）
| ID | 分类 | 图标位 | 说明 |
|---|---|---|---|
| image | 图片工具 | tab 1 | 频次最高，首屏主推 |
| video | 视频/动图 | tab 2 | 主要依赖后端 |
| qr | 条码/二维码 | tab 3 | |
| text | 文本/编码 | tab 4 | |
| calc | 计算/换算 | tab 5 | |
| life | 生活/传感器 | tab 6 | 依赖设备能力 |
| dev | 开发者工具 | tab 7 | 可后置 |

### 4.2 全量工具清单（Master Inventory）

> 下表是 v1 规划的**完整工具集合**，与 `docs/tools-spec.md` 的 FR 编号一一对应，也是 `ToolRegistry` 初始清单的唯一来源。
> 「侧」列含义：`端`=纯前端零网络；`端/云`=前端为主、超阈值降级后端；`云`=必须后端。明确不做项见 §4.3。

**图片工具（image，分包 packageImage）** — 18 项

| 编号 | 工具 | 一句话功能需求 | 侧 | 优先级 |
|---|---|---|---|---|
| FR-IMG-01 | 图片压缩 | 目标体积/质量/最长边三模式，批量，前后对比，EXIF 开关 | 端/云 | P0 |
| FR-IMG-02 | 图片裁剪 | 自由+固定比例+尺寸预设，旋转翻转，构图网格 | 端 | P0 |
| FR-IMG-03 | 图片格式转换 | jpg/png/webp/bmp 互转，透明像素处理 | 端/云 | P0 |
| FR-IMG-04 | 图片拼接 | 纵向/横向长图、九宫格、自定义网格、间距与背景色 | 端 | P0 |
| FR-IMG-05 | 批量水印 | 文字/logo 水印，九宫格位置、平铺斜排、透明度描边阴影 | 端/云 | P0 |
| FR-IMG-06 | 九宫格切图 | 一张图切成 3×3/2×2 等多份，用于朋友圈拼图 | 端 | P1 |
| FR-IMG-07 | 证件照尺寸 | 一寸/二寸/护照/签证等预设 + 白蓝红底色 | 端 | P1 |
| FR-IMG-08 | 图片改尺寸/DPI | 按像素或百分比缩放，输出分辨率设置 | 端 | P1 |
| FR-IMG-09 | 圆角/描边/背景填充 | 圆角半径、边框粗细颜色、画布留白填充 | 端 | P1 |
| FR-IMG-10 | 图片信息 & EXIF | 尺寸、体积、格式、拍摄时间、机型、GPS（可关显示） | 端/云 | P1 |
| FR-IMG-11 | 取色器/调色板 | 点选取色、HEX/RGB/HSL 输出、主色提取、对比度检查 | 端 | P1 |
| FR-IMG-12 | 画面调节 | 亮度/对比度/饱和度/锐化/模糊/灰度 + 预设滤镜 | 端 | P2 |
| FR-IMG-13 | 马赛克/涂抹打码 | 二维码与隐私信息打码、笔刷涂抹、像素块大小 | 端 | P2 |
| FR-IMG-14 | 图片加文字 | 字幕/表情包文字，字体大小颜色描边、位置、多文本层 | 端 | P2 |
| FR-IMG-15 | 图片转 Base64 | 生成 dataURI / 纯串，复制，展示长度 | 端 | P2 |
| FR-IMG-16 | 图片对比 | 两图叠加/滑杆/并排，尺寸差异标注 | 端 | P3 |
| FR-IMG-17 | 图片转 PDF | 多图合并 PDF、A4/A5 分页、页边距、压缩 | 云 | P2 |
| FR-IMG-18 | 图片去背景（AI） | 主体抠图、透明/纯色导出 | 云 | P3 |

**视频 / 动图工具（video，分包 packageVideo）** — 15 项

| 编号 | 工具 | 一句话功能需求 | 侧 | 优先级 |
|---|---|---|---|---|
| FR-VID-01 | 视频压缩 | 目标体积 / 目标码率 / CRF / 分辨率档位，预估结果 | 云 | P0 |
| FR-VID-02 | 视频截取 | 时间轴选起止、缩略图预览、按秒精确 | 云 | P0 |
| FR-VID-03 | 画面裁剪 | 视频画面区域裁切与比例锁定 | 云 | P1 |
| FR-VID-04 | 视频转 GIF | 时间段、帧率、宽度、循环次数、调色板优化 | 云 | P0 |
| FR-VID-05 | 提取封面/抽帧 | 指定时间点、均匀抽 N 帧、导出图片集 | 云 | P0 |
| FR-VID-06 | 视频信息 | 时长、分辨率、帧率、码率、编码格式、大小 | 端/云 | P1 |
| FR-VID-07 | 提取音频 | mp3/aac/m4a 导出与比特率 | 云 | P1 |
| FR-VID-08 | 视频加水印 | 文字/logo 水印、位置、透明度 | 云 | P1 |
| FR-VID-09 | 视频转格式 | mp4/mov/mkv/webm 容器与编码转换 | 云 | P1 |
| FR-VID-10 | 旋转/翻转 | 90/180/270 度与镜像 | 云 | P2 |
| FR-VID-11 | 倍速/静音/音量 | 0.5–2x 变速、静音、增益调整 | 云 | P2 |
| FR-VID-12 | 多段拼接 | 多视频顺序合并（参数归一化） | 云 | P2 |
| FR-VID-13 | 硬字幕压制 | srt/ass 内嵌字幕、字体大小位置 | 云 | P3 |
| FR-VID-14 | GIF 编辑 | 逐帧删除、GIF 拼接、GIF 压缩、GIF 转序列帧 | 云 | P3 |
| FR-VID-15 | 图片合成视频 | 图片序列 + 时长/BGM 生成视频 | 云 | P3 |

**二维码 / 条码（qr，分包 packageQr）** — 6 项

| 编号 | 工具 | 一句话功能需求 | 侧 | 优先级 |
|---|---|---|---|---|
| FR-QR-01 | 二维码生成 | 文本/URL/WiFi/vCard/短信/电话/地理位置，容错等级、尺寸、配色、中心 logo | 端 | P0 |
| FR-QR-02 | 相册二维码识别 | 从相册图片识别二维码内容（非相机扫码），批量、结果可复制 | 端 | P0 |
| FR-QR-03 | 二维码内容解析 | 解析二维码文本（URL 参数、vCard 字段、WiFi 信息结构化展示） | 端 | P1 |
| FR-QR-04 | 条形码生成 | Code128 / Code39 / EAN-13 / ITF，尺寸与下方文字 | 端 | P1 |
| FR-QR-05 | 二维码批量生成 | CSV/换行列表批量出图、命名规则、打包保存 | 端/云 | P2 |
| FR-QR-06 | 二维码美化 | 样式模板、圆角点阵、渐变、海报背景嵌入 | 端 | P2 |

**文本 / 编码（text，分包 packageText）** — 19 项

| 编号 | 工具 | 一句话功能需求 | 侧 | 优先级 |
|---|---|---|---|---|
| FR-TXT-01 | JSON 格式化 | 美化/压缩、语法错误行列定位、树视图折叠、键名排序 | 端 | P0 |
| FR-TXT-02 | 时间戳 ⇄ 日期 | 秒/毫秒自动识别、双向转换、时区选择、相对时间 | 端 | P0 |
| FR-TXT-03 | Base64 编解码 | UTF-8 安全、文本与图片文件双向、URL-safe 变体 | 端 | P0 |
| FR-TXT-04 | URL 编解码 | encode/decodeURIComponent、query 参数解析与重建 | 端 | P0 |
| FR-TXT-05 | 哈希计算 | MD5/SHA-1/SHA-256/SHA-512、HMAC（可选密钥）、文件哈希 | 端 | P0 |
| FR-TXT-06 | UUID / 随机串 | UUID v4 批量、雪花 ID、随机密码（强度策略） | 端 | P0 |
| FR-TXT-07 | 正则测试 | 实时匹配高亮、分组捕获、标志位、替换预览、常用样例 | 端 | P1 |
| FR-TXT-08 | 字数统计 | 字符/中文/英文/单词/行/段落/字节（UTF-8）分别统计 | 端 | P1 |
| FR-TXT-09 | 文本对比 diff | 行级差异、增删改着色、相似度 | 端 | P1 |
| FR-TXT-10 | 命名风格转换 | camel/snake/kebab/Pascal/CONSTANT 互转 | 端 | P1 |
| FR-TXT-11 | 大小写转换 | 全大写/小写/首字母大写/大小写互换 | 端 | P1 |
| FR-TXT-12 | 多行文本处理 | 去重、排序、去空行、去首尾空白、加前后缀、编号、行截取 | 端 | P1 |
| FR-TXT-13 | 进制转换 | 2/8/10/16 互转，位运算预览 | 端 | P1 |
| FR-TXT-14 | Unicode / 转义 | \uXXXX 互转、JSON 字符串转义、HTML 实体互转 | 端 | P2 |
| FR-TXT-15 | 繁简 / 全半角转换 | 字典转换、标点与数字全半角互转 | 端 | P2 |
| FR-TXT-16 | CSV ⇄ JSON | 表头映射、分隔符可选、单层嵌套展开 | 端 | P2 |
| FR-TXT-17 | XML / YAML ⇄ JSON | 结构互转与错误提示 | 端 | P3 |
| FR-TXT-18 | Markdown 预览 | 渲染预览，支持代码块与表格 | 端 | P2 |
| FR-TXT-19 | 拼音 & 首字母 | 汉字转拼音、首字母串（本地字典，多音字取常用音） | 端 | P3 |

**计算 / 换算（calc，分包 packageCalc）** — 12 项

| 编号 | 工具 | 一句话功能需求 | 侧 | 优先级 |
|---|---|---|---|---|
| FR-CAL-01 | 单位换算 | 长度/重量/面积/体积/温度/速度/时间/数据存储/功率/压力 | 端 | P0 |
| FR-CAL-02 | 日期计算 | 日期间隔、日期加减、倒数纪念日、工作日/自然日、季度与周次 | 端 | P0 |
| FR-CAL-03 | 房贷计算 | 等额本息/等额本金/组合贷，月供与总利息明细，利率可调 | 端/云 | P0 |
| FR-CAL-04 | 个税计算 | 工资累计预扣、年终奖单独计税，税率表内置 | 端/云 | P1 |
| FR-CAL-05 | 折扣 / 比价 | 打折、满减、多档优惠对比、反算折扣率、含税价反算 | 端 | P1 |
| FR-CAL-06 | 百分比 & 比例 | 占比、增长率、比例分配、翻倍数 | 端 | P1 |
| FR-CAL-07 | 随机数 / 决策 | 区间随机、不重复抽取、抛硬币、转盘、分组抽签、点名 | 端 | P1 |
| FR-CAL-08 | 汇率换算 | 多币种实时汇率（后端代理 + 缓存 15min）、常用货币对 | 云 | P1 |
| FR-CAL-09 | 身体指标 | BMI、体脂率（围度公式）、基础代谢、每日热量建议 | 端 | P2 |
| FR-CAL-10 | 复利 / 存款 | 复利终值、定投收益估算、存款到期利息 | 端 | P2 |
| FR-CAL-11 | 油费 / 出行成本 | 里程油耗费用、打车与自驾成本对比 | 端 | P3 |
| FR-CAL-12 | 实用计算器 | 科学计算、历史记录、表达式解析 | 端 | P2 |

**生活 / 设备（life，分包 packageLife）** — 13 项

| 编号 | 工具 | 一句话功能需求 | 侧 | 优先级 |
|---|---|---|---|---|
| FR-LIF-01 | 指南针 | 方位角与朝向，`wx.onCompassChange`，校准提示 | 端 | P1 |
| FR-LIF-02 | 水平仪 | 俯仰/横滚角、气泡可视化、水平锁定提示 | 端 | P1 |
| FR-LIF-03 | 秒表 & 倒计时 | 多路倒计时、计时分段、后台持续（`wx.setKeepAlive`） | 端 | P1 |
| FR-LIF-04 | 番茄钟 | 25/5 循环、轮次统计、页内提醒 | 端 | P2 |
| FR-LIF-05 | 尺子 | 屏幕刻度（DPI 估算）+ 已知物体校准流程 | 端 | P3 |
| FR-LIF-06 | 噪音计 | 采样计算分贝区间与波形（需录音授权，属主动授权工具） | 端 | P2 |
| FR-LIF-07 | 网速测试 | 下载固定资源测带宽、时延与抖动 | 端/云 | P2 |
| FR-LIF-08 | 网络信息 | 本机公网 IP、运营商与城市归属、时区 | 云 | P2 |
| FR-LIF-09 | 万年历 / 农历 | 公历农历互查、节假日与调休（数据后端下发） | 端/云 | P3 |
| FR-LIF-10 | 屏幕检测 | 坏点检测纯色轮换、色彩与对比度测试 | 端 | P3 |
| FR-LIF-11 | 手电筒 | 相机取景页 + `torch` 常亮（真机验证不通过则下架） | 端 | P3 |
| FR-LIF-12 | 快递单号识别 | 输入单号自动判别承运商与官方查询链接 | 云 | P3 |
| FR-LIF-13 | 密码强度检测 | 本地计算强度，明文不联网上传 | 端 | P3 |

**开发者工具（dev，分包 packageDev）** — 9 项

| 编号 | 工具 | 一句话功能需求 | 侧 | 优先级 |
|---|---|---|---|---|
| FR-DEV-01 | HTTP 请求调试 | 方法/头/体自定义、状态码、耗时、响应大小，支持后端代理跨域 | 端/云 | P1 |
| FR-DEV-02 | 颜色工具 | HEX/RGB/HSL/HSV 互转、取色、调色板、WCAG 对比度检查 | 端 | P1 |
| FR-DEV-03 | JWT 解析 | header/payload 解码与过期时间（明确「不验签」提示） | 端 | P2 |
| FR-DEV-04 | Cron 表达式 | 解析与最近 N 次触发时间预览 | 端 | P2 |
| FR-DEV-05 | SQL 格式化 | 关键字美化、压缩、方言提示 | 端 | P2 |
| FR-DEV-06 | User-Agent 解析 | 浏览器/内核/设备/系统识别 | 端 | P2 |
| FR-DEV-07 | 代码格式化 | JS/TS 美化（本地打包轻量 formatter） | 端 | P3 |
| FR-DEV-08 | JSON Schema 生成 | 由样例 JSON 推断 schema | 端 | P3 |
| FR-DEV-09 | 时区换算 | 多时区对照表、跨时区会议时间选择 | 端 | P3 |

**合计 92 项工具**（P0 20 项 / P1 30 项 / P2 25 项 / P3 17 项）；纯前端 62 项、必须后端 19 项、前端为主+超限降级后端 11 项（按「侧」列统计）。

> **前端可行性结论**：视频在小程序端无编码 API，`wx.chooseMedia` 只能拿到临时文件播放/上传，因此视频类工具一律「分片上传 → 服务端异步任务 → 签名 URL 下载」，必须设计**断点续传 + 进度反馈 + 任务持久化**。图片类以 Canvas 2D 为主引擎，超阈值（>15MB、批量>50、webp 解码、PDF 生成）降级服务端。

### 4.3 明确不做（v1 排除，附理由）
| 项 | 理由 |
|---|---|
| 手机号 / 通讯录 / 精确位置获取 | 与「静默登录、最小授权」原则冲突，审核风险高 |
| 人脸识别 / 证件 OCR / 身份证年龄性别解析 | 需额外类目资质与生物识别合规审查 |
| 门禁卡 / NFC / 蓝牙解锁类 | 平台能力与安全边界不可控 |
| 活码 / 短链 / 推广统计 | 依赖第三方服务，易被判营销诱导 |
| 多轨视频时间轴编辑器 | 复杂度远超 v1 范围，留待 v2 |
| PDF 内容编辑 | 只做「图片 → PDF」单向生成 |
| 天气 / 新闻等内容型工具 | 需内容类目资质，非工具箱定位 |
| 下载管理 / 文件系统浏览 | 小程序沙箱不允许任意文件读写 |

### 4.4 工具通用功能需求（每个工具都必须具备）
| 编号 | 需求 | 说明 |
|---|---|---|
| FR-COM-01 | 统一页面外壳 | 标题、简介、使用说明（可折叠）、参数区、结果区、错误态、空态 |
| FR-COM-02 | 输入校验前置 | 体积/格式/数量/权限不满足时**不发请求、不启动处理**，给可读提示 |
| FR-COM-03 | 结果可落地 | 复制、保存到相册、转发文件、以结果再生成二维码等出口 |
| FR-COM-04 | 收藏与最近使用 | 本地记录 + 登录用户与服务端合并（§5.4） |
| FR-COM-05 | 使用埋点 | `tool_expose/open/run_start/run_success/run_fail`，失败带错误码与引擎 |
| FR-COM-06 | 中断与重试 | 长任务可取消；失败保留参数并提供一次重试 |
| FR-COM-07 | 深色模式 | 全部分包适配 |
| FR-COM-08 | 离线提示 | `client` 工具断网可用；`server` 类断网时禁用入口并提示 |
| FR-COM-09 | 版本与灰度 | `status`/`min_version`/`gray_percent` 控制上架（§5.1），下线工具页展示「暂未开放」 |
| FR-COM-10 | 隐私声明 | 触发相册/相机/录音前展示用途，符合平台隐私接口规范 |
| FR-COM-11 | 参数记忆 | 同工具参数本地记忆（默认沿用上次），下次进入自动填充 |
| FR-COM-12 | 结果水印合规 | 服务端产物不添加任何推广水印（避免体验与审核风险），仅可标注处理信息 |

---

## 5. 工具箱框架设计（可扩展性是核心验收项）

### 5.1 工具清单（ToolRegistry）
所有工具通过**一条声明式记录**注册，清单是首页、搜索、分类、AI 映射的**唯一数据源**。

```js
// tools/registry/image-compress.js  （示意，非最终代码）
module.exports = {
  id: 'image-compress',            // 全局唯一，kebab-case
  name: '图片压缩',
  category: 'image',                // 分类 ID
  keywords: ['压缩', '变小', '瘦身', 'KB'],   // 搜索 + AI 意图召回
  icon: '/assets/ic-compress.png',
  shortDesc: '照片瘦身，可控目标大小',
  entry: '/packageImage/pages/compress/index', // 页面路径
  engine: 'client',                 // client | server | hybrid
  fallback: 'server',               // engine=hybrid 时的降级目标
  limits: { batchSize: 50, maxBytes: 15 * 1024 * 1024 },
  requiresLogin: false,             // 仅限额功能为 true
  requiresPrivacy: ['相册'],         // 触发的隐私声明
  ai: { capability: 'compressImage', args: { targetKB: 'number' } }, // AI 模式映射
  status: 'online',                 // online | beta | offline —— 支持灰度下线
  version: '1.0.0'
}
```

**框架约束（必须实现）**：
- `tools/index.js` 聚合导出全部清单，`registry` 提供 `all() / byCategory() / search(kw) / get(id) / online()`。
- 清单同时是**首页渲染数据**、**搜索索引**、**AI `page-meta.json` 生成源**、**埋点白名单**——不允许任何一处再手写第二遍。
- 新增工具流程只允许：① 新建分包页面 ② 新增一条清单记录 ③ 需要时注册 AI 原子接口。**禁止**改动主干代码。
- 支持服务端下发 `tool_flags`（开关/排序/灰度），清单本地兜底。

### 5.2 统一执行契约（能力封装层）
每个工具的内部实现遵循同一生命周期，便于复用 UI 与埋点：

```
pick()   → 选择输入（图片/视频/文本/参数）
validate() → 体积/格式/数量/权限校验，返回可读错误
run(params, onProgress) → 返回 Promise<{ ok, result, engineUsed, costMs }>
render(result) → 统一结果面板（预览/对比/复制/保存/分享/再来一次）
```

`engine: hybrid` 的工具必须实现同一 `run()` 接口下的双引擎（`client.js` / `server.js`），由 `engine.js` 按 `limits` 与网络状况选择，并记录 `engineUsed` 上报。

### 5.3 复用组件（前端一次封装，全工具使用）
| 组件 | 职责 |
|---|---|
| `<media-picker>` | 统一选图/选视频，封装 `wx.chooseMedia` 参数、隐私授权、数量限制 |
| `<crop-canvas>` | 裁剪交互层（缩放/旋转/比例锁定/网格） |
| `<result-panel>` | 结果展示：图片对比滑杆、视频预览、文件信息、复制按钮 |
| `<task-progress>` | 异步任务进度（上传%/处理%/排队位）+ 取消 |
| `<param-form>` | 由 schema 渲染参数表单（滑杆/开关/单选/数字） |
| `<tool-shell>` | 工具页统一外壳：标题、说明、广告位、错误态、埋点 |
| `error-center` | 全局错误码 → 用户话术映射（禁止把 `errMsg` 直接抛给用户） |

### 5.4 数据与用户态
- 收藏、最近使用、使用次数存本地 `Storage`，登录用户与服务端 `favorites` / `tool_usage` 双向合并（本地优先，冲突取时间新）。
- 全部工具结果**默认不落服务端**；只有选择「保存/分享」或服务端任务时才上传，服务端文件 TTL 24h（§7.6）。

### 5.5 包体与资源策略
- 分包：`packageImage`、`packageVideo`、`packageQr`、`packageText`、`packageCalc`、`packageLife`、`packageDev`、`packageSkill`（AI）。
- 主包只放首页/分类/我的 + 框架 + P0 中最高频的图片压缩与裁剪。
- 图标/示例图走 CDN；分包 `independent: false`（需要共享框架代码）。

---

## 6. 静默登录与账号体系（详细需求）

### 6.1 时序
```
小程序 onLaunch
  ├─ wx.login() → code
  ├─ POST /api/v1/auth/silent  { code, appId, env }
  │     └─ 后端: code → 微信 code2session → openid/unionid/session_key
  │              ├─ upsert users
  │              ├─ 签发 JWT(access 2h, refresh 30d, HS256/RS256)
  │              └─ 返回 { accessToken, refreshToken, userId, isNew }
  ├─ 本地 storage 保存 token（不进 globalData 明文日志）
  └─ 失败 → 游客模式（local uuid，功能不受限，收藏/历史仅本地）

token 过期 → 请求拦截器自动用 refreshToken 换新 → 静默重试原请求
refreshToken 失效 → 重新走一次 wx.login 静默续期 → 仍失败则游客模式，不弹窗
```

### 6.2 硬性要求
1. `appsecret` **只存服务端**，通过环境变量注入，禁止出现在小程序包内。
2. 前端**不感知 openid**：后端返回的是内部 `userId`/`accessToken`，openid 不下发（避免用户标识泄漏）。
3. `session_key` 仅服务端保存、不落库明文（可加密列），不做解密手机号等敏感用途。
4. 未登录可用全部工具；`requiresLogin: true` 的工具清单在 v1 **为空**（仅为后续会员/限额预留字段）。
5. 微信侧要求：需在小程序管理后台配置**服务器域名白名单**（request + uploadFile + downloadFile），本地开发可临时关闭校验。
6. 隐私政策：声明仅收集「设备标识（openid）+ 用户主动上传的媒体文件」，不收集手机号/通讯录/位置（GPS 仅在用户主动查看图片信息时读取文件内 EXIF，不主动定位）。

### 6.3 限额与风控（后端）
- 游客（无 token）：仅可用 `engine: client` 工具。
- 登录用户：服务端任务默认 **20 次/天**，单文件 **≤200MB**，并发 **≤2**；超限返回 `429` + 友好文案。
- IP + userId 双维度限流；上传文件类型白名单（magic number 校验，非扩展名）。

---

## 7. AI 模式（小微）需求 —— 按官方 `ai-mode-demo` 范式

### 7.1 目标形态
用户在小微对话里说「帮我把这张图压到 200KB 以内」「把昨天那个视频转成 GIF」→ 小微调用小程序原子接口 → 返回**文本 + 小程序卡片** → 用户点卡片 **handoff 接力**进入对应工具页，页内完成选择与执行。

> 与 demo 一致的关键约定：对话内**不渲染原子组件 GUI**，只做「文本 + 卡片」，重交互留在小程序页面。

### 7.2 工程接入（四件套，逐条对应 demo）
1. **`app.json`**：
```json
{
  "agent": {
    "skills": [
      { "name": "toolbox", "description": "通用工具箱：图片压缩裁剪、视频压缩转GIF、二维码生成识别、JSON格式化、单位换算、日期计算", "path": "skills/toolbox-skill" }
    ],
    "pageMetadata": "page-meta.json"
  }
}
```
2. **`skills/toolbox-skill/`**：`SKILL.md`（业务说明书）+ `mcp.json`（原子接口声明，含 `_meta.ui.pagePath`）+ `apis/*.js` + `index.js`（`wx.modelContext.createSkill('skills/toolbox-skill')` + `registerAPI`）。作为独立分包。
3. **`app.js`**：`onLaunch` 内注册 `wx.onAgentHandoff`，按 `pageId` 缓存 `{path, query, payload}`，提供 `takeAgentHandoff(pageId)` 取后即删（与 demo 实现一致，必须在 `onBeforeAppRoute` 之前注册）。
4. **接力页**：`onLoad(query)` 解析参数；可选用 `pageId` 取 `payload` 预置数据加速首屏；页面内用普通导航完成后链操作。

### 7.3 v1 原子接口清单（与工具清单 §5.1 的 `ai` 字段一一对应）
| 接口名 | 意图 | input | handoff.query | 接力页 |
|---|---|---|---|---|
| `searchTools` | 「有什么工具 / 找压缩图片的」 | `keyword?` | `keyword=压缩` | `/pages/home/home` |
| `getToolDetail` | 看某工具说明/参数 | `toolId`（来自 searchTools） | `toolId=image-compress` | `/pages/tool-detail/tool-detail` |
| `startImageCompress` | 压缩图片 | `targetKB?`, `maxSide?` | `orderId=<taskId>` | `/packageImage/pages/compress/index` |
| `startImageCrop` | 裁剪 | `ratio?` | `ratio=1:1` | `/packageImage/pages/crop/index` |
| `addWatermark` | 加水印 | `text?`, `position?` | `text=xx&position=br` | `/packageImage/pages/watermark/index` |
| `startVideoCompress` | 视频压缩 | `targetMB?`, `resolution?` | `orderId=<taskId>` | `/packageVideo/pages/compress/index` |
| `videoToGif` | 转 GIF | `start?`, `end?`, `fps?` | `orderId=<taskId>` | `/packageVideo/pages/gif/index` |
| `extractFrames` | 抽帧/封面 | `count?` | `orderId=<taskId>` | `/packageVideo/pages/frames/index` |
| `generateQrcode` | 生成二维码 | `content`, `type` | `content=...` | `/packageQr/pages/generate/index` |
| `formatJson` | JSON 格式化（对话内直接给结果） | `content` | 无（纯文本结果，不出卡） | — |
| `convertUnit` | 单位换算（对话内直接给结果） | `value`, `from`, `to` | 无 | — |
| `calcDateRange` | 日期计算（对话内） | `start`, `end` | 无 | — |
| `listHistory` | 查看最近使用/收藏 | `scope?` | 空 | `/pages/mine/mine` |

> **设计原则**：纯计算类（JSON/换算/日期）**在对话内直接返回结果**，不做 handoff，减少无谓跳转；凡需要用户选文件的，一律出卡 + 接力页，文件选择**永远发生在小程序页内**（原子接口无法访问用户相册）。

### 7.4 SKILL.md 必须写明的约束（沿用 demo 的行文强度）
- **能力边界**：仅上述接口为全部能力；超出范围必须直接回复「该能力暂不支持」，禁止乱调接口（对应 demo「0. 能力边界」）。
- **参数来源铁律**：`toolId` 必须来自 `searchTools` 返回原值，`orderId` 必须来自 `start*` 返回原值，**【禁止编造】**；用户原话未给参数时用默认值而非猜测（对齐 demo「用户没提就别传」）。
- **执行顺序**：`startImageCompress` 等需先有 `getToolDetail` 或直接接受默认参数（v1 定为：允许直接调用并用默认值，接力页让用户微调）。
- **输出形态**：出卡时话术一句简短，禁止 markdown 列全部工具清单。
- **接力页后续**：选图、确认、下载均在页内完成，不回到对话（对齐 demo「3. 进小程序后的后续」）。
- **失败分支**：接口失败返回 `isError: true` + 文案中给出**唯一正确出口**并写明「禁止编造参数重试」（对齐 demo `searchDrinks` 零命中处理）。

### 7.5 `mcp.json` 规范要点
- 每个接口 `description` 写清「业务对象 + 前置条件 + 严禁场景 + 后续动作」四段。
- `inputSchema` 每个字段标注取值来源与枚举；`outputSchema` 给 Agent 理解用的精简结构。
- `_meta.ui.componentPath` 保留原子组件路径（小微暂不渲染，为小程序内 Agent 场景预留），`_meta.ui.pagePath` **不含 query**。
- `structuredContent` 与 `_meta`（含图片 URL）分离：Agent 不可见渲染数据。

### 7.6 降级
基础库不支持 `wx.onAgentHandoff` / `wx.modelContext` 时：跳过注册并 `console.warn`（同 demo），AI 能力静默不可用，主流程零影响。**AI 模式不作为 v1 上线阻塞项**（P1 里程碑）。

---

## 8. 后端需求（Rust + PostgreSQL）

### 8.1 技术选型
| 层 | 选型 | 理由 |
|---|---|---|
| HTTP | `axum` 0.8 + `tokio` | 官方推荐、模块化、易测 |
| DB | `sqlx`（编译期校验查询）+ `postgres` | 类型安全、无 ORM 魔法 |
| 迁移 | `sqlx-cli` migrations（`migrations/` 顺序脚本） | 可审计、可回滚 |
| 配置 | `config` + `dotenvy`，环境变量优先 | 密钥不入库不入代码 |
| 鉴权 | `jsonwebtoken`（access/refresh 双 token） | 静默登录续期 |
| 媒体 | `tokio::process` 调用 `ffmpeg`/`ffprobe`（容器内提供） | 稳定、可控、避免绑定复杂 |
| 图处理 | `image` + `imageproc` + `mozjpeg`(或 `jpeg-encoder`) | 服务端高清/批量压缩 |
| 上传 | `reqwest` 无关；`axum` `multipart` + 分片落盘合并 | 大文件 |
| 任务 | `tokio::sync::mpsc` + `sqlx` 任务表；多实例时接 Redis（v2） | v1 单实例进程内队列 + DB 持久化状态 |
| 观测 | `tracing` + `tracing-subscriber`（JSON），`/healthz`、`/metrics` | 排障 |
| 测试 | `cargo test` + `axum::test` + 真库集成测试 | — |

本地数据库（已确认可连通）：
```
host=127.0.0.1  port=15433  user=postgre  password=postgre  db=toolbox_dev(待建)
DATABASE_URL=postgres://postgre:postgre@127.0.0.1:15433/toolbox_dev
```
本机 **无 ffmpeg** → 开发期用 Docker 容器（含 ffmpeg）跑后端，或 `brew install ffmpeg`。生产用官方镜像内置 ffmpeg。

> ✅ **已落地（2026-10-14）**：`server/Dockerfile` 构建出的 `toolbox-server:latest` 内置
> ffmpeg/ffprobe 7.1.5 + Noto CJK 字体，`MEDIA_DRY_RUN=0` 下真实转码链路已在容器内实测通过。
> 日常更新**不需要重建镜像**：`server/scripts/update.sh`（容器内增量编译 → 产物 `./dist` →
> bind mount 进容器 → 重启，无改动 1s、有改动约 60s）。命令与踩坑见 `docs/backend-verification.md` §7B。

### 8.2 API 设计（`/api/v1`，JSON，统一响应包）
```
统一响应： { "ok": true, "data": {...}, "requestId": "..." }
统一错误： { "ok": false, "error": { "code": "TASK_QUOTA_EXCEEDED", "message": "今天使用次数已达上限", "hint": "..." }, "requestId": "..." }
鉴权： Authorization: Bearer <accessToken>（可选接口允许游客）
```
| 方法与路径 | 用途 | 鉴权 |
|---|---|---|
| `POST /auth/silent` | code 换 token | 无 |
| `POST /auth/refresh` | 刷新 access | refresh |
| `GET /me` | 当前用户概览（次数余量、偏好） | 是 |
| `GET /tools/flags` | 工具开关/排序/灰度下发 | 无 |
| `POST /media/tasks` | 创建媒体任务（type、params、fileId） | 是 |
| `GET /media/tasks/:id` | 查询任务状态与结果 | 是 |
| `GET /media/tasks?limit=` | 我的任务列表（接力页恢复用） | 是 |
| `POST /media/tasks/:id/cancel` | 取消 | 是 |
| `POST /files/upload` | 分片上传（multipart: fileId/index/total/chunk） | 是 |
| `POST /files/init` / `POST /files/:id/complete` | 初始化与合并 | 是 |
| `GET /files/:id/download?token=` | 结果下载（一次性签名 URL，TTL 24h） | 签名 |
| `GET /files/probe/:id` | ffprobe 元信息 | 是 |
| `POST /favorites/sync`、`GET /favorites` | 收藏同步 | 是 |
| `POST /usage/batch` | 客户端使用记录批量上报（离线补传） | 是 |
| `GET /fx/rates` | 汇率（缓存 + 上游代理，密钥服务端） | 无（限流） |
| `GET /ip-info` | 网络类工具数据 | 无 |
| `GET /healthz` `/metrics` | 运维 | 内网 |

### 8.3 数据模型（PostgreSQL）
```sql
users(id bigserial pk, openid varchar unique, unionid varchar null,
      nickname varchar null, avatar_url varchar null,          -- 仅在用户主动授权后才写，v1 恒为空
      status smallint default 1, created_at timestamptz, last_login_at timestamptz)

sessions(id uuid pk, user_id fk, refresh_token_hash varchar, session_key_enc bytea,
         device_info jsonb, expires_at timestamptz, created_at)

media_tasks(id uuid pk, user_id fk, tool_id varchar not null, type varchar not null,  -- image|video
            status varchar not null,      -- queued|uploading|processing|succeeded|failed|canceled
            input_file_id uuid null, output_file_id uuid null,
            params jsonb not null, progress smallint default 0,
            error_code varchar null, error_message varchar null,
            engine_used varchar null, cost_ms int null, bytes_in bigint, bytes_out bigint,
            created_at, started_at, finished_at, expires_at)
  index: (user_id, created_at desc), (status) partial where status in ('queued','processing')

files(id uuid pk, user_id fk, name varchar, mime varchar, size bigint, sha256 varchar,
      storage_key varchar, kind varchar,     -- input|output|asset
      status varchar,                         -- uploading|ready|expired|deleted
      uploaded_at, expires_at)

tool_usage(id bigserial, user_id fk null, tool_id varchar, engine varchar,
           success boolean, cost_ms int, day date, created_at)
  index: (tool_id, day)  -- 统计热点工具

favorites(id bigserial, user_id fk, tool_id varchar, created_at, unique(user_id, tool_id))

tool_flags(tool_id pk, enabled bool, sort int, min_version varchar, gray_percent int, updated_at)

rate_limits(id bigserial, scope varchar /*user|ip*/, key varchar, day date, count int,
            unique(scope, key, day))
```
迁移脚本放 `server/migrations/`，命名 `20261013xxxx_name.sql`；所有表 `created_at/updated_at` 用 `timestamptz`；软删除用 `status` 而非 `deleted_at`（保持简单）。

### 8.4 异步任务流程（媒体处理）
```
client: files/init → 分片 upload（并发 3，失败重试 2）→ files/complete
      → media/tasks 创建（返回 taskId）→ 轮询 GET /tasks/:id（2s→5s 退避）或后续回查
server: 入队 → ffmpeg/ffprobe 执行（超时 10min，CPU 权重 1）→ 产物落盘 → status=succeeded
      → 生成一次性下载签名 URL → expires_at=now()+24h → 定时清理任务删除过期文件
worker 崩溃恢复：启动时把 processing 超过 15min 的任务置为 failed/requeue
```
进度来源：`ffmpeg -progress pipe:1 -nostats` 解析 `out_time_ms` / 总时长。

### 8.5 安全与合规
1. magic number 校验文件真实类型；禁止执行/脚本类文件。
2. 文件名 sanitize，存储 key 使用 uuid，不采用用户文件名。
3. JWT 密钥 ≥256bit，`env` 注入；refresh token 只存 hash。
4. `code2session` 失败/微信 errcode 透传映射为内部错误码，不回显微信原始响应。
5. 全链路 `tracing` 记录 `requestId`，日志**不落**用户媒体内容、不落 token。
6. 结果 URL 一次性签名（HMAC + 过期），未授权访问返回 403。
7. CORS/域名白名单；上传大小限制在网关层先拒（413 + 文案）。
8. 用户可在「我的-数据」一键清除其服务端文件与任务（软删 + 定时物理删）。

---

## 9. 非功能需求

| 维度 | 指标 |
|---|---|
| 首屏 | 首页冷启动 ≤ 1.5s（真机中端安卓）；工具页 ≤ 800ms |
| 图片压缩 | 3000×4000 单图 ≤ 3s（前端 Canvas 2D），成功率 ≥ 98% |
| 视频任务 | 60s/1080p 视频压缩 ≤ 90s（服务端），排队 P95 ≤ 20s |
| 包体 | 主包 ≤ 1.9MB；每个分包 ≤ 1.9MB |
| 可用性 | 后端 API P99 ≤ 300ms（不含任务处理）；月度 99.5% |
| 兼容 | 基础库 ≥ 3.0.0（Skyline 按 demo 配置在图片分包开启）；iOS/Android 双端真机验证 |
| 深色模式 | `darkmode: true`，全部分包适配（沿用 demo 配置） |
| 错误体验 | 0 处把接口 `errMsg` 原文展示给用户；统一 `error-center` 文案 |
| 隐私 | 未使用手机号/通讯录/位置接口；`requiredPrivateInfos` 按需最小声明 |

---

## 10. 里程碑与验收标准

| 里程碑 | 内容 | 验收标准 |
|---|---|---|
| **M1 骨架**（前端） | 工程初始化、`ToolRegistry`、首页/分类/搜索/我的、`<tool-shell>`/`<media-picker>`/`<result-panel>`/`<param-form>`、分包结构、静默登录闭环、`error-center` 与埋点 | 新增 1 个 mock 工具仅需 1 条清单 + 1 页面即出现在首页与搜索结果；token 过期自动续期；游客模式前端工具不受限；主包 ≤ 1.9MB |
| **M2 图片 + P0 前端工具集** | FR-IMG-01~05、FR-QR-01/02、FR-TXT-01~06、FR-CAL-01/02/03（前端本地利率） | 压缩/裁剪在 20 台机型抽样通过率 ≥95%；批量 50 图不 OOM；二维码生成抽样识别 100%；20 项 P0 工具全部有 3 正向 + 2 异常用例 |
| **M3 后端最小可用** | Rust 服务（auth/silent、分片上传、任务队列、ffmpeg 适配层）、PG 迁移与 7 张表、限流与健康检查、Docker 镜像（含 ffmpeg） | `POST /auth/silent` 真机换 token 成功；上传 100MB 断点续传成功；FR-VID-01~04 端到端跑通；任务失败返回 §0.3 错误码而非 500 |
| **M4 视频工具集** | 视频类工具页（FR-VID-01~07）+ `<task-progress>` + 任务持久化与恢复 + 结果下载保存 | 60s/1080p 压缩 P95 ≤90s；target=20MB 命中率 ≥90%；杀进程重进可查到历史任务并下载 |
| **M5 AI 模式**（AppID 已开通内测） | `skills/toolbox-skill`（`mcp.json` + `SKILL.md` + `apis/*` + 接力页）、`wx.onAgentHandoff` 接入、`page-meta.json` 由清单生成 | §7.3 的 13 条原子接口全部可用；超范围提问明确回复「不支持」且不误调接口；不支持 AI 的基础库上零影响；FR-AI-01~10 逐条通过 |
| **M6 P1 工具集** | FR-IMG-06~11、FR-QR-03/04、FR-TXT-07~13、FR-CAL-04~08、FR-VID-08/09、FR-LIF-01~03、FR-DEV-01/02 | 30 项 P1 工具上架；后端代理类（汇率/网络信息/HTTP 代理）SSRF 与限流用例通过 |
| **M7 打磨上线** | 深色模式全量、埋点报表、性能与包体治理、隐私政策与审核材料、灰度与 `tool_flags` | 通过微信审核；总包 ≤ 30MB；核心链路真机回归无阻塞 bug；崩溃率 < 0.1% |

**框架可扩展性验收（贯穿每个里程碑）**：随机抽取任一未实现工具（如 FR-IMG-11 取色器），从 0 到上架改动文件 ≤ 3 个（清单 + 页面 + 引擎），**且不修改框架层任何文件**。

**功能完整性验收**：`docs/tools-spec.md` 的每条 FR 必须在 `qa/coverage.md` 中有对应用例编号；未实现的 FR 必须在清单中置 `status: offline` 且首页不出现（禁止「清单有、点进去是空白」）。

---

## 11. 埋点与数据指标
- 事件：`tool_expose` / `tool_open` / `tool_run_start` / `tool_run_success` / `tool_run_fail(code,engine)` / `engine_fallback(client→server)` / `result_save` / `result_copy` / `result_share` / `task_created` / `task_succeeded` / `task_failed` / `ai_api_called` / `ai_card_click` / `ai_handoff_enter`。
- 指标：工具 DAU/使用次数/成功率/P50 与 P95 耗时/前后端引擎占比/图片压缩节省字节总量/视频任务排队时长；AI 卡片点击率与接力页完成率（决定后续 AI 接口优先级）；各分类使用热度（决定分包顺序）。
- 上报：本地批量缓存（≥10 条或 30s）+ 离线补传；服务端 `tool_usage` 日聚合；**埋点不得携带用户内容**（文本内容、文件名、图片路径一律不上报，仅报尺寸/体积档位）。

---

## 12. 风险与待确认问题

### 12.1 已消解（本轮决策）
| # | 原问题 | 结论 |
|---|---|---|
| R1 | 视频处理方案 | ✅ 定为 **Rust 自研 + Docker 内 ffmpeg**（不走微信云存储）。遗留动作见 R1' |
| R4 | AI 内测权限 | ✅ AppID **已开通**，M5 需真机对接验证；仍保留能力探测降级 |
| R5 | 本机无 ffmpeg | ✅ 后端容器化交付（镜像内置 ffmpeg/ffprobe + CJK 字体，供 FR-VID-08 水印/字幕使用）。**已构建并在容器内跑通真实编解码**；配套 `update.sh` 支持不重建镜像的热更新（见 `docs/backend-verification.md` §6/§7B） |

### 12.2 仍待处理
| # | 风险/问题 | 影响 | 处置建议 | 待谁确认 |
|---|---|---|---|---|
| R1' | 自有域名 **ICP 备案 + 小程序后台合法域名**（request/uploadFile/downloadFile 三项）尚未配置 | 视频与全部云端工具无法发布 | 尽早启动备案（周期 1–2 周，阻塞 M3 联调上线，不阻塞本地开发） | 用户（域名与备案主体） |
| R2 | 大文件上传在安卓低端机内存/耗时失败率高 | 视频工具失败率 | 分片 4MB、并发 1–2、上限 200MB；失败文案给出「先截取再压缩」出口；M4 抽样 10 台低端机回归 | — |
| R3 | 类目与资质：`去背景`(FR-IMG-18)、`OCR`、人脸相关易被要求额外资质 | 审核驳回 | v1 置 `offline`，不上架；工具类目按「工具-效率」申报 | 用户（小程序类目选择） |
| R6 | 服务端结果文件保留 24h（成本 vs 体验） | 体验/存储成本 | 默认 24h 且可配置（`FILE_TTL_HOURS`）；到期前 2h 页面提示下载 | 用户（可接受时长） |
| R7 | 汇率 / 快递 / IP 归属地等第三方数据源选型与密钥 | FR-CAL-08、FR-LIF-08/12 不可用 | 服务端代理 + 缓存 15min；密钥仅 env 注入；无数据源时对应工具 `offline` | 用户（是否有指定数据源） |
| R8 | 后端**部署环境**未定（云主机 / 容器编排 / Serverless）与并发容量 | M3/M7 排期与压测标准 | 先按单机 Docker + 进程内队列设计（§8.4），确认部署形态后再决定是否接 Redis 队列 | 用户 |
| R9 | Canvas 2D 大图（>4096px）在 iOS 偶发解码失败 | 图片工具失败率 | 降采样预处理 + 失败自动降级云端；对无法降采样的场景（FR-IMG-10 信息查看）只用 `getImageInfo` 元数据 | — |
| R10 | 传感器类工具（指南针/水平仪/噪音计）机型差异大 | 体验不稳定 | 上线前真机矩阵验证；不可用机型展示「设备不支持」而非错误数据；不申请与工具无关的权限 | — |
| R11 | 92 项工具的包体与工期压力（尤其 M6 P1 集） | 排期超期 | 严格按 `status` 分批上架；每个分包 ≤1.9MB 预算，超限优先把低频工具挪到后一里程碑 | 用户（上架节奏偏好） |

---

## 13. 附录 A：目录结构规划（前端）
```
miniprogram/
├── app.js / app.json / app.wxss        # agent.skills + darkmode + skyline 配置
├── page-meta.json                      # 由 tools/registry 生成（含各工具页元数据）
├── pages/ home / category / mine / search
├── tools/ registry/<category>/<tool>.js + index.js + registry.js
├── utils/ auth/ request/ media/ file/ store/ track/ error/
├── components/ tool-shell/ media-picker/ crop-canvas/ result-panel/ task-progress/ param-form/
├── packageImage/ packageVideo/ packageQr/ packageText/ packageCalc/ packageLife/ packageDev/
└── skills/toolbox-skill/  (independent 分包)
    ├── SKILL.md  mcp.json  index.js  apis/*.js  components/*\/
server/
├── Cargo.toml  migrations/  src/
│   ├── main.rs  config.rs  routes/  auth/  files/  tasks/  media/(ffmpeg)  db/  error.rs  telemetry.rs
├── Dockerfile（含 ffmpeg）  .dockerignore
├── docker-compose.yml（生产编排）  docker-compose.update.yml（磁盘映射热更新）
└── scripts/ update.sh（不重建镜像更新） live_smoke.sh（C8 契约冒烟） gen_speedtest_files.sh
```

## 14. 附录 B：环境变量（后端）
```bash
DATABASE_URL=postgres://postgre:postgre@127.0.0.1:15433/toolbox_dev
WECHAT_APPID=<待填>        WECHAT_APPSECRET=<待填>
JWT_SECRET=<32B+>         ACCESS_TTL=7200  REFRESH_TTL=2592000
STORAGE_DIR=/data/uploads FILE_TTL_HOURS=24
MAX_UPLOAD_BYTES=209715200 DAILY_QUOTA=20  TASK_TIMEOUT_SECS=600
FFMPEG_BIN=ffmpeg         LOG_LEVEL=info  PORT=8080
```

## 15. 附录 C：与 ai-mode-demo 的对齐点（实现时逐条核对）
1. `app.js` 的 `registerAgentHandoff` / `takeAgentHandoff`（`onLaunch` 内注册、按 `pageId` 缓存、取后即删）原样复用。
2. `silentLogin` 流程复用，但 **必须替换 demo 的 `mockLogin`**：真实调用后端 `code2session`，禁止伪造 openid（demo 已注明仅演示）。
3. `index.js` 必须用 `wx.modelContext.createSkill(path)` + `registerAPI(name)`，`name` 与 `mcp.json` 严格一致。
4. `app.json` 的 `agent` 字段、`lazyCodeLoading: requiredComponents`、`darkmode: true`、skyline `rendererOptions` 配置形态沿用 demo。
5. 原子接口返回体沿用 demo 约定：`content`(文本) + `structuredContent`(Agent 可见) + `_meta`(渲染可见、Agent 不可见) + 顶层 `handoff:{ query, payload?, card? }` + 失败分支 `isError: true` 且文案给出唯一正确出口。
6. `SKILL.md` 需保留 demo 的六个章节骨架：业务流程图 / 接口↔接力页映射 / 业务约束（含「0. 能力边界」）/ 用户意图分流 / 参数取值铁律 / 降级说明。
7. 注意 demo 提醒：`wx.openAgent` / `wx.navigateBackAgent` 当前不可用，接力页不得依赖「返回对话」。
