//! TTL 清理定时任务（requirements §8.4：到期物理删除；§8.5.8 用户自助清除）。
//!
//! 每 `CLEANUP_INTERVAL_SECS`（默认 300s）扫描一次：
//! 1. `files.status IN ('ready','uploading') AND expires_at <= now()` → 删磁盘 blob，置 `expired`；
//! 2. `status='expired'` 超过 1 天 → 置 `deleted`（软删保留审计行）；
//! 3. 残留分片目录（`incoming/<id>`，DB 记录已 ready/expired）→ 删除；
//! 4. `sessions.expires_at <= now()` 与过期 `rate_limits`（>2 天）→ 清理，防表膨胀。

use std::time::Duration;

use crate::{
    config::Settings, db::Db, error::AppError, files::Storage,
};

pub fn spawn_ttl_task(db: Db, storage: std::sync::Arc<Storage>, cfg: &Settings) {
    let every = Duration::from_secs(cfg.cleanup_interval_secs.max(30));
    // upload_session_ttl_secs 是 i64（env/config 解析），`.max(60)` 已保证为正再转 u64
    let stale_upload = Duration::from_secs(cfg.upload_session_ttl_secs.max(60) as u64);
    let batch = 200i64;

    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(every);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            ticker.tick().await;
            match sweep(&db, &storage, stale_upload, batch).await {
                Ok(report) => {
                    if !report.is_empty() {
                        // SweepReport 不是 tracing::Value：拆成结构化字段记录
                        tracing::info!(
                            expired_files = report.expired_files,
                            purged_files = report.purged_files,
                            stale_uploads = report.stale_uploads,
                            dropped_sessions = report.dropped_sessions,
                            dropped_rate_limits = report.dropped_rate_limits,
                            "ttl cleanup swept"
                        );
                    }
                }
                Err(err) => tracing::warn!(error = ?err, code = ?err.code, "ttl cleanup failed"),
            }
        }
    });
}

#[derive(Debug, Default)]
pub struct SweepReport {
    pub expired_files: usize,
    pub purged_files: usize,
    pub stale_uploads: usize,
    pub dropped_sessions: i64,
    pub dropped_rate_limits: i64,
}

impl SweepReport {
    pub fn is_empty(&self) -> bool {
        self.expired_files == 0
            && self.purged_files == 0
            && self.stale_uploads == 0
            && self.dropped_sessions == 0
            && self.dropped_rate_limits == 0
    }
}

pub async fn sweep(
    db: &Db,
    storage: &Storage,
    stale_upload_after: Duration,
    batch: i64,
) -> Result<SweepReport, AppError> {
    let mut report = SweepReport::default();

    // 1) 过期文件：删 blob + 置 expired
    let rows = crate::files::list_expired(db, batch).await?;
    for f in rows {
        if let Err(err) = storage.remove_blob(&f.storage_key).await {
            tracing::warn!(file_id = %f.id, error = ?err, "remove expired blob failed");
        }
        crate::files::mark_status(db, f.id, "expired").await?;
        report.expired_files += 1;
    }

    // 2) expired → deleted（保留行做审计，物理文件已消失）
    let purged = sqlx::query(
        "UPDATE files SET status='deleted', updated_at=now()
          WHERE status='expired' AND updated_at < now() - interval '1 day'",
    )
    .execute(db.pool())
    .await
    .map_err(|e| AppError::internal(anyhow::anyhow!(e)))?;
    report.purged_files = purged.rows_affected() as usize;

    // 3) 上传超时未完成：置 expired（前端可重新 init）
    let stale = sqlx::query(
        "UPDATE files SET status='expired', expires_at=now(), updated_at=now()
          WHERE status='uploading' AND created_at < now() - ($1 || ' seconds')::interval",
    )
    .bind(format!("{}", stale_upload_after.as_secs()))
    .execute(db.pool())
    .await
    .map_err(|e| AppError::internal(anyhow::anyhow!(e)))?;
    report.stale_uploads = stale.rows_affected() as usize;

    // 4) sessions / rate_limits 表膨胀控制
    let sess = sqlx::query("DELETE FROM sessions WHERE expires_at <= now()")
        .execute(db.pool())
        .await
        .map_err(|e| AppError::internal(anyhow::anyhow!(e)))?;
    report.dropped_sessions = sess.rows_affected() as i64;

    let rl = sqlx::query("DELETE FROM rate_limits WHERE day < current_date - 2")
        .execute(db.pool())
        .await
        .map_err(|e| AppError::internal(anyhow::anyhow!(e)))?;
    report.dropped_rate_limits = rl.rows_affected() as i64;

    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_report_detection() {
        assert!(SweepReport::default().is_empty());
        let r = SweepReport {
            expired_files: 1,
            ..Default::default()
        };
        assert!(!r.is_empty());
    }
}
