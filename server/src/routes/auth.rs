//! 静默登录与续期（C8 `POST /auth/silent`、`POST /auth/refresh`）。
//!
//! 安全铁律（requirements §8.5.4）：
//! - `openid` / `session_key` **只在服务端**，响应只回内部 `userId`；
//! - 微信/桩失败映射成内部码，绝不回显微信原文；
//! - `WECHAT_APPID/APPSECRET` 未配置时由 `wechat_stub=1` 走本地派生 openid，
//!   `POST /auth/silent` 仍返回真实 JWT 对（access + refresh）。

use axum::{extract::State, Json};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::{
    auth::{
        self,
        jwt,
        refresh::generate_refresh_token,
        wechat::{WechatClient, WechatError},
    },
    error::{ok_data, AppError, OkEnvelope},
    state::AppState,
};

/// `POST /auth/silent {code, appId}`
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SilentReq {
    pub code: String,
    #[serde(default)]
    pub app_id: Option<String>,
}

pub async fn silent(
    State(state): State<AppState>,
    Json(req): Json<SilentReq>,
) -> Result<Json<OkEnvelope<Value>>, AppError> {
    let cfg = state.cfg();
    let client = WechatClient::from_settings(cfg);

    // 生产环境禁止桩：明确拒绝，绝不发出假用户
    if client.stub_rejected_in_prod() {
        return Err(WechatError::ConfigRejected.to_app_error());
    }

    let wx = client.code2session(&req.code).await.map_err(WechatError::to_app_error)?;

    let (user_id, is_new) =
        auth::upsert_user_by_openid(&state.db, &wx.openid, wx.unionid.as_deref()).await?;

    let new_refresh = generate_refresh_token();
    let device_info = json!({
        "appId": req.app_id,
        "env": format!("{:?}", cfg.environment),
    });
    let session_id = auth::create_session(
        &state.db,
        user_id,
        &new_refresh,
        wx.session_key.as_deref(),
        device_info,
        cfg.refresh_token_ttl_secs,
    )
    .await?;

    let (access, _exp) = jwt::issue_access(
        cfg.jwt_secret(),
        user_id,
        session_id,
        &auth::audience(&state),
        cfg.access_token_ttl_secs,
    )?;

    Ok(ok_data(json!({
        "accessToken": access,
        "refreshToken": new_refresh,
        "userId": user_id,
        "isNew": is_new,
    })))
}

/// `POST /auth/refresh {refreshToken}`
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshReq {
    pub refresh_token: String,
}

pub async fn refresh(
    State(state): State<AppState>,
    Json(req): Json<RefreshReq>,
) -> Result<Json<OkEnvelope<Value>>, AppError> {
    let cfg = state.cfg();
    let new_refresh = generate_refresh_token();

    // rotate_session 已把「无效/过期」映射为 TokenInvalid/TokenExpired，直接透传
    let rotated = auth::rotate_session(
        &state.db,
        &req.refresh_token,
        &new_refresh,
        cfg.refresh_token_ttl_secs,
    )
    .await?;

    let (access, _exp) = jwt::issue_access(
        cfg.jwt_secret(),
        rotated.user_id,
        rotated.session_id,
        &auth::audience(&state),
        cfg.access_token_ttl_secs,
    )?;

    Ok(ok_data(json!({
        "accessToken": access,
        "refreshToken": new_refresh,
    })))
}
