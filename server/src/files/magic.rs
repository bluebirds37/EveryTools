//! Magic number 判定（requirements §8.5.1）：文件真实类型只看头部字节，**不信扩展名 / Content-Type**。
//! 同时识别「脚本/可执行」伪装并拒绝。

use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaFormat {
    Jpeg,
    Png,
    Gif,
    Webp,
    Bmp,
    /// ISO-BMFF 家族：mp4 / mov / m4a（由 ftyp brand 区分）
    Mp4,
    Mov,
    M4a,
    Matroska, // webm / mkv（头部相同，按 brand/扩展名二次判定）
    Mp3,
    Wav,
    Avi,
    Flac,
    Pdf,
}

impl MediaFormat {
    pub fn as_str(self) -> &'static str {
        match self {
            MediaFormat::Jpeg => "jpg",
            MediaFormat::Png => "png",
            MediaFormat::Gif => "gif",
            MediaFormat::Webp => "webp",
            MediaFormat::Bmp => "bmp",
            MediaFormat::Mp4 => "mp4",
            MediaFormat::Mov => "mov",
            MediaFormat::M4a => "m4a",
            MediaFormat::Matroska => "webm",
            MediaFormat::Mp3 => "mp3",
            MediaFormat::Wav => "wav",
            MediaFormat::Avi => "avi",
            MediaFormat::Flac => "flac",
            MediaFormat::Pdf => "pdf",
        }
    }

    pub fn mime(self) -> &'static str {
        match self {
            MediaFormat::Jpeg => "image/jpeg",
            MediaFormat::Png => "image/png",
            MediaFormat::Gif => "image/gif",
            MediaFormat::Webp => "image/webp",
            MediaFormat::Bmp => "image/bmp",
            MediaFormat::Mp4 => "video/mp4",
            MediaFormat::Mov => "video/quicktime",
            MediaFormat::M4a => "audio/mp4",
            MediaFormat::Matroska => "video/webm",
            MediaFormat::Mp3 => "audio/mpeg",
            MediaFormat::Wav => "audio/wav",
            MediaFormat::Avi => "video/x-msvideo",
            MediaFormat::Flac => "audio/flac",
            MediaFormat::Pdf => "application/pdf",
        }
    }

    pub fn is_image(self) -> bool {
        matches!(
            self,
            MediaFormat::Jpeg
                | MediaFormat::Png
                | MediaFormat::Gif
                | MediaFormat::Webp
                | MediaFormat::Bmp
        )
    }

    pub fn is_video(self) -> bool {
        matches!(
            self,
            MediaFormat::Mp4 | MediaFormat::Mov | MediaFormat::Matroska | MediaFormat::Avi
        )
    }

    pub fn is_audio(self) -> bool {
        matches!(self, MediaFormat::Mp3 | MediaFormat::M4a | MediaFormat::Wav | MediaFormat::Flac)
    }
}

impl fmt::Display for MediaFormat {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// 依据头部字节（建议 ≥32 字节）判定真实类型；无法识别返回 `None`。
pub fn detect(head: &[u8]) -> Option<MediaFormat> {
    // JPEG: FF D8 FF
    if starts_with(head, &[0xFF, 0xD8, 0xFF]) {
        return Some(MediaFormat::Jpeg);
    }
    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if starts_with(head, &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) {
        return Some(MediaFormat::Png);
    }
    // GIF: "GIF87a" / "GIF89a"
    if starts_with(head, b"GIF87a") || starts_with(head, b"GIF89a") {
        return Some(MediaFormat::Gif);
    }
    // BMP: "BM"
    if starts_with(head, b"BM") && head.len() >= 4 {
        return Some(MediaFormat::Bmp);
    }
    // WEBP: "RIFF" ... "WEBP"
    if starts_with(head, b"RIFF") && region_is(head, 8, b"WEBP") {
        return Some(MediaFormat::Webp);
    }
    // AVI: "RIFF" ... "AVI "
    if starts_with(head, b"RIFF") && region_is(head, 8, b"AVI ") {
        return Some(MediaFormat::Avi);
    }
    // WAV: "RIFF" ... "WAVE"
    if starts_with(head, b"RIFF") && region_is(head, 8, b"WAVE") {
        return Some(MediaFormat::Wav);
    }
    // ISO-BMFF: bytes 4..8 == "ftyp"
    if region_is(head, 4, b"ftyp") {
        return brand(head);
    }
    // Matroska/WebM: 1A 45 DF A3
    if starts_with(head, &[0x1A, 0x45, 0xDF, 0xA3]) {
        return Some(MediaFormat::Matroska);
    }
    // MP3: ID3 tag 或帧同步 FF Ex / FF Fx
    if starts_with(head, b"ID3") {
        return Some(MediaFormat::Mp3);
    }
    if head.len() >= 2 && head[0] == 0xFF && (head[1] & 0xE0) == 0xE0 {
        return Some(MediaFormat::Mp3);
    }
    // FLAC: "fLaC"
    if starts_with(head, b"fLaC") {
        return Some(MediaFormat::Flac);
    }
    // PDF: "%PDF-"
    if starts_with(head, b"%PDF-") {
        return Some(MediaFormat::Pdf);
    }
    None
}

fn brand(head: &[u8]) -> Option<MediaFormat> {
    if head.len() < 12 {
        return Some(MediaFormat::Mp4);
    }
    let b = &head[8..12];
    if b == b"qt  " {
        return Some(MediaFormat::Mov);
    }
    if b == b"M4A " {
        return Some(MediaFormat::M4a);
    }
    Some(MediaFormat::Mp4)
}

/// 明确禁止的类型（可执行/脚本/压缩容器）——「伪装成 jpg 的脚本」必须被拒
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Forbidden {
    Elf,
    MachO,
    PeExe,
    ScriptShebang,
    Zip,
    Html,
    Xml,
    Json,
    PlainText,
}

/// 头部是否属于「可执行/脚本/文本」——即使扩展名是 .jpg 也拒绝
pub fn forbidden_kind(head: &[u8]) -> Option<Forbidden> {
    if starts_with(head, &[0x7F, b'E', b'L', b'F']) {
        return Some(Forbidden::Elf);
    }
    // Mach-O: feed_fac e / cffaedfe / cafebabe / becafeba
    if starts_with(head, &[0xFE, 0xED, 0xFA, 0xCE])
        || starts_with(head, &[0xCF, 0xFA, 0xED, 0xFE])
        || starts_with(head, &[0xCE, 0xFA, 0xED, 0xFE])
        || starts_with(head, &[0xFF, 0xFF, 0xFF, 0xFF])
    {
        return Some(Forbidden::MachO);
    }
    if starts_with(head, b"MZ") {
        return Some(Forbidden::PeExe);
    }
    if starts_with(head, b"#!") {
        return Some(Forbidden::ScriptShebang);
    }
    if starts_with(head, &[0x50, 0x4B, 0x03, 0x04]) || starts_with(head, b"PK\x05\x06") {
        return Some(Forbidden::Zip);
    }
    if starts_with_ascii_ci(head, b"<html") || starts_with_ascii_ci(head, b"<!doctype") {
        return Some(Forbidden::Html);
    }
    if starts_with_ascii_ci(head, b"<?xml") {
        return Some(Forbidden::Xml);
    }
    if starts_with(head, b"{") || starts_with(head, b"[") {
        return Some(Forbidden::Json);
    }
    // 可打印 ASCII 文本（脚本/代码常伪装成图片）：前 16 字节全部可打印且无媒体头
    if head.len() >= 16 && !detect(head).is_some() && head[..16].iter().all(|b| b.is_ascii_graphic() || b.is_ascii_whitespace()) {
        return Some(Forbidden::PlainText);
    }
    None
}

/// 上传白名单：按任务类型判定是否可用
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UploadKind {
    Image,
    Video,
    Audio,
    PdfInput,
}

pub fn is_allowed(fmt: MediaFormat, kind: UploadKind) -> bool {
    match kind {
        UploadKind::Image => fmt.is_image(),
        UploadKind::Video => fmt.is_video(),
        UploadKind::Audio => fmt.is_audio() || fmt == MediaFormat::M4a,
        UploadKind::PdfInput => fmt.is_image(),
    }
}

/// 通用白名单（分片上传首块只做类型嗅探）
pub fn is_allowed_any(fmt: MediaFormat) -> bool {
    fmt.is_image() || fmt.is_video() || fmt.is_audio()
}

/// 首块嗅探：先拒禁用类型，再判白名单。返回真实格式。
pub fn sniff_allowed(head: &[u8], kind: UploadKind) -> SniffOutcome {
    if let Some(f) = forbidden_kind(head) {
        return SniffOutcome::Forbidden(f);
    }
    match detect(head) {
        Some(fmt) if is_allowed(fmt, kind) => SniffOutcome::Ok(fmt),
        Some(fmt) => SniffOutcome::WrongCategory(fmt),
        None => SniffOutcome::Unknown,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SniffOutcome {
    /// 允许
    Ok(MediaFormat),
    /// 是媒体文件但类别不对（如视频任务收到 png）
    WrongCategory(MediaFormat),
    /// 可执行/脚本/文本伪装
    Forbidden(Forbidden),
    /// 完全识别不了
    Unknown,
}

impl SniffOutcome {
    pub fn to_app_error(self) -> crate::error::AppError {
        use crate::error::AppError;
        match self {
            SniffOutcome::Ok(_) => AppError::internal(anyhow::anyhow!(
                "SniffOutcome::Ok has no error; this path is a bug"
            )),
            SniffOutcome::WrongCategory(fmt) => AppError::unsupported_format(fmt.as_str())
                .with_hint("请确认选择的文件类型与该工具匹配"),
            SniffOutcome::Forbidden(_) => AppError::unsupported_format("可执行或脚本文件")
                .with_hint("出于安全考虑，服务端只接受图片/音视频文件"),
            SniffOutcome::Unknown => AppError::unsupported_format("无法识别")
                .with_hint("文件头部不含有效魔数，可能已损坏"),
        }
    }
}

fn starts_with(hay: &[u8], needle: &[u8]) -> bool {
    hay.len() >= needle.len() && &hay[..needle.len()] == needle
}

fn starts_with_ascii_ci(hay: &[u8], needle: &[u8]) -> bool {
    if hay.len() < needle.len() {
        return false;
    }
    hay[..needle.len()]
        .iter()
        .zip(needle.iter())
        .all(|(a, b)| a.to_ascii_lowercase() == *b)
}

fn region_is(hay: &[u8], offset: usize, needle: &[u8]) -> bool {
    hay.len() >= offset + needle.len() && &hay[offset..offset + needle.len()] == needle
}

#[cfg(test)]
mod tests {
    use super::*;

    fn padded(bytes: &[u8]) -> Vec<u8> {
        let mut v = bytes.to_vec();
        v.resize(64, 0);
        v
    }

    #[test]
    fn detects_jpeg_png_gif() {
        assert_eq!(detect(&padded(&[0xFF, 0xD8, 0xFF, 0xE0])), Some(MediaFormat::Jpeg));
        assert_eq!(
            detect(&padded(&[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])),
            Some(MediaFormat::Png)
        );
        assert_eq!(detect(&padded(b"GIF89a")), Some(MediaFormat::Gif));
        assert_eq!(detect(&padded(b"GIF87a")), Some(MediaFormat::Gif));
    }

    #[test]
    fn detects_webp_and_wav_and_avi_from_riff() {
        let mut webp = padded(b"RIFF");
        webp[8..12].copy_from_slice(b"WEBP");
        assert_eq!(detect(&webp), Some(MediaFormat::Webp));
        let mut wav = padded(b"RIFF");
        wav[8..12].copy_from_slice(b"WAVE");
        assert_eq!(detect(&wav), Some(MediaFormat::Wav));
        let mut avi = padded(b"RIFF");
        avi[8..12].copy_from_slice(b"AVI ");
        assert_eq!(detect(&avi), Some(MediaFormat::Avi));
    }

    #[test]
    fn detects_mp4_mov_m4a_by_ftyp_brand() {
        let mut mp4 = padded(b"\0\0\0\x18ftyp");
        mp4[8..12].copy_from_slice(b"isom");
        assert_eq!(detect(&mp4), Some(MediaFormat::Mp4));
        let mut mov = mp4.clone();
        mov[8..12].copy_from_slice(b"qt  ");
        assert_eq!(detect(&mov), Some(MediaFormat::Mov));
        let mut m4a = mp4.clone();
        m4a[8..12].copy_from_slice(b"M4A ");
        assert_eq!(detect(&m4a), Some(MediaFormat::M4a));
    }

    #[test]
    fn detects_webm_matroska_header() {
        assert_eq!(
            detect(&padded(&[0x1A, 0x45, 0xDF, 0xA3, 0x00, 0x00])),
            Some(MediaFormat::Matroska)
        );
    }

    #[test]
    fn rejects_script_disguised_as_jpg() {
        // 一个伪装成 .jpg 的 shell 脚本
        let fake = padded(b"#!/bin/sh\necho pwned\n");
        assert_eq!(detect(&fake), None);
        assert_eq!(forbidden_kind(&fake), Some(Forbidden::ScriptShebang));
        let out = sniff_allowed(&fake, UploadKind::Image);
        assert_eq!(out, SniffOutcome::Forbidden(Forbidden::ScriptShebang));
        // 且错误码必须是 UNSUPPORTED_FORMAT（§0.3）
        let err = out.to_app_error();
        assert_eq!(err.code, crate::error::Code::UnsupportedFormat);
    }

    #[test]
    fn rejects_elf_macho_pe_and_zip() {
        assert_eq!(forbidden_kind(&padded(&[0x7F, b'E', b'L', b'F', 1])), Some(Forbidden::Elf));
        assert_eq!(
            forbidden_kind(&padded(&[0xCF, 0xFA, 0xED, 0xFE, 1])),
            Some(Forbidden::MachO)
        );
        assert_eq!(forbidden_kind(&padded(b"MZ\x90\x00")), Some(Forbidden::PeExe));
        assert_eq!(
            forbidden_kind(&padded(b"PK\x03\x04fake")),
            Some(Forbidden::Zip)
        );
    }

    #[test]
    fn rejects_text_and_html_masquerading() {
        assert_eq!(
            forbidden_kind(&padded(b"<html><script>bad</script></html>")),
            Some(Forbidden::Html)
        );
        assert_eq!(forbidden_kind(&padded(b"{\"a\":1,\"b\":2}")), Some(Forbidden::Json));
        assert_eq!(
            forbidden_kind(&padded(b"printf('hello'); // js payload")),
            Some(Forbidden::PlainText)
        );
    }

    #[test]
    fn real_media_is_not_flagged_forbidden() {
        let jpg = padded(&[0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46]);
        assert_eq!(forbidden_kind(&jpg), None);
        assert!(matches!(
            sniff_allowed(&jpg, UploadKind::Image),
            SniffOutcome::Ok(MediaFormat::Jpeg)
        ));
    }

    #[test]
    fn category_mismatch_is_rejected() {
        let png = padded(&[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
        assert_eq!(
            sniff_allowed(&png, UploadKind::Video),
            SniffOutcome::WrongCategory(MediaFormat::Png)
        );
        let mp4 = {
            let mut h = padded(b"\0\0\0\x18ftyp");
            h[8..12].copy_from_slice(b"isom");
            h
        };
        assert_eq!(
            sniff_allowed(&mp4, UploadKind::Image),
            SniffOutcome::WrongCategory(MediaFormat::Mp4)
        );
    }

    #[test]
    fn unknown_bytes_are_unknown() {
        let mut h = vec![0u8; 64];
        h[0] = 0x00;
        h[1] = 0x01;
        assert_eq!(sniff_allowed(&h, UploadKind::Image), SniffOutcome::Unknown);
    }

    #[test]
    fn mime_and_flags() {
        assert_eq!(MediaFormat::Jpeg.mime(), "image/jpeg");
        assert_eq!(MediaFormat::Mov.mime(), "video/quicktime");
        assert_eq!(MediaFormat::M4a.mime(), "audio/mp4");
        assert!(MediaFormat::Gif.is_image());
        assert!(MediaFormat::Matroska.is_video());
        assert!(MediaFormat::Flac.is_audio());
        assert!(!MediaFormat::Pdf.is_image());
        assert!(is_allowed(MediaFormat::Mp4, UploadKind::Video));
        assert!(!is_allowed(MediaFormat::Pdf, UploadKind::Video));
        assert!(is_allowed_any(MediaFormat::Webp));
        assert!(!is_allowed_any(MediaFormat::Pdf));
    }
}
