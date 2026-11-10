//! 通用工具箱后端（axum + sqlx + ffmpeg 适配层）。
//!
//! 模块划分与 `docs/requirements.md` §13 的 `server/` 结构一一对应。

pub mod auth;
pub mod config;
pub mod db;
pub mod dev_proxy;
pub mod error;
pub mod files;
pub mod fx;
pub mod media;
pub mod routes;
pub mod state;
pub mod tasks;
pub mod telemetry;

pub use error::{AppError, Code, OkEnvelope, ok_data};

use std::sync::Arc;

use anyhow::{Context, Result};
use axum::{Router, http::{HeaderName, HeaderValue, Method, StatusCode}, middleware};
use tower_http::{
    cors::CorsLayer,
    limit::RequestBodyLimitLayer,
    timeout::TimeoutLayer,
    trace::TraceLayer,
};

use crate::{
    config::Settings, db::Db, files::Storage, media::ffmpeg::build_runner, state::AppState,
    tasks::queue::TaskQueue,
};

/// 构建 Router（供 main 与集成测试复用）
pub fn build_router(state: AppState) -> Router {
    let cfg = state.settings.clone();

    let api = routes::api_router().layer(middleware::from_fn(telemetry::request_id_middleware));
    let public = routes::public_router().layer(middleware::from_fn(telemetry::request_id_middleware));

    let mut root = Router::new().nest("/api/v1", api).merge(public);

    // 静态测速文件：`/static/speedtest-1m.bin`、`/static/speedtest-5m.bin`（FR-LIF-07）
    // 由 `server/scripts/gen_speedtest_files.sh` 生成，**不提交二进制**；
    // 走自建 handler（而非 ServeDir）以便下发契约要求的 `Cache-Control: no-store`。
    let static_dir = cfg.static_dir.clone();
    if !static_dir.exists() {
        tracing::warn!(
            "static dir {} missing; run `scripts/gen_speedtest_files.sh` (speedtest files will 404)",
            static_dir.display()
        );
    }
    root = root.merge(routes::speedtest_router());

    root.layer(cors_layer(&cfg))
        .layer(TimeoutLayer::with_status_code(
            // 与弃用前的 `TimeoutLayer::new` 完全一致：超时回 408 Request Timeout
            StatusCode::REQUEST_TIMEOUT,
            cfg.request_timeout(),
        ))
        .layer(TraceLayer::new_for_http())
        // 网关层先拒超大上传（requirements §8.5.7 → 413 + 可读文案由 AppError 统一）
        .layer(RequestBodyLimitLayer::new(cfg.max_upload_bytes as usize))
        .with_state(state)
}

fn cors_layer(cfg: &Settings) -> CorsLayer {
    // 小程序请求不带 Origin；仅当显式配置白名单时才下发 CORS（保守）。
    let origins = cfg
        .cors_origins_list()
        .iter()
        .filter_map(|o| HeaderValue::from_str(o).ok())
        .collect::<Vec<HeaderValue>>();
    if origins.is_empty() {
        return CorsLayer::new();
    }
    CorsLayer::new()
        .allow_origin(origins)
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers([
            HeaderName::from_static("authorization"),
            HeaderName::from_static("content-type"),
            HeaderName::from_static("x-request-id"),
        ])
        .max_age(std::time::Duration::from_secs(600))
}

/// 应用装配：DB → 迁移 → 队列 worker → TTL 清理 → Router
pub async fn startup(cfg: Settings) -> Result<(AppState, Router)> {
    let db = Db::connect(&cfg)
        .await
        .context("database connect failed; check DATABASE_URL (dev: 127.0.0.1:15433/toolbox_dev)")?;
    db.migrate().await.context("migrations failed")?;

    let storage = Arc::new(Storage::new(cfg.storage_dir.clone(), cfg.chunk_size)?);
    std::fs::create_dir_all(&cfg.static_dir)
        .with_context(|| format!("create static dir {}", cfg.static_dir.display()))?;

    let runner = build_runner(&cfg);
    let queue = TaskQueue::new(&cfg, db.clone(), storage.clone(), runner);

    // 崩溃恢复：processing 超过 N 分钟 → failed（requirements §8.4）
    tasks::recovery::recover_stale_tasks(db.pool(), cfg.processing_stale_minutes)
        .await
        .context("stale task recovery failed")?;
    queue.clone().start_workers();
    files::cleanup::spawn_ttl_task(db.clone(), storage.clone(), &cfg);

    let state = AppState {
        settings: Arc::new(cfg),
        db,
        storage,
        queue,
        fx: Arc::new(crate::fx::FxCache::new()),
    };
    let app = build_router(state.clone());
    Ok((state, app))
}

pub async fn run_main() -> Result<()> {
    let cfg = Settings::load().context("configuration error")?;
    telemetry::init_tracing(&cfg.log_level);
    let bind = format!("{}:{}", cfg.host, cfg.port);
    let (_state, app) = startup(cfg).await?;
    let listener = tokio::net::TcpListener::bind(&bind)
        .await
        .with_context(|| format!("failed to bind {bind}"))?;
    tracing::info!("toolbox-server listening on {bind}");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .context("server error")?;
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut sig) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            let _ = sig.recv().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    tracing::info!("shutdown signal received");
}
