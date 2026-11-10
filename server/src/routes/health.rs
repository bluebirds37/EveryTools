//! 健康探针（C8 `GET /healthz` 存活 / `GET /readyz` DB 就绪）。
//!
//! 都在 `public_router`（根路径，无鉴权）：
//! - `/healthz` 只要进程活着就 200，供容器 liveness；
//! - `/readyz` 真正 `SELECT 1` 打一次库，失败 503，供 readiness / 发布门控。

use axum::{
    Json,
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};

use crate::state::AppState;

/// 存活：进程在即 200（不查 DB，避免 DB 抖动导致容器被重启）
pub async fn live() -> Json<Value> {
    Json(json!({ "ok": true, "status": "alive" }))
}

/// 就绪：打一次 `SELECT 1`；失败返回 503 + `ok:false`
pub async fn ready(State(state): State<AppState>) -> Response {
    match state.db.ping().await {
        Ok(()) => (
            StatusCode::OK,
            Json(json!({ "ok": true, "status": "ready", "db": "up" })),
        )
            .into_response(),
        Err(err) => {
            tracing::warn!(error = ?err, "readiness probe: db ping failed");
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({ "ok": false, "status": "not-ready", "db": "down" })),
            )
                .into_response()
        }
    }
}
