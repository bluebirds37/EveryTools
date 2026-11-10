# 前端逐工具功能验证（toolbox 小程序）

> 本文件记录**真实执行**的功能验证过程与结果，不是设计意图。
> 需求依据 `docs/requirements.md`，逐工具规格依据 `docs/tools-spec.md`，接口契约 `docs/CONTRACT.md`。
> 所有数字都能用「复现步骤」一节的命令在本机重跑得到。

## 1. 为什么另起一套 gate

原有三个 gate 各自能证明的范围有限：

| gate | 证明的事 | 证明不了的事 |
| --- | --- | --- |
| `scripts/verify.js` | 静态一致性（注册表/路由/分包/契约字段） | 页面功能是否真的算对 |
| `scripts/smoke.js` | 生命周期不崩（onLoad/onShow/…） | 交互与结果；`bindtap` 指向不存在的方法也不报错 |
| `scripts/lint-ui.js` | 样式令牌规范 | 运行时行为 |

用户实机报的两个问题正好都落在盲区里（首页点击无反应、压缩后体积变大），因此新增两个 gate：

- **`scripts/audit-wxml.js`**：WXML/绑定静态审计（577 处事件绑定、72 个 wxml）。
- **`scripts/verify-tools.js`**：逐工具功能验证——每个在线工具灌已知输入、断言已知输出。

## 2. 结果

| gate | 结果 |
| --- | --- |
| `node scripts/verify-tools.js` | 在线工具 **53 全部覆盖**，场景 **164**，阻塞失败 **0**，标注项 **17**（其中 4 条为确认的产品缺陷，13 条为 harness 输入通道缺口） |
| `node scripts/audit-wxml.js` | 问题 **0** / 警告 1（条件渲染分支导致的 dataset 缺省，属预期） |
| `node scripts/smoke.js` | 通过 67 / 失败 0 |
| `node scripts/verify.js` | 无阻塞问题（92 条 FR、online 53） |
| `node scripts/lint-ui.js` | 问题 0 / 警告 3（纯布局样式未用令牌） |

## 3. 两个用户实报问题的根因（都已修复并加回归断言）

1. **首页工具点击无反应**
   `pages/home/home.wxml` 用 `<template is="toolCard" wx:for="{{...}}" item="{{item}}" />` 调模板。
   WXML 模板是**独立作用域**，只接收 `data` 传入的数据，`item="…"` 这类属性被忽略
   （[官方文档](https://www.tencentcloud.com/zh/document/product/1219/60345)）
   → 模板里 `data-id="{{item.id}}"` 取不到值 → `onToolTap` 的 `if (!id) return` 直接返回 → 点击静默无效。
   同一条根因也解释了用户上一轮反馈的「首页图标未显示」（名称/图标/描述都在同一个模板作用域里）。
   修复：改为 `<block wx:for>` + `<template is="toolCard" data="{{...item}}" />`，模板体改用平铺字段名。
   连带修复：跳转失败不再被静默吞掉——`utils/track.js::openTool` 失败时统一 toast（离线走「该工具暂未开放」），
   并删掉 home/category/search/mine/tool-detail 五处重复的 `isOnline` 预检查与 `.catch(() => {})`。
   回归断言：`audit-wxml.js` 的 C 规则（模板必须用 data 传参 + `<template is>` 上的多余属性报警）。
   已实测：把 home.wxml 改回旧写法后该规则立刻报 4 条问题。

2. **图片压缩 100KB → 400KB**
   `utils/canvas2d.js::clampQuality` 定义在 10–95 整数刻度上，而各工具页按 `CONTRACT.md` 的
   `quality=.9` 约定传 **0–1 分数**：`clampQuality(0.75)` → `Math.round` → 1，
   再由 `qualityParam(1)` 当成 1.0（最高质量）传给 `wx.canvasToTempFilePath`。
   页面里还自带一轮 7 次二分搜索，7 次全部导出同一张最高质量的图 → 体积约为原图 4 倍且永不收敛。
   修复：`clampQuality` 兼容 0–1 与 10–95 两种刻度（`n<=1` 视为分数）；
   页面删掉自带的重复搜索，把目标体积交给 `utils/media.js::searchQuality`（它自带降质量→降尺寸阶梯与
   `reachedTarget`/`OVER_TARGET_NOT_REACHABLE`）；并加硬约束「压缩结果不得大于原图」，
   大于原图时保留原文件并在结果区如实说明（`summary.kept`）。
   回归断言：`scripts/cases/image.js` 场景「共享层质量单位契约」——
   `compressToJpeg` 的 `quality` 传 0.2/0.5/0.9 与 20/50/90 必须得到**相同**体积且体积随质量单调上升。
   已实测：把 `clampQuality` 改回旧实现后该场景报 3 条不等价（0.2/0.5/0.9 全部退化为最高质量体积）。

## 4. 逐工具验证中查出并修复的其他缺陷

| # | 位置 | 缺陷 | 影响面 |
| --- | --- | --- | --- |
| 1 | `packageVideo/pages/{compress,clip,gif,frames,audio,info}/index.wxml` | 给 `<result-panel>` 传 `save/copy/share`，组件属性名实为 `showSave/showCopy/showShare` | 6 个视频工具的「保存到相册」按钮**永远不出现**（`audit-wxml.js` E 规则查出） |
| 2 | `packageDev/utils/cron.js` | 页面依赖 `fixedZone/localZone/nextRuns/summarize/fieldRows`，算法层根本没有这些导出 | 点「运行」必然 TypeError → 无任何提示（批次间 API 漂移）；已补齐实现并导出，含「6 年内无命中」提示 |
| 3 | `packageDev/pages/cron/index.js` | 按 `{ok:false,error}` 形状消费 `cron.parse`，而它实际是 **throw** 且返回体没有 `ok` | 任何表达式（含默认值）都走 `!parsed.ok` 分支并在读 `parsed.error.field` 时崩 |
| 4 | `packageDev/utils/sql.js` | 页面调用 `pretty/compact/balanceCheck`，算法层只有 `format/minify` | 每次运行都以 `TASK_FAILED` 收场；已在共享层补齐（含未闭合字符串定位、行注释强制换行、括号配平） |
| 5 | `packageDev/pages/sql/index.js` | 统计记号数用 `t.t !== 'ws'`，而 token 形状是 `{type,value,index}` | 记号数统计口径错误 |
| 6 | `packageCalc/utils/calc-parser.js` | 键盘有 `π` 常量键、内置示例按钮就是「2π」，但解析器只认 `pi` | 点 π 直接报「无法识别的字符」 |
| 7 | `packageCalc/pages/discount/index.js` | `parseOptions` 只认「8折」，而页面**默认值与提示语写的都是「打8折」/「满1000打8折」** | 默认示例里的一档被静默丢弃 → 最优档位结论错误 |
| 8 | `packageCalc/pages/loan/index.js` | `type=provident` 时利率取 `ratePf`，而 `ratePf` 仅在组合贷下显示 | 用户改「年利率」完全没反应 |
| 9 | `packageCalc/pages/bmi/index.js` | 体脂用 US Navy 的**英寸**常数却直接喂 cm（文案写「公制」） | 女性 160/70/90/32 算出 **98.4%**；改为按 1in=2.54cm 换算（男 88/38/172 → 19.8%，女 → 23.6%，与公开公式一致） |
| 10 | `packageCalc/pages/bmi/index.js` | `goalDelta=0` 仍拼数值 | 文案出现「2267 kcal/天（维持0）」 |
| 11 | `packageCalc/pages/bmi/index.js` | 活动系数非法时 `bmr*NaN` 直接上屏 | 增加合法域校验与保守回落，杜绝 NaN |
| 12 | `packageCalc/pages/calculator/index.js` | `catch` 只写 error 不清 `result` | 出错后屏上仍是上一次答案（「算了但没算」） |
| 13 | `utils/error.js` | `INPUT_EMPTY` 模板丢弃 `extra.reason` | 「右侧文本为空」「输入过长（超过 1,000,000 字符）」全退化成「请先选择内容」；改为原样透出 |
| 14 | `packageText/utils/codec.js` | `urlEncodeComponent` 未保留 `! ' ( ) *` | 与它声明的 encodeURIComponent 语义不一致（已用 `encodeURIComponent` 逐字符对照验证） |
| 15 | `packageText/utils/numsys.js` | `groupBin` 从高位切 4 位 | 511 → 「1111 1111 1」不可读；改为低位对齐「1 1111 1111」 |
| 16 | `packageText/utils/textops.js` | 旗帜 emoji 用 `\p{RI}{2,}` 贪婪匹配 | 🇨🇳🇫🇷 计成 1 簇；改为成对消费后计 2 |

## 5. 已知缺陷（本轮确认存在、尚未修，harness 里以 `knownDefect` 复现）

1. `packageText/pages/json/index.js:89-93`：宽松模式先去尾逗号再去注释，注释挡在 `}`/`]` 前会漏删——**页面自带样例即失败**。
2. `packageText/utils/regex-safety.js::buildReplacement`：只支持 `$<name>`，而 `pages/regex/index.js:41` 的自带样例写的是 `$name` → 输出字面 `[$year]`。
3. `packageText/pages/regex/index.js:181-190`：命中数超上限（`too-many`）被映射成 `TASK_TIMEOUT「处理超时」`，应为成功 + 截断提示（`regex-safety.js` 已带 partial 结果）。
4. `packageText/utils/textops.js:26-27`：`tokenize` 无条件拆字母/数字 → `api_key_v2` 变 `api_key_v_2`，违反 FR-TXT-10「往返转换幂等」。

## 6. harness 输入通道缺口（13 条，非产品结论）

- 视频类 6 个：`media-picker` 的选片回调在 mock 里缺 duration/码率探测，页面停在「请先选择内容」；
  云端任务链路本身的契约正确性由 `server/scripts/live_smoke.sh` 在**真实容器 + 真 ffmpeg** 下断言（39 通过 / 0 失败 / 1 跳过）。
- 图片类 5 个 + 裁剪/拼接/证件照：需要在画面上拖拽裁剪框/取景框，mock 尚无该输入通道；
  这些场景里「导出体积/格式/尺寸」的断言本身有效，通道接入后即可转绿。

## 7. mock 运行时的两处关键加固（否则上面的缺陷根本测不出来）

1. **虚拟文件表 + 体积模型**：`canvasToTempFilePath` 现在按 `fileType + quality(0–1) + destW/H` 计算体积并登记进
   `files`，`getImageInfo/getFileInfo/stat/readFile/copyFile/downloadFile` 全部读同一张表。
   旧 mock 恒定返回 512KB 与固定路径，「压缩后变大」这类缺陷在 harness 里不可见。
2. **空画布导出必须失败**：只有真的调用过 `drawImage/fillRect/fillText` 才允许导出（`fillRect` 也计入，
   否则条码/二维码这类纯矩形绘制的产物会被误杀）。这一条让「画布被提前 release 成 1×1」无所遁形。
   另外 `createSelectorQuery().fields().exec()` 必须回交节点，否则 `makeOffscreen` 的 Promise 永不 settle。

## 8. 复现步骤

```bash
cd /Users/blue/CodeSpaces/日常工具箱

node scripts/verify-tools.js              # 53 个在线工具逐个灌输入、断言已知输出（退出码 0/1）
node scripts/verify-tools.js image-compress --verbose   # 单个工具（前缀匹配）
node scripts/audit-wxml.js                # WXML/事件/dataset/组件属性审计
node scripts/smoke.js                     # 生命周期冒烟
node scripts/verify.js                    # 静态一致性
node scripts/lint-ui.js                   # 样式令牌

# 反向验证（确认 gate 真的能抓住回归）：
# 1) 把 miniprogram/utils/canvas2d.js 的 clampQuality 改回旧的 Math.round 实现
#    → node scripts/verify-tools.js image-compress 报「质量 0–1 与 10–95 刻度不等价」
# 2) 把 pages/home/home.wxml 的模板调用改回 item="{{item}}"
#    → node scripts/audit-wxml.js 报 [C] 模板未用 data 传参
```

用例数据在 `scripts/cases/<分类>.js`（image/image2/text/calc/dev/qr/videolife），
runner 是 `scripts/verify-tools.js`（用例契约写在其文件头注释里）。
每个工具的期望值都要求**手算或与控制实现（Node crypto / encodeURIComponent / 公开公式）对照**，
不接受「有输出就算过」。

## 9. 本轮未覆盖 / 仍受本机限制

- 本机无法打开微信开发者工具，也**不能截图**（见 memory：env-no-screen-recording）。
  因此「图标是否真的显示、栅格是否真的不溢出」仍需用户在真机/开发者工具目测一次。
- 条码（Code128/Code39/EAN-13/ITF）与二维码**识码**仍只做编解码自洽验证，需真机扫码复核。
- `scripts/selftest-text.js` 是历史脚本，其 `require('./miniprogram/...')` 写法在任意 CWD 下都不可解析，
  本轮未纳入 gate（已被 `verify-tools.js` 的文本类用例覆盖）。
- Worker 缺口（FR-TXT-01/05）不变，仍是显式超限报错而不是假实现。
