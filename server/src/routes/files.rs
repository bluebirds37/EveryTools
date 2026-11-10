//! 文件上传 / 分片 / 完成校验 / 签名下载（C8 `POST /files/init`、`POST /files/upload`、
//! `POST /files/:id/complete`、`GET /files/:id/download?token=`）。
//!
//! 全部复用既有领域模块，本文件只做解包与编排：
//! - 建记录 [`crate::files::create_uploading`]（storage_key 由服务端 uuid 决定，绝不信任用户文件名）；
//! - 分片落盘 [`crate::files::Storage::write_chunk`]，合并 [`crate::files::Storage::merge_chunks`]；
//! - magic number 判定 [`crate::files::magic`]（requirements §8.5.1：只认真实头部字节）；
//! - sha256 自校验 [`crate::files::chunks::verify_sha`]（前端无摘要能力时留空，服务端算并记录）；
//! - 一次性 HMAC 下载签名 [`crate::files::sign`]（绑定 file_id+user_id+exp，失败统一 403）。
//!
//! `POST /files/upload` 同时接受**两种前端上传模式**（见 `utils/file-upload.js`）：
//! 1. `multipart/form-data`：字段 `fileId`/`index`/`mode` + 文件段（field 名 `chunk`）——
//!    单文件直传（`mode=single`）与分片（`mode=chunk`）都走这里；
//! 2. `application/octet-stream`：整段二进制作请求体，`fileId`/`index`/`mode` 走 query
//!    （低端机分片兜底路径）。
//! 因此用 [`axum::extract::Request`]（唯一的 body extractor，放最后）按 content-type 手动分派。

use axum::{
    Json,
    body::Bytes,
    extract::{FromRequest, Multipart, Path, Query, Request, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use chrono::Utc;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio_util::io::ReaderStream;
use uuid::Uuid;

use crate::{
    auth::RequiredAuth,
    error::{AppError, Code, OkEnvelope, ok_data},
    files::{self, chunks, magic},
    state::AppState,
};

// ---------------------------------------------------------------------------
// POST /files/init
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InitReq {
    #[serde(default)]
    name: String,
    #[serde(default)]
    size: i64,
    #[serde(default)]
    sha256: Option<String>,
    #[serde(default)]
    mime: Option<String>,
}

fn non_empty(v: Option<String>) -> Option<String> {
    v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

pub async fn init(
    auth: RequiredAuth,
    State(state): State<AppState>,
    Json(req): Json<InitReq>,
) -> Result<Json<OkEnvelope<Value>>, AppError> {
    let cfg = state.cfg();
    if req.size < 0 {
        return Err(AppError::param_invalid("size", "不能为负数"));
    }
    let max_mb = cfg.max_upload_bytes / (1024 * 1024);
    if req.size as u64 > cfg.max_upload_bytes {
        return Err(AppError::file_too_large(max_mb));
    }

    let sha = non_empty(req.sha256);
    let mime = non_empty(req.mime);

    let file_id = files::create_uploading(
        &state.db,
        auth.0.user_id,
        &req.name,
        mime.as_deref(),
        req.size,
        sha.as_deref(),
        "input",
        cfg.file_ttl_hours,
    )
    .await?;

    let uploaded = files::uploaded_chunk_indexes(&state.storage.incoming_dir(file_id));
    let chunked = (req.size as u64) > cfg.chunk_size;

    Ok(crate::ok_data(json!({
        "fileId": file_id.to_string(),
        "chunkSize": cfg.chunk_size,
        "uploaded": uploaded,
        "chunked": chunked,
        "multipart": true,
    })))
}

// ---------------------------------------------------------------------------
// POST /files/upload  （multipart 与 octet-stream 两种模式）
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UploadQuery {
    file_id: Option<String>,
    index: Option<String>,
    #[serde(default)]
    #[allow(dead_code)]
    mode: Option<String>,
}

pub async fn upload(
    auth: RequiredAuth,
    State(state): State<AppState>,
    Query(q): Query<UploadQuery>,
    req: Request,
) -> Result<Json<OkEnvelope<Value>>, AppError> {
    let is_multipart = req
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.starts_with("multipart/"))
        .unwrap_or(false);

    let (raw_file_id, raw_index, bytes) = if is_multipart {
        read_multipart(req, &state).await?
    } else {
        let body = Bytes::from_request(req, &state)
            .await
            .map_err(|_| bad_upload("无法读取请求体"))?;
        (q.file_id, q.index, body.to_vec())
    };

    let file_id = parse_uuid(raw_file_id.as_deref(), "fileId")?;
    let index = parse_index(raw_index.as_deref())?;

    let record = files::get(&state.db, file_id)
        .await?
        .ok_or_else(AppError::not_found)?;
    if record.user_id != auth.0.user_id {
        return Err(AppError::forbidden("不能上传到他人的文件"));
    }

    let received = state
        .storage
        .write_chunk(file_id, index, &bytes)
        .await
        .map_err(AppError::storage)?;

    Ok(ok_data(json!({ "index": index, "received": received })))
}

/// multipart：`fileId`/`index` 文本字段 + 文件段（任意 field 名，取第一个带 content-type 的段）
async fn read_multipart(
    req: Request,
    state: &AppState,
) -> Result<(Option<String>, Option<String>, Vec<u8>), AppError> {
    let mut mp = Multipart::from_request(req, state)
        .await
        .map_err(|_| bad_upload("multipart 解析失败，请检查 content-type 与 boundary"))?;

    let mut file_id: Option<String> = None;
    let mut index: Option<String> = None;
    let mut chunk: Vec<u8> = Vec::new();

    while let Some(field) = mp
        .next_field()
        .await
        .map_err(|e| bad_upload(format!("分片字段读取失败：{e}")))?
    {
        let name = field.name().unwrap_or("").to_string();
        match name.as_str() {
            "fileId" => file_id = field.text().await.ok(),
            "index" => index = field.text().await.ok(),
            "mode" => {
                let _ = field.text().await; // 记录用，不强制
            }
            _ => {
                let data = field
                    .bytes()
                    .await
                    .map_err(|e| bad_upload(format!("文件段读取失败：{e}")))?;
                chunk = data.to_vec();
            }
        }
    }

    Ok((file_id, index, chunk))
}

fn bad_upload(detail: impl Into<String>) -> AppError {
    AppError::new(StatusCode::BAD_REQUEST, Code::ParamInvalid)
        .with_message("上传请求不合法")
        .with_hint(detail.into())
}

fn parse_uuid(raw: Option<&str>, field: &str) -> Result<Uuid, AppError> {
    let s = raw.map(str::trim).filter(|v| !v.is_empty()).ok_or_else(|| {
        AppError::param_invalid(field, "缺少该字段（multipart form 字段或 query 参数）")
    })?;
    Uuid::parse_str(s)
        .map_err(|_| AppError::param_invalid(field, "不是合法的 uuid"))
}

fn parse_index(raw: Option<&str>) -> Result<usize, AppError> {
    let s = raw.map(str::trim).filter(|v| !v.is_empty()).ok_or_else(|| {
        AppError::param_invalid("index", "缺少分片序号")
    })?;
    s.parse::<usize>()
        .map_err(|_| AppError::param_invalid("index", "分片序号必须是非负整数"))
}

// ---------------------------------------------------------------------------
// POST /files/:id/complete
// ---------------------------------------------------------------------------

pub async fn complete(
    auth: RequiredAuth,
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(_body): Json<Value>,
) -> Result<Json<OkEnvelope<Value>>, AppError> {
    let cfg = state.cfg();
    let record = files::get(&state.db, id)
        .await?
        .ok_or_else(AppError::not_found)?;
    if record.user_id != auth.0.user_id {
        return Err(AppError::forbidden("不能完成他人的文件"));
    }
    // 幂等：已 ready 直接回成功
    if record.is_ready() {
        return Ok(ok_data(json!({ "fileId": id.to_string(), "ready": true })));
    }

    let total = chunks::chunk_count(record.size.max(0) as u64, cfg.chunk_size);
    let uploaded = files::uploaded_chunk_indexes(&state.storage.incoming_dir(id));

    if chunks::plan_merge(total, &uploaded).is_err() {
        let missing = (0..total).filter(|i| !uploaded.contains(i)).count();
        return Err(AppError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            Code::UploadIncomplete,
        )
        .with_message(format!("还有 {missing} 个分片未上传，请继续上传后再完成")));
    }

    let merged = state
        .storage
        .merge_chunks(id, total, &uploaded, &record.storage_key)
        .await
        .map_err(AppError::storage)?;

    let sha = state
        .storage
        .sha256_hex(&record.storage_key)
        .await
        .map_err(AppError::storage)?;
    if !chunks::verify_sha(record.sha256.as_deref(), &sha) {
        return Err(AppError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            Code::ChecksumMismatch,
        ));
    }

    // magic number：拒绝可执行/脚本伪装（§8.5.1），并据此确定真实 mime
    let head = state
        .storage
        .read_head(&record.storage_key, 64)
        .await
        .unwrap_or_default();
    if magic::forbidden_kind(&head).is_some() {
        return Err(AppError::unsupported_format("可执行或脚本文件")
            .with_hint("服务端只接受图片/音视频文件"));
    }
    let mime = magic::detect(&head)
        .map(|f| f.mime().to_string())
        .or_else(|| record.mime.clone())
        .unwrap_or_else(|| "application/octet-stream".to_string());

    files::mark_ready(
        &state.db,
        id,
        merged as i64,
        &sha,
        &mime,
        cfg.file_ttl_hours,
    )
    .await?;

    Ok(ok_data(json!({ "fileId": id.to_string(), "ready": true })))
}

// ---------------------------------------------------------------------------
// GET /files/:id/download?token=   （一次性 HMAC 签名 + 属主绑定；流式二进制）
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub(crate) struct DownloadQuery {
    #[serde(default)]
    token: Option<String>,
}

pub async fn download(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Query(q): Query<DownloadQuery>,
) -> Response {
    match serve_download(&state, id, q.token.as_deref()).await {
        Ok(resp) => resp,
        Err(err) => err.into_response(),
    }
}

async fn serve_download(
    state: &AppState,
    id: Uuid,
    token: Option<&str>,
) -> Result<Response, AppError> {
    let record = files::get(&state.db, id)
        .await?
        .ok_or_else(AppError::not_found)?;

    let now = Utc::now();
    let raw = token.ok_or_else(|| AppError::forbidden("缺少下载签名"))?;
    // 校验：token 绑定的 user_id 用文件属主 → 换文件/换用户必然 403（§8.5.6）
    files::sign::verify(state.cfg().jwt_secret(), raw, id, record.user_id, now)?;

    if !record.is_ready() || record.is_expired_at(now) {
        return Err(AppError::not_found()
            .with_hint("文件未就绪或已过期，请重新上传/生成"));
    }

    let path = state.storage.blob_path(&record.storage_key);
    let file = tokio::fs::File::open(&path)
        .await
        .map_err(|_| AppError::not_found().with_hint("文件已被清理，请重新生成"))?;

    let stream = ReaderStream::new(file);
    let body = axum::body::Body::from_stream(stream);

    let content_type = record
        .mime
        .clone()
        .unwrap_or_else(|| "application/octet-stream".to_string());
    // 纯 ASCII 下载名（避免中文文件名破坏响应头）： `<uuid>.<ext>`
    let disp = format!(
        "attachment; filename=\"{}.{}\"",
        id.simple(),
        ext_for(record.mime.as_deref())
    );

    let mut builder = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CONTENT_DISPOSITION, disp)
        .header(header::CACHE_CONTROL, "no-store");
    if record.size > 0 {
        builder = builder.header(header::CONTENT_LENGTH, record.size.to_string());
    }
    builder
        .body(body)
        .map_err(|e| AppError::storage(anyhow::anyhow!(e)))
}

/// 由真实 mime 取下载扩展名（与前端 `media.extension` 一致的小集合）
fn ext_for(mime: Option<&str>) -> &'static str {
    match mime.unwrap_or("") {
        "image/jpeg" => "jpg",
        "image/png" => "png",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/bmp" => "bmp",
        "video/mp4" | "audio/mp4" => "mp4",
        "video/quicktime" => "mov",
        "video/webm" => "webm",
        "video/x-matroska" => "mkv",
        "audio/mpeg" => "mp3",
        "audio/wav" => "wav",
        "audio/flac" => "flac",
        "application/pdf" => "pdf",
        _ => "bin",
    }
}
