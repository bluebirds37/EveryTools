//! 测速静态文件（C8 `GET /static/speedtest-{1,5}m.bin`，FR-LIF-07 网络测速）。
//!
//! 不用 `tower_http::services::ServeDir`：它无法给响应加 `Cache-Control`，
//! 而契约要求这两个文件**必须** `no-store`（否则小程序命中缓存，测速结果失真）；
//! 只暴露固定文件名也不给目录列举/路径穿越留任何面。文件由
//! `server/scripts/gen_speedtest_files.sh` 生成，不入库。

use axum::{
    Router,
    extract::{Path, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use tokio_util::io::ReaderStream;

use crate::{error::AppError, state::AppState};

/// 允许的尺寸档位（MB）——与前端网络测速页的档位一致
const FILES: [(&str, &str); 2] = [("1", "speedtest-1m.bin"), ("5", "speedtest-5m.bin")];

pub fn speedtest_router() -> Router<AppState> {
    Router::new().route("/static/{name}", get(serve))
}

async fn serve(State(state): State<AppState>, Path(name): Path<String>) -> Response {
    if !FILES.iter().any(|(_, f)| *f == name) {
        let tiers = FILES.map(|(k, _)| format!("{k}MB")).join("、");
        return AppError::not_found()
            .with_hint(format!("静态文件只有 {tiers} 两档测速文件"))
            .into_response();
    }

    let path = state.cfg().static_dir.join(name);
    match tokio::fs::File::open(&path).await {
        Ok(file) => {
            let len = file.metadata().await.map(|m| m.len()).unwrap_or(0);
            (
                StatusCode::OK,
                [
                    (header::CONTENT_TYPE, "application/octet-stream".to_string()),
                    (header::CACHE_CONTROL, "no-store".to_string()),
                    (header::CONTENT_LENGTH, len.to_string()),
                ],
                axum::body::Body::from_stream(ReaderStream::new(file)),
            )
                .into_response()
        }
        Err(err) => {
            tracing::warn!(error = ?err, path = %path.display(), "speedtest file missing");
            AppError::not_found()
                .with_hint("未生成测速文件，请执行 server/scripts/gen_speedtest_files.sh")
                .into_response()
        }
    }
}
