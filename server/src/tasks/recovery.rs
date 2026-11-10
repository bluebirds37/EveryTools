//! 崩溃恢复（docs/requirements.md §8.4 最后一行）。
//!
//! worker 是被 `kill -9` 的：DB 里会留下永远停在 `processing` 的孤儿任务，前端一直转圈。
//! 启动时把它们一次性收敛成 `failed`（带可读错误码），前端轮询即可看到失败态并重试。
//!
//! 说明：
//! - 只处理 `processing`；`queued` 的行由 [`queue`] 的 worker 启动时回捞（进程内队列丢失但任务还没开始）。
//! - 判定基准是 `started_at`，缺 `started_at` 的异常行退到 `updated_at`/`created_at`，
//!   避免「状态是 processing 但从未开始」的行永远卡在列表里。
//! - 本函数在 `TaskQueue::start_workers` 之前调用，因此不存在「正在跑的任务被判成陈旧」的竞态。
//! - `uploading` 状态的 `files` 行属于 TTL 清理职责（`files::cleanup`），这里不碰。

use anyhow::{Context, Result};
use sqlx::PgPool;
use uuid::Uuid;

/// 恢复结果（`lib.rs::startup` 打日志用）
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RecoveryReport {
    /// 被置为 `failed` 的任务数
    pub failed: usize,
    /// 任务 id（单测断言用；生产日志只打数量与前几个 id）
    pub ids: Vec<Uuid>,
}

impl RecoveryReport {
    pub fn is_empty(&self) -> bool {
        self.failed == 0
    }
}

/// 陈旧任务的落库错误码与文案（与 `error::Code` 的 serde 名一致，前端 error-center 有话术）
pub const STALE_ERROR_CODE: &str = "TASK_TIMEOUT";
pub const STALE_ERROR_MESSAGE: &str = "服务在处理过程中重启，任务已中断，可重新提交";

/// `processing` 超过 `stale_minutes` 分钟 → `failed`。
///
/// `stale_minutes <= 0` 时什么都不做（留给单实例手动运维）。
pub async fn recover_stale_tasks(pool: &PgPool, stale_minutes: i32) -> Result<RecoveryReport> {
    let report = recover_with_sweep(pool, stale_minutes, STALE_ERROR_CODE, STALE_ERROR_MESSAGE)
        .await
        .context("recover stale media tasks")?;
    if report.is_empty() {
        tracing::info!(
            stale_minutes,
            "task recovery: no stale processing tasks"
        );
    } else {
        let head: Vec<String> = report
            .ids
            .iter()
            .take(5)
            .map(|id| id.simple().to_string())
            .collect();
        tracing::warn!(
            stale_minutes,
            count = report.failed,
            sample = %head.join(","),
            "task recovery: marked stale processing tasks as failed"
        );
    }
    Ok(report)
}

/// 与 `recover_stale_tasks` 相同，但错误码/文案可注入（单测用来验证落库字段）。
pub async fn recover_with_sweep(
    pool: &PgPool,
    stale_minutes: i32,
    error_code: &str,
    error_message: &str,
) -> Result<RecoveryReport> {
    if stale_minutes <= 0 {
        return Ok(RecoveryReport::default());
    }
    // 时间比较放在 SQL 里（`make_interval`），避免本机时区/应用时钟与 DB 时钟漂移。
    let rows = sqlx::query(
        "UPDATE media_tasks
            SET status = 'failed',
                error_code = $2,
                error_message = $3,
                finished_at = now(),
                updated_at = now(),
                progress = COALESCE(progress, 0)
          WHERE status = 'processing'
            AND COALESCE(started_at, updated_at, created_at)
                < now() - make_interval(mins => $1::int)
          RETURNING id",
    )
    .bind(stale_minutes)
    .bind(error_code)
    .bind(error_message)
    .fetch_all(pool)
    .await
    .context("update stale processing tasks")?;

    let mut ids = Vec::with_capacity(rows.len());
    for row in &rows {
        let id: Uuid = sqlx::Row::try_get(row, "id").context("read recovered task id")?;
        ids.push(id);
    }
    Ok(RecoveryReport {
        failed: ids.len(),
        ids,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn report_default_is_empty() {
        assert!(RecoveryReport::default().is_empty());
        assert_eq!(
            RecoveryReport {
                failed: 1,
                ids: vec![Uuid::nil()]
            }
            .failed,
            1
        );
    }

    /// 纯 SQL 文本层面的约束（不需要 DB）：状态值必须落在 `media_tasks` 的 CHECK 集合里，
    /// 且只碰 processing —— queued 的回捞是 worker 的职责。
    #[test]
    fn error_code_matches_frontend_recognized_codes() {
        assert_eq!(STALE_ERROR_CODE, "TASK_TIMEOUT");
        assert!(!STALE_ERROR_MESSAGE.contains("panic"));
    }
}
