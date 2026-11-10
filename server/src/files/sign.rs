//! 结果下载一次性签名 URL（requirements §8.2 `GET /files/:id/download?token=`、§8.5.6）。
//!
//! token = `base64url(exp_unix).hmac_sha256(secret, "dl|file_id|user_id|exp")`
//! - 绑定 file_id 与 user_id：换文件/换用户必然 403；
//! - 绑定过期时间：默认跟随 `FILE_TTL_HOURS`（24h），过期 403；
//! - **不记录到日志**，不进 `media_tasks` 表。
//!
//! 关于「一次性」：§8.3 的表结构没有给 files 增加 used_at 列，因此这里实现为
//! 「短时效 + 绑定用户」的签名；真正单次消费需要新增列（README 已列为后续动作）。

use base64::{Engine as _, engine::general_purpose::URL_SAFE};
use chrono::{DateTime, Duration, Utc};
use hmac::{Hmac, Mac};
use sha2::Sha256;
use uuid::Uuid;

use crate::error::AppError;

type HmacSha256 = Hmac<Sha256>;

fn canonical(file_id: Uuid, user_id: i64, exp: i64) -> String {
    format!("dl|{}|{user_id}|{exp}", file_id.simple())
}

fn mac(secret: &str, body: &str) -> Result<Vec<u8>, AppError> {
    let mut m = HmacSha256::new_from_slice(secret.as_bytes())
        .map_err(|e| AppError::internal(anyhow::anyhow!(e)))?;
    m.update(body.as_bytes());
    Ok(m.finalize().into_bytes().to_vec())
}

/// 签发下载 token
pub fn issue(secret: &str, file_id: Uuid, user_id: i64, ttl: Duration) -> String {
    let exp = (Utc::now() + ttl).timestamp();
    let sig = mac(secret, &canonical(file_id, user_id, exp)).expect("hmac key valid");
    format!(
        "{}.{}",
        URL_SAFE.encode(exp.to_string()),
        URL_SAFE.encode(sig)
    )
}

/// 校验下载 token（失败统一 403，不区分原因以免侧信道）
pub fn verify(secret: &str, token: &str, file_id: Uuid, user_id: i64, now: DateTime<Utc>) -> Result<(), AppError> {
    let err = || AppError::forbidden("下载链接无效或已过期，请重新获取");
    let (exp_part, sig_part) = token.split_once('.').ok_or_else(err)?;
    let exp_str = URL_SAFE
        .decode(exp_part)
        .map_err(|_| err())?;
    let exp: i64 = String::from_utf8(exp_str).map_err(|_| err())?.parse().map_err(|_| err())?;
    if exp <= now.timestamp() {
        return Err(err());
    }
    let expected = mac(secret, &canonical(file_id, user_id, exp)).map_err(|_| err())?;
    let given = URL_SAFE.decode(sig_part).map_err(|_| err())?;
    if !constant_time_eq(&expected, &given) {
        return Err(err());
    }
    Ok(())
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "unit-test-secret-0123456789abcdef-0123456789abcdef";

    #[test]
    fn issued_token_verifies() {
        let fid = Uuid::new_v4();
        let token = issue(SECRET, fid, 42, Duration::hours(24));
        assert!(verify(SECRET, &token, fid, 42, Utc::now()).is_ok());
    }

    #[test]
    fn token_is_bound_to_file_and_user() {
        let fid = Uuid::new_v4();
        let token = issue(SECRET, fid, 42, Duration::hours(24));
        assert!(verify(SECRET, &token, Uuid::new_v4(), 42, Utc::now()).is_err());
        assert!(verify(SECRET, &token, fid, 43, Utc::now()).is_err());
        assert!(verify("another-secret-long-enough-for-hmac-0123456789", &token, fid, 42, Utc::now()).is_err());
    }

    #[test]
    fn expired_token_is_rejected() {
        let fid = Uuid::new_v4();
        let token = issue(SECRET, fid, 42, Duration::seconds(-1));
        let err = verify(SECRET, &token, fid, 42, Utc::now()).unwrap_err();
        assert_eq!(err.status.as_u16(), 403);
        assert_eq!(err.code, crate::error::Code::PermissionDenied);
    }

    #[test]
    fn tampered_or_garbage_token_is_rejected() {
        let fid = Uuid::new_v4();
        let mut token = issue(SECRET, fid, 42, Duration::hours(24));
        // 翻转签名最后一个字符
        let last = token.pop().unwrap();
        token.push(if last == 'A' { 'B' } else { 'A' });
        assert!(verify(SECRET, &token, fid, 42, Utc::now()).is_err());

        for garbage in ["", "abc", "abc.def", "AAA.BBB.CCC", "."] {
            assert!(verify(SECRET, garbage, fid, 42, Utc::now()).is_err(), "{garbage}");
        }
    }

    #[test]
    fn download_url_shape_for_frontend() {
        let fid = Uuid::parse_str("3f2504e0-4f89-11d3-9a0c-0305e8001000").unwrap();
        let token = issue(SECRET, fid, 7, Duration::hours(24));
        let url = format!("/api/v1/files/{fid}/download?token={token}");
        assert!(url.contains("/files/"));
        assert!(url.contains("/download?token="));
    }
}
