//! 汇率代理（docs/requirements.md §8.2 `GET /fx/rates`、CONTRACT C8）
//!
//! 只做两件事：**服务端持密钥请求上游** + **内存缓存 15 分钟**，
//! 这样小程序不必把上游密钥写进前端，也不会在用户反复进出工具页时打下游额度。
//!
//! 密钥/地址（requirements 附录 B 的安全约束，见 `config.rs` 头注释）：
//! - `FX_API_KEY`：**只从环境变量读**（`config.rs` 已保证配置文件无法覆盖密钥），
//!   代码里无默认值、不进日志；缺失 → `UPSTREAM_UNAVAILABLE`，
//!   **绝不返回假数据/写死汇率**（宁可对用户说「数据源暂不可用」）。
//! - `FX_API_BASE`：只从环境变量读；未设置时退回 `Settings::fx_rates_url`（同一默认端点）。
//! - 上游超时取 `Settings::fx_timeout()`，缓存时长取 `Settings::fx_cache()`（默认 900s=15min）。
//!
//! 缓存策略：单个币种槽位（前端只用一个基准币种，够用且不必造 LRU）。
//! 上游失败时**不**按 15min 缓存失败结果，只做 15s 负缓存：
//! 既不让用户「重试一次又被拒一刻钟」，也防止连环点击打爆上游。
//!
//! 测试友好：`rates()` 只是 `rates_with_key()` 的一层薄封装（从环境变量取 key/base），
//! 因此单测能注入空 key / 不可达地址，而不需要 `unsafe { env::set_var }`（Edition 2024 禁止）。

use std::{
    sync::Mutex,
    time::{Duration, Instant},
};

use reqwest::Client;
use serde_json::{Value, json};

use crate::{
    config::Settings,
    error::{AppError, Code},
};

/// 上游端点前缀（拼成 `{base}/{CURRENCY}`）。默认与 `config.rs` 的 `fx_rates_url` 一致。
pub const DEFAULT_FX_BASE: &str = "https://open.er-api.com/v6/latest";
/// 环境变量名（附录 B / `config.rs::ENV_KEYS`）
pub const ENV_FX_API_KEY: &str = "FX_API_KEY";
pub const ENV_FX_API_BASE: &str = "FX_API_BASE";
/// 缓存 15min（requirements §8.2「汇率（缓存 + 上游代理）」、FR-CAL-08）
pub const DEFAULT_CACHE_TTL: Duration = Duration::from_secs(900);
/// 上游失败后的负缓存时长
const FAILURE_COOLDOWN: Duration = Duration::from_secs(15);
/// 基准币种长度（ISO-4217 三位字母）
const CODE_LEN: usize = 3;
/// 用户可见话术（错误码 UPSTREAM_UNAVAILABLE 的 message）
const UPSTREAM_MESSAGE: &str = "汇率数据源暂不可用，请稍后重试";

#[derive(Debug, Clone)]
struct Entry {
    base: String,
    fetched_at: Instant,
    /// 已整形好的响应 data（`{base, rates, updatedAt, count}`）
    data: Value,
}

#[derive(Debug)]
enum Slot {
    Hit(Entry),
    /// 上次上游失败：`Instant` 是失败时刻，`String` 是排障 hint（不含密钥）
    Failed(Instant, String),
}

/// 汇率缓存。`lib.rs::startup` 用 `FxCache::new()`（无参）构造，装在 `AppState.fx`。
pub struct FxCache {
    slot: Mutex<Option<Slot>>,
    client: Client,
}

impl Default for FxCache {
    fn default() -> Self {
        Self::new()
    }
}

impl FxCache {
    pub fn new() -> Self {
        Self {
            slot: Mutex::new(None),
            // 整体上限兜底；真正的每次超时用 cfg.fx_timeout()
            client: Client::builder()
                .timeout(Duration::from_secs(30))
                .build()
                .unwrap_or_else(|_| Client::new()),
        }
    }

    // ---- 环境变量解析（纯函数，便于单测） ----

    /// `FX_API_BASE` 优先，空/未设置则用配置默认端点；去掉尾斜杠便于拼 `/{base}`。
    fn resolve_base(env_value: Option<&str>, fallback: &str) -> String {
        let chosen = env_value
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(fallback.trim());
        if chosen.is_empty() {
            DEFAULT_FX_BASE.to_string()
        } else {
            chosen.trim_end_matches('/').to_string()
        }
    }

    /// 密钥：环境变量 `FX_API_KEY` → `Settings::fx_api_key()`（同样只可能来自环境变量）。
    fn resolve_key(env_value: Option<&str>, from_settings: &str) -> String {
        let from_env = env_value.unwrap_or_default().trim();
        if !from_env.is_empty() {
            return from_env.to_string();
        }
        from_settings.trim().to_string()
    }

    /// 上游地址（`FX_API_BASE` → `Settings.fx_rates_url`）
    pub fn api_base(cfg: &Settings) -> String {
        Self::resolve_base(std::env::var(ENV_FX_API_BASE).ok().as_deref(), &cfg.fx_rates_url)
    }

    /// 上游密钥（只来自环境变量；缺失返回空串）
    pub fn api_key(cfg: &Settings) -> String {
        if cfg.has_fx_upstream_key() {
            return cfg.fx_api_key().trim().to_string();
        }
        Self::resolve_key(std::env::var(ENV_FX_API_KEY).ok().as_deref(), "")
    }

    /// 命中判定（纯函数，单测覆盖）：同币种且未过期才算命中。
    fn fresh(entry: &Entry, ttl: Duration, now: Instant) -> bool {
        entry.fetched_at + ttl > now
    }

    /// `GET /fx/rates?base=CNY`：读环境变量里的密钥后转发到 [`Self::rates_with_key`]。
    pub async fn rates(&self, cfg: &Settings, base: &str) -> Result<Value, AppError> {
        let key = Self::api_key(cfg);
        self.rates_with_key(cfg, base, &key).await
    }

    /// 可注入密钥的实现体（`rates()` 的真身；单测直接调它）。
    pub async fn rates_with_key(
        &self,
        cfg: &Settings,
        base: &str,
        key: &str,
    ) -> Result<Value, AppError> {
        let base = normalize_base(base)?;
        let ttl = effective_ttl(cfg);

        // 1) 缓存 / 负缓存
        let cached = {
            match self.slot.lock() {
                Ok(g) => match g.as_ref() {
                    Some(Slot::Hit(e)) if e.base == base && Self::fresh(e, ttl, Instant::now()) => {
                        Some(Ok(e.data.clone()))
                    }
                    Some(Slot::Failed(at, reason)) if at.elapsed() < FAILURE_COOLDOWN => {
                        Some(Err(missing_upstream_hint(reason)))
                    }
                    _ => None,
                },
                Err(_) => None, // 锁中毒：当作未命中，下面重新拉取
            }
        };
        if let Some(res) = cached {
            return res;
        }

        // 2) 无 key：可辨识错误码（绝不返回假数据）
        if key.is_empty() {
            let why = format!("{ENV_FX_API_KEY} 未配置（服务端环境变量注入）");
            self.remember_failure(&why);
            return Err(AppError::new(
                axum::http::StatusCode::SERVICE_UNAVAILABLE,
                Code::UpstreamUnavailable,
            )
            .with_message("汇率数据源暂未开放")
            .with_hint(&why));
        }

        // 3) 拉上游
        match self.fetch(cfg, &base, key).await {
            Ok(data) => {
                if let Ok(mut g) = self.slot.lock() {
                    *g = Some(Slot::Hit(Entry {
                        base,
                        fetched_at: Instant::now(),
                        data: data.clone(),
                    }));
                }
                Ok(data)
            }
            Err(err) => {
                self.remember_failure(&err.message);
                Err(err)
            }
        }
    }

    /// 单次上游请求 + 整形。
    /// 上游原始响应体**不透传**给用户（requirements §8.5.4），只进 tracing。
    async fn fetch(&self, cfg: &Settings, base: &str, key: &str) -> Result<Value, AppError> {
        let url = format!("{}/{}", Self::api_base(cfg), base);
        let resp = self
            .client
            .get(&url)
            .header("x-api-key", key)
            .timeout(cfg.fx_timeout())
            .send()
            .await
            .map_err(|e| {
                AppError::upstream_unavailable(UPSTREAM_MESSAGE).caused_by(anyhow::Error::from(e))
            })?;
        let status = resp.status();
        if !status.is_success() {
            tracing::warn!(code = status.as_u16(), "fx upstream returned non-2xx");
            return Err(AppError::upstream_unavailable(UPSTREAM_MESSAGE));
        }
        let body: Value = resp.json().await.map_err(|e| {
            AppError::upstream_unavailable("汇率数据源返回格式异常")
                .caused_by(anyhow::Error::from(e))
        })?;
        shape_response(&body, base)
    }

    fn remember_failure(&self, reason: &str) {
        if let Ok(mut g) = self.slot.lock() {
            *g = Some(Slot::Failed(
                Instant::now(),
                reason.chars().take(120).collect(),
            ));
        }
    }

    /// 清空缓存（单测之间隔离状态用）
    pub fn invalidate(&self) {
        if let Ok(mut g) = self.slot.lock() {
            *g = None;
        }
    }

    /// 当前缓存的币种（诊断/单测用；无缓存返回 None）
    pub fn cached_base(&self) -> Option<String> {
        self.slot.lock().ok().and_then(|g| match g.as_ref() {
            Some(Slot::Hit(e)) => Some(e.base.clone()),
            _ => None,
        })
    }
}

/// 实际缓存时长：`FX_CACHE_SECS`（默认 900s=15min）；配 0 时退回默认，避免打穿上游。
pub fn effective_ttl(cfg: &Settings) -> Duration {
    let d = cfg.fx_cache();
    if d.is_zero() {
        DEFAULT_CACHE_TTL
    } else {
        d
    }
}

/// `?base=` 校验：ISO-4217 三位字母；空 → CNY（前端默认基准币种）。
pub fn normalize_base(raw: &str) -> Result<String, AppError> {
    let t = raw.trim();
    if t.is_empty() {
        return Ok("CNY".to_string());
    }
    if t.len() != CODE_LEN || !t.chars().all(|c| c.is_ascii_alphabetic()) {
        return Err(AppError::param_invalid(
            "base",
            "请使用 3 位 ISO 币种代码，如 CNY/USD/EUR",
        ));
    }
    Ok(t.to_ascii_uppercase())
}

/// 负缓存期间给用户的错误（保持同一错误码，hint 里带一句排障线索）
fn missing_upstream_hint(reason: &str) -> AppError {
    AppError::upstream_unavailable(UPSTREAM_MESSAGE).with_hint(reason.to_string())
}

/// 上游 JSON → 契约 `{rates, updatedAt}`（C8）。
/// 兼容两种形态：`er-api`（顶层 `rates`）与带 `quotes`/`data` 包装的供应商。
pub fn shape_response(body: &Value, base: &str) -> Result<Value, AppError> {
    if let Some(result) = body.get("result").and_then(|v| v.as_str()) {
        if !result.eq_ignore_ascii_case("success") {
            tracing::warn!(result, "fx upstream reported failure");
            return Err(AppError::upstream_unavailable(UPSTREAM_MESSAGE));
        }
    }
    let rates = ["rates", "quotes", "data"]
        .iter()
        .find_map(|k| body.get(*k).and_then(|v| v.as_object()))
        .cloned()
        .ok_or_else(|| {
            AppError::upstream_unavailable("汇率数据源未返回有效汇率")
                .with_hint("上游响应缺少 rates 字段")
        })?;
    if rates.is_empty() {
        return Err(AppError::upstream_unavailable("汇率数据源未返回有效汇率"));
    }
    let updated_at = ["time_last_update_utc", "date", "timestamp"]
        .iter()
        .find_map(|k| body.get(*k).and_then(|v| v.as_str()))
        .map(str::to_string)
        .unwrap_or_else(|| chrono::Utc::now().to_rfc3339());
    Ok(Value::Object({
        let mut m = serde_json::Map::new();
        m.insert("base".into(), json!(base));
        m.insert("rates".into(), Value::Object(rates));
        m.insert("updatedAt".into(), json!(updated_at));
        m.insert("count".into(), json!(rates_len(body)));
        m
    }))
}

fn rates_len(body: &Value) -> usize {
    ["rates", "quotes", "data"]
        .iter()
        .find_map(|k| body.get(*k).and_then(|v| v.as_object()))
        .map(|m| m.len())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> Settings {
        let mut c = Settings::for_tests();
        c.fx_cache_secs = 900;
        // 单测里绝不联网：指向本机不可能有服务的端口
        c.fx_rates_url = "http://127.0.0.1:1/latest".into();
        c.fx_timeout_secs = 2;
        c
    }

    #[test]
    fn base_code_is_validated_and_uppercased() {
        assert_eq!(normalize_base("").unwrap(), "CNY");
        assert_eq!(normalize_base(" usd ").unwrap(), "USD");
        assert_eq!(normalize_base("cny").unwrap(), "CNY");
        for bad in ["C", "CNYY", "CN2", "€€€", "--"] {
            let err = normalize_base(bad).unwrap_err();
            assert_eq!(err.code, Code::ParamInvalid, "{bad}");
        }
    }

    #[test]
    fn ttl_defaults_to_15_minutes() {
        assert_eq!(effective_ttl(&cfg()), DEFAULT_CACHE_TTL);
        let mut c = Settings::for_tests();
        c.fx_cache_secs = 0;
        assert_eq!(effective_ttl(&c), DEFAULT_CACHE_TTL);
        let mut c2 = Settings::for_tests();
        c2.fx_cache_secs = 30;
        assert_eq!(effective_ttl(&c2), Duration::from_secs(30));
    }

    #[test]
    fn env_resolution_is_pure_and_secret_free() {
        // FX_API_BASE 覆盖 > 配置默认；空白等于未设置
        assert_eq!(
            FxCache::resolve_base(None, "https://api.example/v6/latest"),
            "https://api.example/v6/latest"
        );
        assert_eq!(
            FxCache::resolve_base(Some("https://x.example/fx/"), "https://a"),
            "https://x.example/fx"
        );
        assert_eq!(FxCache::resolve_base(Some("   "), "https://a"), "https://a");
        assert_eq!(
            FxCache::resolve_base(Some(""), ""),
            DEFAULT_FX_BASE.trim_end_matches('/')
        );
        // 密钥：env 优先，空白退回配置值，两者都空 → 空串（触发可辨识错误）
        assert_eq!(FxCache::resolve_key(Some("k-env"), "k-cfg"), "k-env");
        assert_eq!(FxCache::resolve_key(Some("  "), "k-cfg"), "k-cfg");
        assert_eq!(FxCache::resolve_key(None, ""), "");
    }

    #[test]
    fn freshness_needs_same_base_and_within_ttl() {
        let e = Entry {
            base: "USD".into(),
            fetched_at: Instant::now(),
            data: json!({}),
        };
        assert!(FxCache::fresh(&e, Duration::from_secs(900), Instant::now()));
        assert!(!FxCache::fresh(&e, Duration::ZERO, Instant::now()));
        let expired = Entry {
            fetched_at: Instant::now() - Duration::from_secs(901),
            ..e.clone()
        };
        assert!(!FxCache::fresh(&expired, Duration::from_secs(900), Instant::now()));
    }

    #[test]
    fn response_shaping_handles_both_layouts_and_errors() {
        let er = json!({"result":"success","base":"CNY","date":"2026-10-13","rates":{"USD":0.14,"EUR":0.13}});
        let shaped = shape_response(&er, "CNY").unwrap();
        assert_eq!(shaped["base"], "CNY");
        assert_eq!(shaped["rates"]["USD"], 0.14);
        assert_eq!(shaped["updatedAt"], "2026-10-13");
        assert_eq!(shaped["count"], 2);

        let wrapped = json!({"quotes": {"USDCNY": 7.1}, "timestamp": "1700000000"});
        let shaped2 = shape_response(&wrapped, "USD").unwrap();
        assert_eq!(shaped2["rates"]["USDCNY"], 7.1);

        for bad in [
            json!({"result":"error","error-type":"limited"}),
            json!({"rates": {}}),
            json!({"foo": 1}),
        ] {
            let err = shape_response(&bad, "USD").unwrap_err();
            assert_eq!(err.code, Code::UpstreamUnavailable, "{bad}");
        }
    }

    #[tokio::test]
    async fn missing_key_is_identifiable_error_not_fake_data() {
        let cache = FxCache::new();
        let err = cache
            .rates_with_key(&cfg(), "CNY", "")
            .await
            .expect_err("无 key 必须报错");
        assert_eq!(err.code, Code::UpstreamUnavailable);
        assert_eq!(err.status, axum::http::StatusCode::SERVICE_UNAVAILABLE);
        assert!(err.hint.clone().unwrap_or_default().contains(ENV_FX_API_KEY));
        // 不返回任何假汇率数据
        assert!(!err.message.contains("7.1"));
        // 负缓存：紧接着的请求依旧失败（同一错误码），且不会重新打上游
        let err2 = cache
            .rates_with_key(&cfg(), "CNY", "")
            .await
            .expect_err("负缓存生效");
        assert_eq!(err2.code, Code::UpstreamUnavailable);
        assert_eq!(cache.cached_base(), None, "失败不该被当作有效缓存");
        cache.invalidate();
    }

    #[tokio::test]
    async fn unreachable_upstream_maps_to_upstream_unavailable() {
        let cache = FxCache::new();
        let err = cache
            .rates_with_key(&cfg(), "usd", "test-key")
            .await
            .expect_err("127.0.0.1:1 无服务");
        assert_eq!(err.code, Code::UpstreamUnavailable);
        // 用户可见文案里没有上游地址/密钥
        assert!(!err.message.contains("127.0.0.1"));
        assert!(!err.message.contains("test-key"));
        cache.invalidate();
    }

    #[tokio::test]
    async fn invalid_base_never_touches_upstream() {
        let cache = FxCache::new();
        let err = cache
            .rates_with_key(&cfg(), "TOOLONG", "test-key")
            .await
            .expect_err("参数校验先行");
        assert_eq!(err.code, Code::ParamInvalid);
        assert_eq!(cache.cached_base(), None);
    }
}
