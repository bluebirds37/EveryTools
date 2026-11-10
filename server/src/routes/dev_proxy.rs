//! 开发期跨域代理路由包装（C8 `POST /dev/proxy`，写接口 → 需登录）。
//!
//! 真正的转发 + SSRF/协议/响应体大小防御全部在 [`crate::dev_proxy`]，
//! 这里只补上 C8 要求的鉴权（挂 `RequiredAuth`）后原样委派，不改任何安全语义。

use axum::{Json, extract::State};
use serde_json::Value;

use crate::{
    auth::RequiredAuth,
    dev_proxy::{ProxyInput, proxy_handler},
    error::{AppError, OkEnvelope},
    state::AppState,
};

pub async fn proxy(
    _auth: RequiredAuth,
    state: State<AppState>,
    input: Json<ProxyInput>,
) -> Result<Json<OkEnvelope<Value>>, AppError> {
    proxy_handler(state.0, input).await
}
