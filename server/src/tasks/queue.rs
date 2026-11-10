//! 进程内任务队列（docs/requirements.md §8.4）。
//!
//! ```text
//! POST /media/tasks ──▶ tasks::insert(queued) ──▶ TaskQueue::submit(uuid)
//!                                                        │
//!                            pump（最多 workers 个并发槽）│
//!                                                        ▼
//!                                        dispatch(type) ─▶ media::params::*::from_params
//!                                                        ─▶ CommandSpec（media::ffmpeg）
//!                                                        ─▶ CommandRunner（生产 ProcessRunner /
//!                                                           开发 DryRunRunner / 测试 MockRunner）
//!                                                        ─▶ Storage::alloc_output + files::insert_output
//!                                                        ─▶ tasks::succeed / fail
//! ```
//!
//! 设计约束（刻意保持简单，v1 单实例）：
//! - **不引入 Redis**：内存 `mpsc` 负责调度，DB 的 `status='queued'` 负责真相；
//!   进程重启后 worker 启动时会把 DB 里滞留的 queued 任务回捞进队列。
//! - **进度节流**：变化 <5% 且距上次写入 <1s 时不落库（避免轮询写放大）。
//! - **取消**：每个阶段边界查一次 DB 状态；`succeed/fail` 的 SQL 带状态前置条件，
//!   因此被取消的任务不会被终态写入覆盖。
//! - **本机无 ffmpeg**：`MEDIA_DRY_RUN=1` 时 runner 是 `DryRunRunner`，写占位产物，
//!   全链路（init→upload→complete→task→success）照样跑通，测试不依赖真 ffmpeg。
//!
//! 产物归属：`media_tasks` 没有 result 列，产物清单写在 `params._server`
//! （见 `tasks` 模块头注释），由 routes 读它并即时签发一次性下载 token。

use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};

use serde_json::{Value, json};
use tokio::sync::{Notify, Semaphore, mpsc};
use uuid::Uuid;

use crate::{
    config::Settings,
    db::Db,
    error::{AppError, Code},
    files::{self, Storage, magic::MediaFormat},
    media::{
        ffmpeg::{
            CommandRunner, CommandSpec, ProbeInfo, RunContext, parse_probe, probe_args,
        },
        image_ops,
        params::{
            AudioParams, CompressParams, FramesParams, GifParams, Params, TrimParams,
            WatermarkParams, MAX_VIDEO_SECONDS,
        },
    },
    tasks::{self, queue::media_info::resolve_media_info, status},
};

/// 队列深度（超过则拒绝新任务，返回可读 503）
pub const QUEUE_DEPTH: usize = 2048;
/// worker 并发上限（`TASK_WORKERS`，默认 2，最多 8）
pub const MAX_WORKERS: usize = 8;
/// 进度落库节流：最小变化幅度（百分点）
const PROGRESS_MIN_DELTA: i16 = 5;
/// 进度落库节流：最小间隔
const PROGRESS_MIN_INTERVAL: Duration = Duration::from_secs(1);

#[derive(Clone)]
pub struct TaskQueue {
    inner: Arc<Inner>,
    tx: mpsc::Sender<Uuid>,
}

pub(crate) struct Inner {
    settings: Arc<Settings>,
    db: Db,
    storage: Arc<Storage>,
    runner: Arc<dyn CommandRunner>,
    workers: usize,
    /// 启动回捞用的入队句柄（`start_workers` 的 pump 循环消费它）
    tx: mpsc::Sender<Uuid>,
    /// `start_workers` 只能成功调用一次（rx 取走即空）
    rx: std::sync::Mutex<Option<mpsc::Receiver<Uuid>>>,
}

impl TaskQueue {
    /// `lib.rs::startup` 的调用点：`TaskQueue::new(&cfg, db.clone(), storage.clone(), runner)`
    pub fn new(
        cfg: &Settings,
        db: Db,
        storage: Arc<Storage>,
        runner: Arc<dyn CommandRunner>,
    ) -> Self {
        let (tx, rx) = mpsc::channel(QUEUE_DEPTH);
        Self {
            inner: Arc::new(Inner {
                settings: Arc::new(cfg.clone()),
                db,
                storage,
                runner,
                workers: worker_count(),
                tx: tx.clone(),
                rx: std::sync::Mutex::new(Some(rx)),
            }),
            tx,
        }
    }

    /// 启动 pump + 并发槽（`lib.rs` 里是同步调用，内部 `tokio::spawn`）
    pub fn start_workers(self) {
        let rx = match self.inner.rx.lock().ok().and_then(|mut g| g.take()) {
            Some(rx) => rx,
            None => {
                tracing::warn!("task workers already started; skip");
                return;
            }
        };
        let inner = self.inner.clone();
        tracing::info!(workers = inner.workers, "task queue workers started");

        tokio::spawn(async move {
            // 崩溃恢复：DB 里 queued 的行内存队列中没有，启动时捞回
            requeue_pending(&inner).await;

            let slots = Arc::new(Semaphore::new(inner.workers));
            let mut rx = rx;
            while let Some(id) = rx.recv().await {
                // 并发槽满时这里自然等待，内存队列随之堆积 → submit 返回队列已满
                let permit = match slots.clone().acquire_owned().await {
                    Ok(p) => p,
                    Err(_) => break,
                };
                let inner = inner.clone();
                tokio::spawn(async move {
                    let _permit = permit;
                    run_task(&inner, id).await;
                });
            }
        });
    }

    /// 入队（`POST /media/tasks` 落库后调用）
    pub async fn submit(&self, id: Uuid) -> Result<(), AppError> {
        self.tx.try_send(id).map_err(|_| {
            AppError::engine_unavailable("任务队列已满，请稍后重试").with_hint(format!(
                "当前并发 {}，队列深度 {}",
                self.inner.workers, QUEUE_DEPTH
            ))
        })
    }

    pub fn is_dry_run(&self) -> bool {
        self.inner.runner.is_dry_run()
    }

    pub fn runner_name(&self) -> &'static str {
        self.inner.runner.name()
    }

    /// 测试/诊断：当前 worker 配置
    pub fn workers(&self) -> usize {
        self.inner.workers
    }
}

fn worker_count() -> usize {
    std::env::var("TASK_WORKERS")
        .ok()
        .and_then(|v| v.trim().parse::<usize>().ok())
        .unwrap_or(2)
        .clamp(1, MAX_WORKERS)
}

/// 启动回捞：queued 的行内存队列里没有，重新塞进 mpsc（pump 循环会顺序消费，
/// 并发仍由 `Semaphore` 限制，队列满时 `send` 自然等待）
async fn requeue_pending(inner: &Arc<Inner>) {
    match tasks::queued_ids(inner.db.pool(), QUEUE_DEPTH as i64).await {
        Ok(ids) => {
            if !ids.is_empty() {
                tracing::info!(count = ids.len(), "recovered queued tasks from DB");
            }
            for id in ids {
                if inner.tx.send(id).await.is_err() {
                    tracing::warn!(task_id = %id, "queue closed during recovery; leave as queued");
                    return;
                }
            }
        }
        Err(err) => tracing::warn!(error = ?err, "queued task recovery failed"),
    }
}

// ---------------------------------------------------------------------------
// 单个任务的执行
// ---------------------------------------------------------------------------

/// 任务产物（已落盘，待登记到 files 表）
#[derive(Clone)]
struct Produced {
    key: String,
    path: PathBuf,
    name: String,
    mime: String,
    label: String,
}

struct TaskOutcome {
    kind: &'static str,
    outputs: Vec<Produced>,
    /// 写进 result.meta（字符串或对象）
    meta: Value,
    /// 写进 result.items 的额外键值行（video-probe 用 kind=kv）
    kv: Vec<Value>,
    /// 结果说明文案（如 "已压到 720p/24fps"）
    note: Option<String>,
}

async fn run_task(inner: &Arc<Inner>, id: Uuid) {
    let pool = inner.db.pool();
    let started = Instant::now();

    let task = match tasks::load(pool, id).await {
        Ok(Some(t)) => t,
        Ok(None) => {
            tracing::warn!(task_id = %id, "queued task vanished before execution");
            return;
        }
        Err(err) => {
            tracing::warn!(task_id = %id, error = ?err, "task load failed");
            return;
        }
    };
    if task.is_terminal() {
        return; // 已完成/已取消/已失败：重复投递直接忽略
    }

    if !tasks::is_known_type(&task.task_type) {
        let err = tasks::unknown_type_error(&task.task_type);
        finish_failure(inner, id, err.code, &err.message, started).await;
        return;
    }

    // CAS 认领：queued → processing（已被取消则直接结束）
    match tasks::claim_processing(pool, id).await {
        Ok(true) => {}
        Ok(false) => return,
        Err(err) => {
            tracing::warn!(task_id = %id, error = ?err, "task claim failed");
            return;
        }
    }
    let mut reporter = Reporter::new(pool.clone(), id);
    let _ = reporter.force(1).await;

    let result = dispatch(inner, &task, &mut reporter).await;
    let cost_ms = started.elapsed().as_millis() as i32;

    match result {
        Ok(outcome) => {
            if reporter.canceled().await.unwrap_or(false) {
                tracing::info!(task_id = %id, "task canceled before commit; outputs dropped");
                drop_outputs(inner, &outcome.outputs).await;
                return;
            }
            match commit(inner, &task, outcome, cost_ms).await {
                Ok(bytes_out) => {
                    record_usage(inner, &task, true, cost_ms);
                    tracing::info!(
                        task_id = %id,
                        type_ = %task.task_type,
                        cost_ms,
                        bytes_out,
                        engine = inner.runner.name(),
                        "task succeeded"
                    );
                }
                Err(err) => {
                    tracing::warn!(task_id = %id, error = ?err, "output registration failed");
                    finish_failure(inner, id, err.code, &err.message, started).await;
                    record_usage(inner, &task, false, cost_ms);
                }
            }
        }
        Err(err) => {
            // 取消优先：状态已是 canceled 时不写失败（fail 的 SQL 也带状态前置条件）
            if !reporter.canceled().await.unwrap_or(false) {
                finish_failure(inner, id, err.code, &err.message, started).await;
            }
            record_usage(inner, &task, false, cost_ms);
            tracing::warn!(
                task_id = %id,
                type_ = %task.task_type,
                code = ?err.code,
                message = %err.message,
                "task failed"
            );
        }
    }
}

async fn finish_failure(inner: &Arc<Inner>, id: Uuid, code: Code, message: &str, started: Instant) {
    let cost = started.elapsed().as_millis() as i32;
    if let Err(err) = tasks::fail(inner.db.pool(), id, code, message, cost).await {
        tracing::warn!(task_id = %id, error = ?err, "task failure write failed");
    }
}

/// 产物登记 + 终态写入，返回 bytes_out
async fn commit(
    inner: &Arc<Inner>,
    task: &tasks::TaskRow,
    outcome: TaskOutcome,
    cost_ms: i32,
) -> Result<i64, AppError> {
    let mut items: Vec<Value> = Vec::new();
    let mut bytes_out = 0i64;
    let mut first_output: Option<Uuid> = None;

    for produced in &outcome.outputs {
        let size = tokio::fs::metadata(&produced.path)
            .await
            .map(|m| m.len() as i64)
            .map_err(|e| AppError::storage(anyhow::anyhow!(e)))?;
        let sha = inner
            .storage
            .sha256_hex(&produced.key)
            .await
            .map_err(|e| AppError::storage(e))?;
        let file_id = files::insert_output(
            &inner.db,
            task.user_id,
            &produced.name,
            &produced.key,
            &produced.mime,
            size,
            &sha,
            inner.settings.file_ttl_hours,
        )
        .await?;
        first_output.get_or_insert(file_id);
        bytes_out += size;
        items.push(json!({
            "fileId": file_id.to_string(),
            "label": produced.label,
            "mime": produced.mime,
            "sizeBytes": size,
            "name": produced.name,
        }));
    }
    for row in &outcome.kv {
        items.push(row.clone());
    }

    let size_mb = (bytes_out as f64 / 1_048_576.0 * 100.0).round() / 100.0;
    let mut server_meta = json!({
        "kind": outcome.kind,
        "items": items,
        "sizeMB": size_mb,
        "outputs": items,
    });
    if !outcome.meta.is_null() {
        server_meta["meta"] = outcome.meta;
    }
    if let Some(note) = outcome.note {
        server_meta["note"] = json!(note);
    }

    tasks::succeed(
        inner.db.pool(),
        task.id,
        first_output,
        &server_meta,
        task.bytes_in.unwrap_or(0).max(0),
        bytes_out,
        cost_ms,
        inner.runner.name(),
    )
    .await?;
    Ok(bytes_out)
}

async fn drop_outputs(inner: &Arc<Inner>, outputs: &[Produced]) {
    for o in outputs {
        if let Err(err) = inner.storage.remove_blob(&o.key).await {
            tracing::warn!(key = %o.key, error = ?err, "canceled task output cleanup failed");
        }
    }
}

fn record_usage(inner: &Arc<Inner>, task: &tasks::TaskRow, success: bool, cost_ms: i32) {
    let db = inner.db.clone();
    let user_id = task.user_id;
    let tool_id = task.tool_id.clone();
    let engine = if inner.runner.is_dry_run() {
        "dry-run"
    } else {
        "server"
    }
    .to_string();
    tokio::spawn(async move {
        let _ = sqlx::query(
            "INSERT INTO tool_usage (user_id, tool_id, engine, success, cost_ms, day, created_at)
             VALUES ($1,$2,$3,$4,$5,current_date, now())",
        )
        .bind(user_id)
        .bind(&tool_id)
        .bind(&engine)
        .bind(success)
        .bind(cost_ms)
        .execute(db.pool())
        .await;
    });
}

// ---------------------------------------------------------------------------
// 类型分发（10 个前端会提交的 type）
// ---------------------------------------------------------------------------

async fn dispatch(
    inner: &Arc<Inner>,
    task: &tasks::TaskRow,
    rep: &mut Reporter,
) -> Result<TaskOutcome, AppError> {
    let params = Params::new(task.client_params());
    match task.task_type.as_str() {
        "video-compress" => video_compress(inner, task, &params, rep).await,
        "video-clip" => video_clip(inner, task, &params, rep).await,
        "video-gif" => video_gif(inner, task, &params, rep).await,
        "video-frames" => video_frames(inner, task, &params, rep).await,
        "video-probe" => video_probe(inner, task, &params, rep).await,
        "video-audio" => video_audio(inner, task, &params, rep).await,
        "image-compress" => image_compress(inner, task, &params, rep).await,
        "image-convert" => image_convert(inner, task, &params, rep).await,
        "image-watermark" => image_watermark(inner, task, &params, rep).await,
        "image-exif" => image_exif(inner, task, &params, rep).await,
        other => Err(tasks::unknown_type_error(other)),
    }
}

/// 输入文件（必须 ready 且磁盘上存在）
struct InputFile {
    path: PathBuf,
    size: i64,
    format: Option<MediaFormat>,
}

async fn load_input(inner: &Arc<Inner>, task: &tasks::TaskRow) -> Result<InputFile, AppError> {
    let file_id = task.input_file_id.ok_or_else(|| {
        AppError::param_invalid("fileIds", "该任务需要 1 个输入文件（先上传再创建任务）")
    })?;
    let record = files::get(&inner.db, file_id)
        .await?
        .ok_or_else(AppError::not_found)?;
    if record.user_id != task.user_id {
        return Err(AppError::forbidden("不能引用他人的文件"));
    }
    if !record.is_ready() {
        return Err(AppError::new(
            axum::http::StatusCode::UNPROCESSABLE_ENTITY,
            Code::UploadIncomplete,
        )
        .with_message("文件还未上传完成，请先完成上传"));
    }
    let path = inner.storage.blob_path(&record.storage_key);
    if !path.exists() {
        return Err(AppError::not_found()
            .with_hint("文件已过期或被清理，请重新上传"));
    }
    let format = inner
        .storage
        .read_head(&record.storage_key, 64)
        .await
        .ok()
        .and_then(|head| files::magic::detect(&head));
    Ok(InputFile {
        path,
        size: record.size,
        format,
    })
}

fn is_video_kind(input: &InputFile) -> bool {
    input
        .format
        .map(|f| f.is_video() || f.is_audio())
        .unwrap_or(true) // dry-run/占位文件也可能没有可识别头，交给 ffmpeg 判断
}

fn check_video_duration(duration_sec: f64) -> Result<(), AppError> {
    if duration_sec > MAX_VIDEO_SECONDS + 0.5 {
        return Err(AppError::file_too_large(200).with_message(format!(
            "视频时长 {duration_sec:.0}s 超过云端上限 {}s，请先用「视频截取」剪短",
            MAX_VIDEO_SECONDS as i64
        )));
    }
    Ok(())
}

/// 申请输出文件（blob 目录内的 key + 路径）
fn alloc(inner: &Arc<Inner>, ext: &str) -> Result<Produced, AppError> {
    let (key, path) = inner
        .storage
        .alloc_output(ext)
        .map_err(|e| AppError::storage(e))?;
    Ok(Produced {
        key,
        path,
        name: String::new(),
        mime: String::new(),
        label: String::new(),
    })
}

fn mime_of_ext(ext: &str) -> &'static str {
    match ext {
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" | "mkv" => "video/webm",
        "gif" => "image/gif",
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "m4a" | "aac" => "audio/mp4",
        "flac" => "audio/flac",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}

// ---- 视频类（走 ffmpeg 适配层）----

async fn video_probe(
    inner: &Arc<Inner>,
    task: &tasks::TaskRow,
    params: &Params,
    rep: &mut Reporter,
) -> Result<TaskOutcome, AppError> {
    let input = load_input(inner, task).await?;
    rep.force(20).await?;
    let info = resolve_media_info(inner, params, &input.path).await?;
    rep.force(100).await?;
    Ok(TaskOutcome {
        kind: "kv",
        outputs: vec![],
        meta: json!(info.kv_map()),
        kv: info.kv_rows(),
        note: None,
    })
}

async fn video_compress(
    inner: &Arc<Inner>,
    task: &tasks::TaskRow,
    params: &Params,
    rep: &mut Reporter,
) -> Result<TaskOutcome, AppError> {
    let input = load_input(inner, task).await?;
    if !is_video_kind(&input) {
        return Err(AppError::unsupported_format("非视频文件"));
    }
    let info = probe_for(inner, params, &input).await?;
    check_video_duration(info.duration())?;
    let cp = CompressParams::from_params(params)?;
    let out = alloc(inner, "mp4")?;
    let pass_log = inner.storage.blob_path(&format!("{}-passlog", task.id.simple()));

    let steps = crate::media::ffmpeg::compress_commands(
        &input.path,
        &out.path,
        &pass_log,
        &cp,
        info.duration(),
    );
    if steps.is_empty() {
        return Err(AppError::param_invalid(
            "mode",
            format!("未知压缩模式 {}", cp.mode),
        ));
    }
    run_steps(inner, &steps, rep, 10, 80).await?;
    cleanup_pass_log(&pass_log);

    let size_mb = file_size_mb(&out.path).await?;
    Ok(TaskOutcome {
        kind: "video",
        outputs: vec![named(
            out,
            "mp4",
            &format!("{}.mp4", stem(task, "compressed")),
            "压缩结果",
        )],
        meta: json!({ "时长": format!("{:.1}s", info.duration()), "输出": format!("{size_mb:.2}MB") }),
        kv: vec![],
        note: Some(format!(
            "{} · {}p · 约 {size_mb:.2}MB",
            cp.mode,
            if cp.target_width == 0 { "源" } else { "目标" }
        )),
    })
}

async fn video_clip(
    inner: &Arc<Inner>,
    task: &tasks::TaskRow,
    params: &Params,
    rep: &mut Reporter,
) -> Result<TaskOutcome, AppError> {
    let input = load_input(inner, task).await?;
    let info = probe_for(inner, params, &input).await?;
    let tp = TrimParams::from_params(params, info.duration())?;
    let out = alloc(inner, "mp4")?;
    let steps = crate::media::ffmpeg::trim_commands(&input.path, &out.path, &tp);
    run_steps(inner, &steps, rep, 10, 80).await?;
    Ok(TaskOutcome {
        kind: "video",
        outputs: vec![named(
            out,
            "mp4",
            &format!("{}.mp4", stem(task, "clip")),
            "截取结果",
        )],
        meta: json!({ "区间": format!("{:.1}s ~ {:.1}s", tp.start_sec, tp.end_sec) }),
        kv: vec![],
        note: Some(if tp.fast_cut {
            "关键帧快速切割".into()
        } else {
            "重编码截取".into()
        }),
    })
}

async fn video_gif(
    inner: &Arc<Inner>,
    task: &tasks::TaskRow,
    params: &Params,
    rep: &mut Reporter,
) -> Result<TaskOutcome, AppError> {
    let input = load_input(inner, task).await?;
    let info = probe_for(inner, params, &input).await?;
    let gp = GifParams::from_params(params, info.duration())?;
    let out = alloc(inner, "gif")?;
    let palette = alloc(inner, "png")?;
    let steps = crate::media::ffmpeg::gif_commands(
        &input.path,
        &palette.path,
        &out.path,
        &gp,
        gp.fps,
        gp.width,
    );
    let result = run_steps(inner, &steps, rep, 10, 80).await;
    let _ = inner.storage.remove_blob(&palette.key).await;
    result?;
    let size_mb = file_size_mb(&out.path).await?;
    Ok(TaskOutcome {
        kind: "image",
        outputs: vec![named(
            out,
            "gif",
            &format!("{}.gif", stem(task, "gif")),
            "GIF",
        )],
        meta: json!({ "尺寸": format!("{}px", gp.width), "帧率": format!("{}fps", gp.fps as i64), "体积": format!("{size_mb:.2}MB") }),
        kv: vec![],
        note: Some(format!("{}s 片段 · {}", (gp.end_sec - gp.start_sec).round(), gp.quality)),
    })
}

async fn video_frames(
    inner: &Arc<Inner>,
    task: &tasks::TaskRow,
    params: &Params,
    rep: &mut Reporter,
) -> Result<TaskOutcome, AppError> {
    let input = load_input(inner, task).await?;
    let info = probe_for(inner, params, &input).await?;
    let fp = FramesParams::from_params(params, info.duration())?;

    // 多产物：放进 blobs/<task_id>_frames/ 目录，key 带子目录前缀
    let dir_name = format!("{}_frames", task.id.simple());
    let out_dir = inner.storage.blobs_dir().join(&dir_name);
    std::fs::create_dir_all(&out_dir).map_err(|e| AppError::storage(anyhow::anyhow!(e)))?;

    let steps = crate::media::ffmpeg::frames_commands(&input.path, &out_dir, &fp, info.duration());
    let produced: Vec<Produced> = steps
        .iter()
        .filter_map(|s| {
            s.output.as_ref().map(|p| Produced {
                key: format!("{}/{}", dir_name, file_name(p)),
                path: p.clone(),
                name: String::new(),
                mime: String::new(),
                label: String::new(),
            })
        })
        .collect();

    let result = run_steps(inner, &steps, rep, 10, 80).await;
    if let Err(err) = result {
        let _ = std::fs::remove_dir_all(&out_dir);
        return Err(err);
    }

    let mut outputs = Vec::new();
    for p in produced.iter() {
        if !p.path.exists() {
            continue; // dry-run 只写了有 output 的步骤；contact-sheet 等权重 0 步骤可能缺
        }
        let ext = ext_of(&p.path);
        let name = file_name(&p.path);
        let label = if name.starts_with("frame_") {
            let no = name.trim_start_matches("frame_").replace(".jpg", "").replace(".png", "");
            format!("帧 {no}")
        } else {
            "预览图".to_string()
        };
        let mut one = p.clone();
        one.mime = mime_of_ext(&ext).to_string();
        one.name = name;
        one.label = label;
        outputs.push(one);
    }
    if outputs.is_empty() {
        let _ = std::fs::remove_dir_all(&out_dir);
        return Err(AppError::task_failed("没有抽到任何画面"));
    }
    let frame_count = outputs.len();
    Ok(TaskOutcome {
        kind: "images",
        outputs,
        meta: json!({ "帧数": frame_count, "格式": fp.format, "抽帧": fp.mode }),
        kv: vec![],
        note: Some(format!("共 {frame_count} 张")),
    })
}

async fn video_audio(
    inner: &Arc<Inner>,
    task: &tasks::TaskRow,
    params: &Params,
    rep: &mut Reporter,
) -> Result<TaskOutcome, AppError> {
    let input = load_input(inner, task).await?;
    let info = probe_for(inner, params, &input).await?;
    if !info.info.has_audio {
        return Err(AppError::no_audio_stream());
    }
    let ap = AudioParams::from_params(params, info.duration())?;
    let ext = match ap.format.as_str() {
        "aac" | "m4a" => "m4a",
        "wav" => "wav",
        other => other,
    };
    let out = alloc(inner, ext)?;
    let steps = crate::media::ffmpeg::audio_commands(&input.path, &out.path, &ap);
    run_steps(inner, &steps, rep, 10, 80).await?;
    Ok(TaskOutcome {
        kind: "audio",
        outputs: vec![named(
            out,
            ext,
            &format!("{}.{}", stem(task, "audio"), ext),
            "音频",
        )],
        meta: json!({ "格式": ap.format.to_uppercase(), "码率": format!("{}k", ap.bitrate_kbps) }),
        kv: vec![],
        note: None,
    })
}

// ---- 图片类（纯 Rust，不依赖 ffmpeg）----

async fn image_compress(
    inner: &Arc<Inner>,
    task: &tasks::TaskRow,
    params: &Params,
    rep: &mut Reporter,
) -> Result<TaskOutcome, AppError> {
    let input = load_input(inner, task).await?;
    rep.force(15).await?;
    let (img, _fmt) = image_ops::decode(&input.path)?;
    rep.force(45).await?;

    let mode = params.one_of("mode", "quality", &["size", "quality", "dimension"])?;
    let max_side = params.num_in("maxSide", 0.0, 0.0, 8192.0)?.round() as u32;
    let quality = params.num_in("quality", 75.0, 10.0, 95.0)? as u8;
    let bg = image_ops::hex_to_rgb(&params.str_or("bgColor", "#FFFFFF"))
        .unwrap_or((255, 255, 255));
    let scaled = image_ops::resize_max_side(&img, max_side);
    let flat = image_ops::flatten_with_bg(&scaled, bg);
    let flat = image::DynamicImage::ImageRgb8(flat);

    let (bytes, used_q) = if mode == "size" {
        let target_kb = params.num_in("targetKB", 200.0, 20.0, 5120.0)?;
        let target = (target_kb * 1024.0) as usize;
        let (q, size, reached) = image_ops::pick_quality_for_target(
            target,
            image_ops::JPEG_QUALITY_MIN,
            image_ops::JPEG_QUALITY_MAX,
            |q| image_ops::encode_jpeg(&flat, q),
        )?;
        if !reached {
            return Err(AppError::task_failed(format!(
                "最低质量仍 {size}B > 目标 {target}B，请缩小尺寸或放宽目标体积"
            )));
        }
        (image_ops::encode_jpeg(&flat, q)?, q)
    } else {
        (image_ops::encode_jpeg(&flat, quality)?, quality)
    };
    rep.force(85).await?;

    let out = write_bytes(inner, "jpg", &bytes).await?;
    Ok(TaskOutcome {
        kind: "image",
        outputs: vec![named(
            out,
            "jpg",
            &format!("{}.jpg", stem(task, "compressed")),
            "压缩结果",
        )],
        meta: json!({
            "尺寸": format!("{}×{}", scaled.width(), scaled.height()),
            "质量": used_q,
            "体积": format!("{:.2}MB", bytes.len() as f64 / 1_048_576.0),
        }),
        kv: vec![],
        note: Some(format!("JPEG q={used_q}")),
    })
}

async fn image_convert(
    inner: &Arc<Inner>,
    task: &tasks::TaskRow,
    params: &Params,
    rep: &mut Reporter,
) -> Result<TaskOutcome, AppError> {
    let input = load_input(inner, task).await?;
    rep.force(15).await?;
    let (img, _fmt) = image_ops::decode(&input.path)?;
    let orientation = image_ops::read_exif_from_file(&input.path, false)?
        .orientation
        .map(|v| v.max(1).min(8));
    let img = image_ops::normalized_image(&img, orientation);
    rep.force(45).await?;

    let to = params.one_of("toFormat", "png", &["png", "jpg", "jpeg", "webp"])?;
    let bg = image_ops::hex_to_rgb(&params.str_or("bgColor", "#FFFFFF"))
        .unwrap_or((255, 255, 255));
    let quality = params.num_in("quality", 90.0, 10.0, 100.0)? as u8;
    let (bytes, _mime, ext) = image_ops::convert_format(&img, to, bg, quality)?;
    rep.force(85).await?;

    let out = write_bytes(inner, ext, &bytes).await?;
    Ok(TaskOutcome {
        kind: "image",
        outputs: vec![named(
            out,
            ext,
            &format!("{}.{}", stem(task, "converted"), ext),
            "转换结果",
        )],
        meta: json!({ "格式": ext.to_uppercase(), "尺寸": format!("{}×{}", img.width(), img.height()) }),
        kv: vec![],
        note: None,
    })
}

async fn image_watermark(
    inner: &Arc<Inner>,
    task: &tasks::TaskRow,
    params: &Params,
    rep: &mut Reporter,
) -> Result<TaskOutcome, AppError> {
    let input = load_input(inner, task).await?;
    let (w, h) = image_ops::decode(&input.path)
        .map(|(img, _)| (img.width() as i64, img.height() as i64))
        .unwrap_or((0, 0));
    let normalized = normalize_image_watermark_params(params.raw(), w.max(1), h.max(1));
    let wp = WatermarkParams::from_params(&Params::new(normalized), 0.0)?;

    let (key, out_path) = inner
        .storage
        .alloc_output("jpg")
        .map_err(|e| AppError::storage(e))?;
    let logo = match (wp.kind.as_str(), &wp.logo_file_id) {
        ("logo", Some(logo_id)) => {
            let lid = Uuid::parse_str(logo_id)
                .map_err(|_| AppError::param_invalid("logoFileId", "不是合法的文件 id"))?;
            let rec = files::get(&inner.db, lid)
                .await?
                .ok_or_else(AppError::not_found)?;
            if rec.user_id != task.user_id {
                return Err(AppError::forbidden("不能引用他人的 logo 文件"));
            }
            Some(inner.storage.blob_path(&rec.storage_key))
        }
        ("logo", None) => return Err(AppError::param_invalid("logoFileId", "type=logo 时必填")),
        _ => None,
    };

    let spec = image_watermark_spec(
        &input.path,
        &out_path,
        logo.as_deref(),
        &inner.settings.watermark_font_file,
        &wp,
        w,
        h,
        params.num_in("quality", 90.0, 10.0, 100.0)? as u8,
    );
    let steps = vec![spec];
    run_steps(inner, &steps, rep, 15, 70).await?;

    let produced = Produced {
        key,
        path: out_path,
        name: format!("{}.jpg", stem(task, "watermark")),
        mime: "image/jpeg".to_string(),
        label: "水印结果".to_string(),
    };
    Ok(TaskOutcome {
        kind: "image",
        outputs: vec![produced],
        meta: json!({ "水印": wp.kind, "位置": wp.position }),
        kv: vec![],
        note: None,
    })
}

async fn image_exif(
    inner: &Arc<Inner>,
    task: &tasks::TaskRow,
    params: &Params,
    rep: &mut Reporter,
) -> Result<TaskOutcome, AppError> {
    let input = load_input(inner, task).await?;
    rep.force(20).await?;
    let reveal = params.bool_or("revealGps", false) || params.bool_or("full", false);
    let exif = image_ops::read_exif_from_file(&input.path, reveal)?;
    let (img, fmt) = image_ops::decode(&input.path)?;
    rep.force(90).await?;
    let info = image_ops::ImageInfo::new(fmt, img.width(), img.height(), input.size as u64);
    let mut meta = serde_json::to_value(&info).unwrap_or(Value::Null);
    let exif_value = serde_json::to_value(&exif).unwrap_or(Value::Null);
    if let (Some(a), Some(b)) = (meta.as_object_mut(), exif_value.as_object()) {
        for (k, v) in b {
            a.insert(k.clone(), v.clone());
        }
    }
    Ok(TaskOutcome {
        kind: "kv",
        outputs: vec![],
        meta,
        kv: exif_rows(&exif, &info, reveal),
        note: Some(if exif.has_exif {
            "已读取 EXIF".into()
        } else {
            "无拍摄信息".into()
        }),
    })
}

fn exif_rows(
    exif: &image_ops::ExifInfo,
    info: &image_ops::ImageInfo,
    reveal: bool,
) -> Vec<Value> {
    let mut rows: Vec<Value> = Vec::new();
    let mut push = |k: &str, v: Option<String>| {
        if let Some(value) = v {
            rows.push(json!({ "key": k, "value": value }));
        }
    };
    push("尺寸", Some(format!("{}×{}", info.width, info.height)));
    push("格式", Some(info.format.clone()));
    push("体积", Some(format!("{:.2}MB", info.bytes as f64 / 1_048_576.0)));
    push("像素", Some(format!("{}MP", info.megapixels)));
    push("宽高比", Some(info.aspect.clone()));
    push("相机", exif.camera.clone());
    push("镜头", exif.lens.clone());
    push("拍摄时间", exif.datetime_original.clone());
    push("ISO", exif.iso.map(|v| v.to_string()));
    push("光圈", exif.f_number.map(|v| format!("f/{v:.1}")));
    push(
        "快门",
        exif.shutter_text(),
    );
    push("焦距", exif.focal_length_mm.map(|v| format!("{v:.0}mm")));
    push("软件", exif.software.clone());
    push("方向", exif.orientation.map(|v| v.to_string()));
    if exif.gps_present {
        push(
            "GPS",
            Some(if reveal {
                match &exif.gps {
                    Some(g) => format!("{:.5}, {:.5}", g.lat, g.lon),
                    None => "含 GPS（未解析）".into(),
                }
            } else {
                "含 GPS（默认脱敏，可点「显示位置」）".into()
            }),
        );
    }
    rows
}

// ---------------------------------------------------------------------------
// ffmpeg 执行 + 进度节流
// ---------------------------------------------------------------------------

struct Reporter {
    pool: sqlx::PgPool,
    id: Uuid,
    last_pct: i16,
    last_at: Instant,
}

impl Reporter {
    fn new(pool: sqlx::PgPool, id: Uuid) -> Self {
        Self {
            pool,
            id,
            last_pct: 0,
            last_at: Instant::now(),
        }
    }

    /// 节流写进度：Δ<5% 且距上次 <1s 时跳过（终态 99/100 必写）
    async fn report(&mut self, pct: i16) -> Result<(), AppError> {
        let pct = pct.clamp(0, 99);
        let big_enough = pct - self.last_pct >= PROGRESS_MIN_DELTA;
        let old_enough = self.last_at.elapsed() >= PROGRESS_MIN_INTERVAL;
        if pct <= self.last_pct || !(big_enough || old_enough) {
            return Ok(());
        }
        self.force(pct).await
    }

    async fn force(&mut self, pct: i16) -> Result<(), AppError> {
        self.last_pct = pct;
        self.last_at = Instant::now();
        tasks::set_progress(&self.pool, self.id, pct).await
    }

    /// 阶段边界：查 DB 是否已被取消
    async fn canceled(&self) -> Result<bool, AppError> {
        Ok(tasks::current_status(&self.pool, self.id)
            .await?
            .map(|s| s == status::CANCELED)
            .unwrap_or(true))
    }
}

async fn run_steps(
    inner: &Arc<Inner>,
    steps: &[CommandSpec],
    rep: &mut Reporter,
    base_pct: i16,
    span: i16,
) -> Result<(), AppError> {
    let total_w: f64 = steps
        .iter()
        .map(|s| if s.weight > 0.0 { s.weight } else { 0.001 })
        .sum::<f64>()
        .max(0.001);
    let cancel = Arc::new(Notify::new());
    let mut done_w = 0.0;

    for spec in steps {
        if rep.canceled().await? {
            cancel.notify_waiters();
            return Err(AppError::task_failed("任务已取消"));
        }
        let timeout = inner.settings.task_timeout();
        let outcome = inner
            .runner
            .run(spec, RunContext {
                timeout,
                cancel: cancel.clone(),
            })
            .await?;
        if !outcome.exit_ok {
            return Err(AppError::task_failed("处理未成功，可重试或调整参数"));
        }
        // 单步内部进度（runner 解析 out_time_ms 得到）先报一次，节流由 Reporter 负责
        if outcome.progress_pct > 0 {
            let inner_pct = base_pct
                + ((done_w / total_w) as f64 * span as f64) as i16
                + (span as f64 * (spec.weight.max(0.001) / total_w)
                    * (outcome.progress_pct as f64 / 100.0)) as i16;
            rep.report(inner_pct).await?;
        }
        done_w += if spec.weight > 0.0 { spec.weight } else { 0.001 };
        let ratio = (done_w / total_w).min(1.0);
        rep.report(base_pct + (ratio * span as f64) as i16).await?;
    }
    rep.force(base_pct + span).await?;
    Ok(())
}

/// 图片水印：单帧命令（`watermark_commands` 带 libx264 输出，不适合图片成品）
fn image_watermark_spec(
    input: &Path,
    output: &Path,
    logo: Option<&Path>,
    fontfile: &str,
    p: &WatermarkParams,
    in_w: i64,
    in_h: i64,
    quality: u8,
) -> CommandSpec {
    use crate::media::ffmpeg::{
        drawtext_filter, head_args, overlay_position_expressions, tiling_grid,
        MAX_WATERMARK_TILES,
    };
    let mut a = head_args();
    a.extend(["-i".into(), input.to_string_lossy().to_string()]);

    if p.kind == "logo" {
        let l = logo.unwrap_or_else(|| Path::new("logo.png"));
        a.extend(["-i".into(), l.to_string_lossy().to_string()]);
        let (x, y) = overlay_position_expressions(&p.position, p.margin_pct);
        a.extend([
            "-filter_complex".into(),
            format!(
                "[1:v]scale=iw*{:.4}:-1[wm];[0:v][wm]overlay=x={x}:y={y}[v]",
                p.logo_scale_pct / 100.0
            ),
            "-map".into(),
            "[v]".into(),
        ]);
    } else {
        let chain = if p.tiling {
            tiling_grid(in_w, in_h, p.tile_gap_px, MAX_WATERMARK_TILES)
                .into_iter()
                .map(|(x, y)| {
                    crate::media::ffmpeg::drawtext_filter_at(
                        fontfile,
                        &p.text,
                        p,
                        &x.to_string(),
                        &y.to_string(),
                    )
                })
                .collect::<Vec<_>>()
                .join(",")
        } else {
            drawtext_filter(fontfile, &p.text, p)
        };
        a.extend(["-vf".into(), chain]);
    }
    a.extend([
        "-frames:v".into(),
        "1".into(),
        "-q:v".into(),
        crate::media::ffmpeg::jpeg_qscale(quality as f64),
        output.to_string_lossy().to_string(),
    ]);
    CommandSpec::ffmpeg("image-watermark", a).with_output(output)
}

/// 图片水印参数适配（前端 `packageImage/pages/watermark` 的取值语义 → `WatermarkParams`）：
/// - `fontSize`：短边**千分比**（10~200）→ 输出高度**百分比**（1~30）
/// - `margin`：客户端按 `margin * 短边 / 900` 换算像素，这里 >30 时按同一比例回算百分比（0~30）
/// - `tile` → `tiling`（服务端参数名）
/// - 位置别名 `tc/bc/mc` → 九宫格的 `t/b/m`
/// - 图片没有时间轴：丢掉 `startSec/endSec`，否则 range 校验会报错
fn normalize_image_watermark_params(raw: &Value, w: i64, h: i64) -> Value {
    let mut obj = match raw.as_object().cloned() {
        Some(m) => m,
        None => serde_json::Map::new(),
    };
    let short = (w.min(h)).clamp(1, i64::from(u32::MAX)) as f64;
    if let Some(v) = obj.get("fontSize").and_then(|v| v.as_f64()) {
        if v > 30.0 {
            let pct = (v / short * 100.0).clamp(1.0, 30.0);
            obj.insert("fontSize".into(), json!(pct));
        }
    }
    if let Some(v) = obj.get("margin").and_then(|v| v.as_f64()) {
        if v > 30.0 {
            let pct = (v / 900.0 * 100.0).clamp(0.0, 30.0);
            obj.insert("margin".into(), json!(pct));
        }
    }
    if let Some(pos) = obj.get("position").and_then(|v| v.as_str()) {
        let mapped = match pos {
            "tc" => "t",
            "bc" => "b",
            "mc" => "m",
            other => other,
        };
        obj.insert("position".into(), json!(mapped));
    }
    if obj.get("tiling").is_none() {
        if let Some(tile) = obj.get("tile").cloned() {
            obj.insert("tiling".into(), tile);
        }
    }
    // 平铺间距：前端可能带 tileAngle（本实现按水平网格平铺，角度暂不支持），只透传 gap
    obj.remove("tileAngle");
    obj.remove("shadow");
    obj.remove("strokeWidth");
    obj.remove("startSec");
    obj.remove("endSec");
    Value::Object(obj)
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

async fn write_bytes(inner: &Arc<Inner>, ext: &str, bytes: &[u8]) -> Result<Produced, AppError> {
    let mut out = alloc(inner, ext)?;
    tokio::fs::write(&out.path, bytes)
        .await
        .map_err(|e| AppError::storage(anyhow::anyhow!(e)))?;
    out.mime = mime_of_ext(ext).to_string();
    out.name = format!("out.{ext}");
    out.label = "结果".to_string();
    Ok(out)
}

fn named(mut p: Produced, ext: &str, name: &str, label: &str) -> Produced {
    p.mime = mime_of_ext(ext).to_string();
    p.name = name.to_string();
    p.label = label.to_string();
    p
}

fn stem(task: &tasks::TaskRow, tag: &str) -> String {
    let tool = files::sanitize_file_name(&task.tool_id);
    format!("{tool}-{tag}-{}", &task.id.simple().to_string()[..8])
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "out.bin".to_string())
}

fn ext_of(path: &Path) -> String {
    path.extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_else(|| "bin".to_string())
}

async fn file_size_mb(path: &Path) -> Result<f64, AppError> {
    let len = tokio::fs::metadata(path)
        .await
        .map(|m| m.len() as f64)
        .map_err(|e| AppError::storage(anyhow::anyhow!(e)))?;
    Ok(len / 1_048_576.0)
}

fn cleanup_pass_log(prefix: &Path) {
    for suffix in ["0.log", "0.log.mbtree", "0.temp", "0.log.temp"] {
        let mut p = prefix.as_os_str().to_os_string();
        p.push(suffix);
        let _ = std::fs::remove_file(PathBuf::from(p));
    }
}

async fn probe_for(
    inner: &Arc<Inner>,
    params: &Params,
    input: &InputFile,
) -> Result<MediaInfo, AppError> {
    resolve_media_info(inner, params, &input.path).await
}

/// 媒体元信息（ffprobe 结果或 dry-run 合成值）
#[derive(Debug, Clone)]
pub struct MediaInfo {
    pub info: ProbeInfo,
    pub synthetic: bool,
}

impl MediaInfo {
    pub fn duration(&self) -> f64 {
        self.info.duration_sec
    }

    fn kv_rows(&self) -> Vec<Value> {
        let i = &self.info;
        let mut rows = vec![
            json!({"key":"容器格式","value": i.format.clone().unwrap_or_else(|| "未知".into())}),
            json!({"key":"视频编码","value": i.video_codec.clone().unwrap_or_else(|| "无".into())}),
            json!({"key":"时长","value": format!("{:.2}s", i.duration_sec)}),
            json!({"key":"宽高","value": format!("{}×{}", i.width, i.height)}),
            json!({"key":"帧率","value": if i.fps > 0.0 { format!("{:.2} fps", i.fps) } else { "未知".into() }}),
            json!({"key":"总码率","value": i.bitrate_kbps.map(|k| format!("{:.0} kbps", k)).unwrap_or_else(|| "未知".into())}),
            json!({"key":"文件体积","value": format!("{:.2}MB", i.size_bytes as f64 / 1_048_576.0)}),
            json!({"key":"音频流","value": if i.has_audio { format!("有（{}）", i.audio_codec.clone().unwrap_or_default()) } else { "无".into() }}),
            json!({"key":"旋转元数据","value": format!("{}°", i.rotation)}),
            json!({"key":"HDR 元信息","value": if i.has_hdr { "可能为 HDR" } else { "SDR" }}),
        ];
        if self.synthetic {
            rows.push(json!({"key":"数据来源","value":"开发模式占位值（MEDIA_DRY_RUN=1）"}));
        }
        rows
    }

    fn kv_map(&self) -> serde_json::Map<String, Value> {
        let mut m = serde_json::Map::new();
        for row in self.kv_rows() {
            if let (Some(k), Some(v)) = (row.get("key").and_then(|x| x.as_str()), row.get("value")) {
                m.insert(k.to_string(), v.clone());
            }
        }
        m
    }
}

// ---------------------------------------------------------------------------
// 测试（纯函数部分；需要 DB 的全链路在 tests/api_e2e.rs）
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worker_count_is_clamped() {
        // SAFETY: 单线程测试内串行修改进程环境变量供 worker_count() 读取，
        // Edition 2024 下 set_var/remove_var 为 unsafe（无并发 env 访问）。
        unsafe { std::env::remove_var("TASK_WORKERS") };
        assert_eq!(worker_count(), 2);
        unsafe { std::env::set_var("TASK_WORKERS", "99") };
        assert_eq!(worker_count(), MAX_WORKERS);
        unsafe { std::env::set_var("TASK_WORKERS", "0") };
        assert_eq!(worker_count(), 1);
        unsafe { std::env::set_var("TASK_WORKERS", "abc") };
        assert_eq!(worker_count(), 2);
        unsafe { std::env::remove_var("TASK_WORKERS") };
    }

    #[test]
    fn mime_and_extension_mapping() {
        assert_eq!(mime_of_ext("mp4"), "video/mp4");
        assert_eq!(mime_of_ext("gif"), "image/gif");
        assert_eq!(mime_of_ext("mp3"), "audio/mpeg");
        assert_eq!(mime_of_ext("bin"), "application/octet-stream");
    }

    #[test]
    fn stem_is_sanitized_and_short() {
        let task = tasks::TaskRow {
            id: Uuid::parse_str("3f2504e0-4f89-11d3-9a0c-0305e8001000").unwrap(),
            user_id: 1,
            tool_id: "../../vid compress".into(),
            task_type: "video-compress".into(),
            status: status::QUEUED.into(),
            input_file_id: None,
            output_file_id: None,
            params: json!({}),
            progress: 0,
            error_code: None,
            error_message: None,
            engine_used: None,
            cost_ms: None,
            bytes_in: None,
            bytes_out: None,
            created_at: chrono::Utc::now(),
            started_at: None,
            finished_at: None,
        };
        let s = stem(&task, "compressed");
        assert!(!s.contains('/'), "{s}");
        assert!(s.contains("compressed"));
    }

    #[test]
    fn watermark_param_adapter_maps_permille_and_aliases() {
        let raw = json!({
            "type": "text", "text": "示例", "fontSize": 32,
            "position": "tc", "strokeWidth": 3, "startSec": 5, "endSec": 9
        });
        let fixed = normalize_image_watermark_params(&raw, 1000, 800);
        let p = Params::new(fixed);
        let w = WatermarkParams::from_params(&p, 0.0).expect("valid watermark params");
        assert_eq!(w.position, "t");
        assert!((1.0..=30.0).contains(&w.font_size_pct), "{}", w.font_size_pct);
        assert_eq!(w.start_sec, 0.0);
        assert_eq!(w.end_sec, 0.0);
    }

    #[test]
    fn image_watermark_spec_is_single_frame_jpeg() {
        let p = WatermarkParams::from_params(
            &Params::new(json!({"text": "水印", "position": "br"})),
            0.0,
        )
        .unwrap();
        let spec = image_watermark_spec(
            Path::new("/tmp/in.jpg"),
            Path::new("/tmp/out.jpg"),
            None,
            "/fonts/Noto.ttf",
            &p,
            1200,
            800,
            90,
        );
        let joined = spec.describe();
        assert!(joined.contains("-frames:v 1"), "{joined}");
        assert!(joined.contains("drawtext"), "{joined}");
        assert!(!joined.contains("libx264"), "图片成品不该带视频编码器: {joined}");
        assert_eq!(spec.output.as_deref(), Some(Path::new("/tmp/out.jpg")));
    }

    #[test]
    fn media_info_kv_rows_are_readable_pairs() {
        let info = MediaInfo {
            info: ProbeInfo {
                format: Some("mp4".into()),
                duration_sec: 12.5,
                width: 1280,
                height: 720,
                fps: 30.0,
                video_codec: Some("h264".into()),
                has_audio: true,
                size_bytes: 5_242_880,
                bitrate_kbps: Some(3355.4),
                ..Default::default()
            },
            synthetic: false,
        };
        let rows = info.kv_rows();
        assert!(rows.len() >= 10);
        let map = info.kv_map();
        assert_eq!(map["宽高"], json!("1280×720"));
        assert_eq!(map["时长"], json!("12.50s"));
        assert_eq!(map["文件体积"], json!("5.00MB"));
        assert!(!map.contains_key("数据来源"));
    }
}

/// 元信息解析放在子模块里，便于 `resolve_media_info` 与 runner 注入解耦。
mod media_info {
    use super::*;

    /// `ffprobe` → 元信息。取值优先级：
    /// 1. runner 的真实 stdout（生产 ProcessRunner 修好后走这里）；
    /// 2. 前端参数里已探测到的 `durationSec/width/height/fps`（小程序本地探测）；
    /// 3. `MEDIA_DRY_RUN=1` 时合成占位值（本机无 ffmpeg 也能跑通全链路）；
    /// 4. 否则明确报 `ENGINE_UNAVAILABLE`（绝不返回假数据）。
    pub async fn resolve_media_info(
        inner: &Arc<Inner>,
        params: &Params,
        path: &Path,
    ) -> Result<MediaInfo, AppError> {
        let spec = probe_args(&path.to_string_lossy());
        let ctx = RunContext {
            timeout: inner.settings.task_timeout(),
            cancel: Arc::new(Notify::new()),
        };
        let stdout = match inner.runner.run(&spec, ctx).await {
            Ok(out) => out.stdout,
            Err(err) => {
                if inner.runner.is_dry_run() {
                    String::new()
                } else {
                    return Err(err);
                }
            }
        };
        if !stdout.trim().is_empty() {
            if let Ok(info) = parse_probe(&stdout) {
                if info.duration_sec > 0.0 || info.width > 0 {
                    return Ok(MediaInfo {
                        info: with_file_size(inner, path, info),
                        synthetic: false,
                    });
                }
            }
        }

        let from_client = client_probe(params, path);
        if let Some(info) = from_client {
            return Ok(MediaInfo {
                info,
                synthetic: false,
            });
        }
        if inner.runner.is_dry_run() {
            let info = ProbeInfo {
                format: Some("mp4".into()),
                duration_sec: 30.0,
                size_bytes: file_len(path),
                bitrate_kbps: Some(2000.0),
                width: 1280,
                height: 720,
                fps: 30.0,
                video_codec: Some("h264".into()),
                audio_codec: Some("aac".into()),
                has_audio: true,
                ..Default::default()
            };
            tracing::warn!(
                "MEDIA_DRY_RUN=1：ffprobe 元信息使用合成值（30s/1280x720/30fps）"
            );
            return Ok(MediaInfo {
                info,
                synthetic: true,
            });
        }
        Err(AppError::engine_unavailable(
            "无法读取视频元信息（ffprobe 未返回有效数据）",
        ))
    }

    fn client_probe(params: &Params, path: &Path) -> Option<ProbeInfo> {
        let duration = params
            .f64("durationSec")
            .or_else(|| params.f64("duration"))
            .filter(|v| *v > 0.0)?;
        Some(ProbeInfo {
            format: Some(ext_of(&path.to_path_buf()).to_string()),
            duration_sec: duration,
            size_bytes: file_len(path),
            bitrate_kbps: params.f64("bitrateKbps"),
            width: params.i64("width").unwrap_or(0).max(0) as u32,
            height: params.i64("height").unwrap_or(0).max(0) as u32,
            fps: params.f64("fps").unwrap_or(0.0),
            video_codec: params.get("videoCodec").and_then(|v| v.as_str()).map(String::from),
            audio_codec: params.get("audioCodec").and_then(|v| v.as_str()).map(String::from),
            sample_rate: params.i64("sampleRate").map(|v| v as u32),
            channels: params.i64("channels").map(|v| v as u32),
            rotation: params.i64("rotation").unwrap_or(0) as i32,
            has_audio: params.bool_or("hasAudio", true),
            has_hdr: params.bool_or("hasHdr", false),
        })
    }

    fn with_file_size(_inner: &Arc<Inner>, path: &Path, mut info: ProbeInfo) -> ProbeInfo {
        if info.size_bytes <= 0 {
            info.size_bytes = file_len(path);
        }
        info
    }

    fn file_len(path: &Path) -> i64 {
        std::fs::metadata(path).map(|m| m.len() as i64).unwrap_or(0)
    }
}
