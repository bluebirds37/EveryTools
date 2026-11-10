//! HTTP 路由层（`docs/requirements.md` §8.2 / §13，`docs/CONTRACT.md` C8）。
//!
//! 本模块只做「解包 → 复用既有领域模块（auth/files/tasks/media/fx/dev_proxy）→
//! 统一响应包 `ok_data`/`AppError`」，不含任何业务算法。
//!
//! ## 两个 Router 的划分（lib.rs 已按此调用，勿改）
//! - [`api_router`]：`lib.rs` 里 `nest("/api/v1", ...)`，承载 C8 全部业务接口。
//!   **鉴权是逐 handler 通过 extractor 实现的**（复用 [`crate::auth`]，没有整条 Router 的
//!   blanket auth 中间件）：写接口用 [`crate::auth::RequiredAuth`] 强制 Bearer；
//!   少数 C8 标注为「无鉴权 / 一次性签名」的接口**故意不挂 `RequiredAuth`**：
//!   - `GET /tools/flags`：游客可访问（`auth:false`，前端 `request.js` 也可能不带 token）。
//!   - `GET /fx/rates`：§8.2 标注「无（限流）」，游客可用；密钥在服务端，不因此泄露。
//!   - `GET /files/:id/download?token=`：走一次性 HMAC 签名 + 属主校验，**不依赖 Bearer**
//!     （`wx.downloadFile` 无法可靠带 Authorization 头）。
//! - [`public_router`]：`lib.rs` 里 `merge`（根路径），只放「拿 access token 之前就必须能访问」的入口：
//!   - `GET /healthz`（存活）、`GET /readyz`（DB 就绪）。
//!   - `POST /api/v1/auth/silent`、`POST /api/v1/auth/refresh`（静默登录/续期：此时还没有 token）。
//!     因为 public 挂在根，这里写**完整路径** `/api/v1/auth/*`，与 C8「`/api/v1` 前缀」一致。
//!
//! ## 游客降级（silent guest degradation）
//! Bearer 解析逻辑复用 [`crate::auth`]：`RequiredAuth` 无/坏 token 直接 401/403（前端 `request.js`
//! 遇 401 自动 `refresh()` 重试一次，仍失败则前端 `auth.js` 回落 `guest`）；
//! 标注 `auth:false` 的路由不校验 token，游客天然可用。openid/session_key 绝不出现在任何响应里，
//! 对外只有 `userId`。

mod auth;
mod dev_proxy;
mod files;
mod fx;
mod health;
mod media;
mod static_files;
mod tools;
mod usage;

pub use static_files::speedtest_router;

use axum::{
    Router,
    routing::{get, post},
};

use crate::state::AppState;

/// 鉴权业务路由（`lib.rs` 会 nest 到 `/api/v1`）。
pub fn api_router() -> Router<AppState> {
    Router::new()
        // 公共 / 特殊鉴权（详见模块头注释）
        .route("/tools/flags", get(tools::flags))
        .route("/fx/rates", get(fx::rates))
        .route("/files/{id}/download", get(files::download))
        // 分片上传（RequiredAuth）
        .route("/files/init", post(files::init))
        .route("/files/upload", post(files::upload))
        .route("/files/{id}/complete", post(files::complete))
        // 媒体任务队列（RequiredAuth）
        .route("/media/tasks", post(media::create).get(media::list))
        .route("/media/tasks/{id}", get(media::get_task))
        .route("/media/tasks/{id}/cancel", post(media::cancel))
        // 埋点上报（RequiredAuth）
        .route("/usage/batch", post(usage::batch))
        // 开发期跨域代理（RequiredAuth）
        .route("/dev/proxy", post(dev_proxy::proxy))
}

/// 公开路由（`lib.rs` 会 merge 到根）。
pub fn public_router() -> Router<AppState> {
    Router::new()
        .route("/healthz", get(health::live))
        .route("/readyz", get(health::ready))
        .route("/api/v1/auth/silent", post(auth::silent))
        .route("/api/v1/auth/refresh", post(auth::refresh))
}
