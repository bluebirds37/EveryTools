//! Access token（JWT，HS256）。requirements §8.1 / §6.2：
//! - `appsecret`/`JWT_SECRET` 只存服务端、env 注入；
//! - 前端不感知 openid：JWT 里只放内部 `user_id`（sub）与 `session_id`。

use chrono::{DateTime, Utc};
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation, decode, encode};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::{AppError, Code};

pub const ISSUER: &str = "toolbox-server";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Claims {
    /// 内部 user id（字符串形式，兼容 future 非数字 id）
    pub sub: String,
    pub uid: i64,
    /// sessions.id
    pub sid: Uuid,
    /// "access"（refresh token 不是 JWT，只存 hash）
    pub kind: String,
    pub iat: i64,
    pub exp: i64,
    pub iss: String,
    pub aud: String,
}

impl Claims {
    pub fn expires_at(&self) -> DateTime<Utc> {
        DateTime::<Utc>::from_timestamp(self.exp, 0).unwrap_or_else(Utc::now)
    }
    pub fn is_expired_at(&self, now: i64) -> bool {
        self.exp <= now
    }
}

/// 签发 access token。`ttl_secs` 默认 7200（ACCESS_TTL）。
pub fn issue_access(
    secret: &str,
    user_id: i64,
    session_id: Uuid,
    audience: &str,
    ttl_secs: i64,
) -> Result<(String, i64), AppError> {
    let now = Utc::now().timestamp();
    let exp = now + ttl_secs;
    let claims = Claims {
        sub: user_id.to_string(),
        uid: user_id,
        sid: session_id,
        kind: "access".into(),
        iat: now,
        exp,
        iss: ISSUER.into(),
        aud: audience.to_string(),
    };
    let token = encode(
        &Header::new(Algorithm::HS256),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .map_err(|e| AppError::internal(anyhow::anyhow!(e)))?;
    Ok((token, exp))
}

/// 校验 access token。错误映射为契约里的 `TOKEN_EXPIRED` / `TOKEN_INVALID`
/// （前端 request.js 见到 401 会自动用 refresh 续期并重试一次）。
pub fn verify_access(secret: &str, audience: &str, token: &str) -> Result<Claims, AppError> {
    let mut validation = Validation::new(Algorithm::HS256);
    validation.set_issuer(&[ISSUER]);
    validation.set_audience(&[audience]);
    validation.leeway = 5;
    // exp/iat 由 jsonwebtoken 自动校验
    let data = decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &validation,
    )
    .map_err(|err| match err.kind() {
        // jsonwebtoken 11: `Error::kind()` 是方法（返回 &ErrorKind）
        jsonwebtoken::errors::ErrorKind::ExpiredSignature => {
            AppError::token(Code::TokenExpired)
        }
        _ => AppError::token(Code::TokenInvalid),
    })?;
    let claims = data.claims;
    if claims.kind != "access" {
        return Err(AppError::token(Code::TokenInvalid).with_hint("kind 必须是 access"));
    }
    Ok(claims)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "unit-test-secret-0123456789abcdef-0123456789abcdef";
    const AUD: &str = "wx0000000000000000";

    fn sample(ttl: i64) -> (String, Uuid) {
        let sid = Uuid::new_v4();
        let (token, _exp) = issue_access(SECRET, 42, sid, AUD, ttl).unwrap();
        (token, sid)
    }

    #[test]
    fn issue_then_verify_roundtrip() {
        let (token, sid) = sample(7200);
        let claims = verify_access(SECRET, AUD, &token).expect("valid token must verify");
        assert_eq!(claims.uid, 42);
        assert_eq!(claims.sid, sid);
        assert_eq!(claims.sub, "42");
        assert_eq!(claims.kind, "access");
        assert!(claims.exp > Utc::now().timestamp());
    }

    #[test]
    fn expired_token_maps_token_expired() {
        // ttl = -60 → 已过期（leeway 5s 内仍拒绝）
        let (token, _) = sample(-60);
        let err = verify_access(SECRET, AUD, &token).unwrap_err();
        assert_eq!(err.code, Code::TokenExpired);
        assert_eq!(err.status.as_u16(), 401);
    }

    #[test]
    fn wrong_secret_is_rejected() {
        let (token, _) = sample(7200);
        let err = verify_access("another-secret-that-is-long-enough-0123456789", AUD, &token)
            .unwrap_err();
        assert_eq!(err.code, Code::TokenInvalid);
    }

    #[test]
    fn tampered_payload_is_rejected() {
        let (token, _) = sample(7200);
        let parts: Vec<&str> = token.split('.').collect();
        assert_eq!(parts.len(), 3);
        // 篡改 signature 最后一个字符
        let mut sig = parts[2].to_string();
        let last = sig.pop().unwrap();
        let replaced = if last == 'a' { 'b' } else { 'a' };
        sig.push(replaced);
        let bad = format!("{}.{sig}", parts[0]);
        let _ = bad; // 结构断言：header.payload 两段本身可解码但签名必失败
        let err = verify_access(SECRET, AUD, &format!("{}.{}.{}", parts[0], parts[1], sig)).unwrap_err();
        assert_eq!(err.code, Code::TokenInvalid);
    }

    #[test]
    fn audience_mismatch_is_rejected() {
        let (token, _) = sample(7200);
        let err = verify_access(SECRET, "wxOtherAppId", &token).unwrap_err();
        assert_eq!(err.code, Code::TokenInvalid);
    }

    #[test]
    fn non_jwt_garbage_is_rejected() {
        let err = verify_access(SECRET, AUD, "not.a.jwt").unwrap_err();
        assert_eq!(err.code, Code::TokenInvalid);
    }

    #[test]
    fn claims_expires_at_and_flag() {
        let (token, _) = sample(100);
        let claims = verify_access(SECRET, AUD, &token).unwrap();
        assert!(!claims.is_expired_at(claims.iat + 50));
        assert!(claims.is_expired_at(claims.exp));
        assert!(claims.expires_at() > Utc::now());
    }
}
