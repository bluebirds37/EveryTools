//! 异步任务层（docs/requirements.md §8.4）
//!
//! - [`queue`]：进程内 `tokio::sync::mpsc` 队列 + N 个 worker（v1 单实例，多实例接 Redis 留 v2）
//! - [`recovery`]：启动时把 `processing` 超过 N 分钟的任务置 `failed`
//! - 本模块：`media_tasks` 表仓储 + 任务类型清单（前端会提交的 10 个 type）
//!
//! 状态机（与 `migrations/00000000000000__init.sql` 的 CHECK 约束完全一致）：
//! ```text
//! queued → processing → succeeded
//!                     ↘ failed
//!   ↘ canceled（queued/processing 都可被取消）
//! ```
//! 表里没有 `result` 列，因此产物清单写在 `params` 的服务端保留键 `_server` 里
//! （前端参数都是 camelCase、不会以 `_` 开头，不会冲突）；`GET /media/tasks/:id`
//! 读它并**即时签发**一次性下载 token，token 不进数据库（requirements §8.5.6）。

pub mod queue;
pub mod recovery;

use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

use crate::db::{col, col_opt};
use crate::error::{AppError, Code};

/// DB 状态值（media_tasks.status CHECK 约束）
pub mod status {
    pub const QUEUED: &str = "queued";
    pub const PROCESSING: &str = "processing";
    pub const SUCCEEDED: &str = "succeeded";
    pub const FAILED: &str = "failed";
    pub const CANCELED: &str = "canceled";
}

/// 前端 `utils/video-task.js` 的 `STATUS_STAGE` 认得的对外状态名。
/// DB 用 `succeeded`（CHECK 约束），对外必须回 `success`，否则前端会把完成态
/// 误判成「仍在处理」。
pub fn api_status(db_status: &str) -> &'static str {
    match db_status {
        status::SUCCEEDED => "success",
        status::QUEUED => "queued",
        status::PROCESSING => "processing",
        status::FAILED => "failed",
        status::CANCELED => "canceled",
        _ => "queued",
    }
}

/// 对外 `stage`（task-progress 组件用；DB 无该列，由状态推导）
pub fn stage_of(db_status: &str, progress: i16) -> &'static str {
    match db_status {
        status::QUEUED => "queue",
        status::PROCESSING => "process",
        status::SUCCEEDED => "done",
        status::FAILED => "failed",
        status::CANCELED => "canceled",
        _ if progress >= 100 => "done",
        _ => "queue",
    }
}

/// 前端会提交的 10 个 type（C8 `POST /media/tasks`）
pub const TASK_TYPES: &[&str] = &[
    "video-compress",
    "video-clip",
    "video-gif",
    "video-frames",
    "video-probe",
    "video-audio",
    "image-compress",
    "image-convert",
    "image-watermark",
    "image-exif",
];

pub fn is_known_type(t: &str) -> bool {
    TASK_TYPES.contains(&t)
}

/// 未知 type：明确可读的 `PARAM_INVALID`（绝不 panic）
pub fn unknown_type_error(t: &str) -> AppError {
    AppError::param_invalid(
        "type",
        format!("未知任务类型 \"{t}\"，支持：{}", TASK_TYPES.join(", ")),
    )
    .with_hint("type 必须与 docs/CONTRACT.md C8 的任务类型一致")
}

/// `params` 里服务端保留键（产物清单 / 结果文案）
pub const SERVER_PARAMS_KEY: &str = "_server";

#[derive(Debug, Clone)]
pub struct TaskRow {
    pub id: Uuid,
    pub user_id: i64,
    pub tool_id: String,
    pub task_type: String,
    pub status: String,
    pub input_file_id: Option<Uuid>,
    pub output_file_id: Option<Uuid>,
    pub params: Value,
    pub progress: i16,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub engine_used: Option<String>,
    pub cost_ms: Option<i32>,
    pub bytes_in: Option<i64>,
    pub bytes_out: Option<i64>,
    pub created_at: DateTime<Utc>,
    pub started_at: Option<DateTime<Utc>>,
    pub finished_at: Option<DateTime<Utc>>,
}

impl TaskRow {
    pub fn is_terminal(&self) -> bool {
        matches!(
            self.status.as_str(),
            status::SUCCEEDED | status::FAILED | status::CANCELED
        )
    }

    /// 服务端写入的产物清单（`params._server.outputs`）
    pub fn server_outputs(&self) -> Vec<Value> {
        self.params
            .get(SERVER_PARAMS_KEY)
            .and_then(|s| s.get("outputs"))
            .and_then(|o| o.as_array())
            .cloned()
            .unwrap_or_default()
    }

    pub fn server_str(&self, key: &str) -> Option<String> {
        self.params
            .get(SERVER_PARAMS_KEY)
            .and_then(|s| s.get(key))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
    }

    /// 提交给前端的参数（去掉服务端保留键）
    pub fn client_params(&self) -> Value {
        let mut obj = match self.params.as_object().cloned() {
            Some(m) => m,
            None => serde_json::Map::new(),
        };
        obj.remove(SERVER_PARAMS_KEY);
        Value::Object(obj)
    }
}

const TASK_COLS: &str = "id, user_id, tool_id, type, status, input_file_id, output_file_id, \
     params, progress, error_code, error_message, engine_used, cost_ms, bytes_in, bytes_out, \
     created_at, started_at, finished_at";

fn row_to_task(row: &sqlx::postgres::PgRow) -> Result<TaskRow, AppError> {
    Ok(TaskRow {
        id: col(row, "id").map_err(AppError::internal)?,
        user_id: col(row, "user_id").map_err(AppError::internal)?,
        tool_id: col(row, "tool_id").map_err(AppError::internal)?,
        task_type: col(row, "type").map_err(AppError::internal)?,
        status: col(row, "status").map_err(AppError::internal)?,
        input_file_id: col_opt(row, "input_file_id").map_err(AppError::internal)?,
        output_file_id: col_opt(row, "output_file_id").map_err(AppError::internal)?,
        params: col(row, "params").map_err(AppError::internal)?,
        progress: col(row, "progress").map_err(AppError::internal)?,
        error_code: col_opt(row, "error_code").map_err(AppError::internal)?,
        error_message: col_opt(row, "error_message").map_err(AppError::internal)?,
        engine_used: col_opt(row, "engine_used").map_err(AppError::internal)?,
        cost_ms: col_opt(row, "cost_ms").map_err(AppError::internal)?,
        bytes_in: col_opt(row, "bytes_in").map_err(AppError::internal)?,
        bytes_out: col_opt(row, "bytes_out").map_err(AppError::internal)?,
        created_at: col(row, "created_at").map_err(AppError::internal)?,
        started_at: col_opt(row, "started_at").map_err(AppError::internal)?,
        finished_at: col_opt(row, "finished_at").map_err(AppError::internal)?,
    })
}

/// `POST /media/tasks`：入队前先落 DB（status=queued），进程重启还能捞回来。
/// `bytes_in` 直接记输入文件字节数（表里有列，用于统计与前端展示）。
#[allow(clippy::too_many_arguments)]
pub async fn insert(
    pool: &PgPool,
    user_id: i64,
    tool_id: &str,
    task_type: &str,
    params: &Value,
    input_file_id: Option<Uuid>,
    bytes_in: Option<i64>,
) -> Result<Uuid, AppError> {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO media_tasks (id, user_id, tool_id, type, status, input_file_id, params, progress, bytes_in, created_at, updated_at)
         VALUES ($1,$2,$3,$4,'queued',$5,$6,0,$7, now(), now())",
    )
    .bind(id)
    .bind(user_id)
    .bind(tool_id)
    .bind(task_type)
    .bind(input_file_id)
    .bind(params)
    .bind(bytes_in)
    .execute(pool)
    .await
    .map_err(|e| AppError::internal(anyhow::anyhow!(e)))?;
    Ok(id)
}

pub async fn load(pool: &PgPool, id: Uuid) -> Result<Option<TaskRow>, AppError> {
    let sql = format!("SELECT {TASK_COLS} FROM media_tasks WHERE id = $1");
    let row = sqlx::query(&sql)
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(|e| AppError::internal(anyhow::anyhow!(e)))?;
    match row {
        Some(r) => row_to_task(&r).map(Some),
        None => Ok(None),
    }
}

pub async fn list_for_user(
    pool: &PgPool,
    user_id: i64,
    limit: i64,
) -> Result<Vec<TaskRow>, AppError> {
    let sql = format!(
        "SELECT {TASK_COLS} FROM media_tasks WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2"
    );
    let rows = sqlx::query(&sql)
        .bind(user_id)
        .bind(limit)
        .fetch_all(pool)
        .await
        .map_err(|e| AppError::internal(anyhow::anyhow!(e)))?;
    rows.iter().map(row_to_task).collect()
}

/// 启动/入队前捞取待处理任务（崩溃恢复：queued 的行内存队列里已经没有了）
pub async fn queued_ids(pool: &PgPool, limit: i64) -> Result<Vec<Uuid>, AppError> {
    let rows = sqlx::query(
        "SELECT id FROM media_tasks WHERE status = 'queued' ORDER BY created_at LIMIT $1",
    )
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(|e| AppError::internal(anyhow::anyhow!(e)))?;
    rows.iter()
        .map(|r| {
            col::<Uuid>(r, "id").map_err(AppError::internal)
        })
        .collect()
}

/// 该用户当前活跃任务数（并发上限用）
pub async fn active_count_for_user(pool: &PgPool, user_id: i64) -> Result<i64, AppError> {
    let row = sqlx::query(
        "SELECT count(*)::bigint AS n FROM media_tasks WHERE user_id = $1 AND status IN ('queued','processing')",
    )
    .bind(user_id)
    .fetch_one(pool)
    .await
    .map_err(|e| AppError::internal(anyhow::anyhow!(e)))?;
    col::<i64>(&row, "n").map_err(AppError::internal)
}

/// queued → processing（CAS：只有仍在排队的任务才会被认领，取消/重复投递自然失败）
pub async fn claim_processing(pool: &PgPool, id: Uuid) -> Result<bool, AppError> {
    let n = sqlx::query(
        "UPDATE media_tasks SET status='processing', started_at=now(), progress=0, updated_at=now()
          WHERE id=$1 AND status='queued'",
    )
    .bind(id)
    .execute(pool)
    .await
    .map_err(|e| AppError::internal(anyhow::anyhow!(e)))?;
    Ok(n.rows_affected() == 1)
}

pub async fn set_progress(pool: &PgPool, id: Uuid, percent: i16) -> Result<(), AppError> {
    sqlx::query("UPDATE media_tasks SET progress=$2, updated_at=now() WHERE id=$1")
        .bind(id)
        .bind(percent.clamp(0, 100))
        .execute(pool)
        .await
        .map_err(|e| AppError::internal(anyhow::anyhow!(e)))?;
    Ok(())
}

/// 当前 DB 状态（worker 每个阶段检查是否被取消）
pub async fn current_status(pool: &PgPool, id: Uuid) -> Result<Option<String>, AppError> {
    let row = sqlx::query("SELECT status FROM media_tasks WHERE id=$1")
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(|e| AppError::internal(anyhow::anyhow!(e)))?;
    match row {
        Some(r) => col_opt::<String>(&r, "status").map_err(AppError::internal),
        None => Ok(None),
    }
}

/// 成功收尾：产物清单写进 `params._server`（表里没有 result 列，见模块头注释）。
/// SQL 带 `status='processing'` 前置条件，因此已取消的任务不会被完成态覆盖。
#[allow(clippy::too_many_arguments)]
pub async fn succeed(
    pool: &PgPool,
    id: Uuid,
    output_file_id: Option<Uuid>,
    server_meta: &Value,
    bytes_in: i64,
    bytes_out: i64,
    cost_ms: i32,
    engine_used: &str,
) -> Result<(), AppError> {
    let n = sqlx::query(
        "UPDATE media_tasks
            SET status='succeeded', progress=100, output_file_id=$2, engine_used=$3,
                cost_ms=$4, bytes_in=$5, bytes_out=$6, finished_at=now(), updated_at=now(),
                error_code=NULL, error_message=NULL,
                params = params || jsonb_build_object('_server', $7::jsonb)
          WHERE id=$1 AND status='processing'",
    )
    .bind(id)
    .bind(output_file_id)
    .bind(engine_used)
    .bind(cost_ms)
    .bind(bytes_in)
    .bind(bytes_out)
    .bind(server_meta)
    .execute(pool)
    .await
    .map_err(|e| AppError::internal(anyhow::anyhow!(e)))?;
    if n.rows_affected() != 1 {
        tracing::info!(task_id = %id, "task left processing before commit; result dropped");
    }
    Ok(())
}

/// `Code` → 落库字符串（`error_code` 是 varchar，必须与响应的 code 同名）。
/// 直接绑 `Code` 会写进 serde 的 `"` 引号，因此这里显式序列化再去引号。
pub fn code_str(code: Code) -> String {
    serde_json::to_value(code)
        .ok()
        .and_then(|v| v.as_str().map(|s| s.to_string()))
        .unwrap_or_else(|| "TASK_FAILED".to_string())
}

pub async fn fail(
    pool: &PgPool,
    id: Uuid,
    code: Code,
    message: &str,
    cost_ms: i32,
) -> Result<(), AppError> {
    sqlx::query(
        "UPDATE media_tasks SET status='failed', error_code=$2, error_message=$3, cost_ms=$4,
                finished_at=now(), updated_at=now()
          WHERE id=$1 AND status IN ('queued','processing')",
    )
    .bind(id)
    .bind(code_str(code))
    .bind(message)
    .bind(cost_ms)
    .execute(pool)
    .await
    .map_err(|e| AppError::internal(anyhow::anyhow!(e)))?;
    Ok(())
}

/// 取消：queued/processing → canceled。返回最终状态（已终态则原样返回）。
pub async fn cancel(pool: &PgPool, id: Uuid) -> Result<Option<String>, AppError> {
    let n = sqlx::query(
        "UPDATE media_tasks SET status='canceled', finished_at=now(), updated_at=now(),
                error_code=NULL, error_message=NULL
          WHERE id=$1 AND status IN ('queued','processing')",
    )
    .bind(id)
    .execute(pool)
    .await
    .map_err(|e| AppError::internal(anyhow::anyhow!(e)))?;
    if n.rows_affected() == 1 {
        return Ok(Some(status::CANCELED.to_string()));
    }
    current_status(pool, id).await
}

/// 任务状态摘要（列表与详情共用；`result` 由 routes 注入即时签名的下载链接）
pub fn summary(task: &TaskRow) -> Value {
    json!({
        "id": task.id.to_string(),
        "taskId": task.id.to_string(),
        "toolId": task.tool_id,
        "type": task.task_type,
        "status": api_status(&task.status),
        "dbStatus": task.status,
        "stage": stage_of(&task.status, task.progress),
        "progress": task.progress,
        "createdAt": task.created_at.to_rfc3339(),
        "startedAt": task.started_at.map(|t| t.to_rfc3339()),
        "finishedAt": task.finished_at.map(|t| t.to_rfc3339()),
        "costMs": task.cost_ms,
        "engineUsed": task.engine_used,
        "errorCode": task.error_code,
        "errorMessage": task.error_message,
        "bytesIn": task.bytes_in,
        "bytesOut": task.bytes_out,
        "inputFileId": task.input_file_id.map(|i| i.to_string()),
        "params": task.client_params(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_names_match_db_check_constraint() {
        // DB CHECK: queued|uploading|processing|succeeded|failed|canceled
        for s in [
            status::QUEUED,
            status::PROCESSING,
            status::SUCCEEDED,
            status::FAILED,
            status::CANCELED,
        ] {
            assert!([
                "queued", "uploading", "processing", "succeeded", "failed", "canceled"
            ]
            .contains(&s));
        }
    }

    #[test]
    fn succeeded_maps_to_frontend_recognizable_success() {
        // 前端 STATUS_STAGE 里没有 "succeeded"，直接透出会被当成「还在处理」
        assert_eq!(api_status(status::SUCCEEDED), "success");
        assert_eq!(api_status(status::QUEUED), "queued");
        assert_eq!(stage_of(status::SUCCEEDED, 100), "done");
        assert_eq!(stage_of(status::QUEUED, 0), "queue");
        assert_eq!(stage_of(status::PROCESSING, 40), "process");
        assert_eq!(stage_of(status::FAILED, 0), "failed");
        assert_eq!(stage_of(status::CANCELED, 0), "canceled");
    }

    #[test]
    fn all_ten_frontend_types_are_supported() {
        assert_eq!(TASK_TYPES.len(), 10);
        for t in TASK_TYPES {
            assert!(is_known_type(t), "{t}");
        }
        assert!(!is_known_type("video-unknown"));
        let err = unknown_type_error("exe-run");
        assert_eq!(err.code, Code::ParamInvalid);
        assert!(err.message.contains("video-compress"), "{}", err.message);
        assert!(err.message.contains("exe-run"));
    }

    #[test]
    fn error_code_is_plain_string_for_varchar_column() {
        // error_code 是 varchar：绑 serde_json::Value 会在运行期报 encode 错误
        assert_eq!(code_str(Code::QuotaExceeded), "QUOTA_EXCEEDED");
        assert_eq!(code_str(Code::NoAudioStream), "NO_AUDIO_STREAM");
        assert!(!code_str(Code::TaskTimeout).contains('"'));
    }

    #[test]
    fn client_params_hide_server_reserved_key() {
        let mut task = json!({});
        task["x"] = json!(1);
        task[SERVER_PARAMS_KEY] = json!({"outputs": [{"fileId": "u"}]});
        let row = TaskRow {
            id: Uuid::nil(),
            user_id: 1,
            tool_id: "video-compress".into(),
            task_type: "video-compress".into(),
            status: status::SUCCEEDED.into(),
            input_file_id: None,
            output_file_id: None,
            params: task,
            progress: 100,
            error_code: None,
            error_message: None,
            engine_used: Some("ffmpeg".into()),
            cost_ms: Some(12),
            bytes_in: Some(9),
            bytes_out: Some(4),
            created_at: Utc::now(),
            started_at: None,
            finished_at: None,
        };
        assert_eq!(row.server_outputs().len(), 1);
        assert_eq!(row.client_params(), json!({ "x": 1 }));
        assert!(row.is_terminal());
        let s = summary(&row);
        assert_eq!(s["status"], "success");
        assert_eq!(s["stage"], "done");
        assert!(s.get("params").unwrap().get("_server").is_none());
    }
}
