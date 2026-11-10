//! ffmpeg / ffprobe 适配层。
//!
//! 设计要点（本机没有 ffmpeg 也必须能编译/跑测试）：
//! 1. **参数构造是纯函数**：`build_*` 系列只产出 `Vec<CommandSpec>`（bin + args），
//!    不含 IO，全部按 FR 逐条单测（target 反算码率/2pass、`-ss/-to` 位置、palette 两步、
//!    `atempo` 级联、`setpts`、SAR 归一化等）。
//! 2. **执行走 [`CommandRunner`] trait**：真实实现 `ProcessRunner`（`tokio::process` +
//!    `kill_on_drop`），测试用 `MockRunner`，开发用 `DryRunRunner`（`MEDIA_DRY_RUN=1`），
//!    这样 ffmpeg 相关逻辑可以被完整 mock。
//! 3. 进度来自 `ffmpeg -progress pipe:1 -nostats`，解析 `out_time_ms`（见 [`progress_percent`]）。

use std::{path::PathBuf, sync::Arc, time::Duration};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::error::{AppError, Code};
use super::params::{
    AudioParams, CompressParams, ContainerParams, ConcatParams, CropParams, FramesParams,
    GifParams, RotateParams, SpeedParams, TrimParams, WatermarkParams,
};

/// 一条待执行的命令（纯数据，便于断言）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CommandSpec {
    /// "ffmpeg" | "ffprobe"（运行时替换为 FFMPEG_BIN/FFPROBE_BIN）
    pub bin: String,
    pub args: Vec<String>,
    /// 该步骤产物路径（用于 dry-run 占位与进度日志）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<PathBuf>,
    /// 人类可读标签：pass1/pass2/palettegen/paletteuse/frame-3/...
    pub label: String,
    /// 该步骤在整体任务中的权重（进度百分比归一化）
    pub weight: f64,
    /// 2pass 时需要的日志前缀（-passlogfile）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pass_log_prefix: Option<PathBuf>,
}

impl CommandSpec {
    pub fn ffmpeg(label: &str, args: Vec<String>) -> Self {
        // 先取最后一个参数作为产物路径，再移动 `args`（避免 move 后借用）
        let output = args.last().map(PathBuf::from);
        Self {
            bin: "ffmpeg".into(),
            args,
            output,
            label: label.into(),
            weight: 1.0,
            pass_log_prefix: None,
        }
    }

    pub fn with_output(mut self, path: impl Into<PathBuf>) -> Self {
        self.output = Some(path.into());
        self
    }

    pub fn with_weight(mut self, w: f64) -> Self {
        self.weight = w;
        self
    }

    /// 供前端「预计耗时」与日志使用
    pub fn describe(&self) -> String {
        format!("{} {}", self.bin, self.args.join(" "))
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct CommandOutcome {
    pub exit_ok: bool,
    pub stdout: String,
    pub stderr_tail: String,
    pub duration_ms: u64,
    /// 解析到的最大进度百分比（0~100）
    pub progress_pct: i16,
    /// 最终 out_time_ms（毫秒），用于跨 pass 累加
    pub out_time_ms: i64,
}

impl CommandOutcome {
    pub fn ok(progress_pct: i16, out_time_ms: i64) -> Self {
        Self {
            exit_ok: true,
            stdout: String::new(),
            stderr_tail: String::new(),
            duration_ms: 0,
            progress_pct,
            out_time_ms,
        }
    }
}

/// 可注入的命令执行器
#[async_trait]
pub trait CommandRunner: Send + Sync + 'static {
    async fn run(&self, spec: &CommandSpec, ctx: RunContext) -> Result<CommandOutcome, AppError>;
    /// 用于文案：是否真实执行 ffmpeg
    fn is_dry_run(&self) -> bool {
        false
    }
    fn name(&self) -> &'static str;
}

#[derive(Debug, Clone)]
pub struct RunContext {
    pub timeout: Duration,
    /// 取消信号：worker 收到 cancel 后置 true，runner 立刻 kill
    pub cancel: Arc<tokio::sync::Notify>,
}

impl RunContext {
    pub fn new(timeout: Duration) -> Self {
        Self {
            timeout,
            cancel: Arc::new(tokio::sync::Notify::new()),
        }
    }
}

/// 真实执行：`tokio::process`（requirements §8.1「调用 CLI，不用 ffmpeg-next」）
pub struct ProcessRunner {
    pub ffmpeg_bin: String,
    pub ffprobe_bin: String,
}

#[async_trait]
impl CommandRunner for ProcessRunner {
    async fn run(&self, spec: &CommandSpec, ctx: RunContext) -> Result<CommandOutcome, AppError> {
        use tokio::io::{AsyncBufReadExt, BufReader};
        use tokio::process::Command;

        let bin = match spec.bin.as_str() {
            "ffprobe" => self.ffprobe_bin.clone(),
            _ => self.ffmpeg_bin.clone(),
        };
        let started = std::time::Instant::now();
        let mut cmd = Command::new(&bin);
        cmd.args(&spec.args)
            .kill_on_drop(true)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        let mut child = cmd
            .spawn()
            .map_err(|err| AppError::engine_unavailable(format!("无法启动 {bin}：{err}")))?;

        let stdout_pipe = child.stdout.take().expect("piped stdout");
        let stderr_pipe = child.stderr.take().expect("piped stderr");

        let mut reader = BufReader::new(stdout_pipe).lines();
        let stderr_task = tokio::spawn(async move {
            use tokio::io::AsyncReadExt;
            let mut buf = Vec::new();
            let mut s = stderr_pipe;
            let _ = s.read_to_end(&mut buf).await;
            let text = String::from_utf8_lossy(&buf).to_string();
            let chars: Vec<char> = text.chars().collect();
            let take = chars.len().min(2000);
            chars[chars.len() - take..].iter().collect::<String>()
        });

        let wait = tokio::time::timeout(ctx.timeout, async {
            let mut out_ms: i64 = -1;
            // `progress=` 行只在成功退出时有意义（成功即 100%，见 CommandOutcome::progress_pct），
            // 这里保留解析以便后续按 out_time_ms 归一化进度。
            let mut _pct: i16 = 0;
            // ffprobe 的 JSON 从 stdout 读，因此整段输出必须保留（ffmpeg 的 -progress 输出很小）。
            let mut raw = String::new();
            while let Ok(Some(line)) = reader.next_line().await {
                raw.push_str(&line);
                raw.push('\n');
                if let Some(v) = line.strip_prefix("out_time_ms=") {
                    if let Ok(ms) = v.trim().parse::<i64>() {
                        out_ms = ms;
                    }
                } else if line.starts_with("progress=") {
                    _pct = 100;
                }
            }
            let status = child.wait().await.map_err(|e| anyhow::anyhow!(e));
            (out_ms, raw, status)
        })
        .await;

        let (out_time_ms, stdout, status) = match wait {
            Ok((ms, raw, status)) => (ms, raw, status),
            Err(_) => {
                let _ = child.kill().await;
                return Err(AppError::task_timeout().with_hint(format!(
                    "单步命令超过 {:?}，可缩短片段或降低分辨率",
                    ctx.timeout
                )));
            }
        };
        let status = status.map_err(|e| AppError::internal(anyhow::anyhow!(e)))?;
        let stderr_tail = stderr_task
            .await
            .map_err(|e| AppError::internal(anyhow::anyhow!(e)))?;

        if !status.success() {
            // 不透传 ffmpeg 原文给用户，只给「原因摘要」+ 进日志
            tracing::warn!(
                label = %spec.label,
                exit = ?status.code(),
                stderr = %tail_for_log(&stderr_tail),
                "ffmpeg exited non-zero"
            );
            return Err(map_ffmpeg_failure(&stderr_tail, status.code()));
        }

        Ok(CommandOutcome {
            exit_ok: true,
            // 必须把采集到的 stdout 原样返回：`resolve_media_info` 靠 ffprobe 的 JSON
            // 判时长/分辨率，这里丢空就等于「装了 ffmpeg 也读不出元信息」，
            // 只会退化成 ENGINE_UNAVAILABLE（dry-run 环境掩盖了它，真机才暴露）。
            stdout,
            stderr_tail,
            duration_ms: started.elapsed().as_millis() as u64,
            progress_pct: 100,
            out_time_ms,
        })
    }

    fn name(&self) -> &'static str {
        "ffmpeg"
    }
}

fn tail_for_log(s: &str) -> String {
    let one_line: String = s.chars().filter(|c| *c != '\n' && *c != '\r').collect();
    one_line.chars().take(300).collect()
}

/// 把 ffmpeg 失败输出映射到 §0.3 错误码（**不回显原文**）
pub fn map_ffmpeg_failure(stderr: &str, _code: Option<i32>) -> AppError {
    let lower = stderr.to_ascii_lowercase();
    if lower.contains("invalid data found when processing input")
        || lower.contains("decoder not found")
        || lower.contains("unknown codec")
    {
        return AppError::unsupported_format("编码或容器无法解码");
    }
    if lower.contains("no such file or directory") {
        return AppError::not_found();
    }
    if lower.contains("permission denied") {
        return AppError::forbidden("没有读取该文件的权限");
    }
    if lower.contains("audio encoding failed") || lower.contains("output file") {
        return AppError::task_failed("输出写入失败");
    }
    AppError::task_failed("视频编码未成功")
}

/// `MEDIA_DRY_RUN=1`：不执行 ffmpeg，写占位产物 + 返回满进度。
/// 用于本机（无 ffmpeg）跑通「创建任务→处理→成功」全链路与集成测试。
pub struct DryRunRunner {
    pub note: &'static str,
}

#[async_trait]
impl CommandRunner for DryRunRunner {
    async fn run(&self, spec: &CommandSpec, _ctx: RunContext) -> Result<CommandOutcome, AppError> {
        tracing::warn!(
            label = %spec.label,
            "MEDIA_DRY_RUN=1：跳过真实 ffmpeg（仅开发用，产物是占位文件）"
        );
        if let Some(out) = &spec.output {
            if let Some(parent) = out.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            // 占位产物：GIF 写 GIF 头，图片写 PNG 魔数，其它写一段可识别文本
            let bytes = dry_run_payload(out);
            std::fs::write(out, bytes)
                .map_err(|e| AppError::storage(anyhow::anyhow!(e)))?;
        }
        Ok(CommandOutcome {
            exit_ok: true,
            stdout: String::new(),
            stderr_tail: String::new(),
            duration_ms: 0,
            progress_pct: 100,
            out_time_ms: 0,
        })
    }

    fn is_dry_run(&self) -> bool {
        true
    }

    fn name(&self) -> &'static str {
        "ffmpeg"
    }
}

pub fn dry_run_payload(path: &std::path::Path) -> Vec<u8> {
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "gif" => b"GIF89a".to_vec(),
        "png" => vec![0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A],
        "jpg" | "jpeg" => vec![0xFF, 0xD8, 0xFF, 0xE0],
        "pdf" => b"%PDF-1.4 dry-run".to_vec(),
        "mp3" => b"ID3".to_vec(),
        _ => b"\0\0\0\x18ftypmp42dryrun".to_vec(),
    }
}

/// 可 Clone 的失败桩（`AppError` 本身不是 Clone，脚本化返回需要 Clone）
#[derive(Debug, Clone)]
pub struct FailureStub {
    pub status: axum::http::StatusCode,
    pub code: Code,
    pub message: String,
    pub hint: Option<String>,
}

impl FailureStub {
    pub fn new(code: Code, message: impl Into<String>) -> Self {
        Self {
            status: axum::http::StatusCode::UNPROCESSABLE_ENTITY,
            code,
            message: message.into(),
            hint: None,
        }
    }
    pub fn with_status(mut self, status: axum::http::StatusCode) -> Self {
        self.status = status;
        self
    }
    pub fn into_error(self) -> AppError {
        let mut err = AppError::new(self.status, self.code).with_message(self.message);
        if let Some(h) = self.hint {
            err = err.with_hint(h);
        }
        err
    }
}

/// 测试/桩执行器：记录调用顺序，按脚本返回结果
#[derive(Clone)]
pub struct MockRunner {
    pub calls: Arc<std::sync::Mutex<Vec<CommandSpec>>>,
    /// 每次调用的返回值（超出长度时重复最后一个）
    pub scripted: Vec<Result<CommandOutcome, FailureStub>>,
    pub index: Arc<std::sync::atomic::AtomicUsize>,
}

impl MockRunner {
    pub fn all_ok() -> Self {
        Self {
            calls: Arc::default(),
            scripted: vec![Ok(MockRunner::ok_outcome(100, 0))],
            index: Arc::default(),
        }
    }

    pub fn with_steps(scripted: Vec<Result<CommandOutcome, FailureStub>>) -> Self {
        Self {
            calls: Arc::default(),
            scripted,
            index: Arc::default(),
        }
    }

    pub fn ok_outcome(pct: i16, out_ms: i64) -> CommandOutcome {
        CommandOutcome {
            exit_ok: true,
            stdout: String::new(),
            stderr_tail: String::new(),
            duration_ms: 1,
            progress_pct: pct,
            out_time_ms: out_ms,
        }
    }

    pub fn recorded(&self) -> Vec<CommandSpec> {
        self.calls.lock().expect("mock mutex").clone()
    }

    pub fn recorded_args(&self) -> Vec<Vec<String>> {
        self.recorded().into_iter().map(|s| s.args).collect()
    }
}

#[async_trait]
impl CommandRunner for MockRunner {
    async fn run(&self, spec: &CommandSpec, _ctx: RunContext) -> Result<CommandOutcome, AppError> {
        self.calls.lock().expect("mock mutex").push(spec.clone());
        let i = self
            .index
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
            .min(self.scripted.len().saturating_sub(1));
        match &self.scripted[i] {
            Ok(out) => Ok(out.clone()),
            Err(stub) => Err(stub.clone().into_error()),
        }
    }

    fn name(&self) -> &'static str {
        "ffmpeg"
    }
}

/// 按配置选执行器：`MEDIA_DRY_RUN=1` → DryRunRunner，否则 ProcessRunner
pub fn build_runner(cfg: &crate::config::Settings) -> Arc<dyn CommandRunner> {
    if cfg.media_dry_run {
        tracing::warn!("MEDIA_DRY_RUN=1：ffmpeg 调用将以占位产物模拟（仅开发/CI 用）");
        Arc::new(DryRunRunner { note: "dry-run" })
    } else {
        Arc::new(ProcessRunner {
            ffmpeg_bin: cfg.ffmpeg_bin.clone(),
            ffprobe_bin: cfg.ffprobe_bin.clone(),
        })
    }
}

// ---------------------------------------------------------------------------
// 进度解析（requirements §8.4：`ffmpeg -progress pipe:1 -nostats` 的 out_time_ms）
// ---------------------------------------------------------------------------

/// 解析 `-progress pipe:1` 输出，返回 `Vec<out_time_ms>`（键值对形式）
pub fn parse_progress_out_times(stdout: &str) -> Vec<i64> {
    let mut out = Vec::new();
    for line in stdout.lines() {
        if let Some(v) = line.strip_prefix("out_time_ms=") {
            if let Ok(ms) = v.trim().parse::<i64>() {
                out.push(ms);
            }
        }
    }
    out
}

/// out_time_ms / 总时长(ms) → 0~99 的处理进度（100 由成功后的收尾统一给）
pub fn progress_percent(out_time_ms: i64, duration_ms: i64) -> i16 {
    if duration_ms <= 0 {
        return 0;
    }
    if out_time_ms <= 0 {
        return 0;
    }
    let pct = (out_time_ms as f64 / duration_ms as f64) * 100.0;
    pct.clamp(0.0, 99.0) as i16
}

/// 多步骤任务的加权进度
pub fn weighted_progress(steps: &[(f64, i16)]) -> i16 {
    let total_w: f64 = steps.iter().map(|(w, _)| *w).sum();
    if total_w <= 0.0 {
        return 0;
    }
    let acc: f64 = steps.iter().map(|(w, p)| w * (*p as f64)).sum();
    (acc / total_w).clamp(0.0, 100.0) as i16
}

/// `-progress pipe:1 -nostats` 公共参数（放在 `-i` 之后、输出之前）
pub fn progress_flags() -> Vec<String> {
    vec!["-nostats".into(), "-progress".into(), "pipe:1".into()]
}

pub const COMMON_HEAD: &[&str] = &["-hide_banner", "-loglevel", "error", "-y"];

pub fn head_args() -> Vec<String> {
    COMMON_HEAD.iter().map(|s| s.to_string()).collect()
}

/// ffprobe：结构化元信息
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ProbeInfo {
    pub format: Option<String>,
    pub duration_sec: f64,
    pub size_bytes: i64,
    pub bitrate_kbps: Option<f64>,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
    pub sample_rate: Option<u32>,
    pub channels: Option<u32>,
    pub rotation: i32,
    pub has_audio: bool,
    pub has_hdr: bool,
}

/// ffprobe 命令（`-print_format json`，FR-VID-06）
pub fn probe_args(path: &str) -> CommandSpec {
    CommandSpec {
        bin: "ffprobe".into(),
        args: vec![
            "-v".into(),
            "error".into(),
            "-print_format".into(),
            "json".into(),
            "-show_format".into(),
            "-show_streams".into(),
            path.into(),
        ],
        output: None,
        label: "probe".into(),
        weight: 0.0,
        pass_log_prefix: None,
    }
}

/// 解析 `ffprobe -print_format json`
pub fn parse_probe(json: &str) -> Result<ProbeInfo, AppError> {
    let v: serde_json::Value = serde_json::from_str(json)
        .map_err(|_| AppError::task_failed("无法读取视频信息"))?;
    let mut info = ProbeInfo::default();
    if let Some(fmt) = v.get("format") {
        info.format = fmt
            .get("format_name")
            .and_then(|s| s.as_str())
            .map(|s| s.to_string());
        info.duration_sec = fmt
            .get("duration")
            .and_then(|d| d.as_str().and_then(|s| s.parse().ok()).or_else(|| d.as_f64()))
            .unwrap_or(0.0);
        info.size_bytes = fmt
            .get("size")
            .and_then(|s| s.as_str().and_then(|v| v.parse().ok()).or_else(|| s.as_i64()))
            .unwrap_or(0);
        info.bitrate_kbps = fmt
            .get("bit_rate")
            .and_then(|b| b.as_str().and_then(|s| s.parse::<f64>().ok()).or_else(|| b.as_f64()))
            .map(|bps| bps / 1000.0);
    }
    let streams = v.get("streams").and_then(|s| s.as_array()).cloned().unwrap_or_default();
    for s in streams {
        let codec_type = s.get("codec_type").and_then(|t| t.as_str()).unwrap_or("");
        let codec_name = s.get("codec_name").and_then(|t| t.as_str()).map(|s| s.to_string());
        if codec_type == "video" && info.video_codec.is_none() {
            info.width = s.get("width").and_then(|w| w.as_u64()).unwrap_or(0) as u32;
            info.height = s.get("height").and_then(|h| h.as_u64()).unwrap_or(0) as u32;
            info.video_codec = codec_name;
            info.fps = parse_rate(s.get("avg_frame_rate").and_then(|r| r.as_str()))
                .or_else(|| parse_rate(s.get("r_frame_rate").and_then(|r| r.as_str())))
                .unwrap_or(0.0);
            info.rotation = extract_rotation(&s);
            if let Some(color) = s.get("color_transfer").and_then(|c| c.as_str()) {
                info.has_hdr = matches!(color, "smpte2084" | "arib-std-b67");
            }
        } else if codec_type == "audio" && !info.has_audio {
            info.has_audio = true;
            info.audio_codec = codec_name;
            info.sample_rate = s
                .get("sample_rate")
                .and_then(|r| r.as_str().and_then(|s| s.parse().ok()).or_else(|| r.as_u64()))
                .map(|v| v as u32);
            info.channels = s.get("channels").and_then(|c| c.as_u64()).map(|c| c as u32);
        }
    }
    Ok(info)
}

fn parse_rate(raw: Option<&str>) -> Option<f64> {
    let s = raw?;
    let (num, den) = s.split_once('/')?;
    let n: f64 = num.parse().ok()?;
    let d: f64 = den.parse().ok()?;
    if d == 0.0 {
        return None;
    }
    Some(n / d)
}

fn extract_rotation(stream: &serde_json::Value) -> i32 {
    if let Some(rot) = stream.get("side_data_list").and_then(|l| l.as_array()) {
        for item in rot {
            if let Some(r) = item.get("rotation").and_then(|v| v.as_i64()) {
                return r as i32;
            }
        }
    }
    stream
        .get("tags")
        .and_then(|t| t.get("rotate"))
        .and_then(|r| r.as_str().and_then(|s| s.parse::<i32>().ok()).or_else(|| r.as_i64().map(|v| v as i32)))
        .unwrap_or(0)
}

// ===========================================================================
// 命令构造（纯函数，逐条对应 tools-spec §2 的 FR）
// ===========================================================================

use std::path::Path;

/// target 模式反算视频码率（FR-VID-01 规则）
///
/// `视频码率(kbps) = (targetMB × 8192 ÷ 时长秒) − 音频码率`，再**向下取 5% 安全余量**。
/// 说明：1 MB = 8192 kb，故 `targetMB*8192/duration` 即总码率 kbps。
pub fn calc_target_video_kbps(
    target_mb: f64,
    duration_sec: f64,
    audio_kbps: u32,
    safety_margin_pct: f64,
) -> u32 {
    if target_mb <= 0.0 || duration_sec <= 0.0 {
        return 0;
    }
    let total_kbps = target_mb * 8192.0 / duration_sec;
    let video = total_kbps - audio_kbps as f64;
    let with_margin = video * (1.0 - safety_margin_pct / 100.0);
    // 下限保护：低于 100kbps 时压不出可用画面
    with_margin.floor().max(100.0) as u32
}

pub const TARGET_SAFETY_MARGIN_PCT: f64 = 5.0;

/// target 模式预估输出体积（MB），用于「约 xxMB」文案
pub fn estimate_output_mb(video_kbps: u32, audio_kbps: u32, duration_sec: f64) -> f64 {
    ((video_kbps + audio_kbps) as f64 * duration_sec) / 8192.0
}

/// 粗略耗时预估（秒）：1080p → 约 1.2× 时长（medium preset）
pub fn estimate_seconds(duration_sec: f64, width: u32, preset: &str) -> f64 {
    let resolution_factor = match width {
        0..=640 => 0.6,
        641..=1280 => 1.0,
        1281..=1920 => 1.4,
        _ => 2.2,
    };
    let preset_factor = match preset {
        "ultrafast" | "superfast" | "veryfast" => 0.5,
        "faster" | "fast" => 0.75,
        "medium" => 1.0,
        "slow" | "slower" | "veryslow" => 1.8,
        _ => 1.0,
    };
    (duration_sec * resolution_factor * preset_factor).max(3.0)
}

fn scale_filter(width: u32, fps: f64) -> Option<String> {
    if width == 0 && fps <= 0.0 {
        return None;
    }
    let mut parts = Vec::new();
    if width > 0 {
        // min(iw,W) 保证不放大；-2 保证高度为偶数（yuv420p 要求）
        parts.push(format!("scale='min(iw,{width})':-2:flags=bicubic"));
    }
    if fps > 0.0 {
        parts.push(format!("fps={}", trim_num(fps)));
    }
    Some(parts.join(","))
}

pub fn trim_num(v: f64) -> String {
    if (v - v.round()).abs() < 1e-6 {
        format!("{}", v.round() as i64)
    } else {
        format!("{v:.3}")
    }
}

/// FR-VID-01 视频压缩
pub fn compress_commands(
    input: &Path,
    output: &Path,
    pass_log: &Path,
    p: &CompressParams,
    duration_sec: f64,
) -> Vec<CommandSpec> {
    let mut cmds = Vec::new();
    let in_s = input.to_string_lossy().to_string();
    let out_s = output.to_string_lossy().to_string();
    let pass_s = pass_log.to_string_lossy().to_string();
    let vf = scale_filter(p.target_width, p.fps);
    let audio_args: Vec<String> = if p.keep_audio {
        vec![
            "-c:a".into(),
            "aac".into(),
            "-b:a".into(),
            format!("{}k", p.audio_kbps),
        ]
    } else {
        vec!["-an".into()]
    };

    match p.mode.as_str() {
        "target" => {
            let vkbps =
                calc_target_video_kbps(p.target_mb, duration_sec, p.audio_kbps, TARGET_SAFETY_MARGIN_PCT);
            // ---- pass 1：只出统计，不出音频 ----
            let mut a = head_args();
            a.extend(["-i".into(), in_s.clone()]);
            if let Some(vf) = &vf {
                a.extend(["-vf".into(), vf.clone()]);
            }
            a.extend([
                "-c:v".into(),
                "libx264".into(),
                "-preset".into(),
                p.preset.clone(),
                "-b:v".into(),
                format!("{vkbps}k"),
                "-pass".into(),
                "1".into(),
                "-passlogfile".into(),
                pass_s.clone(),
                "-an".into(),
                "-f".into(),
                "null".into(),
                "-".into(),
            ]);
            let mut pass1 = CommandSpec::ffmpeg("pass1", a).with_weight(0.45);
            pass1.pass_log_prefix = Some(pass_log.to_path_buf());
            cmds.push(pass1);

            // ---- pass 2：出成品 ----
            let mut b = head_args();
            b.extend(["-i".into(), in_s.clone()]);
            if let Some(vf) = &vf {
                b.extend(["-vf".into(), vf.clone()]);
            }
            b.extend([
                "-c:v".into(),
                "libx264".into(),
                "-preset".into(),
                p.preset.clone(),
                "-b:v".into(),
                format!("{vkbps}k"),
                "-pass".into(),
                "2".into(),
                "-passlogfile".into(),
                pass_s.clone(),
            ]);
            b.extend(audio_args.clone());
            b.extend(["-movflags".into(), "+faststart".into()]);
            b.push(out_s.clone());
            let mut pass2 = CommandSpec::ffmpeg("pass2", b).with_weight(0.55);
            pass2.pass_log_prefix = Some(pass_log.to_path_buf());
            pass2.output = Some(output.to_path_buf());
            cmds.push(pass2);
        }
        "crf" | "bitrate" => {
            let mut a = head_args();
            a.extend(["-i".into(), in_s]);
            if let Some(vf) = &vf {
                a.extend(["-vf".into(), vf.clone()]);
            }
            a.extend(["-c:v".into(), "libx264".into(), "-preset".into(), p.preset.clone()]);
            if p.mode == "crf" {
                a.extend(["-crf".into(), trim_num(p.crf)]);
            } else if let Some(k) = p.max_bitrate_kbps {
                a.extend(["-b:v".into(), format!("{k}k")]);
            }
            a.extend(audio_args);
            a.extend(["-movflags".into(), "+faststart".into()]);
            a.push(out_s);
            cmds.push(CommandSpec::ffmpeg("encode", a));
        }
        other => {
            tracing::error!(mode = other, "unknown compress mode reached builder");
        }
    }
    cmds
}

/// FR-VID-02 视频截取。重编码用 `-ss/-to`（输入侧精确定位），fastCut 用 `-c copy`。
pub fn trim_commands(input: &Path, output: &Path, p: &TrimParams) -> Vec<CommandSpec> {
    let mut a = head_args();
    a.extend([
        "-ss".into(),
        trim_num(p.start_sec),
        "-to".into(),
        trim_num(p.end_sec),
        "-i".into(),
        input.to_string_lossy().to_string(),
    ]);
    if p.fast_cut {
        a.extend([
            "-c".into(),
            "copy".into(),
            "-avoid_negative_ts".into(),
            "make_zero".into(),
        ]);
    } else {
        a.extend([
            "-c:v".into(),
            "libx264".into(),
            "-preset".into(),
            "veryfast".into(),
            "-crf".into(),
            "22".into(),
            "-c:a".into(),
            "aac".into(),
            "-b:a".into(),
            "128k".into(),
            "-movflags".into(),
            "+faststart".into(),
        ]);
    }
    a.push(output.to_string_lossy().to_string());
    let label = if p.fast_cut { "trim-copy" } else { "trim-reencode" };
    vec![CommandSpec::ffmpeg(label, a)]
}

/// FR-VID-03 画面裁剪（crop + 可选旋转/翻转）
pub fn crop_commands(input: &Path, output: &Path, crop: &CropParams, rotate: i64, flip_h: bool) -> Vec<CommandSpec> {
    let mut filters = vec![crop.crop_filter()];
    filters.extend(rotation_filters(rotate));
    if flip_h {
        filters.push("hflip".into());
    }
    let mut a = head_args();
    a.extend(["-i".into(), input.to_string_lossy().to_string()]);
    a.extend(["-vf".into(), filters.join(","), "-c:v".into(), "libx264".into(), "-crf".into(), "22".into(), "-c:a".into(), "copy".into()]);
    a.push(output.to_string_lossy().to_string());
    vec![CommandSpec::ffmpeg("crop", a)]
}

/// FR-VID-04 视频转 GIF：palettegen + paletteuse 两步
pub fn gif_commands(
    input: &Path,
    palette: &Path,
    output: &Path,
    p: &GifParams,
    fps: f64,
    width: u32,
) -> Vec<CommandSpec> {
    let in_s = input.to_string_lossy().to_string();
    let seek = vec![
        "-ss".to_string(),
        trim_num(p.start_sec),
        "-to".to_string(),
        trim_num(p.end_sec),
    ];
    let base_vf = format!("fps={},scale={width}:-1:flags=lanczos", trim_num(fps));

    // step1 palettegen
    let mut a = head_args();
    a.extend(seek.clone());
    a.extend(["-i".into(), in_s.clone()]);
    a.extend([
        "-vf".into(),
        format!("{base_vf},palettegen=stats_mode={}", p.stats_mode()),
    ]);
    if p.quality == "省体积" {
        a.extend(["-max_colors".into(), "64".into()]);
    }
    a.push(palette.to_string_lossy().to_string());
    // `gen` 是 edition 2024 保留字，改名 `palette_cmd`
    let mut palette_cmd = CommandSpec::ffmpeg("palettegen", a).with_weight(0.35);
    palette_cmd.output = Some(palette.to_path_buf());

    // step2 paletteuse
    let mut b = head_args();
    b.extend(seek);
    b.extend(["-i".into(), in_s, "-i".into(), palette.to_string_lossy().to_string()]);
    b.extend([
        "-lavfi".into(),
        format!("{base_vf}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5"),
        "-loop".into(),
        p.loop_count.to_string(),
    ]);
    b.push(output.to_string_lossy().to_string());
    let use_cmd = CommandSpec::ffmpeg("paletteuse", b).with_weight(0.65);
    vec![palette_cmd, use_cmd]
}

/// FR-VID-05 抽帧时间点公式：`duration * (i + 0.5) / count`（验收：误差 ≤0.5s）
pub fn frame_times(duration_sec: f64, count: usize) -> Vec<f64> {
    if count == 0 || duration_sec <= 0.0 {
        return vec![0.0];
    }
    (0..count)
        .map(|i| {
            let t = duration_sec * (i as f64 + 0.5) / count as f64;
            (t * 100.0).round() / 100.0
        })
        .collect()
}

pub fn frames_commands(
    input: &Path,
    out_dir: &Path,
    p: &FramesParams,
    duration_sec: f64,
) -> Vec<CommandSpec> {
    let in_s = input.to_string_lossy().to_string();
    let times: Vec<f64> = match p.mode.as_str() {
        "first" => vec![0.0],
        "count" => frame_times(duration_sec, p.count),
        _ => vec![p.time_sec],
    };
    let quality_arg = if p.format == "jpg" {
        vec!["-q:v".to_string(), jpeg_qscale(p.quality)]
    } else {
        vec![]
    };
    let width_arg = if p.width > 0 {
        format!(",scale={}:-2", p.width)
    } else {
        String::new()
    };
    let mut cmds = Vec::new();
    for (i, t) in times.iter().enumerate() {
        let out = out_dir.join(format!("frame_{:03}.{}", i + 1, p.format));
        let mut a = head_args();
        if *t > 0.0 {
            a.extend(["-ss".into(), trim_num(*t)]);
        }
        a.extend(["-i".into(), in_s.clone(), "-frames:v".into(), "1".into()]);
        if !width_arg.is_empty() {
            a.extend(["-vf".into(), width_arg.trim_start_matches(',').to_string()]);
        }
        a.extend(quality_arg.clone());
        a.extend(progress_flags());
        a.push(out.to_string_lossy().to_string());
        let w = 1.0 / times.len() as f64;
        cmds.push(CommandSpec::ffmpeg(&format!("frame-{}", i + 1), a).with_weight(w));
    }
    if p.contact_sheet {
        let n = times.len().max(1);
        let cols = (n as f64).sqrt().ceil() as usize;
        let rows = (n as f64 / cols as f64).ceil() as usize;
        let pattern = out_dir.join(format!("%0{}d.{}", 3, p.format));
        let mut a = head_args();
        a.extend([
            "-framerate".into(),
            "1".into(),
            "-i".into(),
            pattern.to_string_lossy().to_string(),
            "-vf".into(),
            format!("tile={cols}x{rows}"),
            "-frames:v".into(),
            "1".into(),
        ]);
        a.push(out_dir.join("contact_sheet.jpg").to_string_lossy().to_string());
        cmds.push(CommandSpec::ffmpeg("contact-sheet", a).with_weight(0.0));
    }
    cmds
}

/// 质量 1~100 → ffmpeg `-q:v` 2~31（越小越好）
pub fn jpeg_qscale(quality: f64) -> String {
    let q = quality.clamp(1.0, 100.0);
    let v = 31.0 - (q / 100.0) * 29.0;
    v.round().clamp(2.0, 31.0).to_string()
}

/// FR-VID-07 提取音频
pub fn audio_commands(input: &Path, output: &Path, p: &AudioParams) -> Vec<CommandSpec> {
    let mut a = head_args();
    if p.start_sec > 0.0 {
        a.extend(["-ss".into(), trim_num(p.start_sec)]);
    }
    a.extend(["-i".into(), input.to_string_lossy().to_string()]);
    if let Some(end) = p.end_sec {
        if end > p.start_sec {
            a.extend(["-t".into(), trim_num(end - p.start_sec)]);
        }
    }
    a.extend(["-vn".into(), "-c:a".into(), p.codec().to_string()]);
    if p.format != "wav" {
        a.extend(["-b:a".into(), format!("{}k", p.bitrate_kbps)]);
    }
    if p.sample_rate_hz > 0 {
        a.extend(["-ar".into(), p.sample_rate_hz.to_string()]);
    }
    if p.fade {
        // 结尾 3s 淡出（时长未知时用 st 由调用方补齐，这里给通用表达式）
        a.extend(["-af".into(), "afade=t=out:st=0:d=3".into()]);
    }
    a.push(output.to_string_lossy().to_string());
    vec![CommandSpec::ffmpeg("extract-audio", a)]
}

/// FR-VID-08 文字水印 drawtext 参数（按 9 宫格定位）
pub fn drawtext_filter(fontfile: &str, text: &str, p: &WatermarkParams) -> String {
    let (x, y) = position_expressions(&p.position, p.margin_pct);
    drawtext_filter_at(fontfile, text, p, &x, &y)
}

/// drawtext 滤镜（显式 x/y 表达式；平铺水印按像素偏移时复用）
pub fn drawtext_filter_at(fontfile: &str, text: &str, p: &WatermarkParams, x: &str, y: &str) -> String {
    let escaped = escape_drawtext(text);
    let mut f = format!("drawtext=fontfile={fontfile}:text='{escaped}'");
    f.push_str(&format!(":fontsize=h*{:.4}", p.font_size_pct / 100.0));
    f.push_str(&format!(":fontcolor={}@{}", p.color, p.alpha()));
    if p.border {
        f.push_str(":borderw=2:bordercolor=black@0.6:shadowx=2:shadowy=2:shadowcolor=black@0.4");
    }
    f.push_str(&format!(":x={x}:y={y}"));
    f
}

/// 时段水印的 `enable` 表达式（全程水印返回 None）
pub fn enable_expr(start_sec: f64, end_sec: f64, duration_sec: f64) -> Option<String> {
    let partial = start_sec > 0.0 || (duration_sec > 0.0 && end_sec < duration_sec - 0.01);
    partial.then(|| {
        format!(
            "enable='between(t,{},{})'",
            trim_num(start_sec),
            trim_num(end_sec.max(start_sec))
        )
    })
}

/// 给滤镜链尾部追加 `:enable=...`（空链返回空串）
fn with_enable(chain: &str, enable: Option<&str>) -> String {
    match (chain.is_empty(), enable) {
        (true, _) => String::new(),
        (_, None) => chain.to_string(),
        (false, Some(e)) => format!("{chain}:{e}"),
    }
}

/// 9 宫格位置 → drawtext 的 x/y 表达式（边距按画面宽度百分比）
pub fn position_expressions(position: &str, margin_pct: f64) -> (String, String) {
    let m = format!("w*{:.4}", margin_pct / 100.0);
    match position {
        "tl" => (m.clone(), m.clone()),
        "t" => ("(w-tw)/2".into(), m.clone()),
        "tr" => (format!("w-tw-{m}"), m.clone()),
        "ml" => (m.clone(), "(h-th)/2".into()),
        "m" => ("(w-tw)/2".into(), "(h-th)/2".into()),
        "mr" => (format!("w-tw-{m}"), "(h-th)/2".into()),
        "bl" => (m.clone(), format!("h-th-{m}")),
        "b" => ("(w-tw)/2".into(), format!("h-th-{m}")),
        _ => (format!("w-tw-{m}"), format!("h-th-{m}")),
    }
}

/// 9 宫格位置 → overlay 的 x/y 表达式（overlay 用 main_*/overlay_* 变量）
pub fn overlay_position_expressions(position: &str, margin_pct: f64) -> (String, String) {
    let m = format!("main_w*{:.4}", margin_pct / 100.0);
    match position {
        "tl" => (m.clone(), m.clone()),
        "t" => ("(main_w-overlay_w)/2".into(), m.clone()),
        "tr" => (format!("main_w-overlay_w-{m}"), m.clone()),
        "ml" => (m.clone(), "(main_h-overlay_h)/2".into()),
        "m" => ("(main_w-overlay_w)/2".into(), "(main_h-overlay_h)/2".into()),
        "mr" => (format!("main_w-overlay_w-{m}"), "(main_h-overlay_h)/2".into()),
        "bl" => (m.clone(), format!("main_h-overlay_h-{m}")),
        "b" => ("(main_w-overlay_w)/2".into(), format!("main_h-overlay_h-{m}")),
        _ => (format!("main_w-overlay_w-{m}"), format!("main_h-overlay_h-{m}")),
    }
}

/// 平铺水印网格：按输入尺寸与间距给出每个水印的像素左上角坐标。
/// 数量超过 `max_tiles` 时按列/行递减（避免滤镜链爆炸）。
pub const MAX_WATERMARK_TILES: i64 = 24;

pub fn tiling_grid(in_w: i64, in_h: i64, gap_px: i64, max_tiles: i64) -> Vec<(i64, i64)> {
    let (in_w, in_h) = (in_w.max(1), in_h.max(1));
    let gap = gap_px.max(20);
    let mut cols = (in_w / gap).clamp(1, max_tiles);
    let mut rows = (in_h / gap).clamp(1, max_tiles);
    while cols * rows > max_tiles.max(1) {
        if cols >= rows {
            cols -= 1;
        } else {
            rows -= 1;
        }
    }
    let step_x = in_w / cols;
    let step_y = in_h / rows;
    let mut out = Vec::with_capacity((cols * rows) as usize);
    for r in 0..rows {
        for c in 0..cols {
            out.push((c * step_x, r * step_y));
        }
    }
    out
}

/// drawtext 文本转义：`\` `:` `'` `%`（ffmpeg filter 语法要求）
pub fn escape_drawtext(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            ':' => out.push_str("\\:"),
            '\'' => out.push_str("\\'"),
            '%' => out.push_str("\\%"),
            '\n' | '\r' => out.push(' '),
            c => out.push(c),
        }
    }
    out
}

/// FR-VID-08 水印（文字 drawtext / logo overlay / 平铺 / 时段）
pub fn watermark_commands(
    input: &Path,
    output: &Path,
    logo: Option<&Path>,
    fontfile: &str,
    p: &WatermarkParams,
    duration_sec: f64,
    in_w: i64,
    in_h: i64,
) -> Vec<CommandSpec> {
    let enable = enable_expr(p.start_sec, p.end_sec, duration_sec);
    let mut a = head_args();
    a.extend(["-i".into(), input.to_string_lossy().to_string()]);

    if p.kind == "logo" {
        let l = logo.unwrap_or_else(|| Path::new("logo.png"));
        a.extend(["-i".into(), l.to_string_lossy().to_string()]);
        let (x, y) = overlay_position_expressions(&p.position, p.margin_pct);
        let ov_enable = enable.as_deref().unwrap_or("");
        let chain = if ov_enable.is_empty() {
            format!(
                "[1:v]scale=iw*{:.4}:-1[wm];[0:v][wm]overlay=x={x}:y={y}[v]",
                p.logo_scale_pct / 100.0
            )
        } else {
            format!(
                "[1:v]scale=iw*{:.4}:-1[wm];[0:v][wm]overlay=x={x}:y={y}:{ov_enable}[v]",
                p.logo_scale_pct / 100.0
            )
        };
        a.extend([
            "-filter_complex".into(),
            chain,
            "-map".into(),
            "[v]".into(),
            "-map".into(),
            "0:a?".into(),
            "-c:a".into(),
            "copy".into(),
        ]);
    } else {
        let chain = if p.tiling {
            tiling_grid(in_w, in_h, p.tile_gap_px, MAX_WATERMARK_TILES)
                .into_iter()
                .map(|(x, y)| drawtext_filter_at(fontfile, &p.text, p, &x.to_string(), &y.to_string()))
                .collect::<Vec<_>>()
                .join(",")
        } else {
            drawtext_filter(fontfile, &p.text, p)
        };
        a.extend(["-vf".into(), with_enable(&chain, enable.as_deref())]);
        a.extend(["-c:a".into(), "copy".into()]);
    }
    a.extend(["-c:v".into(), "libx264".into(), "-crf".into(), "23".into(), "-preset".into(), "veryfast".into()]);
    a.push(output.to_string_lossy().to_string());
    vec![CommandSpec::ffmpeg("watermark", a)]
}

/// FR-VID-09 容器转换。`copy` 只在同编码族允许，否则降级重编码（返回 downgraded=true）。
pub fn container_commands(
    input: &Path,
    output: &Path,
    p: &ContainerParams,
    source_video_codec: Option<&str>,
) -> (Vec<CommandSpec>, bool) {
    let mut a = head_args();
    a.extend(["-i".into(), input.to_string_lossy().to_string()]);
    let mut downgraded = false;
    let copy_ok = p.codec == "copy"
        && copy_compatible(&p.container, source_video_codec.unwrap_or("h264"));
    if p.codec == "copy" && !copy_ok {
        downgraded = true;
    }
    if copy_ok {
        a.extend(["-c".into(), "copy".into()]);
    } else {
        let vcodec = match p.codec.as_str() {
            _ if downgraded => "libx264",
            "libx265" => "libx265",
            "vp9" => "libvpx-vp9",
            _ => "libx264",
        };
        a.extend(["-c:v".into(), vcodec.into()]);
        if vcodec == "libvpx-vp9" {
            a.extend(["-b:v".into(), "0".into(), "-crf".into(), "32".into()]);
        } else {
            a.extend(["-crf".into(), "23".into(), "-preset".into(), "veryfast".into()]);
        }
        let acodec = match p.container.as_str() {
            "webm" => "libopus",
            "mkv" | "mp4" | "mov" => "aac",
            _ => "aac",
        };
        a.extend(["-c:a".into(), acodec.into()]);
    }
    if p.faststart && matches!(p.container.as_str(), "mp4" | "mov") {
        a.extend(["-movflags".into(), "+faststart".into()]);
    }
    a.push(output.to_string_lossy().to_string());
    (vec![CommandSpec::ffmpeg("remux", a)], downgraded)
}

/// copy 兼容性：容器与源编码族是否匹配
pub fn copy_compatible(container: &str, source_codec: &str) -> bool {
    let codec = source_codec.to_ascii_lowercase();
    match container {
        "mp4" | "mov" | "mkv" => !matches!(codec.as_str(), "vp8" | "vp9" | "av1"),
        "webm" => matches!(codec.as_str(), "vp8" | "vp9" | "opus" | "vorbis"),
        _ => false,
    }
}

/// FR-VID-10 旋转/翻转滤镜
pub fn rotation_filters(rotate: i64) -> Vec<String> {
    match rotate {
        90 => vec!["transpose=1".into()],
        180 => vec!["transpose=1".into(), "transpose=1".into()],
        270 => vec!["transpose=2".into()],
        _ => vec![],
    }
}

pub fn rotate_commands(input: &Path, output: &Path, p: &RotateParams) -> Vec<CommandSpec> {
    let mut a = head_args();
    a.extend(["-noautorotate".into(), "-i".into(), input.to_string_lossy().to_string()]);
    if p.reencode {
        let mut f = rotation_filters(p.rotate);
        if p.flip_h {
            f.push("hflip".into());
        }
        if p.flip_v {
            f.push("vflip".into());
        }
        if f.is_empty() {
            f.push("null".into());
        }
        a.extend(["-vf".into(), f.join(","), "-c:v".into(), "libx264".into(), "-crf".into(), "22".into(), "-preset".into(), "veryfast".into(), "-c:a".into(), "copy".into()]);
    } else {
        // 仅写元数据旋转（只对 mp4/mov 有效，builder 由调用方保证容器匹配）
        a.extend([
            "-c".into(),
            "copy".into(),
            "-metadata:s:v:0".into(),
            format!("rotate={}", p.rotate),
        ]);
    }
    a.extend(["-movflags".into(), "+faststart".into()]);
    a.push(output.to_string_lossy().to_string());
    vec![CommandSpec::ffmpeg(if p.reencode { "rotate-reencode" } else { "rotate-metadata" }, a)]
}

/// `atempo` 合法范围 0.5~2.0：超出级联多个 atempo（FR-VID-11）
pub fn atempo_chain(speed: f64) -> Vec<String> {
    if speed <= 0.0 {
        return vec!["atempo=1.000".into()];
    }
    let mut remaining = speed;
    let mut chain: Vec<f64> = Vec::new();
    while remaining > 2.0 + 1e-9 {
        chain.push(2.0);
        remaining /= 2.0;
    }
    while remaining < 0.5 - 1e-9 {
        chain.push(0.5);
        remaining /= 0.5;
    }
    chain.push(remaining);
    chain
        .iter()
        .map(|f| format!("atempo={:.3}", round_to_step(*f)))
        .collect()
}

fn round_to_step(v: f64) -> f64 {
    (v * 1000.0).round() / 1000.0
}

/// FR-VID-11 倍速/静音/音量
pub fn speed_commands(input: &Path, output: &Path, p: &SpeedParams) -> Vec<CommandSpec> {
    let speed = round_to_step(p.speed);
    let mut filter_complex = format!("[0:v]setpts=PTS/{speed}[v]");
    if !p.mute {
        let mut af: Vec<String> = atempo_chain(p.speed);
        if (p.volume_pct - 100.0).abs() > 0.01 {
            af.push(format!("volume={:.3}", p.volume_pct / 100.0));
        }
        filter_complex = format!("{filter_complex};[0:a]{}[a]", af.join(","));
    }
    let mut a = head_args();
    a.extend(["-i".into(), input.to_string_lossy().to_string()]);
    a.extend(["-filter_complex".into(), filter_complex, "-map".into(), "[v]".into()]);
    if p.mute {
        a.extend(["-an".into()]);
    } else {
        a.extend(["-map".into(), "[a]".into(), "-c:a".into(), "aac".into()]);
    }
    a.extend(["-c:v".into(), "libx264".into(), "-crf".into(), "23".into(), "-preset".into(), "veryfast".into()]);
    a.push(output.to_string_lossy().to_string());
    vec![CommandSpec::ffmpeg("speed", a)]
}

/// FR-VID-12 多段拼接：分辨率/帧率/SAR 归一化后 concat
pub fn concat_commands(inputs: &[PathBuf], output: &Path, p: &ConcatParams) -> Vec<CommandSpec> {
    let mut a = head_args();
    for i in inputs {
        a.extend(["-i".into(), i.to_string_lossy().to_string()]);
    }
    let mute = p.mute_all();
    let mut parts: Vec<String> = Vec::new();
    let mut concat_labels: Vec<String> = Vec::new();
    for (idx, _) in inputs.iter().enumerate() {
        parts.push(format!(
            "[{idx}:v]scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps={fps}[v{idx}]",
            w = p.width,
            h = p.height,
            fps = trim_num(p.fps)
        ));
        if mute {
            concat_labels.push(format!("[v{idx}]"));
        } else {
            parts.push(format!("[{idx}:a]aresample=48000[a{idx}]"));
            concat_labels.push(format!("[v{idx}][a{idx}]"));
        }
    }
    parts.push(format!(
        "{}concat=n={}:v=1:a={}{}",
        concat_labels.join(""),
        inputs.len(),
        if mute { 0 } else { 1 },
        if mute { "[v]" } else { "[v][a]" }
    ));
    a.extend([
        "-filter_complex".into(),
        parts.join(";"),
        "-map".into(),
        "[v]".into(),
    ]);
    if !mute {
        a.extend(["-map".into(), "[a]".into()]);
    }
    a.extend(["-c:v".into(), "libx264".into(), "-crf".into(), "23".into(), "-preset".into(), "veryfast".into()]);
    if !mute {
        a.extend(["-c:a".into(), "aac".into()]);
    }
    a.push(output.to_string_lossy().to_string());
    vec![CommandSpec::ffmpeg("concat", a)]
}

/// FR-VID-13 硬字幕压制（srt，字体走容器内 Noto CJK）
pub fn subtitle_commands(input: &Path, srt_path: &Path, output: &Path, fontfile: &str, font_size: u32, position: &str, margin_v: u32) -> Vec<CommandSpec> {
    let escaped_srt = srt_path.to_string_lossy().replace(':', r"\:");
    let align = match position {
        "top" => 6,
        "center" => 2,
        _ => 2,
    };
    let vf = format!(
        "subtitles='{escaped_srt}':force_style='FontName=Noto Sans CJK SC,Fontsize={font_size},PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,Outline=2,Alignment={align},MarginV={margin_v},FontFile={fontfile}'"
    );
    let mut a = head_args();
    a.extend(["-i".into(), input.to_string_lossy().to_string()]);
    a.extend(["-vf".into(), vf, "-c:v".into(), "libx264".into(), "-crf".into(), "23".into(), "-c:a".into(), "copy".into()]);
    a.push(output.to_string_lossy().to_string());
    vec![CommandSpec::ffmpeg("subtitle", a)]
}

/// SRT 时间轴校验（FR-VID-13：错误定位到第 N 条）
pub fn validate_srt(text: &str) -> Result<usize, (usize, &'static str)> {
    let mut idx = 0usize;
    let mut last_end: i64 = -1;
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        if line.contains("-->") {
            idx += 1;
            let mut it = line.split("-->");
            let start = it.next().unwrap_or("").trim();
            let end = it.next().unwrap_or("").trim();
            let (Some(s), Some(e)) = (parse_srt_time(start), parse_srt_time(end)) else {
                return Err((idx, "时间格式错误，应为 HH:MM:SS,mmm"));
            };
            if e <= s {
                return Err((idx, "结束时间必须晚于开始时间"));
            }
            if s < last_end {
                return Err((idx, "时间轴重叠/顺序错误"));
            }
            last_end = e;
        }
    }
    if idx == 0 {
        return Err((0, "缺少序号/时间行（未找到 -> 时间戳）"));
    }
    Ok(idx)
}

fn parse_srt_time(s: &str) -> Option<i64> {
    let head = s.split_whitespace().next()?;
    let (hms, ms) = head.split_once(',')?;
    let mut it = hms.split(':');
    let h: i64 = it.next()?.parse().ok()?;
    let m: i64 = it.next()?.parse().ok()?;
    let sec: i64 = it.next()?.parse().ok()?;
    let ms: i64 = ms.parse().ok()?;
    Some(h * 3_600_000 + m * 60_000 + sec * 1000 + ms)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    /// ProcessRunner 必须把子进程 stdout 原样带回：`resolve_media_info` 靠 ffprobe 的 JSON
    /// 判时长/分辨率，返回空串就等于「装了 ffmpeg 也读不出元信息」，只会退化成
    /// ENGINE_UNAVAILABLE —— 而 dry-run 环境恰好掩盖了这一点，只有真实镜像能暴露。
    /// 这里用 `/bin/echo` 冒充 ffprobe，不依赖镜像内的真 ffmpeg。
    #[tokio::test]
    async fn process_runner_forwards_stdout() {
        if !std::path::Path::new("/bin/echo").exists() {
            return;
        }
        let runner = ProcessRunner {
            ffmpeg_bin: "/bin/echo".into(),
            ffprobe_bin: "/bin/echo".into(),
        };
        let mut spec = probe_args("/tmp/no-such-file.mp4");
        // 去掉路径参数：echo 不会真去打开文件，只需证明参数透传 + stdout 采集
        spec.args.retain(|a| a.starts_with('-'));
        let out = runner
            .run(&spec, RunContext::new(Duration::from_secs(5)))
            .await
            .expect("echo 退出码 0");
        assert!(out.exit_ok);
        assert!(
            out.stdout.contains("-print_format") && out.stdout.contains("-show_streams"),
            "stdout 被丢弃了：{:#?}",
            out.stdout
        );
    }
}
