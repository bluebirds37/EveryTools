//! FR-IMG-17 图片转 PDF（`type=image2pdf`）。
//!
//! 直接手写 PDF 1.4 字节流（JPEG 以 `/DCTDecode` 原样内嵌，不二次编码）：
//! - 每页一张图（`pageSize=A4|A5|Letter|auto`、`orientation`、`margin`、`fit=contain|cover`）
//! - `fit=cover` 用「裁剪框 + 等比放大绘制」实现，超出边距部分被 `re W n` 裁掉，
//!   因此验收点「每页无裁切（contain）/ 不变形（cover）」都成立。
//! - 结构合法性由测试里的 `lopdf::Document::load_mem` 反向校验（dev-dependency）。

use std::fmt::Write as _;

use crate::error::AppError;
use crate::media::params::PdfLayout;

/// 一页一张图
#[derive(Debug, Clone, Copy)]
pub struct PageImage<'a> {
    pub jpeg: &'a [u8],
    pub px_w: u32,
    pub px_h: u32,
    pub layout: PdfLayout,
}

/// PDF 对象表：1 开始编号
#[derive(Default)]
struct ObjectTable {
    objects: Vec<Vec<u8>>,
}

impl ObjectTable {
    fn new(starting_at: usize) -> Self {
        Self {
            objects: vec![Vec::new(); starting_at],
        }
    }

    /// 追加对象，返回 1-based 对象号
    fn put(&mut self, body: Vec<u8>) -> usize {
        self.objects.push(body);
        self.objects.len()
    }

    fn set(&mut self, id: usize, body: Vec<u8>) {
        self.objects[id - 1] = body;
    }

    fn len(&self) -> usize {
        self.objects.len()
    }
}

/// 图片 → PDF 字节。`title` 写入文档信息（已 sanitize 的文件名）。
pub fn build_pdf(images: &[PageImage<'_>], title: &str) -> Result<Vec<u8>, AppError> {
    if images.is_empty() {
        return Err(AppError::input_empty());
    }
    // 预留 1=Catalog、2=Pages
    let mut table = ObjectTable::new(2);
    let mut kids: Vec<usize> = Vec::with_capacity(images.len());

    // 先建内容流与图像流，再建页对象
    for im in images {
        let content_id = table.put(content_stream(im));
        let image_id = table.put(image_stream(im));
        let page_id = table.put(page_dict(im, content_id, image_id));
        kids.push(page_id);
    }

    let pages_body = {
        let kids_str = kids
            .iter()
            .map(|id| format!("{id} 0 R"))
            .collect::<Vec<_>>()
            .join(" ");
        let mut s = String::from("<< /Type /Pages /Kids [");
        s.push_str(&kids_str);
        let _ = write!(s, "] /Count {} >>", kids.len());
        s.into_bytes()
    };
    let info_id = table.put(info_dict(title));
    table.set(2, pages_body);
    table.set(
        1,
        format!("<< /Type /Catalog /Pages 2 0 R /Info {info_id} 0 R >>").into_bytes(),
    );

    Ok(serialize(&table))
}

/// 单页内容流（裁剪到边距框后按 layout 绘制图像）
fn content_stream(im: &PageImage<'_>) -> Vec<u8> {
    let l = im.layout;
    let clip_x = num(l.margin_pt);
    let clip_y = num(l.margin_pt);
    let clip_w = num((l.page_w - 2.0 * l.margin_pt).max(1.0));
    let clip_h = num((l.page_h - 2.0 * l.margin_pt).max(1.0));
    let dw = num(l.img_w.max(1.0));
    let dh = num(l.img_h.max(1.0));
    let dx = num(l.offset_x);
    let dy = num(l.offset_y);
    let body = format!(
        "q\n{clip_x} {clip_y} {clip_w} {clip_h} re W n\n{dw} 0 0 {dh} {dx} {dy} cm\n/Im0 Do\nQ\n"
    );
    stream_object(&body.as_bytes().to_vec(), &format!("<< /Length {} >>", body.len()))
}

fn image_stream(im: &PageImage<'_>) -> Vec<u8> {
    let dict = format!(
        "<< /Type /XObject /Subtype /Image /Width {} /Height {} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length {} >>",
        im.px_w.max(1),
        im.px_h.max(1),
        im.jpeg.len()
    );
    stream_object(im.jpeg, &dict)
}

fn page_dict(im: &PageImage<'_>, content_id: usize, image_id: usize) -> Vec<u8> {
    format!(
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {} {}] /Resources << /XObject << /Im0 {image_id} 0 R >> /ProcSet [/PDF /ImageC] >> /Contents {content_id} 0 R >>",
        num(im.layout.page_w),
        num(im.layout.page_h)
    )
    .into_bytes()
}

fn info_dict(title: &str) -> Vec<u8> {
    format!(
        "<< /Title ({}) /Producer (toolbox-server) /Creator (toolbox-server) >>",
        escape_pdf_string(title)
    )
    .into_bytes()
}

fn stream_object(payload: &[u8], dict: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len() + 64);
    out.extend_from_slice(dict.as_bytes());
    out.extend_from_slice(b"\nstream\n");
    out.extend_from_slice(payload);
    out.extend_from_slice(b"\nendstream");
    out
}

/// 数字：最多 2 位小数且去掉多余的 `.0`
pub fn num(v: f64) -> String {
    let r = (v * 100.0).round() / 100.0;
    if (r - r.round()).abs() < 0.005 {
        format!("{}", r.round() as i64)
    } else {
        format!("{r:.2}")
    }
}

/// PDF 字面量字符串转义
pub fn escape_pdf_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for ch in s.chars() {
        match ch {
            '\\' => out.push_str(r"\\"),
            '(' => out.push_str(r"\("),
            ')' => out.push_str(r"\)"),
            c if (c as u32) > 126 => out.push('?'), // 文件名已 sanitize，保守兜底
            c => out.push(c),
        }
    }
    out
}

/// 组装交叉表（xref 偏移必须精确到字节）
///
/// `Vec<u8>` 不是 `fmt::Write` 的目标，因此固定头部之后统一用 `extend_from_slice`
/// 写入 ASCII 片段（`put!` 宏），保证与原 `write!` 逐字节一致。
fn serialize(table: &ObjectTable) -> Vec<u8> {
    macro_rules! put {
        ($out:expr, $($t:tt)*) => {
            $out.extend_from_slice(format!($($t)*).as_bytes())
        };
    }

    let mut out: Vec<u8> = Vec::new();
    out.extend_from_slice(b"%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
    let mut offsets: Vec<usize> = Vec::with_capacity(table.len());
    for (idx, body) in table.objects.iter().enumerate() {
        offsets.push(out.len());
        put!(out, "{} 0 obj\n", idx + 1);
        out.extend_from_slice(body);
        out.extend_from_slice(b"\nendobj\n");
    }
    let xref_start = out.len();
    let size = table.len() + 1;
    put!(out, "xref\n0 {size}\n0000000000 65535 f \n");
    for off in &offsets {
        put!(out, "{off:010} 00000 n \n");
    }
    put!(
        out,
        "trailer\n<< /Size {size} /Root 1 0 R >>\nstartxref\n{xref_start}\n%%EOF\n"
    );
    out
}

/// 目标单文件体积保护（FR-IMG-17 验收：单文件 ≤20MB）
pub const MAX_PDF_BYTES: usize = 20 * 1024 * 1024;

pub fn check_pdf_size(bytes: &[u8]) -> Result<(), AppError> {
    if bytes.len() > MAX_PDF_BYTES {
        return Err(AppError::file_too_large((MAX_PDF_BYTES / 1_048_576) as u64));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake_jpeg(seed: u8) -> Vec<u8> {
        // 只用于结构校验：真实 JPEG 由 image 编码产出
        vec![0xFF, 0xD8, 0xFF, 0xE0, seed, 0xFF, 0xD9]
    }

    fn layout(page_w: f64, page_h: f64, margin: f64) -> PdfLayout {
        PdfLayout {
            page_w,
            page_h,
            img_w: page_w - 2.0 * margin,
            img_h: page_h - 2.0 * margin,
            offset_x: margin,
            offset_y: margin,
            landscape: page_w > page_h,
            margin_pt: margin,
        }
    }

    #[test]
    fn numbers_and_escaping() {
        assert_eq!(num(595.28), "595.28");
        assert_eq!(num(612.0), "612");
        assert_eq!(num(28.346456_692913), "28.35");
        assert_eq!(escape_pdf_string(r"a(b)c\d"), r"a\(b\)c\\d");
        assert_eq!(escape_pdf_string("图片"), "??");
    }

    #[test]
    fn empty_input_rejected() {
        let err = build_pdf(&[], "x.pdf").unwrap_err();
        assert_eq!(err.code, crate::error::Code::InputEmpty);
    }

    #[test]
    fn pdf_is_parseable_by_lopdf_with_expected_pages() {
        let images = [
            PageImage {
                jpeg: &fake_jpeg(1),
                px_w: 600,
                px_h: 400,
                layout: layout(595.28, 841.89, 28.35),
            },
            PageImage {
                jpeg: &fake_jpeg(2),
                px_w: 400,
                px_h: 600,
                layout: layout(841.89, 595.28, 28.35),
            },
        ];
        let bytes = build_pdf(&images, "相册.pdf").unwrap();
        assert!(bytes.starts_with(b"%PDF-1.4"));
        assert!(bytes.windows(6).any(|w| w == b"%%EOF\n"));
        assert!(bytes.windows(b"/DCTDecode".len()).any(|w| w == b"/DCTDecode"));

        // lopdf 0.45 的 `save` 需要 `&mut self`（会重排对象表）
        let mut doc = lopdf::Document::load_mem(&bytes).expect("lopdf 解析失败（xref/对象结构有误）");
        assert_eq!(doc.page_iter().count(), 2, "应有 2 页");
        // MediaBox 与 layout 一致（lopdf 0.45：页号 → ObjectId，再取字典）
        let first_id = *doc.get_pages().get(&1).expect("第 1 页必须存在");
        let first = doc.get_dictionary(first_id).unwrap();
        let mb = first.get(b"MediaBox").unwrap().as_array().unwrap();
        // lopdf 0.45 的实数访问器是 as_f32（无 as_f64），断言保留 A4 尺寸语义
        assert!((f64::from(mb[2].as_f32().unwrap()) - 595.28).abs() < 0.01);
        assert!((f64::from(mb[3].as_f32().unwrap()) - 841.89).abs() < 0.01);
        // 图像 XObject 可读出像素尺寸
        let res = first.get(b"Resources").unwrap().as_dict().unwrap();
        let xo = res.get(b"XObject").unwrap().as_dict().unwrap();
        let im = xo.get(b"Im0").unwrap().as_reference().unwrap();
        let obj = doc.get_object(im).unwrap();
        let stream = obj.as_stream().unwrap();
        assert_eq!(stream.dict.get(b"Width").unwrap().as_i64().unwrap(), 600);
        doc.save("/tmp/toolbox_pdf_check.pdf").unwrap();
    }

    #[test]
    fn cover_fit_emits_clip_box() {
        let im = PageImage {
            jpeg: &fake_jpeg(3),
            px_w: 100,
            px_h: 100,
            layout: PdfLayout {
                page_w: 595.0,
                page_h: 842.0,
                img_w: 900.0,
                img_h: 900.0,
                offset_x: -152.5,
                offset_y: -29.0,
                landscape: false,
                margin_pt: 28.35,
            },
        };
        let cs = String::from_utf8_lossy(&content_stream(&im)).to_string();
        assert!(cs.contains(" re W n"), "cover 必须带裁剪框: {cs}");
        assert!(
            cs.contains(&format!("{} {} cm", num(-152.5), num(-29.0))),
            "{cs}"
        );
    }

    #[test]
    fn size_guard_matches_20mb() {
        assert!(check_pdf_size(&vec![0u8; MAX_PDF_BYTES - 1]).is_ok());
        let err = check_pdf_size(&vec![0u8; MAX_PDF_BYTES + 1]).unwrap_err();
        assert_eq!(err.code, crate::error::Code::FileTooLarge);
    }
}
