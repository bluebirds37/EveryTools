//! 图片类云端能力（tools-spec §1）：
//! - FR-IMG-01 图片压缩（`mode=size|quality|dimension`）
//! - FR-IMG-03 格式转换（jpg/png；透明按 `bgColor` 铺底）
//! - FR-IMG-10 图片信息 & EXIF（GPS 默认脱敏）
//!
//! 全部纯 Rust 编解码（`image` + `kamadak-exif`），不依赖本机任何 CLI 工具。

use std::{io::Cursor, path::Path};

use image::{
    codecs::{jpeg::JpegEncoder, png::PngEncoder},
    DynamicImage, ExtendedColorType, GenericImageView, ImageEncoder, ImageFormat, ImageReader,
    RgbImage,
};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, Code};

/// 超过该像素总数直接拒绝（防 OOM，`IMAGE_TOO_BIG`）
pub const MAX_IMAGE_PIXELS: u64 = 40_000_000;
/// 单图字节上限（FR-IMG-01 降级到云之后服务端再兜底）
pub const MAX_IMAGE_BYTES: u64 = 30 * 1024 * 1024;
pub const JPEG_QUALITY_MIN: u8 = 10;
pub const JPEG_QUALITY_MAX: u8 = 95;
/// 总像素超阈值时的降边长阶梯（FR-IMG-04 同源规则）
pub const SIDE_LADDER: &[u32] = &[8192, 4096, 3072, 2048, 1536, 1024];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageInfo {
    pub format: String,
    pub mime: String,
    pub width: u32,
    pub height: u32,
    pub bytes: u64,
    pub megapixels: f64,
    /// 宽高比展示（如 "3:2"）
    pub aspect: String,
    pub orientation: Option<u32>,
}

impl ImageInfo {
    pub fn new(fmt: ImageFormat, width: u32, height: u32, bytes: u64) -> Self {
        let (format, mime) = format_names(fmt);
        Self {
            format: format.to_string(),
            mime: mime.to_string(),
            width,
            height,
            bytes,
            megapixels: round2((width as f64 * height as f64) / 1_000_000.0),
            aspect: aspect_of(width, height),
            orientation: None,
        }
    }
}

pub fn format_names(fmt: ImageFormat) -> (&'static str, &'static str) {
    match fmt {
        ImageFormat::Jpeg => ("jpg", "image/jpeg"),
        ImageFormat::Png => ("png", "image/png"),
        ImageFormat::Gif => ("gif", "image/gif"),
        ImageFormat::WebP => ("webp", "image/webp"),
        ImageFormat::Bmp => ("bmp", "image/bmp"),
        ImageFormat::Tiff => ("tiff", "image/tiff"),
        ImageFormat::Ico => ("ico", "image/vnd.microsoft.icon"),
        _ => ("bin", "application/octet-stream"),
    }
}

fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

/// 宽高比：先按 gcd 化简，超过 999 则退化为 `x.xx:1`
pub fn aspect_of(width: u32, height: u32) -> String {
    if width == 0 || height == 0 {
        return "0:0".to_string();
    }
    let g = gcd(width, height).max(1);
    let (w, h) = (width / g, height / g);
    if w > 999 || h > 999 {
        return format!("{:.2}:1", width as f64 / height as f64);
    }
    format!("{w}:{h}")
}

fn gcd(a: u32, b: u32) -> u32 {
    if b == 0 { a } else { gcd(b, a % b) }
}

/// 解码 + 像素/体积保护。返回 `(图像, 实际格式)`。
pub fn decode(path: &Path) -> Result<(DynamicImage, ImageFormat), AppError> {
    let meta = std::fs::metadata(path).map_err(|_| AppError::not_found())?;
    if meta.len() > MAX_IMAGE_BYTES {
        return Err(AppError::image_too_big(format!(
            "图片 {}MB 超过服务端上限 {}MB",
            meta.len() / 1_048_576,
            MAX_IMAGE_BYTES / 1_048_576
        )));
    }
    let reader = ImageReader::open(path)
        .map_err(|_| AppError::not_found())?
        .with_guessed_format()
        .map_err(|_| AppError::unsupported_format("无法识别图片格式"))?;
    let guessed = reader.format();
    let img = reader.decode().map_err(|e| {
        tracing::debug!(err = %e, "image decode failed");
        AppError::new(
            axum::http::StatusCode::UNPROCESSABLE_ENTITY,
            Code::UnsupportedFormat,
        )
        .with_message("图片解码失败，可能已损坏或格式不支持")
    })?;
    let (w, h) = img.dimensions();
    check_pixel_budget(w, h)?;
    Ok((img, guessed.unwrap_or(ImageFormat::Png)))
}

pub fn check_pixel_budget(width: u32, height: u32) -> Result<(), AppError> {
    let px = width as u64 * height as u64;
    if px > MAX_IMAGE_PIXELS {
        return Err(AppError::image_too_big(format!(
            "图片像素 {width}×{height}（约 {}MP）超过上限 {}MP，请先缩小尺寸",
            (px as f64 / 1_000_000.0).round(),
            MAX_IMAGE_PIXELS / 1_000_000
        )));
    }
    Ok(())
}

/// 沿阶梯找出第一个能容纳源图的边长（FR-IMG-04「逐级降 maxSide 重试」）
pub fn ladder_for(width: u32, height: u32, max_side: u32) -> Vec<u32> {
    let long = width.max(height).max(1);
    let start = if max_side > 0 {
        max_side.min(long)
    } else {
        long
    };
    let mut out: Vec<u32> = SIDE_LADDER.iter().copied().filter(|s| *s <= start).collect();
    if out.first().copied().unwrap_or(0) > start {
        out.insert(0, start);
    }
    if out.is_empty() {
        out.push(start);
    }
    out
}

/// 等比缩到最长边 `max_side`（0 = 原样）
pub fn resize_max_side(img: &DynamicImage, max_side: u32) -> DynamicImage {
    if max_side == 0 {
        return img.clone();
    }
    let (w, h) = img.dimensions();
    if w.max(h) <= max_side {
        return img.clone();
    }
    let (nw, nh) = if w >= h {
        (
            max_side,
            ((h as f64 * max_side as f64) / w as f64).round().max(1.0) as u32,
        )
    } else {
        (
            ((w as f64 * max_side as f64) / h as f64).round().max(1.0) as u32,
            max_side,
        )
    };
    img.thumbnail_exact(nw, nh)
}

/// 透明像素按 `bgColor` 铺底（FR-IMG-03：png→jpg 不得出现黑底）
pub fn flatten_with_bg(img: &DynamicImage, bg: (u8, u8, u8)) -> RgbImage {
    let rgba = img.to_rgba8();
    let (w, h) = rgba.dimensions();
    let mut base = RgbImage::from_pixel(w, h, image::Rgb([bg.0, bg.1, bg.2]));
    for (x, y, px) in rgba.enumerate_pixels() {
        let a = px.0[3] as f32 / 255.0;
        let mixed = image::Rgb([
            (px.0[0] as f32 * a + bg.0 as f32 * (1.0 - a)).round() as u8,
            (px.0[1] as f32 * a + bg.1 as f32 * (1.0 - a)).round() as u8,
            (px.0[2] as f32 * a + bg.2 as f32 * (1.0 - a)).round() as u8,
        ]);
        base.put_pixel(x, y, mixed);
    }
    base
}

pub fn encode_jpeg(img: &DynamicImage, quality: u8) -> Result<Vec<u8>, AppError> {
    let rgb = img.to_rgb8();
    let mut buf = Vec::new();
    // image 0.25：`write_image` 属于 `ImageEncoder` trait（按值消费 encoder）
    JpegEncoder::new_with_quality(&mut buf, quality.max(1))
        .write_image(
            rgb.as_raw(),
            rgb.width(),
            rgb.height(),
            ExtendedColorType::Rgb8,
        )
        .map_err(|e| AppError::task_failed(format!("图片编码失败：{}", short_err(&e.to_string()))))?;
    Ok(buf)
}

pub fn encode_png(img: &DynamicImage) -> Result<Vec<u8>, AppError> {
    let rgba = img.to_rgba8();
    let mut buf = Vec::new();
    PngEncoder::new(&mut buf)
        .write_image(
            rgba.as_raw(),
            rgba.width(),
            rgba.height(),
            ExtendedColorType::Rgba8,
        )
        .map_err(|e| AppError::task_failed(format!("图片编码失败：{}", short_err(&e.to_string()))))?;
    Ok(buf)
}

/// `#RRGGBB` / `#RGB` → (r,g,b)
pub fn hex_to_rgb(raw: &str) -> Option<(u8, u8, u8)> {
    let s = raw.trim().trim_start_matches('#');
    let byte = |r: std::ops::Range<usize>| u8::from_str_radix(&s[r], 16).ok();
    match s.len() {
        3 => {
            let (r, g, b) = (byte(0..1)?, byte(1..2)?, byte(2..3)?);
            Some((r * 17, g * 17, b * 17))
        }
        6 => {
            let (r, g, b) = (byte(0..2)?, byte(2..4)?, byte(4..6)?);
            Some((r, g, b))
        }
        _ => None,
    }
}

/// 目标体积模式的质量二分：**取「体积 ≤ 目标」的最高质量**（FR-IMG-01 mode=size）。
///
/// 纯函数：`encode(q)` 给出该质量下的字节数（真实调用传编码闭包，单测传假函数）。
/// 返回 `(质量, 体积, 是否达标)`；最低质量仍超目标时返回 `(lo, size, false)`，
/// 由调用方回 `OVER_TARGET_NOT_REACHABLE` 语义的提示。
pub fn pick_quality_for_target(
    target_bytes: usize,
    lo: u8,
    hi: u8,
    mut encode: impl FnMut(u8) -> Result<Vec<u8>, AppError>,
) -> Result<(u8, usize, bool), AppError> {
    if lo >= hi {
        let only = encode(lo.max(hi))?;
        return Ok((lo.max(hi), only.len(), only.len() <= target_bytes));
    }
    let smallest = encode(lo)?;
    if smallest.len() > target_bytes {
        return Ok((lo, smallest.len(), false));
    }
    let largest = encode(hi)?;
    if largest.len() <= target_bytes {
        return Ok((hi, largest.len(), true));
    }
    let (mut low, mut high) = (lo, hi);
    let mut best = (lo, smallest.len(), true);
    while low + 1 < high {
        let mid = low + (high - low) / 2;
        let bytes = encode(mid)?;
        if bytes.len() <= target_bytes {
            best = (mid, bytes.len(), true);
            low = mid;
        } else {
            high = mid;
        }
    }
    Ok(best)
}

/// FR-IMG-03 格式转换输出：`(字节, mime, 扩展名)`。
/// webp 编码本期 `image` 库不支持 → 明确 503（不静默降级成 png）。
pub fn convert_format(
    img: &DynamicImage,
    to: &str,
    bg: (u8, u8, u8),
    quality: u8,
) -> Result<(Vec<u8>, &'static str, &'static str), AppError> {
    match to {
        "jpg" | "jpeg" => {
            let flat = DynamicImage::ImageRgb8(flatten_with_bg(img, bg));
            Ok((encode_jpeg(&flat, quality)?, "image/jpeg", "jpg"))
        }
        "png" => Ok((encode_png(img)?, "image/png", "png")),
        "webp" => Err(AppError::engine_unavailable(
            "WebP 编码暂未开放（服务端图片库未含 WebP 编码器），可先转 PNG",
        )),
        other => Err(AppError::param_invalid("toFormat", format!("未知目标格式 {other}"))),
    }
}

// ---------------------------------------------------------------------------
// FR-IMG-10 图片信息 & EXIF
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ExifInfo {
    pub has_exif: bool,
    pub make: Option<String>,
    pub model: Option<String>,
    /// Make + Model 合并展示
    pub camera: Option<String>,
    pub lens: Option<String>,
    /// EXIF DateTimeOriginal 原格式（`2024:05:01 18:22:03`）
    pub datetime_original: Option<String>,
    pub orientation: Option<u32>,
    pub iso: Option<u32>,
    pub f_number: Option<f64>,
    /// 快门秒数（0.008 → 展示 `1/125`）
    pub exposure_time: Option<f64>,
    pub focal_length_mm: Option<f64>,
    pub software: Option<String>,
    /// 默认脱敏：只有 `revealGps=true` 才填充
    pub gps: Option<GpsPoint>,
    /// 是否含 GPS（不含坐标，仅提示）
    pub gps_present: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GpsPoint {
    pub lat: f64,
    pub lon: f64,
    pub alt_m: Option<f64>,
}

impl ExifInfo {
    /// 快门可读文本（FR-IMG-10 展示）
    pub fn shutter_text(&self) -> Option<String> {
        let t = self.exposure_time?;
        if t <= 0.0 {
            return None;
        }
        if t >= 1.0 {
            return Some(format!("{:.1}s", t));
        }
        Some(format!("1/{}", (1.0 / t).round() as i64))
    }
}

fn find_tag<'a>(exif: &'a exif::Exif, tag: exif::Tag) -> Option<&'a exif::Field> {
    // 子 IFD（Exif/GPS）的 `In` 编号不对外稳定，按 tag（含 context）全局查找更可靠
    exif.fields().into_iter().find(|f| f.tag == tag)
}

fn ascii_at(exif: &exif::Exif, tag: exif::Tag) -> Option<String> {
    let f = find_tag(exif, tag)?;
    let raw: &[u8] = match &f.value {
        exif::Value::Ascii(v) => v.first()?.as_slice(),
        exif::Value::Undefined(v, _) => v.as_slice(),
        _ => return None,
    };
    let text = String::from_utf8_lossy(raw).trim_matches('\0').trim().to_string();
    (!text.is_empty()).then_some(text)
}

fn ratio_at(exif: &exif::Exif, tag: exif::Tag, index: usize) -> Option<f64> {
    let f = find_tag(exif, tag)?;
    match &f.value {
        exif::Value::Rational(v) => Some(v.get(index)?.to_f64()),
        exif::Value::SRational(v) => Some(v.get(index)?.to_f64()),
        _ => None,
    }
}

fn uint_at(exif: &exif::Exif, tag: exif::Tag) -> Option<u32> {
    let f = find_tag(exif, tag)?;
    f.value.get_uint(0)
}

/// GPS 的度/分/秒是 3 个有理数
pub fn gps_dms_to_decimal(exif: &exif::Exif, tag: exif::Tag) -> Option<f64> {
    let deg = ratio_at(exif, tag, 0)?;
    let min = ratio_at(exif, tag, 1)?;
    let sec = ratio_at(exif, tag, 2)?;
    Some(dms_to_decimal(deg, min, sec))
}

/// 度分秒 → 十进制度（6 位小数）
pub fn dms_to_decimal(deg: f64, min: f64, sec: f64) -> f64 {
    let sign = if deg < 0.0 { -1.0 } else { 1.0 };
    let v = deg.abs() + min / 60.0 + sec / 3600.0;
    (sign * v * 1_000_000.0).round() / 1_000_000.0
}

fn gps_ref_sign(exif: &exif::Exif, tag: exif::Tag, v: f64) -> f64 {
    ascii_at(exif, tag)
        .map(|r| {
            let up = r.to_uppercase();
            if up.starts_with('S') || up.starts_with('W') { -v } else { v }
        })
        .unwrap_or(v)
}

/// 读 EXIF。`reveal_gps=false` 时仅返回 `gpsPresent`（FR-IMG-10 默认脱敏）。
/// 无 EXIF 不报错，返回 `has_exif=false`（前端显示「无拍摄信息」）。
pub fn read_exif_from_bytes(bytes: &[u8], reveal_gps: bool) -> Result<ExifInfo, AppError> {
    let mut cursor = Cursor::new(bytes);
    let parsed = exif::Reader::new().read_from_container(&mut cursor);
    let exif = match parsed {
        Ok(e) => e,
        Err(_) => return Ok(ExifInfo::default()),
    };

    let make = ascii_at(&exif, exif::Tag::Make);
    let model = ascii_at(&exif, exif::Tag::Model);
    let camera = match (&make, &model) {
        (Some(mk), Some(md)) => Some(format!("{mk} {md}")),
        (Some(mk), None) => Some(mk.clone()),
        (None, Some(md)) => Some(md.clone()),
        (None, None) => None,
    };
    let lat = gps_dms_to_decimal(&exif, exif::Tag::GPSLatitude);
    let lon = gps_dms_to_decimal(&exif, exif::Tag::GPSLongitude);
    let gps_present = lat.is_some() && lon.is_some();

    let mut info = ExifInfo {
        has_exif: false,
        make,
        model,
        camera,
        lens: ascii_at(&exif, exif::Tag::LensModel),
        datetime_original: ascii_at(&exif, exif::Tag::DateTimeOriginal),
        orientation: uint_at(&exif, exif::Tag::Orientation),
        iso: uint_at(&exif, exif::Tag::PhotographicSensitivity),
        f_number: ratio_at(&exif, exif::Tag::FNumber, 0),
        exposure_time: ratio_at(&exif, exif::Tag::ExposureTime, 0),
        focal_length_mm: ratio_at(&exif, exif::Tag::FocalLength, 0),
        software: ascii_at(&exif, exif::Tag::Software),
        gps: None,
        gps_present,
    };
    if gps_present && reveal_gps {
        if let (Some(lat), Some(lon)) = (lat, lon) {
            info.gps = Some(GpsPoint {
                lat: gps_ref_sign(&exif, exif::Tag::GPSLatitudeRef, lat),
                lon: gps_ref_sign(&exif, exif::Tag::GPSLongitudeRef, lon),
                alt_m: ratio_at(&exif, exif::Tag::GPSAltitude, 0),
            });
        }
    }
    info.has_exif = info.camera.is_some()
        || info.datetime_original.is_some()
        || info.orientation.is_some()
        || info.iso.is_some()
        || info.gps_present;
    Ok(info)
}

pub fn read_exif_from_file(path: &Path, reveal_gps: bool) -> Result<ExifInfo, AppError> {
    let bytes = std::fs::read(path).map_err(|_| AppError::not_found())?;
    read_exif_from_bytes(&bytes, reveal_gps)
}

/// EXIF `Orientation` 1~8 → (顺时针角度, 是否水平镜像)
pub fn orientation_transform(o: Option<u32>) -> (f64, bool) {
    match o {
        None | Some(1) => (0.0, false),
        Some(2) => (0.0, true),
        Some(3) => (180.0, false),
        Some(4) => (180.0, true),
        Some(5) => (90.0, true),
        Some(6) => (90.0, false),
        Some(7) => (270.0, true),
        Some(8) => (270.0, false),
        Some(_) => (0.0, false),
    }
}

/// 按 EXIF 方向摆正（PDF/水印等后续处理统一用摆正后的图）
///
/// image 0.25 起 `DynamicImage` 不再自带 orientation（只有 decoder 能读到），
/// 因此方向值由调用方从 EXIF（[`uint_at`] / [`read_exif_from_bytes`] 的 `orientation`）传入；
/// 无方向或方向非法（0、>8）时原样返回，与旧行为一致。
pub fn normalized_image(img: &DynamicImage, orientation: Option<u32>) -> DynamicImage {
    let mut out = img.clone();
    let o = orientation
        .and_then(|v| u8::try_from(v).ok())
        .and_then(image::metadata::Orientation::from_exif);
    if let Some(o) = o {
        out.apply_orientation(o);
    }
    out
}

fn short_err(s: &str) -> String {
    s.chars().take(60).collect()
}
