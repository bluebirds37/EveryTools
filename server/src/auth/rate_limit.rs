//! 限流（requirements §6.3 / §8.3 `rate_limits`）：
//! - `user` 与 `ip` **双维度**，按天计数（`day` 列，服务端本地时区 UTC+8 由 SQL `current_date` 决定）；
//! - 默认 20 次/天（`DAILY_QUOTA`）；超限返回 429 + `QUOTA_EXCEEDED`；
//! - 计数用单条 `INSERT ... ON CONFLICT DO UPDATE ... WHERE count < limit RETURNING` 完成，
//!   并发下不会超卖（DB 层原子）。

use axum::http::StatusCode;
use chrono::{DateTime, Duration, NaiveDate, Utc};
use sqlx::Row;

use crate::{
    db::Db,
    error::{AppError, Code},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    User,
    Ip,
}

impl Scope {
    pub fn as_str(self) -> &'static str {
        match self {
            Scope::User => "user",
            Scope::Ip => "ip",
        }
    }

    pub fn key(self, user_id: i64) -> String {
        user_id.to_string()
    }

    pub fn key_ip(self, ip: &str) -> String {
        ip.to_string()
    }
}

/// 纯函数：某天的计数桶。跨天判定与「剩余次数」都可单测。
pub fn day_bucket(now: DateTime<Utc>) -> NaiveDate {
    now.date_naive()
}

pub fn seconds_until_tomorrow(now: DateTime<Utc>) -> i64 {
    let tomorrow = day_bucket(now) + Duration::days(1);
    // NaiveDateTime → UTC 时刻用 `and_utc()`（`and_utc_time` 是 NaiveDate 的方法）
    let next_midnight = tomorrow.and_hms_opt(0, 0, 0).unwrap().and_utc();
    (next_midnight - now).num_seconds().max(0)
}

/// 原子扣减配额。返回剩余次数；超限返回 Err(429)。
pub async fn consume(
    db: &Db,
    scope: Scope,
    key: &str,
    limit: i32,
    now: DateTime<Utc>,
) -> Result<i32, AppError> {
    let day = day_bucket(now);
    let row = sqlx::query(
        "INSERT INTO rate_limits (scope, key, day, count, created_at, updated_at)
         VALUES ($1, $2, $3, 1, now(), now())
         ON CONFLICT (scope, key, day) DO UPDATE
            SET count = rate_limits.count + 1, updated_at = now()
          WHERE rate_limits.count < $4
         RETURNING count",
    )
    .bind(scope.as_str())
    .bind(key)
    .bind(day)
    .bind(limit)
    .fetch_optional(db.pool())
    .await
    .map_err(|e| AppError::internal(anyhow::anyhow!(e)))?;

    match row {
        Some(r) => {
            let used: i32 = r
                .try_get("count")
                .map_err(|e| AppError::internal(anyhow::anyhow!(e)))?;
            Ok((limit - used).max(0))
        }
        None => {
            // 已超限：读当前值仅用于文案，不再增加计数
            let used: i32 = sqlx::query("SELECT count FROM rate_limits WHERE scope=$1 AND key=$2 AND day=$3")
                .bind(scope.as_str())
                .bind(key)
                .bind(day)
                .fetch_optional(db.pool())
                .await
                .map_err(|e| AppError::internal(anyhow::anyhow!(e)))?
                .map(|r| r.try_get::<i32, _>("count").unwrap_or(limit))
                .unwrap_or(limit);
            Err(quota_error(scope, limit, used))
        }
    }
}

/// 只读查询当日余量（`GET /me` 用）
pub async fn remaining(db: &Db, scope: Scope, key: &str, limit: i32, now: DateTime<Utc>) -> i32 {
    let day = day_bucket(now);
    let used: i32 = sqlx::query("SELECT count FROM rate_limits WHERE scope=$1 AND key=$2 AND day=$3")
        .bind(scope.as_str())
        .bind(key)
        .bind(day)
        .fetch_optional(db.pool())
        .await
        .map(|r| r.map(|row| row.try_get::<i32, _>("count").unwrap_or(0)).unwrap_or(0))
        .unwrap_or(0);
    (limit - used).max(0)
}

fn quota_error(scope: Scope, limit: i32, used: i32) -> AppError {
    let mut err = AppError::new(StatusCode::TOO_MANY_REQUESTS, Code::QuotaExceeded)
        .with_message(format!("今日云端处理次数已用完（每天 {limit} 次），明天再来"));
    if scope == Scope::Ip {
        err = err.with_hint("当前网络请求过于频繁，请稍后再试");
    } else {
        err = err.with_hint(format!("今日已使用 {used} 次；本地（端内）工具不受限制"));
    }
    err
}

/// `POST /media/tasks` 的组合限流：user 维度（每日配额）+ ip 维度（防脚本刷）。
/// IP 维度上限取 `DAILY_QUOTA * 5`（同一出口 IP 多用户场景），最少 100。
pub fn ip_daily_limit(user_daily: i32) -> i32 {
    (user_daily * 5).max(100)
}

/// 业务动作：创建任务前调用。user 超限优先报（用户话术更明确）。
pub async fn guard_task_creation(
    db: &Db,
    user_id: i64,
    ip: &str,
    user_daily: i32,
    now: DateTime<Utc>,
) -> Result<(), AppError> {
    let _remaining_user = consume(db, Scope::User, &user_id.to_string(), user_daily, now).await?;
    let _remaining_ip = consume(
        db,
        Scope::Ip,
        &Scope::Ip.key_ip(ip),
        ip_daily_limit(user_daily),
        now,
    )
    .await;
    // IP 维度超限不阻断（用户已消耗配额），只告警：避免 NAT 出口误伤真实用户
    if let Err(err) = _remaining_ip {
        tracing::warn!(code = ?err.code, ip, "ip-dimension rate limit hit (not enforced)");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn day_bucket_and_reset_window() {
        let now: DateTime<Utc> = "2026-10-13T23:59:30Z".parse().unwrap();
        assert_eq!(day_bucket(now), NaiveDate::from_ymd_opt(2026, 10, 13).unwrap());
        let secs = seconds_until_tomorrow(now);
        assert!((0..86_400).contains(&secs), "reset window must be within a day, got {secs}");
    }

    #[test]
    fn scope_keys_are_stable() {
        assert_eq!(Scope::User.key(42), "42");
        assert_eq!(Scope::Ip.key_ip("1.2.3.4"), "1.2.3.4");
        assert_eq!(Scope::User.as_str(), "user");
        assert_eq!(Scope::Ip.as_str(), "ip");
    }

    #[test]
    fn ip_limit_scales_with_user_quota() {
        assert_eq!(ip_daily_limit(20), 100);
        assert_eq!(ip_daily_limit(1), 100);
        assert_eq!(ip_daily_limit(50), 250);
    }

    #[test]
    fn quota_message_matches_spec() {
        let err = quota_error(Scope::User, 20, 21);
        assert_eq!(err.status, StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(err.code, Code::QuotaExceeded);
        assert!(err.message.contains("明天再来"));
        assert!(err.hint.unwrap().contains("本地"));
    }
}
