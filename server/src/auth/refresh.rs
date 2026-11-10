//! Refresh token：随机串下发给前端，**服务端只存 SHA-256 hash**（requirements §8.5.3）。
//! 每次 `/auth/refresh` 轮换（rotate）：旧 hash 立即失效。

use sha2::{Digest, Sha256};
use uuid::Uuid;

/// 生成 refresh token（不透明随机串，≥256bit）。
///
/// 随机源：`Uuid::new_v4()`（内部使用操作系统 CSPRNG）。
/// 拼接 2 个 v4 = 256bit，再加时间戳做唯一性区分，最后 SHA-256 归一化长度。
pub fn generate_refresh_token() -> String {
    let mut hasher = Sha256::new();
    hasher.update(Uuid::new_v4().as_bytes());
    hasher.update(Uuid::new_v4().as_bytes());
    hasher.update(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos().to_string())
            .unwrap_or_default(),
    );
    hex_lower(&hasher.finalize())
}

/// refresh token 的存储 hash：`sha256(token)`。
/// 额外混入服务端密钥可以防「撞库 rainbow」，但会让 DB 数据无法跨实例迁移，
/// 因此这里用裸 SHA-256（token 本身 256bit 随机，无需盐）。
pub fn hash_refresh_token(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    hex_lower(&hasher.finalize())
}

/// 恒定时间比较（避免 hash 比对的时间侧信道）
pub fn token_hash_matches(token: &str, stored_hash: &str) -> bool {
    let candidate = hash_refresh_token(token);
    constant_time_eq(candidate.as_bytes(), stored_hash.trim().as_bytes())
}

pub fn hex_lower(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(char::from_digit((b >> 4) as u32, 16).unwrap());
        out.push(char::from_digit((b & 0x0f) as u32, 16).unwrap());
    }
    out
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

    #[test]
    fn generated_tokens_are_unique_and_long() {
        let a = generate_refresh_token();
        let b = generate_refresh_token();
        assert_ne!(a, b);
        assert_eq!(a.len(), 64, "sha256 hex");
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn hash_is_stable_and_not_the_token() {
        let token = "deadbeef";
        let h = hash_refresh_token(token);
        assert_eq!(h.len(), 64);
        assert_ne!(h, token);
        assert_eq!(h, hash_refresh_token(token));
        // 已知向量：sha256("abc")
        assert_eq!(
            hash_refresh_token("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn match_and_mismatch() {
        let token = generate_refresh_token();
        let stored = hash_refresh_token(&token);
        assert!(token_hash_matches(&token, &stored));
        assert!(!token_hash_matches(&generate_refresh_token(), &stored));
        assert!(!token_hash_matches(&token, &"0".repeat(64)));
    }
}
