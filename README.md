# EveryTools · 通用工具箱微信小程序

微信小程序原生前端 + Rust 后端的通用工具箱。**本地优先**：绝大多数工具在小程序端离线完成，
只有重媒体（视频、超大图、保留 EXIF）才走后端。当前规格覆盖 **92 项工具**，其中 **53 项已上线可用**。

- 前端：微信小程序原生（无跨端框架），分包 + 自定义 tabBar + 深色模式令牌
- 后端：Rust（axum 0.8 + sqlx + PostgreSQL），镜像内置 ffmpeg/ffprobe 与 CJK 字体
- AI：接入微信小程序官方 AI 模式（小微）原子能力与 Skill 目录

## 目录结构

```
miniprogram/            小程序前端
├── pages/              首页 / 分类 / 搜索 / 我的 / 工具详情 / custom-tab-bar
├── components/         tool-shell · media-picker · param-form · result-panel · grid-icon …
├── utils/              request · auth · store · track · media · canvas2d · error · video-task
├── tools/              注册表（registry.js + index.js，92 条工具元数据）
├── packageImage|Video|Qr|Text|Calc|Life|Dev/   7 个分包，53 个工具页
└── skills/toolbox-skill/  微信 AI 模式 Skill（independent 分包）

server/                 Rust 后端
├── src/                routes · auth · files · tasks · media(ffmpeg) · db · error · telemetry
├── migrations/         由 sqlx::migrate! 编译期嵌入
├── Dockerfile          两阶段：rust:1-trixie 编译 → debian:trixie-slim 运行（含 ffmpeg/字体）
├── docker-compose.yml         生产编排
├── docker-compose.update.yml  开发/联调：磁盘映射热更新（不重建镜像）
├── scripts/            update.sh · live_smoke.sh（契约级联调）· gen_speedtest_files.sh
└── .env.example        全部配置键的占位模板（真实值只从环境变量注入）

scripts/                前端质量门禁（Node，无需小程序环境）
├── verify.js           静态一致性：注册表 ↔ 路由 ↔ 分包 ↔ 契约
├── smoke.js            无头生命周期冒烟（mock wx）
├── lint-ui.js          设计令牌 / UI 规范校验
├── audit-wxml.js       WXML 与事件绑定审计
├── verify-tools.js     逐工具功能验证（已知输入 → 已知输出）
└── cases/              各分类的功能用例数据

docs/                   需求、工具规格、接口契约、验证报告
tests/                  二维码等算法的参考向量与对拍脚本
```

## 快速开始

### 前端

1. 微信开发者工具导入 `miniprogram/` 目录（基础库 ≥ 3.x）。
2. 在 `miniprogram/project.config.json` 填入**你自己的 AppID**（仓库里刻意留空；AI 模式需该 AppID 已开通内测权限）。
3. 后端地址在 `miniprogram/utils/env.js`（默认指向本地/内网调试地址，上线改成已备案域名）。

### 后端

```bash
cd server
cp .env.example .env            # 填 DATABASE_URL / JWT_SECRET / WECHAT_APPID / WECHAT_APPSECRET
cargo run                       # 本机开发（无 ffmpeg 时配 MEDIA_DRY_RUN=1）

# 推荐：构建一次镜像，之后用磁盘映射热更新（不重建镜像）
bash scripts/update.sh          # 容器内增量编译 → ./dist → 重启挂载容器 → /readyz 门控
bash scripts/update.sh --smoke  # 顺带跑 C8 契约级联调
```

密钥（`JWT_SECRET` / `WECHAT_APPSECRET` / `FX_API_KEY` / `DATABASE_URL`）**只从环境变量读取**，
不写进代码、不进镜像层、不进日志；`Settings::validate()` 会在 `JWT_SECRET` 过短（<32 字节）时拒绝启动。

## 质量门禁

```bash
node scripts/verify.js          # 静态一致性
node scripts/smoke.js           # 生命周期冒烟
node scripts/lint-ui.js         # UI 规范
node scripts/audit-wxml.js      # WXML / 事件绑定 / 组件属性
node scripts/verify-tools.js    # 逐工具功能验证（当前 53 个在线工具、164 个场景）
cd server && cargo test         # 后端单元/属性测试
bash server/scripts/live_smoke.sh   # 后端契约级联调（需服务在跑）
```

验证过程与真实结果记录在 [docs/frontend-verification.md](docs/frontend-verification.md)
与 [docs/backend-verification.md](docs/backend-verification.md)（含已知偏差，不粉饰）。

## 已知限制

- **Worker 未接入**：>2 MB 文本哈希、1 MB JSON 解析仍受主线程限制，超出阈值时是显式报错而不是假实现。
- **条码/二维码识码**需真机扫码复核（本机只做编解码自洽验证）。
- **繁简字典**仅常用字表；**GBK 字节数**因无码表不提供。
- 上线前需自行完成：自有域名 **ICP 备案** + 小程序后台 `request/uploadFile/downloadFile` **合法域名**配置。
- 云端工具依赖第三方数据源（汇率等），未配置密钥时对应工具会明确提示「未配置数据源」。

## 第三方参考实现

`ai-mode-demo`（[wechat-miniprogram/ai-mode-demo](https://github.com/wechat-miniprogram/ai-mode-demo)，MIT）
是本仓库的**邻居目录**而非子模块，已在 `.gitignore` 中排除；需要时请自行 clone。
本项目 `miniprogram/skills/toolbox-skill/` 的接入方式参考了它。

## 许可

Apache-2.0（见 `LICENSE`）。

- 本仓库不包含微信官方 `ai-mode-demo` 源码（已 gitignore），仅参考其接入方式；如需请自行 clone 其仓库（MIT）。
- 第三方依赖各自遵循其上游许可证；`tests/reference/` 下的二维码参考向量来自开源实现，仅作对拍验证用途。
- 贡献即表示接受 Apache-2.0 的授权条款（含专利授权与第 5 条的提交说明要求）。
