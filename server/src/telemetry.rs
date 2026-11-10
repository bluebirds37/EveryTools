//! 观测：tracing(JSON) 初始化 + requestId 中间件。
//!
//! 约束（requirements §8.5.5）：全链路记录 `requestId`；日志**不落**用户媒体内容、不落 token。
//! 因此这里只记录 method/path/status/latency/requestId，绝不记录 body 与 Authorization 头。

use std::time::Instant;

use axum::{
    extract::Request,
    http::{HeaderName, HeaderValue},
    middleware::Next,
    response::Response,
};
use tracing_subscriber::{EnvFilter, fmt, prelude::*, registry::Registry};

pub const REQUEST_ID_HEADER: &str = "x-request-id";

tokio::task_local! {
    static CURRENT_REQUEST_ID: String;
}

/// 当前请求的 requestId；不在请求上下文中（单测/后台任务）时返回 `"-"`
pub fn current_request_id() -> String {
    CURRENT_REQUEST_ID
        .try_with(|s| s.clone())
        .unwrap_or_else(|_| "-".to_string())
}

#[derive(Clone, Debug)]
pub struct RequestId(pub String);

impl RequestId {
    /// 优先复用上游传入的 x-request-id（只接受可见字符，防日志注入）
    pub fn from_headers(existing: Option<&HeaderValue>) -> Self {
        let incoming = existing
            .and_then(|v| v.to_str().ok())
            .map(|s| s.trim())
            .filter(|s| !s.is_empty() && s.len() <= 64 && s.chars().all(|c| c.is_ascii_graphic()))
            .map(|s| s.to_string());
        RequestId(incoming.unwrap_or_else(|| format!("req_{}", uuid::Uuid::new_v4().simple())))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// requestId 中间件：注入 header + task-local + 访问日志
pub async fn request_id_middleware(mut req: Request, next: Next) -> Response {
    let id = RequestId::from_headers(req.headers().get(REQUEST_ID_HEADER));
    let method = req.method().clone();
    let path = req.uri().path().to_string();
    req.extensions_mut().insert(id.clone());

    let started = Instant::now();
    let resp = CURRENT_REQUEST_ID
        .scope(id.0.clone(), async move { next.run(req).await })
        .await;

    let status = resp.status();
    let latency_ms = started.elapsed().as_millis() as u64;
    let log = tracing::info_span!(
        "http",
        request_id = %id.0,
        method = %method,
        path = %path,
        status = status.as_u16(),
        latency_ms,
    );
    if status.is_client_error() || status.is_server_error() {
        tracing::event!(parent: &log, tracing::Level::WARN, "request finished");
    } else {
        tracing::event!(parent: &log, tracing::Level::INFO, "request finished");
    }

    let mut resp = resp;
    if let Ok(v) = HeaderValue::from_str(&id.0) {
        resp.headers_mut().insert(HeaderName::from_static(REQUEST_ID_HEADER), v);
    }
    resp
}

/// 初始化 JSON 日志。`LOG_LEVEL` 形如 `info`/`debug`/`toolbox_server=debug,info`。
pub fn init_tracing(level: &str) {
    let filter = EnvFilter::try_new(level)
        .or_else(|_| EnvFilter::try_new("info"))
        .unwrap_or_else(|_| EnvFilter::new("info"));
    // 分层必须按具体类型组合：`Vec<Box<dyn Layer<Registry>>>` 再 `.with()` 不满足
    // `Layer<Layered<EnvFilter, Registry>>`，因此这里按分支各自 init（语义不变：
    // 默认 JSON、含 `pretty` 时用 compact 文本，都带同一个 EnvFilter）。
    let base = Registry::default().with(filter);
    if level.contains("pretty") {
        base.with(fmt::layer().compact().with_target(false)).init();
    } else {
        base.with(fmt::layer().json().with_current_span(false)).init();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_id_prefers_valid_incoming_header() {
        let id = RequestId::from_headers(Some(&HeaderValue::from_static("trace-abc")));
        assert_eq!(id.as_str(), "trace-abc");
    }

    #[test]
    fn request_id_rejects_hostile_header() {
        // 空白/非 ASCII/非法 UTF-8 一律忽略，改用自建 id（避免日志注入与响应头拆分）
        for bytes in [
            b"a b".as_slice(),
            b"caf\xC3\xA9".as_slice(),
            b"\xFF\xFE".as_slice(),
        ] {
            let raw = HeaderValue::from_bytes(bytes).expect("构造合法 HeaderValue");
            let id = RequestId::from_headers(Some(&raw));
            assert!(id.as_str().starts_with("req_"), "{bytes:?} -> {}", id.as_str());
        }
        let long = "x".repeat(200);
        let id = RequestId::from_headers(HeaderValue::from_str(&long).ok().as_ref());
        assert!(id.as_str().starts_with("req_"));
    }

    #[test]
    fn current_request_id_outside_scope_is_dash() {
        assert_eq!(current_request_id(), "-");
    }
}
