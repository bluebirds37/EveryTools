//! 共享状态（Router state）。所有 handler 通过它拿到 DB / 存储 / 队列 / 配置。

use std::{net::IpAddr, sync::Arc};

use axum::http::HeaderMap;

use crate::{config::Settings, db::Db, files::Storage, fx::FxCache, tasks::queue::TaskQueue};

#[derive(Clone)]
pub struct AppState {
    pub settings: Arc<Settings>,
    pub db: Db,
    pub storage: Arc<Storage>,
    pub queue: TaskQueue,
    pub fx: Arc<FxCache>,
}

impl AppState {
    pub fn cfg(&self) -> &Settings {
        &self.settings
    }
}

/// 客户端 IP 解析：`X-Forwarded-For` 第一项 → `X-Real-IP` → `unknown`
///
/// 说明：本机直连时 axum 的 `ConnectInfo` 需要 `into_make_service_with_connect_info`，
/// 而线上一定在 Nginx/SLB 之后，因此统一以转发头为准；无转发头时用 `unknown`
/// 桶（仍受 user 维度限流约束，不会因为取不到 IP 而放开限流）。
pub fn client_ip(headers: &HeaderMap) -> String {
    if let Some(v) = headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(',').next())
    {
        let trimmed = v.trim();
        if let Ok(ip) = trimmed.parse::<IpAddr>() {
            return ip.to_string();
        }
    }
    if let Some(v) = headers.get("x-real-ip").and_then(|v| v.to_str().ok()) {
        if let Ok(ip) = v.trim().parse::<IpAddr>() {
            return ip.to_string();
        }
    }
    "unknown".to_string()
}
