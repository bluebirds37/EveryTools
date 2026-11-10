//! 鉴权：静默登录的用户/会话仓储 + Bearer 认证 extractor + 限流。

pub mod jwt;
pub mod rate_limit;
pub mod refresh;
pub mod wechat;

use axum::{
    extract::FromRequestParts,
    http::{HeaderMap, StatusCode, header::AUTHORIZATION, request::Parts},
};
use chrono::{DateTime, Utc};
use sqlx::Row;
use uuid::Uuid;

use crate::{
    error::{AppError, Code},
    state::AppState,
};

/// 已通过 access token 的用户
#[derive(Debug, Clone)]
pub struct AuthUser {
    pub user_id: i64,
    pub session_id: Uuid,
}

impl AuthUser {
    pub fn key(&self) -> String {
        format!("user:{}", self.user_id)
    }
}

/// 必需登录：所有写接口用它（游客只允许 GET /tools/flags、/healthz、/static/*）
pub struct RequiredAuth(pub AuthUser);

impl FromRequestParts<AppState> for RequiredAuth {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let token = bearer_token(&parts.headers).ok_or_else(AppError::auth_required)?;
        // aud = 配置的 appid；桩模式下用固定值，避免开发期换 appid 就全 403
        let aud = audience(state);
        let claims = jwt::verify_access(state.settings.jwt_secret(), &aud, token)?;
        Ok(Self(AuthUser {
            user_id: claims.uid,
            session_id: claims.sid,
        }))
    }
}

/// 可选登录：GET 类接口用于按用户维度过滤/统计
pub struct MaybeAuth(pub Option<AuthUser>);

impl FromRequestParts<AppState> for MaybeAuth {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        match bearer_token(&parts.headers) {
            None => Ok(Self(None)),
            Some(token) => {
                let aud = audience(state);
                let claims = jwt::verify_access(state.settings.jwt_secret(), &aud, token)?;
                Ok(Self(Some(AuthUser {
                    user_id: claims.uid,
                    session_id: claims.sid,
                })))
            }
        }
    }
}

fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|raw| raw.split_once(' '))
        .and_then(|(scheme, rest)| {
            if scheme.eq_ignore_ascii_case("bearer") && !rest.trim().is_empty() {
                Some(rest.trim())
            } else {
                None
            }
        })
}

pub fn audience(state: &AppState) -> String {
    if state.settings.wechat_stub {
        "toolbox-dev-aud".to_string()
    } else {
        state.settings.wechat_appid.clone()
    }
}

// ---------------------------------------------------------------------------
// users / sessions 仓储
// ---------------------------------------------------------------------------

/// 静默登录：按 openid upsert 用户，返回 (user_id, is_new)
pub async fn upsert_user_by_openid(
    db: &crate::db::Db,
    openid: &str,
    unionid: Option<&str>,
) -> Result<(i64, bool), AppError> {
    let row = sqlx::query(
        "INSERT INTO users (openid, unionid, status, created_at, updated_at, last_login_at)
         VALUES ($1, $2, 1, now(), now(), now())
         ON CONFLICT (openid) DO UPDATE
            SET unionid      = COALESCE(EXCLUDED.unionid, users.unionid),
                last_login_at = now(),
                updated_at    = now()
         RETURNING id, (xmax = 0) AS is_new",
    )
    .bind(openid)
    .bind(unionid)
    .fetch_one(db.pool())
    .await
    .map_err(|e| AppError::internal(anyhow::anyhow!(e)))?;

    let user_id: i64 = row.try_get("id").map_err(|e| AppError::internal(anyhow::anyhow!(e)))?;
    let is_new: bool = row
        .try_get("is_new")
        .map_err(|e| AppError::internal(anyhow::anyhow!(e)))?;
    Ok((user_id, is_new))
}

/// 创建会话：refresh token 只存 hash；session_key 存 bytea（V1 不做加解密算法，
/// 列类型为 bytea 以便后续接入 KMS；不落明文日志）。
pub async fn create_session(
    db: &crate::db::Db,
    user_id: i64,
    refresh_token: &str,
    session_key: Option<&str>,
    device_info: serde_json::Value,
    ttl_secs: i64,
) -> Result<Uuid, AppError> {
    let session_id = Uuid::new_v4();
    let hash = refresh::hash_refresh_token(refresh_token);
    let expires_at = Utc::now() + chrono::Duration::seconds(ttl_secs);
    let enc: Option<Vec<u8>> = session_key.map(|s| s.as_bytes().to_vec());

    sqlx::query(
        "INSERT INTO sessions (id, user_id, refresh_token_hash, session_key_enc, device_info, expires_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, now(), now())",
    )
    .bind(session_id)
    .bind(user_id)
    .bind(&hash)
    .bind(enc)
    .bind(&device_info)
    .bind(expires_at)
    .execute(db.pool())
    .await
    .map_err(|e| AppError::internal(anyhow::anyhow!(e)))?;

    Ok(session_id)
}

/// 用 refresh token 换会话（轮换）：命中且未过期 → 更新 hash 并返回旧记录
pub struct RefreshedSession {
    pub session_id: Uuid,
    pub user_id: i64,
}

pub async fn rotate_session(
    db: &crate::db::Db,
    presented_token: &str,
    new_refresh_token: &str,
    ttl_secs: i64,
) -> Result<RefreshedSession, AppError> {
    let old_hash = refresh::hash_refresh_token(presented_token);
    let new_hash = refresh::hash_refresh_token(new_refresh_token);
    let expires_at = Utc::now() + chrono::Duration::seconds(ttl_secs);

    let row = sqlx::query(
        "UPDATE sessions
            SET refresh_token_hash = $2, expires_at = $3, updated_at = now()
          WHERE id = (
              SELECT id FROM sessions
               WHERE refresh_token_hash = $1 AND expires_at > now()
               FOR UPDATE
          )
          RETURNING id, user_id",
    )
    .bind(&old_hash)
    .bind(&new_hash)
    .bind(expires_at)
    .fetch_optional(db.pool())
    .await
    .map_err(|e| AppError::internal(anyhow::anyhow!(e)))?;

    let row = row.ok_or_else(|| AppError::token(Code::TokenInvalid))?;
    let session_id: Uuid = row
        .try_get("id")
        .map_err(|e| AppError::internal(anyhow::anyhow!(e)))?;
    let user_id: i64 = row
        .try_get("user_id")
        .map_err(|e| AppError::internal(anyhow::anyhow!(e)))?;
    Ok(RefreshedSession {
        session_id,
        user_id,
    })
}

/// 用户概览（`GET /me`）
pub struct UserSummary {
    pub user_id: i64,
    pub created_at: DateTime<Utc>,
    pub last_login_at: Option<DateTime<Utc>>,
    pub status: i16,
}

pub async fn user_summary(db: &crate::db::Db, user_id: i64) -> Result<UserSummary, AppError> {
    let row = sqlx::query(
        "SELECT id, created_at, last_login_at, status FROM users WHERE id = $1",
    )
    .bind(user_id)
    .fetch_optional(db.pool())
    .await
    .map_err(|e| AppError::internal(anyhow::anyhow!(e)))?
    .ok_or_else(AppError::not_found)?;

    Ok(UserSummary {
        user_id: row
            .try_get("id")
            .map_err(|e| AppError::internal(anyhow::anyhow!(e)))?,
        created_at: row
            .try_get("created_at")
            .map_err(|e| AppError::internal(anyhow::anyhow!(e)))?,
        last_login_at: row
            .try_get("last_login_at")
            .map_err(|e| AppError::internal(anyhow::anyhow!(e)))?,
        status: row
            .try_get("status")
            .map_err(|e| AppError::internal(anyhow::anyhow!(e)))?,
    })
}

/// 用户自助清除：软删文件 + 失败任务（requirements §8.5.8）
pub async fn soft_purge_user_data(
    db: &crate::db::Db,
    user_id: i64,
) -> Result<(i64, i64), AppError> {
    let files = sqlx::query(
        "UPDATE files SET status = 'expired', expires_at = now(), updated_at = now()
          WHERE user_id = $1 AND status IN ('ready','uploading')",
    )
    .bind(user_id)
    .execute(db.pool())
    .await
    .map_err(|e| AppError::internal(anyhow::anyhow!(e)))?;

    let tasks = sqlx::query(
        "UPDATE media_tasks SET status = 'canceled', finished_at = now(), updated_at = now(),
                error_code = 'PERMISSION_DENIED', error_message = '用户已清除数据'
          WHERE user_id = $1 AND status IN ('queued','uploading','processing')",
    )
    .bind(user_id)
    .execute(db.pool())
    .await
    .map_err(|e| AppError::internal(anyhow::anyhow!(e)))?;

    Ok((
        files.rows_affected() as i64,
        tasks.rows_affected() as i64,
    ))
}

/// 未登录时 `POST /auth/*` 的公共状态码
pub const LOGIN_UNAVAILABLE: StatusCode = StatusCode::BAD_GATEWAY;

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    #[test]
    fn bearer_parsing_accepts_only_bearer_scheme() {
        let mut headers = HeaderMap::new();
        headers.insert(AUTHORIZATION, HeaderValue::from_static("Bearer abc.def.ghi"));
        assert_eq!(bearer_token(&headers), Some("abc.def.ghi"));

        headers.insert(AUTHORIZATION, HeaderValue::from_static("bearer  xyz "));
        assert_eq!(bearer_token(&headers), Some("xyz"));

        headers.insert(AUTHORIZATION, HeaderValue::from_static("Basic abc"));
        assert_eq!(bearer_token(&headers), None);

        headers.insert(AUTHORIZATION, HeaderValue::from_static("Bearer"));
        assert_eq!(bearer_token(&headers), None);

        headers.insert(AUTHORIZATION, HeaderValue::from_static("Bearer    "));
        assert_eq!(bearer_token(&headers), None);

        headers.remove(AUTHORIZATION);
        assert_eq!(bearer_token(&headers), None);
    }

    #[test]
    fn auth_user_key_shape() {
        let u = AuthUser {
            user_id: 7,
            session_id: Uuid::nil(),
        };
        assert_eq!(u.key(), "user:7");
    }
}
