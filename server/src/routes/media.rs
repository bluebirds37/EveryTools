//! 媒体任务 HTTP 层（C8 `POST /media/tasks`、`GET /media/tasks/:id`、
//! `POST /media/tasks/:id/cancel`、`GET /media/tasks`）。
//!
//! 本文件只做「解包 → 复用 [`crate::tasks`] / [`crate::files`] / [`crate::auth`] →
//! 统一响应包」，不含任何编解码算法（那部分在只读的 `tasks::queue` worker 里）。
//!
//! ## 结果 `result` 的来源与形态
//! worker 成功后把产物清单写进 `params._server`（`media_tasks` 没有 result 列，见
//! `tasks` 模块头注释），形如：
//! ```json
//! { "kind": "video", "items": [ {"fileId","label","mime","sizeBytes","name"} | {"key","value"} ],
//!   "sizeMB": 3.2, "outputs": [...], "meta": {...}, "note": "已压到 720p" }
//! ```
//! `GET /media/tasks/:id` 读 `_server` 并**即时签发**一次性下载 token 拼成 C8 的
//! `result:{url,kind,items[],sizeMB,meta}`（token 不进 DB，requirements §8.5.6）。
//!
//! `meta` 形态按前端消费者分两类处理（两套页面读法不同，必须都满足）：
//! - **文件类**（kind=video/image/images/audio：compress/clip/gif/frames/audio/image-*）：
//!   前端 `video-estimate.js::buildMeta` 对 `result.meta` 做 `String(r.meta)`，需要**可读字符串**；
//!   这里把 `_server.note` + `_server.meta` 对象摊平成 `k：v · …` 字符串。
//! - **kv 类**（kind=kv：video-probe/image-exif）：`packageVideo/pages/info` 读
//!   `result.items[]`（{key,value} 行），`packageImage/pages/info::onCloudExif` 读
//!   `Object.keys(result.meta)`（对象）——两者都从 `_server` 原样透出，`meta` 保持**对象**。
//!
//! ## 下载 URL 一律是**相对路径**
//! `url` / `items[].url` 必须是 `/files/{id}/download?token=`（不含 `/api/v1`）：
//! 前端 `env.url()` 会给相对路径统一补 `host + /api/v1`，`resultDownload→downloadToTemp`
//! 内部也调用 `env.url()`，写成绝对或带前缀会导致二次拼接。

use axum::{
    Json,
    extract::{Path, Query, State},
    http::HeaderMap,
};
use chrono::{Duration, Utc};
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::{
    auth::{RequiredAuth, rate_limit},
    error::{AppError, OkEnvelope, ok_data},
    files::{self, sign},
    state::{AppState, client_ip},
    tasks::{self, SERVER_PARAMS_KEY},
};

// ---------------------------------------------------------------------------
// POST /media/tasks
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateReq {
    #[serde(default)]
    tool_id: String,
    #[serde(rename = "type", default)]
    task_type: String,
    #[serde(default)]
    params: Value,
    #[serde(default)]
    file_ids: Vec<String>,
}

pub async fn create(
    auth: RequiredAuth,
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<CreateReq>,
) -> Result<Json<OkEnvelope<Value>>, AppError> {
    let cfg = state.cfg();
    let user_id = auth.0.user_id;

    // type 必须是前端会提交的 10 个已知类型之一，否则明确 4xx（绝不静默入队未知类型）
    if !tasks::is_known_type(&req.task_type) {
        return Err(tasks::unknown_type_error(&req.task_type));
    }

    // 解析输入文件（fileIds[0]）：存在则校验属主 + 就绪，取 size 作为 bytes_in。
    // 缺输入不在这里硬拒——交给 worker 的 load_input 产出可读的 PARAM_INVALID/UPLOAD_INCOMPLETE。
    let mut input_file_id: Option<Uuid> = None;
    let mut bytes_in: Option<i64> = None;
    if let Some(raw) = req.file_ids.first().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        let fid = Uuid::parse_str(raw)
            .map_err(|_| AppError::param_invalid("fileIds", "不是合法的文件 id"))?;
        let record = files::get(&state.db, fid)
            .await?
            .ok_or_else(AppError::not_found)?;
        if record.user_id != user_id {
            return Err(AppError::forbidden("不能引用他人的文件"));
        }
        input_file_id = Some(fid);
        bytes_in = Some(record.size.max(0));
    }

    // 每日配额（user 维度）+ IP 维度软限流（超限返回 429 QUOTA_EXCEEDED）
    rate_limit::guard_task_creation(
        &state.db,
        user_id,
        &client_ip(&headers),
        cfg.daily_quota,
        Utc::now(),
    )
    .await?;

    // 并发上限：queued/processing 达上限则拒绝新建（429 CONCURRENT_TASK_LIMIT）
    let active = tasks::active_count_for_user(state.db.pool(), user_id).await?;
    if active >= cfg.max_concurrent_tasks_per_user as i64 {
        return Err(AppError::concurrent_limit(cfg.max_concurrent_tasks_per_user));
    }

    // params 只存前端参数（camelCase）；worker 用 client_params() 读，成功后把
    // 产物写进同名列的 _server 保留键，这里初始不含 _server。
    let params = match req.params {
        Value::Object(_) => req.params,
        _ => json!({}),
    };
    let tool_id = if req.tool_id.trim().is_empty() {
        req.task_type.clone()
    } else {
        req.tool_id.clone()
    };

    let task_id = tasks::insert(
        state.db.pool(),
        user_id,
        &tool_id,
        &req.task_type,
        &params,
        input_file_id,
        bytes_in,
    )
    .await?;

    // 入内存队列（队列满时返回可读 503；DB 行仍是 queued，重启回捞会补投）
    state.queue.submit(task_id).await?;

    Ok(ok_data(json!({
        "taskId": task_id.to_string(),
        "status": tasks::status::QUEUED,
    })))
}

// ---------------------------------------------------------------------------
// GET /media/tasks/:id
// ---------------------------------------------------------------------------

pub async fn get_task(
    auth: RequiredAuth,
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<OkEnvelope<Value>>, AppError> {
    let task = tasks::load(state.db.pool(), id)
        .await?
        .ok_or_else(AppError::not_found)?;
    // 非属主一律 not_found（不泄露任务是否存在）
    if task.user_id != auth.0.user_id {
        return Err(AppError::not_found());
    }

    let mut body = tasks::summary(&task);
    if let Some(result) = build_result(&state, &task) {
        body["result"] = result;
    }
    Ok(ok_data(body))
}

// ---------------------------------------------------------------------------
// POST /media/tasks/:id/cancel
// ---------------------------------------------------------------------------

pub async fn cancel(
    auth: RequiredAuth,
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<OkEnvelope<Value>>, AppError> {
    let task = tasks::load(state.db.pool(), id)
        .await?
        .ok_or_else(AppError::not_found)?;
    if task.user_id != auth.0.user_id {
        return Err(AppError::not_found());
    }

    // queued/processing → canceled；已终态则原样返回当前状态（幂等）
    let final_status = tasks::cancel(state.db.pool(), id).await?;
    Ok(ok_data(json!({
        "ok": true,
        "status": final_status,
    })))
}

// ---------------------------------------------------------------------------
// GET /media/tasks   （我的任务列表）
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub(crate) struct ListQuery {
    #[serde(default)]
    limit: Option<i64>,
}

pub async fn list(
    auth: RequiredAuth,
    State(state): State<AppState>,
    Query(q): Query<ListQuery>,
) -> Result<Json<OkEnvelope<Value>>, AppError> {
    let limit = q.limit.unwrap_or(20).clamp(1, 100);
    let rows = tasks::list_for_user(state.db.pool(), auth.0.user_id, limit).await?;

    let items: Vec<Value> = rows
        .iter()
        .map(|task| {
            let mut body = tasks::summary(task);
            if let Some(result) = build_result(&state, task) {
                body["result"] = result;
            }
            body
        })
        .collect();

    Ok(ok_data(json!({ "items": items })))
}

// ---------------------------------------------------------------------------
// result 组装
// ---------------------------------------------------------------------------

/// 从 `params._server` 构造 C8 的 `result`（仅 succeeded 任务；缺 `_server` 返回 None）。
fn build_result(state: &AppState, task: &tasks::TaskRow) -> Option<Value> {
    if task.status != tasks::status::SUCCEEDED {
        return None;
    }
    let server = task.params.get(SERVER_PARAMS_KEY)?;

    let kind = server
        .get("kind")
        .and_then(|v| v.as_str())
        .unwrap_or("video")
        .to_string();

    // 产物清单：文件项补一次性签名相对下载 url，kv 行（{key,value}）原样透出。
    let raw_items = server.get("items").and_then(|v| v.as_array()).cloned();
    let ttl = Duration::hours(state.cfg().file_ttl_hours.max(1));
    let mut first_url: Option<String> = None;
    let items: Vec<Value> = raw_items
        .unwrap_or_default()
        .into_iter()
        .map(|mut item| {
            if let Some(fid_str) = item.get("fileId").and_then(|v| v.as_str()) {
                if let Ok(fid) = Uuid::parse_str(fid_str) {
                    let url = signed_url(state.cfg().jwt_secret(), fid, task.user_id, ttl);
                    if let Some(o) = item.as_object_mut() {
                        o.insert("url".to_string(), json!(url));
                    }
                    if first_url.is_none() {
                        first_url = Some(url);
                    }
                }
            }
            item
        })
        .collect();

    let size_mb = server.get("sizeMB").cloned().unwrap_or(json!(0));
    let stored_meta = server.get("meta").cloned().unwrap_or(Value::Null);
    let note = server.get("note").and_then(|v| v.as_str());

    // kv 类：meta 保持对象（image-exif 前端 Object.keys(meta)）；文件类：摊平成可读字符串
    //（buildMeta 对 meta 做 String()，直接给对象会变成 "[object Object]"）。
    let meta = if kind == "kv" {
        if stored_meta.is_object() || stored_meta.is_array() {
            stored_meta
        } else if stored_meta.is_null() {
            json!({})
        } else {
            stored_meta
        }
    } else {
        json!(flatten_meta(&stored_meta, note))
    };

    Some(json!({
        "kind": kind,
        "items": items,
        "url": first_url,
        "sizeMB": size_mb,
        "meta": meta,
    }))
}

/// 相对下载地址（不含 `/api/v1`，前端 `env.url` 统一补前缀）。
fn signed_url(secret: &str, file_id: Uuid, user_id: i64, ttl: Duration) -> String {
    let token = sign::issue(secret, file_id, user_id, ttl);
    format!("/files/{}/download?token={}", file_id, token)
}

/// 文件类 `result.meta`：note 优先 + `_server.meta` 对象摊平成 `k：v`，` · ` 连接。
fn flatten_meta(meta: &Value, note: Option<&str>) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(n) = note.map(str::trim).filter(|s| !s.is_empty()) {
        parts.push(n.to_string());
    }
    if let Some(obj) = meta.as_object() {
        for (k, v) in obj {
            let vs = display_value(v);
            if !vs.is_empty() {
                parts.push(format!("{k}：{vs}"));
            }
        }
    } else if let Some(s) = meta.as_str() {
        let s = s.trim();
        if !s.is_empty() {
            parts.push(s.to_string());
        }
    }
    parts.join(" · ")
}

fn display_value(v: &Value) -> String {
    match v {
        Value::String(s) => s.trim().to_string(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}
