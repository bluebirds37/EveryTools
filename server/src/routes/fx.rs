//! 汇率（C8 `GET /fx/rates?base=CNY` → `{rates, updatedAt}`）。
//!
//! 游客可访问（requirements §8.2 标注「无鉴权 / 限流」）：上游密钥只在服务端
//! `FxCache` 内部使用，绝不会因开放该接口而泄露。真正的上游/密钥逻辑都在
//! [`crate::fx::FxCache`]，本 handler 只做解包与转发。

use axum::{Json, extract::Query, extract::State};
use serde::Deserialize;
use serde_json::Value;

use crate::{
    error::{ok_data, AppError, OkEnvelope},
    state::AppState,
};

#[derive(Debug, Deserialize)]
pub struct RatesQuery {
    #[serde(default)]
    base: Option<String>,
}

pub async fn rates(
    State(state): State<AppState>,
    Query(q): Query<RatesQuery>,
) -> Result<Json<OkEnvelope<Value>>, AppError> {
    let base = q.base.unwrap_or_default();
    let data = state.fx.rates(state.cfg(), &base).await?;

    Ok(ok_data(data))
}
