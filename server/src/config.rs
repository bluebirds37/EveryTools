//! 配置加载：`.env`（dotenvy）→ 可选 `config.toml`（`config` crate，仅非密钥项）→ 环境变量（最高优先级）。
//!
//! 安全约束（docs/requirements.md §8.5）：
//! - `JWT_SECRET` / `WECHAT_APPSECRET` / `FX_API_KEY` / `DATABASE_URL` **只能来自环境变量**，
//!   配置文件无法覆盖，代码里没有默认值，也不会写进日志。
//! - `Settings` 不实现 `Debug`（避免 `{cfg:?}` 意外打印密钥）；密钥通过显式 getter 读取。

use std::{env, path::PathBuf, str::FromStr};

use anyhow::{Context, Result, bail};
use serde::Deserialize;

/// 单文件上限默认 200MB（requirements §6.3）
pub const DEFAULT_MAX_UPLOAD_BYTES: u64 = 200 * 1024 * 1024;
/// 分片默认 4MB（tools-spec FR-V-00.2）
pub const DEFAULT_CHUNK_SIZE: u64 = 4 * 1024 * 1024;

/// 附录 B 的裸环境变量名（同时兼容 `TB_` 前缀，如 `TB_PORT`）
const ENV_KEYS: &[&str] = &[
    "PORT",
    "HOST",
    "LOG_LEVEL",
    "ENVIRONMENT",
    "CORS_ALLOWED_ORIGINS",
    "REQUEST_TIMEOUT_SECS",
    "DATABASE_URL",
    "DB_MAX_CONNECTIONS",
    "WECHAT_APPID",
    "WECHAT_APPSECRET",
    "WECHAT_STUB",
    "WECHAT_CODE2SESSION_URL",
    "JWT_SECRET",
    "ACCESS_TTL",
    "REFRESH_TTL",
    "STORAGE_DIR",
    "STATIC_DIR",
    "FILE_TTL_HOURS",
    "MAX_UPLOAD_BYTES",
    "CHUNK_SIZE",
    "UPLOAD_SESSION_TTL_SECS",
    "DAILY_QUOTA",
    "MAX_CONCURRENT_TASKS_PER_USER",
    "TASK_TIMEOUT_SECS",
    "PROCESSING_STALE_MINUTES",
    "CLEANUP_INTERVAL_SECS",
    "FFMPEG_BIN",
    "FFPROBE_BIN",
    "MEDIA_DRY_RUN",
    "WATERMARK_FONT_FILE",
    "FX_RATES_URL",
    "FX_API_KEY",
    "FX_CACHE_SECS",
    "FX_TIMEOUT_SECS",
    "PROXY_MAX_RESPONSE_BYTES",
    "PROXY_TIMEOUT_SECS",
    "PROXY_ALLOW_PRIVATE_NETWORK",
    "CONFIG_FILE",
];

#[derive(Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct Settings {
    // ---- server ----
    pub port: u16,
    pub host: String,
    pub log_level: String,
    pub environment: Environment,
    pub cors_allowed_origins: Vec<String>,
    pub request_timeout_secs: u64,

    // ---- db ----
    pub database_url: String,
    pub db_max_connections: u32,

    // ---- auth ----
    pub wechat_appid: String,
    pub wechat_appsecret: String,
    /// 仅开发用：不请求微信，用 code 派生本地 openid。**生产必须为 false。**
    pub wechat_stub: bool,
    pub wechat_code2session_url: String,
    pub jwt_secret: String,
    pub access_token_ttl_secs: i64,
    pub refresh_token_ttl_secs: i64,

    // ---- files / storage ----
    pub storage_dir: PathBuf,
    pub static_dir: PathBuf,
    pub file_ttl_hours: i64,
    pub max_upload_bytes: u64,
    pub chunk_size: u64,
    pub upload_session_ttl_secs: i64,

    // ---- tasks / media ----
    pub daily_quota: i32,
    pub max_concurrent_tasks_per_user: i32,
    pub task_timeout_secs: u64,
    pub processing_stale_minutes: i32,
    pub cleanup_interval_secs: u64,
    pub ffmpeg_bin: String,
    pub ffprobe_bin: String,
    /// `MEDIA_DRY_RUN=1` 时不执行真实 ffmpeg（本机无 ffmpeg 也能跑通全链路）
    pub media_dry_run: bool,
    pub watermark_font_file: String,

    // ---- fx / upstream ----
    pub fx_rates_url: String,
    pub fx_api_key: String,
    pub fx_cache_secs: u64,
    pub fx_timeout_secs: u64,

    // ---- dev proxy ----
    pub proxy_max_response_bytes: u64,
    pub proxy_timeout_secs: u64,
    pub proxy_allow_private_network: bool,
}

impl Settings {
    // ---- 密钥只经 getter 读取，永不出现在 Display/Debug ----
    pub fn jwt_secret(&self) -> &str {
        &self.jwt_secret
    }
    pub fn wechat_appsecret(&self) -> &str {
        &self.wechat_appsecret
    }
    pub fn fx_api_key(&self) -> &str {
        &self.fx_api_key
    }
    pub fn has_fx_upstream_key(&self) -> bool {
        !self.fx_api_key.trim().is_empty()
    }
    pub fn cors_origins_list(&self) -> &[String] {
        &self.cors_allowed_origins
    }
    pub fn request_timeout(&self) -> std::time::Duration {
        std::time::Duration::from_secs(self.request_timeout_secs)
    }
    pub fn task_timeout(&self) -> std::time::Duration {
        std::time::Duration::from_secs(self.task_timeout_secs)
    }
    pub fn fx_cache(&self) -> std::time::Duration {
        std::time::Duration::from_secs(self.fx_cache_secs)
    }
    pub fn fx_timeout(&self) -> std::time::Duration {
        std::time::Duration::from_secs(self.fx_timeout_secs)
    }
    pub fn proxy_timeout(&self) -> std::time::Duration {
        std::time::Duration::from_secs(self.proxy_timeout_secs)
    }

    /// `.env` → `config.toml`（可选）→ 环境变量。
    pub fn load() -> Result<Self> {
        // 找不到 .env 不算错误（容器里通常没有）
        let _ = dotenvy::dotenv();

        let file = FileSettings::from_config_file()?;
        let mut s = Settings::default();
        if let Some(f) = file {
            f.apply_to(&mut s);
        }
        apply_env(&mut s);
        s.validate().context("invalid settings")?;
        Ok(s)
    }

    fn validate(&self) -> Result<()> {
        if self.database_url.trim().is_empty() {
            bail!("DATABASE_URL is required (env only)");
        }
        if self.jwt_secret.len() < 32 {
            bail!(
                "JWT_SECRET must be at least 32 bytes (got {}); generate with `openssl rand -hex 32`",
                self.jwt_secret.len()
            );
        }
        if !self.wechat_stub {
            if self.wechat_appid.trim().is_empty() {
                bail!("WECHAT_APPID is required unless WECHAT_STUB=1");
            }
            if self.wechat_appsecret.trim().is_empty() {
                bail!("WECHAT_APPSECRET is required unless WECHAT_STUB=1");
            }
        }
        if self.daily_quota <= 0 {
            bail!("DAILY_QUOTA must be > 0");
        }
        if self.max_concurrent_tasks_per_user <= 0 {
            bail!("MAX_CONCURRENT_TASKS_PER_USER must be > 0");
        }
        if self.max_upload_bytes == 0 || self.chunk_size == 0 {
            bail!("MAX_UPLOAD_BYTES and CHUNK_SIZE must be > 0");
        }
        if self.chunk_size > self.max_upload_bytes {
            bail!("CHUNK_SIZE must be <= MAX_UPLOAD_BYTES");
        }
        if self.proxy_max_response_bytes == 0 {
            bail!("PROXY_MAX_RESPONSE_BYTES must be > 0");
        }
        Ok(())
    }

    /// 供集成测试/临时启动：在测试里安全注入密钥
    pub fn for_tests() -> Self {
        Settings {
            database_url: std::env::var("DATABASE_URL")
                .unwrap_or_else(|_| "postgres://postgre:postgre@127.0.0.1:15433/toolbox_dev".into()),
            jwt_secret: "unit-test-secret-0123456789abcdef-0123456789abcdef".into(),
            wechat_stub: true,
            media_dry_run: true,
            environment: Environment::Dev,
            ..Settings::default()
        }
    }
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            port: 8080,
            host: "0.0.0.0".into(),
            log_level: "info".into(),
            environment: Environment::Dev,
            cors_allowed_origins: vec![],
            request_timeout_secs: 30,
            database_url: String::new(),
            db_max_connections: 8,
            wechat_appid: String::new(),
            wechat_appsecret: String::new(),
            wechat_stub: false,
            wechat_code2session_url: "https://api.weixin.qq.com/sns/jscode2session".into(),
            jwt_secret: String::new(),
            access_token_ttl_secs: 2 * 60 * 60,
            refresh_token_ttl_secs: 30 * 24 * 60 * 60,
            storage_dir: PathBuf::from("./data/uploads"),
            static_dir: PathBuf::from("./data/static"),
            file_ttl_hours: 24,
            max_upload_bytes: DEFAULT_MAX_UPLOAD_BYTES,
            chunk_size: DEFAULT_CHUNK_SIZE,
            upload_session_ttl_secs: 24 * 60 * 60,
            daily_quota: 20,
            max_concurrent_tasks_per_user: 2,
            task_timeout_secs: 600,
            processing_stale_minutes: 15,
            cleanup_interval_secs: 300,
            ffmpeg_bin: "ffmpeg".into(),
            ffprobe_bin: "ffprobe".into(),
            media_dry_run: false,
            watermark_font_file:
                "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc".into(),
            fx_rates_url: "https://open.er-api.com/v6/latest".into(),
            fx_api_key: String::new(),
            fx_cache_secs: 900,
            fx_timeout_secs: 8,
            proxy_max_response_bytes: 5 * 1024 * 1024,
            proxy_timeout_secs: 15,
            proxy_allow_private_network: false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Environment {
    Dev,
    Staging,
    Prod,
}

impl Environment {
    pub fn is_prod(self) -> bool {
        matches!(self, Environment::Prod)
    }
}

// ---------------------------------------------------------------------------
// 环境变量读取
// ---------------------------------------------------------------------------

fn env_raw(key: &str) -> Option<String> {
    env::var(key)
        .ok()
        .or_else(|| env::var(&format!("TB_{key}")).ok())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn env_str(key: &str) -> Option<String> {
    env_raw(key)
}

fn env_parse<T: FromStr>(key: &str) -> Option<T> {
    env_raw(key).and_then(|v| v.parse::<T>().ok())
}

fn env_bool(key: &str) -> Option<bool> {
    env_raw(key).map(|v| matches!(v.as_str(), "1" | "true" | "TRUE" | "yes" | "on"))
}

fn env_path(key: &str) -> Option<PathBuf> {
    env_raw(key).map(PathBuf::from)
}

fn env_list(key: &str) -> Option<Vec<String>> {
    env_raw(key).map(|v| {
        v.split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect()
    })
}

fn apply_env(s: &mut Settings) {
    if let Some(v) = env_parse::<u16>("PORT") {
        s.port = v;
    }
    if let Some(v) = env_str("HOST") {
        s.host = v;
    }
    if let Some(v) = env_str("LOG_LEVEL") {
        s.log_level = v;
    }
    if let Some(v) = env_str("ENVIRONMENT") {
        s.environment = match v.to_ascii_lowercase().as_str() {
            "prod" | "production" => Environment::Prod,
            "staging" => Environment::Staging,
            _ => Environment::Dev,
        };
    }
    if let Some(v) = env_list("CORS_ALLOWED_ORIGINS") {
        s.cors_allowed_origins = v;
    }
    if let Some(v) = env_parse("REQUEST_TIMEOUT_SECS") {
        s.request_timeout_secs = v;
    }
    if let Some(v) = env_str("DATABASE_URL") {
        s.database_url = v;
    }
    if let Some(v) = env_parse("DB_MAX_CONNECTIONS") {
        s.db_max_connections = v;
    }
    if let Some(v) = env_str("WECHAT_APPID") {
        s.wechat_appid = v;
    }
    if let Some(v) = env_str("WECHAT_APPSECRET") {
        s.wechat_appsecret = v;
    }
    if let Some(v) = env_bool("WECHAT_STUB") {
        s.wechat_stub = v;
    }
    if let Some(v) = env_str("WECHAT_CODE2SESSION_URL") {
        s.wechat_code2session_url = v;
    }
    if let Some(v) = env_str("JWT_SECRET") {
        s.jwt_secret = v;
    }
    if let Some(v) = env_parse("ACCESS_TTL") {
        s.access_token_ttl_secs = v;
    }
    if let Some(v) = env_parse("REFRESH_TTL") {
        s.refresh_token_ttl_secs = v;
    }
    if let Some(v) = env_path("STORAGE_DIR") {
        s.storage_dir = v;
    }
    if let Some(v) = env_path("STATIC_DIR") {
        s.static_dir = v;
    }
    if let Some(v) = env_parse("FILE_TTL_HOURS") {
        s.file_ttl_hours = v;
    }
    if let Some(v) = env_parse("MAX_UPLOAD_BYTES") {
        s.max_upload_bytes = v;
    }
    if let Some(v) = env_parse("CHUNK_SIZE") {
        s.chunk_size = v;
    }
    if let Some(v) = env_parse("UPLOAD_SESSION_TTL_SECS") {
        s.upload_session_ttl_secs = v;
    }
    if let Some(v) = env_parse("DAILY_QUOTA") {
        s.daily_quota = v;
    }
    if let Some(v) = env_parse("MAX_CONCURRENT_TASKS_PER_USER") {
        s.max_concurrent_tasks_per_user = v;
    }
    if let Some(v) = env_parse("TASK_TIMEOUT_SECS") {
        s.task_timeout_secs = v;
    }
    if let Some(v) = env_parse("PROCESSING_STALE_MINUTES") {
        s.processing_stale_minutes = v;
    }
    if let Some(v) = env_parse("CLEANUP_INTERVAL_SECS") {
        s.cleanup_interval_secs = v;
    }
    if let Some(v) = env_str("FFMPEG_BIN") {
        s.ffmpeg_bin = v;
    }
    if let Some(v) = env_str("FFPROBE_BIN") {
        s.ffprobe_bin = v;
    }
    if let Some(v) = env_bool("MEDIA_DRY_RUN") {
        s.media_dry_run = v;
    }
    if let Some(v) = env_str("WATERMARK_FONT_FILE") {
        s.watermark_font_file = v;
    }
    if let Some(v) = env_str("FX_RATES_URL") {
        s.fx_rates_url = v;
    }
    if let Some(v) = env_str("FX_API_KEY") {
        s.fx_api_key = v;
    }
    if let Some(v) = env_parse("FX_CACHE_SECS") {
        s.fx_cache_secs = v;
    }
    if let Some(v) = env_parse("FX_TIMEOUT_SECS") {
        s.fx_timeout_secs = v;
    }
    if let Some(v) = env_parse("PROXY_MAX_RESPONSE_BYTES") {
        s.proxy_max_response_bytes = v;
    }
    if let Some(v) = env_parse("PROXY_TIMEOUT_SECS") {
        s.proxy_timeout_secs = v;
    }
    if let Some(v) = env_bool("PROXY_ALLOW_PRIVATE_NETWORK") {
        s.proxy_allow_private_network = v;
    }
}

// ---------------------------------------------------------------------------
// 可选配置文件（config crate）：只允许非密钥项
// ---------------------------------------------------------------------------

/// `config.toml` 里可覆盖的项。**刻意不包含** `database_url`/`jwt_secret`/
/// `wechat_appsecret`/`fx_api_key`，即使文件里写了也会被 serde 拒绝（`deny_unknown_fields`）。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields, default)]
struct FileSettings {
    port: Option<u16>,
    host: Option<String>,
    log_level: Option<String>,
    environment: Option<Environment>,
    cors_allowed_origins: Option<Vec<String>>,
    request_timeout_secs: Option<u64>,
    db_max_connections: Option<u32>,
    wechat_appid: Option<String>,
    wechat_stub: Option<bool>,
    wechat_code2session_url: Option<String>,
    access_ttl: Option<i64>,
    refresh_ttl: Option<i64>,
    storage_dir: Option<PathBuf>,
    static_dir: Option<PathBuf>,
    file_ttl_hours: Option<i64>,
    max_upload_bytes: Option<u64>,
    chunk_size: Option<u64>,
    upload_session_ttl_secs: Option<i64>,
    daily_quota: Option<i32>,
    max_concurrent_tasks_per_user: Option<i32>,
    task_timeout_secs: Option<u64>,
    processing_stale_minutes: Option<i32>,
    cleanup_interval_secs: Option<u64>,
    ffmpeg_bin: Option<String>,
    ffprobe_bin: Option<String>,
    media_dry_run: Option<bool>,
    watermark_font_file: Option<String>,
    fx_rates_url: Option<String>,
    fx_cache_secs: Option<u64>,
    fx_timeout_secs: Option<u64>,
    proxy_max_response_bytes: Option<u64>,
    proxy_timeout_secs: Option<u64>,
    proxy_allow_private_network: Option<bool>,
}

impl FileSettings {
    fn from_config_file() -> Result<Option<Self>> {
        let path = env_str("CONFIG_FILE")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("config.toml"));
        if !path.exists() {
            return Ok(None);
        }
        let cfg = config::Config::builder()
            .add_source(config::File::from(path.clone()).required(true))
            .build()
            .with_context(|| format!("failed to read config file {}", path.display()))?;
        let file: FileSettings = cfg
            .try_deserialize()
            .with_context(|| format!("invalid config file {}", path.display()))?;
        Ok(Some(file))
    }

    /// 环境变量优先：已被 env 覆盖的项不再写回
    fn apply_to(self, s: &mut Settings) {
        macro_rules! assign {
            ($slot:expr, $field:ident, $env_key:expr) => {
                if let Some(v) = self.$field {
                    if env_raw($env_key).is_none() {
                        $slot = v;
                    }
                }
            };
        }
        assign!(s.port, port, "PORT");
        assign!(s.host, host, "HOST");
        assign!(s.log_level, log_level, "LOG_LEVEL");
        assign!(s.environment, environment, "ENVIRONMENT");
        assign!(
            s.cors_allowed_origins,
            cors_allowed_origins,
            "CORS_ALLOWED_ORIGINS"
        );
        assign!(
            s.request_timeout_secs,
            request_timeout_secs,
            "REQUEST_TIMEOUT_SECS"
        );
        assign!(s.db_max_connections, db_max_connections, "DB_MAX_CONNECTIONS");
        assign!(s.wechat_appid, wechat_appid, "WECHAT_APPID");
        assign!(s.wechat_stub, wechat_stub, "WECHAT_STUB");
        assign!(
            s.wechat_code2session_url,
            wechat_code2session_url,
            "WECHAT_CODE2SESSION_URL"
        );
        assign!(s.access_token_ttl_secs, access_ttl, "ACCESS_TTL");
        assign!(s.refresh_token_ttl_secs, refresh_ttl, "REFRESH_TTL");
        assign!(s.storage_dir, storage_dir, "STORAGE_DIR");
        assign!(s.static_dir, static_dir, "STATIC_DIR");
        assign!(s.file_ttl_hours, file_ttl_hours, "FILE_TTL_HOURS");
        assign!(s.max_upload_bytes, max_upload_bytes, "MAX_UPLOAD_BYTES");
        assign!(s.chunk_size, chunk_size, "CHUNK_SIZE");
        assign!(
            s.upload_session_ttl_secs,
            upload_session_ttl_secs,
            "UPLOAD_SESSION_TTL_SECS"
        );
        assign!(s.daily_quota, daily_quota, "DAILY_QUOTA");
        assign!(
            s.max_concurrent_tasks_per_user,
            max_concurrent_tasks_per_user,
            "MAX_CONCURRENT_TASKS_PER_USER"
        );
        assign!(s.task_timeout_secs, task_timeout_secs, "TASK_TIMEOUT_SECS");
        assign!(
            s.processing_stale_minutes,
            processing_stale_minutes,
            "PROCESSING_STALE_MINUTES"
        );
        assign!(
            s.cleanup_interval_secs,
            cleanup_interval_secs,
            "CLEANUP_INTERVAL_SECS"
        );
        assign!(s.ffmpeg_bin, ffmpeg_bin, "FFMPEG_BIN");
        assign!(s.ffprobe_bin, ffprobe_bin, "FFPROBE_BIN");
        assign!(s.media_dry_run, media_dry_run, "MEDIA_DRY_RUN");
        assign!(
            s.watermark_font_file,
            watermark_font_file,
            "WATERMARK_FONT_FILE"
        );
        assign!(s.fx_rates_url, fx_rates_url, "FX_RATES_URL");
        assign!(s.fx_cache_secs, fx_cache_secs, "FX_CACHE_SECS");
        assign!(s.fx_timeout_secs, fx_timeout_secs, "FX_TIMEOUT_SECS");
        assign!(
            s.proxy_max_response_bytes,
            proxy_max_response_bytes,
            "PROXY_MAX_RESPONSE_BYTES"
        );
        assign!(
            s.proxy_timeout_secs,
            proxy_timeout_secs,
            "PROXY_TIMEOUT_SECS"
        );
        assign!(
            s.proxy_allow_private_network,
            proxy_allow_private_network,
            "PROXY_ALLOW_PRIVATE_NETWORK"
        );
    }
}

/// 环境变量清单（README/.env.example 对齐用）
pub const KNOWN_ENV_KEYS: &[&str] = ENV_KEYS;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_match_requirements_limits() {
        let d = Settings::default();
        assert_eq!(d.max_upload_bytes, 209_715_200); // 200MB
        assert_eq!(d.chunk_size, 4 * 1024 * 1024);
        assert_eq!(d.daily_quota, 20);
        assert_eq!(d.max_concurrent_tasks_per_user, 2);
        assert_eq!(d.task_timeout_secs, 600);
        assert_eq!(d.file_ttl_hours, 24);
        assert_eq!(d.fx_cache_secs, 900); // 15min（FR-CAL-08）
        assert_eq!(d.proxy_max_response_bytes, 5 * 1024 * 1024);
        assert_eq!(d.access_token_ttl_secs, 7200);
        assert_eq!(d.refresh_token_ttl_secs, 2_592_000);
        assert_eq!(d.processing_stale_minutes, 15);
        assert!(!d.wechat_stub, "微信桩必须显式开启，默认走真实 code2session");
    }

    #[test]
    fn validation_rejects_missing_secrets() {
        let mut s = Settings::default();
        assert!(s.validate().is_err(), "database_url/jwt_secret 必填");
        s.database_url = "postgres://u:p@127.0.0.1:5432/db".into();
        s.jwt_secret = "too-short".into();
        assert!(s.validate().is_err());
        s.jwt_secret = "0123456789012345678901234567890123456789".into();
        s.wechat_stub = true;
        s.validate().expect("stub 模式允许无微信密钥");
    }

    #[test]
    fn chunk_size_must_not_exceed_max_upload() {
        let mut s = Settings::default();
        s.database_url = "postgres://u:p@127.0.0.1:5432/db".into();
        s.jwt_secret = "0123456789012345678901234567890123456789".into();
        s.wechat_stub = true;
        s.chunk_size = 500 * 1024 * 1024;
        assert!(s.validate().is_err());
    }

    #[test]
    fn config_file_cannot_carry_secrets() {
        // deny_unknown_fields：把密钥写进 config.toml 会直接报错
        let toml = "jwt_secret = \"leak\"\n";
        let cfg = config::Config::builder()
            .add_source(config::File::from_str(toml, config::FileFormat::Toml))
            .build()
            .unwrap();
        let err = cfg.try_deserialize::<FileSettings>().unwrap_err();
        assert!(
            err.to_string().contains("jwt_secret"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn config_file_fills_defaults() {
        let toml = "port = 9999\ndaily_quota = 5\n";
        let cfg = config::Config::builder()
            .add_source(config::File::from_str(toml, config::FileFormat::Toml))
            .build()
            .unwrap();
        let file: FileSettings = cfg.try_deserialize().unwrap();
        let mut s = Settings::default();
        file.apply_to(&mut s);
        assert_eq!(s.daily_quota, 5, "config.toml 应覆盖默认值");
        assert_eq!(s.port, 9999);
        // 密钥类字段无法被文件设置（FileSettings 里根本没有这些字段）
        assert!(s.jwt_secret.is_empty());
        assert!(s.database_url.is_empty());
    }
}
