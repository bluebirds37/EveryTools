//! 微信 `code2session`（requirements §6.1 / §8.5.4）。
//!
//! 铁律：
//! - `appsecret` 只从环境变量来，绝不下发前端、绝不写日志；
//! - 微信返回的 `errcode/errmsg` **不透传**给用户，映射成内部错误码（`WECHAT_LOGIN_FAILED` 等）；
//! - `openid` / `session_key` 只在服务端使用，接口响应里只返回内部 `userId`。
//!
//! 开发桩：`WECHAT_STUB=1` 时不请求微信，用 `code` 派生**本地** openid。
//! **仅开发用**：桩出来的 openid 不是真实微信用户，生产环境必须在启动时被拒绝
//! （见 [`WechatClient::stub_rejected_in_prod`]）。

use serde::{Deserialize, Serialize};
use std::time::Duration;

use crate::{
    config::Settings,
    error::{AppError, Code},
};

/// code2session 成功结果
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WxSession {
    pub openid: String,
    pub unionid: Option<String>,
    /// 仅服务端保存（sessions.session_key_enc），V1 不解密使用
    pub session_key: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WechatError {
    /// 调用方参数问题（code 缺失/无效/已使用）
    InvalidCode,
    /// 配置问题（appid/secret 不对）
    ConfigRejected,
    /// 微信侧限流
    RateLimited,
    /// 微信系统忙/网络失败
    UpstreamUnavailable,
    /// 响应无法解析
    BadResponse,
}

impl WechatError {
    /// 映射为对外错误（不含微信原文）
    pub fn to_app_error(self) -> AppError {
        match self {
            WechatError::InvalidCode => AppError::new(
                axum::http::StatusCode::UNAUTHORIZED,
                Code::WechatLoginFailed,
            )
            .with_message("登录凭据已失效，请重新进入小程序")
            .with_hint("微信侧一次性 code 只能用一次，稍后会自动重试静默登录"),
            WechatError::ConfigRejected => AppError::new(
                axum::http::StatusCode::BAD_GATEWAY,
                Code::WechatLoginFailed,
            )
            .with_message("登录服务配置有误，暂时无法登录")
            .with_hint("请检查服务端 WECHAT_APPID / WECHAT_APPSECRET"),
            WechatError::RateLimited => AppError::new(
                axum::http::StatusCode::TOO_MANY_REQUESTS,
                Code::QuotaExceeded,
            )
            .with_message("登录请求过于频繁，请稍后再试"),
            WechatError::UpstreamUnavailable => AppError::wechat_login_failed(),
            WechatError::BadResponse => AppError::upstream_unavailable("登录服务响应异常"),
        }
    }

    /// 微信 errcode → 内部错误分类（docs/requirements.md §8.5.4）
    pub fn from_errcode(errcode: i64) -> Self {
        match errcode {
            40029 | 40163 | 40008 => WechatError::InvalidCode, // invalid code / code been used / missing
            40013 | 40125 | 41004 => WechatError::ConfigRejected, // invalid appid / invalid secret / missing secret
            45011 | 35001 => WechatError::RateLimited,        // api msg frequency blocked / unauthorized
            -1 | 42001 | -61 => WechatError::UpstreamUnavailable, // system error / 系统繁忙
            _ => WechatError::BadResponse,
        }
    }

    pub fn message_key(self) -> &'static str {
        match self {
            WechatError::InvalidCode => "invalid_code",
            WechatError::ConfigRejected => "config_rejected",
            WechatError::RateLimited => "rate_limited",
            WechatError::UpstreamUnavailable => "upstream_unavailable",
            WechatError::BadResponse => "bad_response",
        }
    }
}

/// 微信 JSON 响应（`errmsg` 只用于日志分类，不进用户可见文案）
#[derive(Debug, Deserialize, Serialize)]
struct Code2SessionResp {
    #[serde(default)]
    openid: String,
    #[serde(default)]
    session_key: Option<String>,
    #[serde(default)]
    unionid: Option<String>,
    #[serde(default)]
    errcode: i64,
    #[serde(default)]
    #[allow(dead_code)]
    errmsg: String,
}

#[derive(Clone)]
pub struct WechatClient {
    http: reqwest::Client,
    appid: String,
    appsecret: String,
    url: String,
    stub: bool,
    is_prod: bool,
}

impl WechatClient {
    pub fn from_settings(cfg: &Settings) -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(8))
            .connect_timeout(Duration::from_secs(4))
            .user_agent("toolbox-server/0.1")
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self {
            http,
            appid: cfg.wechat_appid.clone(),
            appsecret: cfg.wechat_appsecret().to_string(),
            url: cfg.wechat_code2session_url.clone(),
            stub: cfg.wechat_stub,
            is_prod: cfg.environment.is_prod(),
        }
    }

    /// 生产环境禁用桩：返回 Err 让调用方（启动逻辑）拒绝启动
    pub fn stub_rejected_in_prod(&self) -> bool {
        self.stub && self.is_prod
    }

    /// `POST /auth/silent` 的实现入口。
    pub async fn code2session(&self, code: &str) -> Result<WxSession, WechatError> {
        let code = code.trim();
        if code.is_empty() {
            return Err(WechatError::InvalidCode);
        }
        if self.stub {
            // ⚠️ 仅开发：不访问微信。openid 由 code 稳定派生（同 code 同用户，便于联调）。
            if self.is_prod {
                return Err(WechatError::ConfigRejected);
            }
            tracing::warn!(
                "WECHAT_STUB=1 → 使用本地派生 openid（仅开发用，禁止在生产开启）"
            );
            return Ok(WxSession {
                openid: stub_openid(code),
                unionid: None,
                session_key: None,
            });
        }

        let resp = self
            .http
            .get(&self.url)
            .query(&[
                ("appid", self.appid.as_str()),
                ("secret", self.appsecret.as_str()),
                ("js_code", code),
                ("grant_type", "authorization_code"),
            ])
            .send()
            .await
            .map_err(|err| {
                tracing::warn!(error = %err, "wechat code2session network failure");
                WechatError::UpstreamUnavailable
            })?;

        let status = resp.status();
        let body: Code2SessionResp = resp
            .json()
            .await
            .map_err(|err| {
                tracing::warn!(%status, error = %err, "wechat code2session unparsable response");
                WechatError::BadResponse
            })?;

        if body.errcode != 0 {
            // 只记录 errcode，不记录 errmsg 原文（防泄漏 & 防日志注入）
            tracing::warn!(errcode = body.errcode, "wechat code2session rejected");
            return Err(WechatError::from_errcode(body.errcode));
        }
        if body.openid.trim().is_empty() {
            return Err(WechatError::BadResponse);
        }
        Ok(WxSession {
            openid: body.openid,
            unionid: body.unionid.filter(|u| !u.trim().is_empty()),
            session_key: body.session_key.filter(|s| !s.trim().is_empty()),
        })
    }
}

/// 桩 openid：`stubdev_` + sha256(code) 前 32 hex。
/// 前缀便于「一眼识别假用户」，也避免与真实 openid（28 位 base64 风格）混淆。
pub fn stub_openid(code: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(code.as_bytes());
    let digest = hasher.finalize();
    let mut hex = String::new();
    for b in digest.iter().take(16) {
        hex.push_str(&format!("{b:02x}"));
    }
    format!("stubdev_{hex}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn errcode_mapping_covers_common_cases() {
        assert_eq!(WechatError::from_errcode(40029), WechatError::InvalidCode);
        assert_eq!(WechatError::from_errcode(40163), WechatError::InvalidCode);
        assert_eq!(WechatError::from_errcode(40013), WechatError::ConfigRejected);
        assert_eq!(WechatError::from_errcode(40125), WechatError::ConfigRejected);
        assert_eq!(WechatError::from_errcode(45011), WechatError::RateLimited);
        assert_eq!(WechatError::from_errcode(-1), WechatError::UpstreamUnavailable);
        assert_eq!(WechatError::from_errcode(999999), WechatError::BadResponse);
    }

    #[test]
    fn mapped_errors_never_contain_wechat_raw_text() {
        // 对外文案必须是中文可读，且不含 errmsg
        for e in [
            WechatError::InvalidCode,
            WechatError::ConfigRejected,
            WechatError::RateLimited,
            WechatError::UpstreamUnavailable,
            WechatError::BadResponse,
        ] {
            let app = e.to_app_error();
            assert!(!app.message.is_empty());
            assert!(!app.message.contains("errmsg"));
            assert!(!app.message.contains("weixin"));
            assert!(
                app.code == Code::WechatLoginFailed
                    || app.code == Code::QuotaExceeded
                    || app.code == Code::UpstreamUnavailable,
                "unexpected code {:?}",
                app.code
            );
        }
    }

    #[test]
    fn stub_openid_is_stable_and_prefixed() {
        let a = stub_openid("code-abc");
        let b = stub_openid("code-abc");
        assert_eq!(a, b);
        assert_ne!(a, stub_openid("code-abd"));
        assert!(a.starts_with("stubdev_"));
        assert_eq!(a.len(), "stubdev_".len() + 32);
    }

    #[test]
    fn empty_code_is_invalid() {
        let mut cfg = Settings::for_tests();
        cfg.wechat_stub = true;
        let client = WechatClient::from_settings(&cfg);
        let err = futures_block(client.code2session("   "));
        assert_eq!(err, Err(WechatError::InvalidCode));
    }

    #[test]
    fn stub_mode_returns_derived_openid() {
        let mut cfg = Settings::for_tests();
        cfg.wechat_stub = true;
        cfg.environment = crate::config::Environment::Dev;
        let client = WechatClient::from_settings(&cfg);
        let sess = futures_block(client.code2session("the-code")).unwrap();
        assert_eq!(sess.openid, stub_openid("the-code"));
        assert!(sess.session_key.is_none());
        assert!(!client.stub_rejected_in_prod());
    }

    #[test]
    fn stub_is_refused_in_prod() {
        let mut cfg = Settings::for_tests();
        cfg.wechat_stub = true;
        cfg.environment = crate::config::Environment::Prod;
        let client = WechatClient::from_settings(&cfg);
        assert!(client.stub_rejected_in_prod());
        assert_eq!(
            futures_block(client.code2session("x")),
            Err(WechatError::ConfigRejected)
        );
    }

    /// 极简 futures executor（避免为 4 个单测引入 tokio-test/async-std）
    fn futures_block<F: std::future::Future>(fut: F) -> F::Output {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        rt.block_on(fut)
    }
}
