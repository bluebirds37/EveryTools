//! 工具参数模型与校验（docs/tools-spec.md §2、FR-IMG-17）。
//!
//! 每个 `from_params` 做**取值范围校验**：越界返回 `PARAM_INVALID`（§0.3），
//! 保证 ffmpeg 只拿到合法参数；默认值严格对齐 spec 的 `名称 (类型) = 默认值` 表。

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::AppError;

/// FR-VID-01：时长 ≤600s
pub const MAX_VIDEO_SECONDS: f64 = 600.0;
/// FR-VID-04：GIF 片段上限 15s
pub const MAX_GIF_SECONDS: f64 = 15.0;
/// FR-VID-02：截取区间上限 600s
pub const MAX_TRIM_SECONDS: f64 = 600.0;
/// FR-IMG-17：单次合 PDF 最多 30 张
pub const MAX_PDF_IMAGES: usize = 30;
/// FR-VID-12：拼接 2–10 段
pub const CONCAT_MIN: usize = 2;
pub const CONCAT_MAX: usize = 10;

/// 参数读取辅助（JSON object）
#[derive(Debug, Clone)]
pub struct Params(Value);

impl Params {
    pub fn new(v: Value) -> Self {
        Params(if v.is_null() { Value::Object(Default::default()) } else { v })
    }

    pub fn raw(&self) -> &Value {
        &self.0
    }

    pub fn is_object(&self) -> bool {
        self.0.is_object()
    }

    pub fn get(&self, key: &str) -> Option<&Value> {
        self.0.get(key)
    }

    pub fn str_or(&self, key: &str, def: &str) -> String {
        self.0
            .get(key)
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| def.to_string())
    }

    pub fn f64(&self, key: &str) -> Option<f64> {
        self.0.get(key).and_then(|v| match v {
            Value::Number(n) => n.as_f64(),
            Value::String(s) => s.trim().parse::<f64>().ok(),
            _ => None,
        })
    }

    pub fn i64(&self, key: &str) -> Option<i64> {
        self.f64(key).map(|v| v.round() as i64)
    }

    pub fn bool_or(&self, key: &str, def: bool) -> bool {
        self.0.get(key).and_then(|v| v.as_bool()).unwrap_or(def)
    }

    /// 数值 + 闭区间校验（None → 默认值）
    pub fn num_in(
        &self,
        key: &str,
        def: f64,
        min: f64,
        max: f64,
    ) -> Result<f64, AppError> {
        match self.f64(key) {
            None => Ok(def),
            Some(v) if v.is_finite() && (min..=max).contains(&v) => Ok(v),
            Some(v) => Err(AppError::param_invalid(
                key,
                format!("应在 {min}~{max} 之间，收到 {v}"),
            )),
        }
    }

    /// 枚举校验
    ///
    /// 返回值借用 `self`（请求 JSON 里的字符串），因此把 `&self` 也纳入 `'a`：
    /// 调用方传的 `def`/`allowed` 是 `'static`，生命周期被 `Params` 的借用期限制。
    pub fn one_of<'a>(
        &'a self,
        key: &str,
        def: &'a str,
        allowed: &[&'a str],
    ) -> Result<&'a str, AppError> {
        match self.0.get(key) {
            None | Some(Value::Null) => Ok(def),
            Some(v) => {
                let s = match v {
                    Value::String(s) => s.as_str(),
                    other => {
                        return Err(AppError::param_invalid(
                            key,
                            format!("必须是字符串，收到 {}", other),
                        ));
                    }
                };
                if allowed.contains(&s) {
                    Ok(s)
                } else {
                    Err(AppError::param_invalid(
                        key,
                        format!("只允许 {:?}，收到 \"{s}\"", allowed),
                    ))
                }
            }
        }
    }

    pub fn string_array(&self, key: &str) -> Vec<String> {
        self.0
            .get(key)
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| match v {
                        Value::String(s) => Some(s.clone()),
                        _ => None,
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    /// `audioBitrate = "128k"` → 128
    pub fn audio_kbps(&self, key: &str, def: u32, allowed: &[u32]) -> Result<u32, AppError> {
        let raw = self.str_or(key, &format!("{def}k"));
        let parsed = raw
            .trim()
            .trim_end_matches('k')
            .trim_end_matches('K')
            .parse::<u32>()
            .map_err(|_| {
                AppError::param_invalid(key, format!("形如 128k，收到 \"{raw}\""))
            })?;
        if allowed.contains(&parsed) {
            Ok(parsed)
        } else {
            Err(AppError::param_invalid(
                key,
                format!("只允许 {:?}k，收到 {parsed}k", allowed),
            ))
        }
    }

    /// 起止时间校验（start < end ≤ duration）
    pub fn range_secs(
        &self,
        start_key: &str,
        end_key: &str,
        duration: f64,
        def_start: f64,
        def_end: f64,
        max_len: f64,
    ) -> Result<(f64, f64), AppError> {
        let start = self.num_in(start_key, def_start, 0.0, duration.max(0.0))?;
        let end = self.num_in(end_key, def_end.min(duration.max(start)), 0.0, duration.max(0.0))?;
        if end <= start {
            return Err(AppError::param_invalid(
                end_key,
                format!("必须大于 {start_key}（{start}s）"),
            ));
        }
        if end - start > max_len {
            return Err(AppError::param_invalid(
                end_key,
                format!("区间长度 {:.1}s 超过上限 {max_len}s", end - start),
            ));
        }
        Ok((start, end))
    }

    fn require_object(&self) -> Result<(), AppError> {
        if self.0.is_object() {
            Ok(())
        } else {
            Err(AppError::param_invalid(
                "params",
                "必须是 JSON 对象（见 docs/CONTRACT.md C8）",
            ))
        }
    }
}

// ---------------------------------------------------------------------------
// FR-VID-01 视频压缩
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompressParams {
    /// target | crf | bitrate
    pub mode: String,
    pub target_mb: f64,
    pub crf: f64,
    pub max_bitrate_kbps: Option<u32>,
    /// source | 1080p | 720p | 480p | 360p | custom
    pub resolution: String,
    /// 目标宽度（已解析，source=0 表示不改）
    pub target_width: u32,
    /// 0 = source
    pub fps: f64,
    pub preset: String,
    pub audio_kbps: u32,
    pub keep_audio: bool,
}

pub const AUDIO_KBPS_ALLOWED: &[u32] = &[64, 96, 128, 192];
pub const RESOLUTIONS: &[&str] = &["source", "1080p", "720p", "480p", "360p", "custom"];
pub const PRESETS: &[&str] = &[
    "ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow",
];
pub const COMPRESS_MODES: &[&str] = &["target", "crf", "bitrate"];

impl CompressParams {
    pub fn from_params(p: &Params) -> Result<Self, AppError> {
        p.require_object()?;
        let mode = p.one_of("mode", "target", COMPRESS_MODES)?.to_string();
        let target_mb = p.num_in("targetMB", 20.0, 5.0, 200.0)?;
        let crf = p.num_in("crf", 26.0, 18.0, 36.0)?;
        let max_bitrate_kbps = match p.get("maxBitrateKbps") {
            Some(v) if !v.is_null() => {
                let kbps = p
                    .num_in("maxBitrateKbps", 2000.0, 100.0, 20_000.0)?
                    .round() as u32;
                Some(kbps)
            }
            _ => None,
        };
        let resolution = p.one_of("resolution", "720p", RESOLUTIONS)?.to_string();
        let target_width = match resolution.as_str() {
            "source" => 0,
            "1080p" => 1920,
            "720p" => 1280,
            "480p" => 854,
            "360p" => 640,
            "custom" => {
                let w = p.num_in("customWidth", 1280.0, 128.0, 4096.0)?;
                w.round() as u32
            }
            other => {
                return Err(AppError::param_invalid(
                    "resolution",
                    format!("未知档位 {other}"),
                ));
            }
        };
        let fps = match p.get("fps") {
            None | Some(Value::Null) => 0.0,
            Some(Value::String(s)) if s == "source" => 0.0,
            _ => p.num_in("fps", 0.0, 1.0, 60.0)?,
        };
        let preset = p.one_of("preset", "medium", PRESETS)?.to_string();
        let audio_kbps = p.audio_kbps("audioBitrate", 128, AUDIO_KBPS_ALLOWED)?;
        let keep_audio = p.bool_or("keepAudio", true);

        if mode == "bitrate" && max_bitrate_kbps.is_none() {
            return Err(AppError::param_invalid(
                "maxBitrateKbps",
                "mode=bitrate 时必填（100~20000）",
            ));
        }
        Ok(Self {
            mode,
            target_mb,
            crf,
            max_bitrate_kbps,
            resolution,
            target_width,
            fps,
            preset,
            audio_kbps,
            keep_audio,
        })
    }
}

// ---------------------------------------------------------------------------
// FR-VID-02 视频截取
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrimParams {
    pub start_sec: f64,
    pub end_sec: f64,
    /// reencode | fastCut
    pub mode: String,
    pub fast_cut: bool,
}

impl TrimParams {
    pub fn from_params(p: &Params, duration: f64) -> Result<Self, AppError> {
        let default_end = 15.0f64.min(duration);
        let (start_sec, end_sec) = p.range_secs("startSec", "endSec", duration, 0.0, default_end, MAX_TRIM_SECONDS)?;
        let mode = p.one_of("mode", "重编码", &["重编码", "fastCut", "keyframe"])?;
        let fast_cut = mode != "重编码" || p.bool_or("fastCut", false);
        Ok(Self {
            start_sec,
            end_sec,
            mode: mode.to_string(),
            fast_cut,
        })
    }
}

// ---------------------------------------------------------------------------
// FR-VID-04 视频转 GIF
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GifParams {
    pub start_sec: f64,
    pub end_sec: f64,
    pub fps: f64,
    pub width: u32,
    /// 0 = 无限
    pub loop_count: i64,
    /// high | standard | economy（映射 palettegen stats_mode）
    pub quality: String,
    pub max_size_mb: f64,
}

impl GifParams {
    pub fn from_params(p: &Params, duration: f64) -> Result<Self, AppError> {
        let default_end = 5.0f64.min(duration.max(0.0));
        let (start_sec, end_sec) =
            p.range_secs("start", "end", duration, 0.0, default_end, MAX_GIF_SECONDS)?;
        let fps = p.num_in("fps", 12.0, 5.0, 25.0)?;
        let width = p.num_in("width", 480.0, 240.0, 720.0)?.round() as u32;
        let loop_count = p.num_in("loop", 0.0, 0.0, 10.0)?.round() as i64;
        let quality = p
            .one_of("quality", "标准", &["高", "标准", "省体积"])?
            .to_string();
        let max_size_mb = p.num_in("maxSizeMB", 8.0, 1.0, 30.0)?;
        Ok(Self {
            start_sec,
            end_sec,
            fps,
            width,
            loop_count,
            quality,
            max_size_mb,
        })
    }

    /// stats_mode：高=full，标准=diff，省体积=diff+单色调板
    pub fn stats_mode(&self) -> &'static str {
        match self.quality.as_str() {
            "高" => "full",
            _ => "diff",
        }
    }

    /// 超体积时自动降级阶梯（tools-spec FR-VID-04 规则）
    pub fn downgrade_ladder(&self) -> Vec<(f64, u32)> {
        let mut out = Vec::new();
        let mut fps = self.fps;
        let mut width = self.width;
        // 先降 fps（12→10→8→6→5），再降 width（-25%）
        while fps > 5.0 {
            fps = (fps - 2.0).max(5.0);
            out.push((fps, width));
            if fps <= 5.0 {
                break;
            }
        }
        while width > 240 {
            width = ((width as f64 * 0.75).round() as u32).max(240);
            out.push((self.fps, width));
            if width <= 240 {
                break;
            }
        }
        out
    }
}

// ---------------------------------------------------------------------------
// FR-VID-05 抽帧
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FramesParams {
    /// at | count | first
    pub mode: String,
    pub time_sec: f64,
    pub count: usize,
    pub format: String,
    pub quality: f64,
    /// 0 = source
    pub width: u32,
    pub contact_sheet: bool,
}

impl FramesParams {
    pub fn from_params(p: &Params, duration: f64) -> Result<Self, AppError> {
        let mode = p.one_of("mode", "at", &["at", "count", "first"])?.to_string();
        let time_sec = p.num_in("timeSec", 0.0, 0.0, duration.max(0.0))?;
        let count = p.num_in("count", 6.0, 1.0, 30.0)?.round() as usize;
        let format = p.one_of("format", "jpg", &["jpg", "png"])?.to_string();
        let quality = p.num_in("quality", 90.0, 1.0, 100.0)?;
        let width = p.num_in("width", 0.0, 0.0, 4096.0)?.round() as u32;
        let contact_sheet = p.bool_or("contactSheet", false);
        Ok(Self {
            mode,
            time_sec,
            count,
            format,
            quality,
            width,
            contact_sheet,
        })
    }
}

// ---------------------------------------------------------------------------
// FR-VID-07 提取音频
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioParams {
    /// mp3 | aac | m4a | wav
    pub format: String,
    pub bitrate_kbps: u32,
    /// 0 = source
    pub sample_rate_hz: u32,
    pub start_sec: f64,
    pub end_sec: Option<f64>,
    pub fade: bool,
}

pub const AUDIO_BITRATES: &[u32] = &[96, 128, 192, 320];

impl AudioParams {
    pub fn from_params(p: &Params, duration: f64) -> Result<Self, AppError> {
        let format = p
            .one_of("format", "mp3", &["mp3", "aac", "m4a", "wav"])?
            .to_string();
        let bitrate_kbps = p.audio_kbps("bitrate", 192, AUDIO_BITRATES)?;
        let sample_rate_hz = match p.get("sampleRate") {
            None | Some(Value::Null) => 0,
            Some(Value::String(s)) if s == "source" => 0,
            Some(_) => {
                // 数字形式（48000）与字符串形式（"48k" / "48000"）都必须生效，
                // 不能用 str_or（它只认字符串，会把数字静默丢掉）
                let raw = match p.get("sampleRate") {
                    Some(Value::String(s)) => s.clone(),
                    Some(Value::Number(n)) => n.to_string(),
                    _ => "44100".to_string(),
                };
                let v = raw
                    .trim()
                    .trim_end_matches('k')
                    .trim_end_matches('K')
                    .parse::<f64>()
                    .map_err(|_| AppError::param_invalid("sampleRate", "形如 44.1k 或 44100"))?;
                let hz = if v < 1000.0 { v * 1000.0 } else { v };
                if !(8_000.0..=96_000.0).contains(&hz) {
                    return Err(AppError::param_invalid(
                        "sampleRate",
                        "应在 8k~96k 之间",
                    ));
                }
                hz.round() as u32
            }
        };
        let start_sec = p.num_in("startSec", 0.0, 0.0, duration.max(0.0))?;
        let end_sec = match p.get("endSec") {
            None | Some(Value::Null) => None,
            _ => Some(p.num_in("endSec", duration.max(0.0), 0.0, duration.max(0.0))?
                .max(start_sec + 0.001)),
        };
        let fade = p.bool_or("fade", false);
        Ok(Self {
            format,
            bitrate_kbps,
            sample_rate_hz,
            start_sec,
            end_sec,
            fade,
        })
    }

    pub fn codec(&self) -> &'static str {
        match self.format.as_str() {
            "mp3" => "libmp3lame",
            "wav" => "pcm_s16le",
            _ => "aac",
        }
    }
}

// ---------------------------------------------------------------------------
// FR-VID-08 视频加水印
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatermarkParams {
    /// text | logo
    pub kind: String,
    pub text: String,
    /// 字号 = 输出高度的百分比（默认 5）
    pub font_size_pct: f64,
    pub color: String,
    pub opacity_pct: f64,
    pub border: bool,
    /// 9 宫格：tl/t/tr/ml/m/mr/bl/b/br
    pub position: String,
    /// 边距 = 宽度的百分比（默认 3）
    pub margin_pct: f64,
    pub start_sec: f64,
    pub end_sec: f64,
    pub tiling: bool,
    pub tile_gap_px: i64,
    /// type=logo 时：logo 相对输入宽度的缩放百分比（FR-IMG-05/FR-VID-08 logoScale=20%，5–60）
    pub logo_scale_pct: f64,
    /// type=logo 时：logo 文件 id
    pub logo_file_id: Option<String>,
}

pub const POSITIONS_9: &[&str] = &["tl", "t", "tr", "ml", "m", "mr", "bl", "b", "br"];

impl WatermarkParams {
    pub fn from_params(p: &Params, duration: f64) -> Result<Self, AppError> {
        let kind = p.one_of("type", "text", &["text", "logo"])?.to_string();
        let text = p.str_or("text", "");
        if kind == "text" && text.trim().is_empty() {
            return Err(AppError::param_invalid("text", "type=text 时水印文字不能为空"));
        }
        if text.chars().count() > 60 {
            return Err(AppError::param_invalid("text", "水印文字最多 60 字"));
        }
        let font_size_pct = p.num_in("fontSize", 5.0, 1.0, 30.0)?;
        let color = normalize_hex_color(&p.str_or("color", "#FFFFFF"))
            .ok_or_else(|| AppError::param_invalid("color", "必须是 #RRGGBB"))?;
        let opacity_pct = p.num_in("opacity", 60.0, 5.0, 100.0)?;
        let border = p.bool_or("border", true);
        let position = p
            .one_of("position", "br", POSITIONS_9)?
            .to_string();
        let margin_pct = p.num_in("margin", 3.0, 0.0, 30.0)?;
        let start_sec = p.num_in("startSec", 0.0, 0.0, duration.max(0.0))?;
        let end_sec = p.num_in("endSec", duration.max(0.0), start_sec, duration.max(0.0))?;
        let tiling = p.bool_or("tiling", false);
        let tile_gap_px = p.num_in("tileGap", 120.0, 20.0, 800.0)?.round() as i64;
        let logo_scale_pct = p.num_in("logoScale", 20.0, 5.0, 60.0)?;
        let logo_file_id = if kind == "logo" {
            let id = p.str_or("logoFileId", "");
            if id.trim().is_empty() {
                return Err(AppError::param_invalid("logoFileId", "type=logo 时必填"));
            }
            Some(id)
        } else {
            None
        };
        Ok(Self {
            kind,
            text,
            font_size_pct,
            color,
            opacity_pct,
            border,
            position,
            margin_pct,
            start_sec,
            end_sec,
            tiling,
            tile_gap_px,
            logo_scale_pct,
            logo_file_id,
        })
    }

    /// drawtext 的 alpha（0~1）
    pub fn alpha(&self) -> String {
        format!("{:.3}", self.opacity_pct / 100.0)
    }
}

pub fn normalize_hex_color(raw: &str) -> Option<String> {
    let s = raw.trim().trim_start_matches('#');
    if s.len() == 3 && s.chars().all(|c| c.is_ascii_hexdigit()) {
        let expanded: String = s.chars().flat_map(|c| [c, c]).collect();
        return Some(format!("#{}", expanded.to_uppercase()));
    }
    if s.len() == 6 && s.chars().all(|c| c.is_ascii_hexdigit()) {
        return Some(format!("#{}", s.to_uppercase()));
    }
    None
}

// ---------------------------------------------------------------------------
// FR-VID-09 转容器
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerParams {
    pub container: String,
    /// copy | libx264 | libx265 | vp9
    pub codec: String,
    pub faststart: bool,
}

pub const CONTAINERS: &[&str] = &["mp4", "mov", "mkv", "webm", "gif"];
pub const CODECS: &[&str] = &["copy", "libx264", "libx265", "vp9"];

impl ContainerParams {
    pub fn from_params(p: &Params) -> Result<Self, AppError> {
        let container = p.one_of("container", "mp4", CONTAINERS)?.to_string();
        let codec = p.one_of("codec", "copy", CODECS)?.to_string();
        let faststart = p.bool_or("faststart", true);
        Ok(Self {
            container,
            codec,
            faststart,
        })
    }
}

// ---------------------------------------------------------------------------
// FR-VID-10 旋转/翻转、FR-VID-11 倍速
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RotateParams {
    pub rotate: i64,
    pub flip_h: bool,
    pub flip_v: bool,
    pub reencode: bool,
}

impl RotateParams {
    pub fn from_params(p: &Params) -> Result<Self, AppError> {
        let rotate = p.num_in("rotate", 90.0, 0.0, 270.0)?.round() as i64;
        if !matches!(rotate, 0 | 90 | 180 | 270) {
            return Err(AppError::param_invalid(
                "rotate",
                "只支持 0/90/180/270 度",
            ));
        }
        Ok(Self {
            rotate,
            flip_h: p.bool_or("flipH", false),
            flip_v: p.bool_or("flipV", false),
            reencode: p.bool_or("reencode", true),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeedParams {
    pub speed: f64,
    pub mute: bool,
    /// 100 = 原始音量
    pub volume_pct: f64,
    pub pitch_keep: bool,
}

impl SpeedParams {
    pub fn from_params(p: &Params) -> Result<Self, AppError> {
        let speed = p.num_in("speed", 1.0, 0.5, 2.0)?;
        Ok(Self {
            speed,
            mute: p.bool_or("mute", false),
            volume_pct: p.num_in("volume", 100.0, 0.0, 400.0)?,
            pitch_keep: p.bool_or("pitchKeep", true),
        })
    }
}

// ---------------------------------------------------------------------------
// FR-VID-03 画面裁剪
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CropParams {
    /// 百分比（0~1）
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl CropParams {
    pub fn from_params(p: &Params) -> Result<Self, AppError> {
        // rect 优先：{x,y,w,h} 0~1
        if let Some(rect) = p.get("rect") {
            let g = |k: &str, d: f64| -> Result<f64, AppError> {
                match rect.get(k).and_then(|v| v.as_f64()) {
                    Some(v) if (0.0..=1.0).contains(&v) => Ok(v),
                    Some(v) => Err(AppError::param_invalid(
                        "rect",
                        format!("{k} 应为 0~1 的比例值，收到 {v}"),
                    )),
                    None => Ok(d),
                }
            };
            let x = g("x", 0.0)?;
            let y = g("y", 0.0)?;
            let w = g("w", 1.0)?;
            let h = g("h", 1.0)?;
            if x + w > 1.0001 || y + h > 1.0001 || w <= 0.0 || h <= 0.0 {
                return Err(AppError::param_invalid(
                    "rect",
                    format!("裁剪区越界：x={x} y={y} w={w} h={h}"),
                ));
            }
            return Ok(Self { x, y, w, h });
        }
        let ratio = p.one_of("ratio", "free", &["free", "1:1", "9:16", "16:9", "4:3"])?;
        // ratio 模式给居中最大框
        let (w, h) = match ratio {
            "1:1" => (0.5, 0.5),
            "9:16" => (0.28125, 0.5),
            "16:9" => (0.5, 0.28125),
            "4:3" => (0.4444, 0.3333),
            _ => (1.0, 1.0),
        };
        let x = (1.0 - w) / 2.0;
        let y = (1.0 - h) / 2.0;
        Ok(Self { x, y, w, h })
    }

    /// ffmpeg crop 表达式（tools-spec：crop=in_w*w:in_h*h:x*in_w:y*in_h）
    pub fn crop_filter(&self) -> String {
        format!(
            "crop=in_w*{:.6}:in_h*{:.6}:trunc(in_w*{:.6}/2)*2:trunc(in_h*{:.6}/2)*2",
            self.w, self.h, self.x, self.y
        )
    }
}

// ---------------------------------------------------------------------------
// FR-VID-12 拼接
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConcatParams {
    pub file_ids: Vec<String>,
    /// 归一化目标（0 = auto 取最小公共档）
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub transition: String,
    pub audio_align: String,
}

impl ConcatParams {
    pub fn from_params(p: &Params) -> Result<Self, AppError> {
        let file_ids = p.string_array("fileIds");
        if file_ids.len() < CONCAT_MIN || file_ids.len() > CONCAT_MAX {
            return Err(AppError::param_invalid(
                "fileIds",
                format!("拼接需要 {CONCAT_MIN}~{CONCAT_MAX} 段，收到 {}", file_ids.len()),
            ));
        }
        let width = p.num_in("width", 1280.0, 240.0, 4096.0)?.round() as u32;
        let height = p.num_in("height", 720.0, 240.0, 4096.0)?.round() as u32;
        let fps = p.num_in("fps", 30.0, 1.0, 60.0)?;
        let transition = p
            .one_of("transition", "none", &["none", "fade"])?
            .to_string();
        let audio_align = p
            .one_of("audioAlign", "保留各自", &["保留各自", "统一静音"])?
            .to_string();
        Ok(Self {
            file_ids,
            width,
            height,
            fps,
            transition,
            audio_align,
        })
    }

    pub fn mute_all(&self) -> bool {
        self.audio_align == "统一静音"
    }
}

// ---------------------------------------------------------------------------
// FR-IMG-17 图片转 PDF
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Image2PdfParams {
    pub file_ids: Vec<String>,
    /// A4 | A5 | Letter | auto
    pub page_size: String,
    /// auto | portrait | landscape
    pub orientation: String,
    pub margin_mm: f64,
    /// contain | cover
    pub fit: String,
    pub quality: f64,
    pub file_name: String,
}

pub const PDF_PAGE_SIZES: &[&str] = &["A4", "A5", "Letter", "auto"];
pub const PDF_ORIENTATIONS: &[&str] = &["auto", "portrait", "landscape"];
pub const PDF_FITS: &[&str] = &["contain", "cover"];

impl Image2PdfParams {
    pub fn from_params(p: &Params) -> Result<Self, AppError> {
        let file_ids = p.string_array("fileIds");
        if file_ids.is_empty() {
            return Err(AppError::input_empty());
        }
        if file_ids.len() > MAX_PDF_IMAGES {
            return Err(AppError::param_invalid(
                "fileIds",
                format!("一次最多 {MAX_PDF_IMAGES} 张，收到 {}", file_ids.len()),
            ));
        }
        let page_size = p.one_of("pageSize", "A4", PDF_PAGE_SIZES)?.to_string();
        let orientation = p
            .one_of("orientation", "auto", PDF_ORIENTATIONS)?
            .to_string();
        let margin_mm = p.num_in("margin", 10.0, 0.0, 20.0)?;
        let fit = p.one_of("fit", "contain", PDF_FITS)?.to_string();
        let quality = p.num_in("quality", 85.0, 10.0, 100.0)?;
        let file_name = {
            let raw = p.str_or("fileName", "images.pdf");
            let cleaned = crate::files::sanitize_file_name(&raw);
            if cleaned.is_empty() || cleaned == "unnamed" {
                "images.pdf".to_string()
            } else if cleaned.to_ascii_lowercase().ends_with(".pdf") {
                cleaned
            } else {
                format!("{cleaned}.pdf")
            }
        };
        Ok(Self {
            file_ids,
            page_size,
            orientation,
            margin_mm,
            fit,
            quality,
            file_name,
        })
    }

    /// 页面尺寸（pt）。A4=595.28x841.89, A5=419.53x595.28, Letter=612x792
    pub fn page_pt(&self) -> Option<(f64, f64)> {
        match self.page_size.as_str() {
            "A4" => Some((595.28, 841.89)),
            "A5" => Some((419.53, 595.28)),
            "Letter" => Some((612.0, 792.0)),
            _ => None, // auto：按图片自身尺寸
        }
    }

    /// mm → pt（页边距换算）
    pub fn margin_pt(&self) -> f64 {
        self.margin_mm * 72.0 / 25.4
    }

    /// 单图页面尺寸（考虑 orientation 与 fit）
    pub fn layout_for(&self, img_w: u32, img_h: u32) -> PdfLayout {
        let img_w = img_w.max(1) as f64;
        let img_h = img_h.max(1) as f64;
        let base = self.page_pt().unwrap_or((img_w, img_h));
        let landscape = match self.orientation.as_str() {
            "landscape" => true,
            "portrait" => false,
            _ => img_w > img_h, // auto
        };
        let (pw, ph) = if landscape { (base.1, base.0) } else { base };
        let m = self.margin_pt();
        let avail_w = (pw - 2.0 * m).max(1.0);
        let avail_h = (ph - 2.0 * m).max(1.0);
        let scale = match self.fit.as_str() {
            "cover" => (avail_w / img_w).max(avail_h / img_h),
            _ => (avail_w / img_w).min(avail_h / img_h),
        };
        PdfLayout {
            page_w: pw,
            page_h: ph,
            img_w: img_w * scale,
            img_h: img_h * scale,
            offset_x: (pw - img_w * scale) / 2.0,
            offset_y: (ph - img_h * scale) / 2.0,
            landscape,
            margin_pt: m,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PdfLayout {
    pub page_w: f64,
    pub page_h: f64,
    pub img_w: f64,
    pub img_h: f64,
    pub offset_x: f64,
    pub offset_y: f64,
    pub landscape: bool,
    /// 页边距（pt）：`fit=cover` 时用于裁切框
    pub margin_pt: f64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::Code;
    use serde_json::json;

    fn p(v: serde_json::Value) -> Params {
        Params::new(v)
    }

    // ---- FR-VID-01 ----

    #[test]
    fn compress_defaults_match_spec() {
        let c = CompressParams::from_params(&p(json!({}))).unwrap();
        assert_eq!(c.mode, "target");
        assert_eq!(c.target_mb, 20.0);
        assert_eq!(c.crf, 26.0);
        assert_eq!(c.resolution, "720p");
        assert_eq!(c.target_width, 1280);
        assert_eq!(c.preset, "medium");
        assert_eq!(c.audio_kbps, 128);
        assert!(c.keep_audio);
        assert_eq!(c.fps, 0.0, "fps=source → 0（不改）");
    }

    #[test]
    fn compress_rejects_out_of_range() {
        // targetMB 5~200
        let err = CompressParams::from_params(&p(json!({"targetMB": 300}))).unwrap_err();
        assert_eq!(err.code, Code::ParamInvalid);
        assert!(err.message.contains("targetMB"));
        // crf 18~36
        assert!(CompressParams::from_params(&p(json!({"crf": 40}))).is_err());
        // fps ≤60
        assert!(CompressParams::from_params(&p(json!({"fps": 120}))).is_err());
        // audioBitrate 白名单
        assert!(CompressParams::from_params(&p(json!({"audioBitrate": "123k"}))).is_err());
        // resolution 枚举
        assert!(CompressParams::from_params(&p(json!({"resolution": "2k"}))).is_err());
        // preset 枚举
        assert!(CompressParams::from_params(&p(json!({"preset": "insane"}))).is_err());
    }

    #[test]
    fn compress_accepts_string_numbers_and_custom_width() {
        let c = CompressParams::from_params(&p(json!({
            "mode": "bitrate",
            "maxBitrateKbps": "3500",
            "resolution": "custom",
            "customWidth": 1600,
            "audioBitrate": "96k",
            "fps": 30
        })))
        .unwrap();
        assert_eq!(c.max_bitrate_kbps, Some(3500));
        assert_eq!(c.target_width, 1600);
        assert_eq!(c.audio_kbps, 96);
        assert_eq!(c.fps, 30.0);
    }

    #[test]
    fn bitrate_mode_requires_max_bitrate() {
        let err = CompressParams::from_params(&p(json!({"mode": "bitrate"}))).unwrap_err();
        assert!(err.message.contains("maxBitrateKbps"));
    }

    #[test]
    fn resolution_ladder_widths() {
        for (r, w) in [("1080p", 1920u32), ("720p", 1280), ("480p", 854), ("360p", 640)] {
            let c = CompressParams::from_params(&p(json!({"resolution": r}))).unwrap();
            assert_eq!(c.target_width, w, "{r}");
        }
        let c = CompressParams::from_params(&p(json!({"resolution": "source"}))).unwrap();
        assert_eq!(c.target_width, 0);
    }

    // ---- FR-VID-02 ----

    #[test]
    fn trim_defaults_and_mode() {
        let t = TrimParams::from_params(&p(json!({})), 60.0).unwrap();
        assert_eq!(t.start_sec, 0.0);
        assert_eq!(t.end_sec, 15.0, "默认 min(15,duration)");
        assert!(!t.fast_cut);
        let fast = TrimParams::from_params(&p(json!({"mode": "fastCut"})), 60.0).unwrap();
        assert!(fast.fast_cut);
    }

    #[test]
    fn trim_rejects_inverted_range_and_over_length() {
        assert!(TrimParams::from_params(&p(json!({"startSec": 20, "endSec": 10})), 60.0).is_err());
        assert!(TrimParams::from_params(&p(json!({"startSec": 0, "endSec": 700})), 900.0).is_err());
        // endSec 不能超过 duration
        assert!(TrimParams::from_params(&p(json!({"startSec": 0, "endSec": 90})), 60.0).is_err());
    }

    // ---- FR-VID-04 ----

    #[test]
    fn gif_defaults_and_stats_mode() {
        let g = GifParams::from_params(&p(json!({})), 30.0).unwrap();
        assert_eq!(g.fps, 12.0);
        assert_eq!(g.width, 480);
        assert_eq!(g.loop_count, 0);
        assert_eq!(g.max_size_mb, 8.0);
        assert_eq!(g.stats_mode(), "diff");
        let hi = GifParams::from_params(&p(json!({"quality": "高"})), 30.0).unwrap();
        assert_eq!(hi.stats_mode(), "full");
        assert_eq!(g.end_sec - g.start_sec, 5.0, "默认 0~5s");
    }

    #[test]
    fn gif_rejects_over_15s_and_bad_ranges() {
        assert!(GifParams::from_params(&p(json!({"start": 0, "end": 20})), 60.0).is_err());
        assert!(GifParams::from_params(&p(json!({"fps": 30})), 60.0).is_err());
        assert!(GifParams::from_params(&p(json!({"width": 1200})), 60.0).is_err());
        assert!(GifParams::from_params(&p(json!({"loop": 20})), 60.0).is_err());
    }

    #[test]
    fn gif_downgrade_ladder_is_monotonic_and_bounded() {
        let g = GifParams::from_params(
            &p(json!({"fps": 12, "width": 480, "start": 0, "end": 5})),
            30.0,
        )
        .unwrap();
        let ladder = g.downgrade_ladder();
        assert!(!ladder.is_empty());
        for (fps, width) in &ladder {
            assert!(*fps >= 5.0 && *fps <= 12.0, "fps 越界 {fps}");
            assert!(*width >= 240 && *width <= 480, "width 越界 {width}");
        }
        // 首个降级必须比原参数更省
        assert!(ladder[0].0 < g.fps || ladder[0].1 < g.width);
    }

    // ---- FR-VID-05 ----

    #[test]
    fn frames_defaults() {
        let f = FramesParams::from_params(&p(json!({})), 60.0).unwrap();
        assert_eq!(f.mode, "at");
        assert_eq!(f.count, 6);
        assert_eq!(f.format, "jpg");
        assert_eq!(f.quality, 90.0);
        assert_eq!(f.width, 0);
        assert!(!f.contact_sheet);
        assert!(FramesParams::from_params(&p(json!({"count": 31})), 60.0).is_err());
    }

    // ---- FR-VID-07 ----

    #[test]
    fn audio_defaults_and_codec() {
        let a = AudioParams::from_params(&p(json!({})), 60.0).unwrap();
        assert_eq!(a.format, "mp3");
        assert_eq!(a.bitrate_kbps, 192);
        assert_eq!(a.sample_rate_hz, 0, "source");
        assert_eq!(a.codec(), "libmp3lame");
        let wav = AudioParams::from_params(&p(json!({"format": "wav"})), 60.0).unwrap();
        assert_eq!(wav.codec(), "pcm_s16le");
        let aac = AudioParams::from_params(&p(json!({"format": "m4a"})), 60.0).unwrap();
        assert_eq!(aac.codec(), "aac");
    }

    #[test]
    fn audio_sample_rate_accepts_k_notation() {
        let a = AudioParams::from_params(&p(json!({"sampleRate": "44.1k"})), 60.0).unwrap();
        assert_eq!(a.sample_rate_hz, 44100);
        let b = AudioParams::from_params(&p(json!({"sampleRate": 48000})), 60.0).unwrap();
        assert_eq!(b.sample_rate_hz, 48000);
        assert!(AudioParams::from_params(&p(json!({"sampleRate": "999k"})), 60.0).is_err());
        assert!(AudioParams::from_params(&p(json!({"bitrate": "200k"})), 60.0).is_err());
    }

    // ---- FR-VID-08 ----

    #[test]
    fn watermark_defaults_and_alpha() {
        let w = WatermarkParams::from_params(&p(json!({"text": "示例水印"})), 60.0).unwrap();
        assert_eq!(w.kind, "text");
        assert_eq!(w.position, "br");
        assert_eq!(w.font_size_pct, 5.0);
        assert_eq!(w.margin_pct, 3.0);
        assert_eq!(w.color, "#FFFFFF");
        assert_eq!(w.alpha(), "0.600");
        assert_eq!(w.end_sec, 60.0, "0=全程 → 覆盖整段");
    }

    #[test]
    fn watermark_rejects_empty_text_and_bad_color() {
        assert!(WatermarkParams::from_params(&p(json!({"text": "   "})), 60.0).is_err());
        assert!(WatermarkParams::from_params(&p(json!({"text": "a", "color": "red"})), 60.0).is_err());
        assert!(WatermarkParams::from_params(
            &p(json!({"text": "超长水印".repeat(20)})),
            60.0
        )
        .is_err());
        assert!(WatermarkParams::from_params(&p(json!({"type": "logo"})), 60.0).is_err());
    }

    #[test]
    fn color_normalization() {
        assert_eq!(normalize_hex_color("#fff").as_deref(), Some("#FFFFFF"));
        assert_eq!(normalize_hex_color("00aaff").as_deref(), Some("#00AAFF"));
        assert_eq!(normalize_hex_color("#12"), None);
    }

    // ---- FR-VID-09 / FR-VID-10 / FR-VID-11 ----

    #[test]
    fn container_defaults() {
        let c = ContainerParams::from_params(&p(json!({}))).unwrap();
        assert_eq!(c.container, "mp4");
        assert_eq!(c.codec, "copy");
        assert!(c.faststart);
        assert!(ContainerParams::from_params(&p(json!({"container": "avi"}))).is_err());
        assert!(ContainerParams::from_params(&p(json!({"codec": "av1"}))).is_err());
    }

    #[test]
    fn rotate_only_cardinal_angles() {
        assert_eq!(RotateParams::from_params(&p(json!({}))).unwrap().rotate, 90);
        assert!(RotateParams::from_params(&p(json!({"rotate": 45}))).is_err());
        assert!(RotateParams::from_params(&p(json!({"rotate": 360}))).is_err());
    }

    #[test]
    fn speed_range_matches_spec() {
        assert_eq!(SpeedParams::from_params(&p(json!({}))).unwrap().speed, 1.0);
        assert!(SpeedParams::from_params(&p(json!({"speed": 4.0}))).is_err());
        assert!(SpeedParams::from_params(&p(json!({"speed": 0.25}))).is_err());
        assert_eq!(
            SpeedParams::from_params(&p(json!({"volume": 250})))
                .unwrap()
                .volume_pct,
            250.0
        );
        assert!(SpeedParams::from_params(&p(json!({"volume": 500}))).is_err());
    }

    // ---- FR-VID-03 ----

    #[test]
    fn crop_rect_percent_validation() {
        let c = CropParams::from_params(&p(json!({"rect": {"x": 0.1, "y": 0.2, "w": 0.5, "h": 0.4} })))
            .unwrap();
        assert_eq!(c.x, 0.1);
        assert!(c.crop_filter().starts_with("crop=in_w*0.500000:in_h*0.400000:"));
        // 越界
        assert!(
            CropParams::from_params(&p(json!({"rect": {"x": 0.6, "y": 0.1, "w": 0.6, "h": 0.5} })))
                .is_err()
        );
        assert!(CropParams::from_params(&p(json!({"rect": {"x": 2.0} }))).is_err());
    }

    #[test]
    fn crop_ratio_gives_centered_box() {
        let c = CropParams::from_params(&p(json!({"ratio": "1:1"}))).unwrap();
        assert!((c.w - 0.5).abs() < 1e-6 && (c.x - 0.25).abs() < 1e-6);
        let full = CropParams::from_params(&p(json!({"ratio": "free"}))).unwrap();
        assert_eq!((full.x, full.y, full.w, full.h), (0.0, 0.0, 1.0, 1.0));
    }

    // ---- FR-VID-12 ----

    #[test]
    fn concat_requires_2_to_10_files() {
        assert!(ConcatParams::from_params(&p(json!({"fileIds": ["a"]}))).is_err());
        let ok = ConcatParams::from_params(&p(json!({"fileIds": ["a", "b"]}))).unwrap();
        assert_eq!(ok.file_ids.len(), 2);
        assert_eq!(ok.width, 1280);
        assert_eq!(ok.height, 720);
        assert!(!ok.mute_all());
        let muted =
            ConcatParams::from_params(&p(json!({"fileIds": ["a", "b"], "audioAlign": "统一静音"})))
                .unwrap();
        assert!(muted.mute_all());
        let too_many: Vec<String> = (0..11).map(|i| format!("f{i}")).collect();
        assert!(ConcatParams::from_params(&p(json!({"fileIds": too_many}))).is_err());
    }

    // ---- FR-IMG-17 ----

    #[test]
    fn image2pdf_defaults() {
        let s = Image2PdfParams::from_params(&p(json!({"fileIds": ["a", "b"]}))).unwrap();
        assert_eq!(s.page_size, "A4");
        assert_eq!(s.orientation, "auto");
        assert_eq!(s.margin_mm, 10.0);
        assert_eq!(s.fit, "contain");
        assert_eq!(s.quality, 85.0);
        assert_eq!(s.file_name, "images.pdf");
        assert_eq!(s.page_pt(), Some((595.28, 841.89)));
        // mm → pt
        assert!((s.margin_pt() - 28.35).abs() < 0.1);
    }

    #[test]
    fn image2pdf_file_limits_and_name() {
        assert!(Image2PdfParams::from_params(&p(json!({"fileIds": []}))).is_err());
        let many: Vec<String> = (0..31).map(|i| format!("f{i}")).collect();
        assert!(Image2PdfParams::from_params(&p(json!({"fileIds": many}))).is_err());
        let s = Image2PdfParams::from_params(&p(json!({
            "fileIds": ["a"], "fileName": "../evil", "pageSize": "A5", "orientation": "landscape"
        })))
        .unwrap();
        assert!(s.file_name.ends_with(".pdf"));
        assert!(!s.file_name.contains('/'));
        assert_eq!(s.page_pt(), Some((419.53, 595.28)));
        assert!(Image2PdfParams::from_params(&p(json!({"fileIds": ["a"], "margin": 25}))).is_err());
    }

    #[test]
    fn image2pdf_layout_contains_and_cover() {
        let contain = Image2PdfParams::from_params(&p(json!({"fileIds": ["a"]}))).unwrap();
        // 3000x2000 图放进 A4（auto → 横版）
        let l = contain.layout_for(3000, 2000);
        assert!(l.landscape);
        assert!(l.img_w <= l.page_w - 2.0 * contain.margin_pt() + 1e-6);
        assert!(l.img_h <= l.page_h - 2.0 * contain.margin_pt() + 1e-6);
        let cover = Image2PdfParams::from_params(&p(json!({"fileIds": ["a"], "fit": "cover"}))).unwrap();
        let lc = cover.layout_for(3000, 2000);
        assert!(lc.img_w >= l.img_w - 1e-6 || lc.img_h >= l.img_h - 1e-6, "cover 至少一边更大");
        // 居中偏移非负
        assert!(l.offset_x >= 0.0 && l.offset_y >= 0.0);
    }

    #[test]
    fn params_reject_non_object() {
        let err = CompressParams::from_params(&p(json!("nope"))).unwrap_err();
        assert_eq!(err.code, Code::ParamInvalid);
    }
}
