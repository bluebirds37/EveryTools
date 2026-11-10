# toolbox-skill 通用工具箱场景（小微 AI Handoff 模式）

> 本 SKILL 已适配「小微 SubAgent handoff」：对话内只展示**文本回复 + 小程序卡片**，
> 用户点击小程序卡片后 **handoff 接力**进入小程序业务页（接力页），在小程序内完成选文件、确认参数、执行与保存。
> 小微对话内**不渲染原子组件**；组件代码与 `componentPath` 保留以便后续复用 / 小程序内 Agent 场景。
> 接口与参数定义见 `mcp.json`（与 `docs/requirements.md` §7.3、`docs/tools-spec.md` FR-AI-01~10 同源）。

## 业务流程图（handoff 模式）

```
用户意图
  │
  ├─ 「有什么工具 / 找压缩图片的」──→ searchTools ──→ 文本 + 小程序卡片
  │        （keyword 留空=全部，按分类分组）           点击卡片 → 接力页 home（首页浏览/搜索）
  │                                                     │ 选中某工具（小程序内）
  │                                                     ↓
  ├─ 已知 toolId 看说明 ──────────→ getToolDetail ──→ 文本 + 小程序卡片
  │                                （toolId 来自上游）   点击卡片 → 接力页 tool-detail（说明/参数/去使用）
  │
  ├─ 「压缩图片 / 转GIF / 加水印…」─→ start* / addWatermark / videoToGif /
  │                                   extractFrames / generateQrcode
  │        （只做参数归一化，不碰文件）  → 文本 + 小程序卡片
  │                                   点击卡片 → 对应工具接力页（页内选图/选视频 → 执行 → 保存）
  │
  ├─ 「这段 JSON 格式化 / 5公里换算成米 / 两个日期差几天」
  │        ──→ formatJson / convertUnit / calcDateRange ──→ 【对话内直接给结果，不出卡、不接力】
  │
  └─ 「我最近用了什么 / 我的收藏」──→ listHistory ──→ 文本 + 小程序卡片
                                                    点击卡片 → 接力页 mine（页内查看与管理）
```

## 原子接口 ↔ 接力页映射

| 接口 | 作用 | handoff.query | 接力页 pagePath |
|------|------|---------------|-----------------|
| searchTools | 关键词搜索 / 浏览全部工具 | `keyword=压缩`（可留空=全部） | /pages/home/home |
| getToolDetail | 工具元信息 + 默认参数 | `toolId=image-compress` | /pages/tool-detail/tool-detail |
| startImageCompress | 图片压缩（参数准备） | `toolId=image-compress&orderId=xxx&targetKB=200&maxSide=0` | /packageImage/pages/compress/index |
| startImageCrop | 图片裁剪（参数准备） | `toolId=image-crop&orderId=xxx&ratio=1:1` | /packageImage/pages/crop/index |
| addWatermark | 批量水印（参数准备） | `toolId=image-watermark&orderId=xxx&text=xx&position=br` | /packageImage/pages/watermark/index |
| startVideoCompress | 视频压缩（参数准备，云端任务） | `toolId=video-compress&orderId=xxx&targetMB=20&resolution=720p` | /packageVideo/pages/compress/index |
| videoToGif | 视频转 GIF（参数准备，云端任务） | `toolId=video-gif&orderId=xxx&start=0&end=5&fps=12` | /packageVideo/pages/gif/index |
| extractFrames | 抽帧/封面（参数准备，云端任务） | `toolId=video-frames&orderId=xxx&count=6` | /packageVideo/pages/frames/index |
| generateQrcode | 二维码生成（内容预置） | `toolId=qr-generate&content=xxx&type=text` | /packageQr/pages/generate/index |
| formatJson | JSON 格式化（对话内直接出结果） | —（无 handoff、不出卡） | — |
| convertUnit | 单位换算（对话内直接出结果） | — | — |
| calcDateRange | 日期间隔计算（对话内直接出结果） | — | — |
| listHistory | 最近使用 / 收藏 | 空（scope 走 payload） | /pages/mine/mine |

> `orderId` 是**对话侧生成的本次 AI 接力会话 ID**（不是后端任务 ID；真实 `taskId` 由接力页创建云端任务后产生）。
> 接力页 `onLoad(query)` 解析 query，并可按 `pageId` 调 `getApp().takeAgentHandoff(pageId)` 取 `payload`（预置参数对象）加速首屏。

## 业务约束（跨接口铁律）

### 0. 能力边界（最高优先级）
- 本 skill 只能完成「工具检索 / 看工具详情 / 图片压缩·裁剪·水印 / 视频压缩·转GIF·抽帧 / 二维码生成 / JSON 格式化 / 单位换算 / 日期计算 / 查看最近使用与收藏」这条链路。以下 **13 条原子接口是全部能力**：`searchTools`、`getToolDetail`、`startImageCompress`、`startImageCrop`、`addWatermark`、`startVideoCompress`、`videoToGif`、`extractFrames`、`generateQrcode`、`formatJson`、`convertUnit`、`calcDateRange`、`listHistory`。
- **当用户意图无法用上述接口完成时（超出工具箱范围，或需要本 skill 不具备的能力），必须直接用一句话如实回复用户「该能力暂不支持 / 无法完成」，禁止为了「凑一个动作」而擅自调用任何原子接口。**
- 典型不支持场景（示例，非穷举）：**批量下载/导出历史任务文件**、**修改或删除已保存到相册的文件**、需要**账号体系/会员/积分/付费**的操作、**访问或操作用户相册内容**（原子接口没有相册权限，只能出卡让用户在页内自选）、跨小程序操作、发消息/社交类、天气新闻等内容型诉求、视频剪辑等未上架工具（如图片转PDF、抠图 status=offline）。遇到这类请求 → 直接文本说明不支持，不要硬套 searchTools/start* 等接口。
- 判断依据：**只有当用户意图能明确对应到某个接口的真实语义时才调用**；无法对应就回复用户，宁可不调用，也不要用错接口或编造参数去调用。

### 1. 输出形态（小微）
- 对话内**只输出文本 + 小程序卡片**，禁止以 markdown 列表铺开工具清单、参数细节、页面路径。
- 调用出卡类接口后：只用**一句简短话术**引导用户点击卡片，具体工具列表 / 参数 / 结果交给卡片与接力页展示。
- 用户诉求与工具无关时（闲聊、问概念）：正常用文本回复即可，不调用任何接口。

### 2. 执行顺序
- `getToolDetail` 的 `toolId` **必须来自 `searchTools` 返回的 `items[].toolId` 原值**；没有 toolId 时先调 `searchTools`。
- `start*` / `addWatermark` / `videoToGif` / `extractFrames` / `generateQrcode` 允许直接调用（参数缺省用默认值，接力页让用户微调），**不需要**先经过 `getToolDetail`。
- **toolId / orderId 禁止编造**：`toolId` 只能来自 `searchTools` 返回，`orderId` 只能来自对应 `start*` 接口返回；禁止从用户口语（「那个压缩」）推断 ID，禁止使用文档示例值，禁止拼接自造 ID。
- 枚举参数一律用**英文枚举值**（`br`、`720p`、`url`…），禁止传中文 label。

### 3. 文件选择铁律（对应 FR-AI-02）
- **原子接口无法访问用户相册/文件**（`wx.chooseMedia` 只能由用户在页内主动触发）。所有需要选图/选视频的接口（`startImageCompress`、`startImageCrop`、`addWatermark`、`startVideoCompress`、`videoToGif`、`extractFrames`）**只准备参数并出卡**：接口返回归一化参数 + `handoff.query` + `payload`，**文件选择动作永远发生在接力页内**。
- 禁止在这些接口的参数里传文件路径、文件名、「用户已选图片」等不存在的数据；禁止向用户暗示「已经帮你选好图了 / 已经开始压缩」。正确话术：参数已备好，点击卡片进入页面选择图片/视频后开始处理。
- 云端视频类接口（`startVideoCompress` / `videoToGif` / `extractFrames`）的真实任务由接力页创建（选视频 → 分片上传 → ffmpeg），游客进入页面后由页面自动静默登录，**禁止在对话侧要求用户做任何授权操作**（FR-AI-09）。

### 4. 纯计算类接口（对应 FR-AI-03）
- `formatJson`、`convertUnit`、`calcDateRange` 是**对话内直接返回结构化结果**的接口：成功时**不出卡、不 handoff**，把结果用一句话（JSON 结果可带代码块文本）回复用户即可。
- 这三条接口不做任何跳转引导；用户若想要完整版/树视图，告知其可在小程序「文本/换算」分包对应页面处理，但**禁止**为此擅自调用其它出卡接口。

### 5. 参数取值铁律（对应 §7.4）
- **用户未明说的参数一律不传，让接口用默认值**，禁止猜测：目标体积、比例、时长、帧率、位置、类型等必须来自**用户原话**；「压小一点」这类模糊表达 → 不传 targetKB 用默认 200KB，接力页内微调。
- **单位、比例、时长换算成接口要求的数字后必须仍来自用户原话**（「1MB 以内」→ targetKB=1024；「第 3 到 10 秒」→ start=3、end=10），禁止顺手上调/下调。
- 日期类相对说法（昨天、下周五）由 Agent 按当前日期解析成 `YYYY-MM-DD` 具体值再传；解析不了就先追问。
- 枚举用英文值：ratio `free|1:1|4:3|3:4|16:9|9:16|original`；position `tl|tm|tr|ml|mc|mr|bl|bm|br`；resolution `source|1080p|720p|480p|360p`；QR type `text|url|wifi|vcard|sms|tel|geo`；scope `recent|favorites|all`。
- 数值越界时接口会自动夹取并在返回文案中说明，**禁止用同一越界值反复重试**。

### 6. 进小程序后的后续
- 选文件、确认参数、执行处理、保存相册、下载结果等后续操作**全部在接力页/工具页内完成**，不再回到对话调用原子接口（接力页也不依赖「返回 Agent 对话」能力）。
- 接力页 `onLoad` 需同时兼容三种进入路径：AI handoff（query + payload）、普通导航、分享深链（FR-AI-07），行为一致且不报错。

### 7. 用户意图分流表（口语说法 → 接口）

| 用户说法（示例） | 接口与参数 |
|---|---|
| 「有什么工具 / 都能干啥 / 随便看看」 | `searchTools`（keyword 留空，返回全部并按分类分组） |
| 「有没有压缩图片的 / 找 JSON 工具」 | `searchTools`（keyword=用户原话关键词） |
| 「图片压缩这个工具具体能干啥 / 怎么用」 | 先 `searchTools` 拿 toolId → `getToolDetail` |
| 「把图片压到 200KB / 压缩照片」 | `startImageCompress`（说了目标才传 targetKB） |
| 「裁成正方形 / 9:16 裁剪」 | `startImageCrop`（ratio='1:1' / '9:16'） |
| 「加水印，写 XXX，放右下角」 | `addWatermark`（text=XXX，position='br'；没说文字→不传待页内输入） |
| 「视频压到 20M 以内 / 压视频」 | `startVideoCompress`（targetMB=20） |
| 「把视频第 3 到 10 秒做成 GIF」 | `videoToGif`（start=3, end=10；没说时间段用默认） |
| 「抽 6 张封面 / 均匀截图」 | `extractFrames`（count=6） |
| 「把 www.x.com 做成二维码」 | `generateQrcode`（content=www.x.com, type='url'；没给内容→先追问，禁止编造） |
| 「这段 JSON 格式化一下 / 校验这个 JSON」 | `formatJson`（对话内直接出结果） |
| 「5 公里等于几米 / 30℃ 多少华氏」 | `convertUnit`（value=5, from='km', to='m'） |
| 「今天到国庆还有几天 / 两个日期差多少」 | `calcDateRange`（先解析成具体日期） |
| 「我最近用了啥 / 我的收藏」 | `listHistory`（说了范围才传 scope） |
| 「帮我批量下载上次任务 / 删相册里的图 / 开会员」 | **不调用接口** → 回复「该能力暂不支持」（见 0. 能力边界） |
| 歧义短语（「那个」「上次的」） | 先反问澄清，禁止猜测调用 |

### 8. 失败分支与降级说明
- **失败分支**：接口失败一律返回 `isError: true`，文案中给出**唯一正确出口**并写明「禁止编造参数重试」。例如 `searchTools` 带关键词零命中 → 出口是「换用户原话关键词或留空看全部」；`getToolDetail` 无效 toolId → 出口是「先 searchTools」；`formatJson` 解析失败 → 出口是「把 行:列 转告用户核对原文」；`generateQrcode` 缺 content → 出口是「先向用户追问内容」。**禁止用编造参数重试、禁止换接口硬凑。**
- **降级**（FR-AI-08 / requirements §7.6）：在不支持 `wx.onAgentHandoff` / `wx.modelContext` 的基础库上，本 skill 的注册（`index.js`）与 handoff 监听（`app.js`，已按 demo 实现）都会 `console.warn` 后**静默跳过**，AI 能力不可用，小程序主流程零影响；用户仍可从微信「发现-小程序」正常进入工具箱使用全部功能。`_meta.ui.componentPath` 为原子组件预留路径，小微当前不渲染 GUI，只出小程序卡片。
