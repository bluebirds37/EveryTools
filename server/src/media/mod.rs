//! 媒体处理层。
//!
//! - [`ffmpeg`]：视频/动图工具的命令构造 + 可注入执行器（本机无 ffmpeg 也能编译与测试）
//! - [`params`]：按 `docs/tools-spec.md` 校验并归一化前端参数
//! - [`image_ops`]：图片压缩 / 格式转换 / EXIF（`image` + `kamadak-exif`，纯 Rust）
//! - [`pdf`]：图片转 PDF（FR-IMG-17，手写 PDF 字节，测试里用 `lopdf` 反向校验）

pub mod ffmpeg;
pub mod image_ops;
pub mod params;
pub mod pdf;
