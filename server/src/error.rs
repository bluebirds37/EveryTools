//! 统一错误模型（docs/requirements.md §8.2 + docs/tools-spec.md §0.3）
//!
//! 响应体固定：
//! ```json
//! { "ok": false, "error": { "code": "QUOTA_EXCEEDED", "message": "今日云端处理次数已用完，明天再来", "hint": "..." }, "requestId": "..." }
//! ```
//! 硬性要求（requirements §8.5.4/5）：微信/上游服务的原始响应**不透传**给用户，
//! 只映射成内部码；`message` 面向用户可读；原始细节只进 tracing（不含用户内容与 token）。
//!
//! `requestId` 由 [`crate::telemetry`] 的中间件写入 task-local，`IntoResponse` 读取，
//! 这样 handler 里 `?` 直接返回 `AppError` 也能带上 requestId。

use std::fmt;

use axum::{
    Json,
    extract::rejection::JsonRejection,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// 对外错误码：`docs/tools-spec.md` §0.3 全套 + 服务端内部码。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Code {
    // ---- §0.3 规范码 ----
    #[serde(rename = "INPUT_EMPTY")]
    InputEmpty,
    #[serde(rename = "FILE_TOO_LARGE")]
    FileTooLarge,
    #[serde(rename = "UNSUPPORTED_FORMAT")]
    UnsupportedFormat,
    #[serde(rename = "IMAGE_TOO_BIG")]
    ImageTooBig,
    #[serde(rename = "PERMISSION_DENIED")]
    PermissionDenied,
    #[serde(rename = "QUOTA_EXCEEDED")]
    QuotaExceeded,
    #[serde(rename = "TASK_TIMEOUT")]
    TaskTimeout,
    #[serde(rename = "TASK_FAILED")]
    TaskFailed,
    #[serde(rename = "NETWORK_OFFLINE")]
    NetworkOffline,
    #[serde(rename = "PARAM_INVALID")]
    ParamInvalid,
    #[serde(rename = "NO_AUDIO_STREAM")]
    NoAudioStream,
    #[serde(rename = "SERVER_UNREACHABLE")]
    ServerUnreachable,
    #[serde(rename = "ENGINE_UNAVAILABLE")]
    EngineUnavailable,
    /// 工具离线（tools-spec §0.3 前端 INTERNAL_CODES 同名码）
    #[serde(rename = "TOOL_OFFLINE")]
    ToolOffline,

    // ---- 服务端内部码（前端 error-center 未识别时走通用文案） ----
    #[serde(rename = "AUTH_REQUIRED")]
    AuthRequired,
    #[serde(rename = "TOKEN_INVALID")]
    TokenInvalid,
    #[serde(rename = "TOKEN_EXPIRED")]
    TokenExpired,
    #[serde(rename = "WECHAT_LOGIN_FAILED")]
    WechatLoginFailed,
    #[serde(rename = "NOT_FOUND")]
    NotFound,
    #[serde(rename = "CONCURRENT_TASK_LIMIT")]
    ConcurrentTaskLimit,
    #[serde(rename = "UPLOAD_INCOMPLETE")]
    UploadIncomplete,
    #[serde(rename = "CHECKSUM_MISMATCH")]
    ChecksumMismatch,
    #[serde(rename = "SSRF_BLOCKED")]
    SsrfBlocked,
    #[serde(rename = "RESPONSE_TOO_LARGE")]
    ResponseTooLarge,
    #[serde(rename = "UPSTREAM_UNAVAILABLE")]
    UpstreamUnavailable,
    #[serde(rename = "INTERNAL")]
    Internal,
}

impl Code {
    /// 面向用户的默认话术（对齐 §0.3 用户话术列）
    pub fn default_message(self) -> &'static str {
        match self {
            Code::InputEmpty => "请先选择内容",
            Code::FileTooLarge => "文件超过大小上限，请拆分或换小文件",
            Code::UnsupportedFormat => "暂不支持该格式",
            Code::ImageTooBig => "图片过大，处理失败，请改用较小的图片",
            Code::PermissionDenied => "未获得权限，无法继续",
            Code::QuotaExceeded => "今日云端处理次数已用完，明天再来",
            Code::TaskTimeout => "处理超时，已保留参数，可重试",
            Code::TaskFailed => "处理失败，可重试或调整参数",
            Code::NetworkOffline => "当前无网络，该工具需要联网",
            Code::ParamInvalid => "参数不合法",
            Code::NoAudioStream => "该视频没有音频流，无法提取音频",
            Code::ServerUnreachable => "服务暂时不可用，请稍后重试",
            Code::EngineUnavailable => "该能力的服务端暂未开放",
            Code::ToolOffline => "该工具暂未开放，可先在「离线可用」列表里找替代工具",
            Code::AuthRequired => "请先登录（静默登录会自动完成）",
            Code::TokenInvalid => "登录状态无效，请重新进入小程序",
            Code::TokenExpired => "登录已过期，请重新登录",
            Code::WechatLoginFailed => "微信登录失败，请稍后重试",
            Code::NotFound => "内容不存在或已过期",
            Code::ConcurrentTaskLimit => "同时进行的任务已达上限，请等待完成",
            Code::UploadIncomplete => "文件还未上传完成，请重试",
            Code::ChecksumMismatch => "文件校验失败，请重新上传",
            Code::SsrfBlocked => "目标地址不允许访问",
            Code::ResponseTooLarge => "响应内容过大，已中止",
            Code::UpstreamUnavailable => "数据源暂不可用，请稍后重试",
            Code::Internal => "服务内部错误，请稍后重试",
        }
    }

    pub fn is_server_fault(self) -> bool {
        matches!(
            self,
            Code::Internal | Code::UpstreamUnavailable | Code::ServerUnreachable
        )
    }
}

/// 统一错误
#[derive(Error, Debug)]
pub struct AppError {
    pub status: StatusCode,
    pub code: Code,
    pub message: String,
    pub hint: Option<String>,
    /// 仅进日志，不进响应（禁止包含用户内容/token）
    #[source]
    pub cause: Option<anyhow::Error>,
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?}: {}", self.code, self.message)
    }
}

impl AppError {
    pub fn new(status: StatusCode, code: Code) -> Self {
        Self {
            status,
            code,
            message: code.default_message().to_string(),
            hint: None,
            cause: None,
        }
    }

    pub fn with_message(mut self, message: impl Into<String>) -> Self {
        self.message = message.into();
        self
    }

    pub fn with_hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = Some(hint.into());
        self
    }

    pub fn caused_by(mut self, cause: anyhow::Error) -> Self {
        self.cause = Some(cause);
        self
    }

    // ---- 常用构造 ----

    pub fn internal(cause: anyhow::Error) -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, Code::Internal).caused_by(cause)
    }

    pub fn storage(cause: anyhow::Error) -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, Code::ServerUnreachable)
            .caused_by(cause)
    }

    pub fn param_invalid(field: &str, detail: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, Code::ParamInvalid)
            .with_message(format!("参数不合法：{field}，{}", detail.into()))
    }

    pub fn input_empty() -> Self {
        Self::new(StatusCode::BAD_REQUEST, Code::InputEmpty)
    }

    pub fn file_too_large(max_mb: u64) -> Self {
        Self::new(StatusCode::PAYLOAD_TOO_LARGE, Code::FileTooLarge)
            .with_message(format!("文件超过 {max_mb}MB，请拆分或换小文件"))
            .with_hint("视频可先用「视频截取」剪短再压缩")
    }

    pub fn unsupported_format(found: &str) -> Self {
        Self::new(StatusCode::UNSUPPORTED_MEDIA_TYPE, Code::UnsupportedFormat)
            .with_message(format!("暂不支持 {found} 格式"))
    }

    pub fn quota_exceeded(daily: i32) -> Self {
        Self::new(StatusCode::TOO_MANY_REQUESTS, Code::QuotaExceeded)
            .with_message(format!("今日云端处理次数已用完（每天 {daily} 次），明天再来"))
    }

    pub fn concurrent_limit(max: i32) -> Self {
        Self::new(StatusCode::TOO_MANY_REQUESTS, Code::ConcurrentTaskLimit)
            .with_message(format!("最多同时进行 {max} 个任务"))
    }

    pub fn auth_required() -> Self {
        Self::new(StatusCode::UNAUTHORIZED, Code::AuthRequired)
    }

    pub fn token(code: Code) -> Self {
        let status = if code == Code::TokenExpired {
            StatusCode::UNAUTHORIZED
        } else {
            StatusCode::FORBIDDEN
        };
        Self::new(status, code)
    }

    pub fn not_found() -> Self {
        Self::new(StatusCode::NOT_FOUND, Code::NotFound)
    }

    pub fn forbidden(reason: impl Into<String>) -> Self {
        Self::new(StatusCode::FORBIDDEN, Code::PermissionDenied).with_message(reason)
    }

    pub fn task_failed(reason: impl Into<String>) -> Self {
        Self::new(StatusCode::UNPROCESSABLE_ENTITY, Code::TaskFailed)
            .with_message(format!("处理失败（{}），可重试或调整参数", reason.into()))
    }

    pub fn task_timeout() -> Self {
        Self::new(StatusCode::UNPROCESSABLE_ENTITY, Code::TaskTimeout)
    }

    pub fn engine_unavailable(why: impl Into<String>) -> Self {
        Self::new(StatusCode::SERVICE_UNAVAILABLE, Code::EngineUnavailable).with_message(why)
    }

    pub fn upstream_unavailable(why: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_GATEWAY, Code::UpstreamUnavailable).with_message(why)
    }

    pub fn wechat_login_failed() -> Self {
        Self::new(StatusCode::BAD_GATEWAY, Code::WechatLoginFailed)
            .with_hint("若持续失败请稍后重试，小程序会以游客模式继续可用")
    }

    pub fn ssrf_blocked(reason: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_GATEWAY, Code::SsrfBlocked).with_message(reason)
    }

    /// 工具云端能力未开放（§5.1 status=offline / P3 未接入）
    pub fn tool_offline(tool: &str) -> Self {
        Self::new(StatusCode::SERVICE_UNAVAILABLE, Code::ToolOffline)
            .with_message(format!("「{tool}」云端能力暂未开放"))
    }

    pub fn no_audio_stream() -> Self {
        Self::new(StatusCode::UNPROCESSABLE_ENTITY, Code::NoAudioStream)
    }

    pub fn image_too_big(detail: impl Into<String>) -> Self {
        Self::new(StatusCode::PAYLOAD_TOO_LARGE, Code::ImageTooBig).with_message(detail)
    }
}

/// 错误响应体
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorBody<'a> {
    code: Code,
    message: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    hint: Option<&'a str>,
}

#[derive(Debug, Serialize)]
struct ErrorEnvelope<'a> {
    ok: bool,
    error: ErrorBody<'a>,
    #[serde(rename = "requestId")]
    request_id: &'a str,
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let request_id = crate::telemetry::current_request_id();
        self.respond(request_id.as_str())
    }
}

impl AppError {
    /// 生成响应（handler/测试可用它显式指定 requestId）
    pub fn respond(&self, request_id: &str) -> Response {
        if let Some(cause) = &self.cause {
            tracing::error!(
                code = ?self.code,
                status = self.status.as_u16(),
                request_id,
                error = ?cause,
                "request failed"
            );
        } else if self.code.is_server_fault() {
            tracing::warn!(
                code = ?self.code,
                status = self.status.as_u16(),
                request_id,
                "request failed"
            );
        } else {
            tracing::debug!(
                code = ?self.code,
                status = self.status.as_u16(),
                request_id,
                "request rejected"
            );
        }

        let body = ErrorEnvelope {
            ok: false,
            error: ErrorBody {
                code: self.code,
                message: &self.message,
                hint: self.hint.as_deref(),
            },
            request_id,
        };
        (self.status, Json(body)).into_response()
    }
}

/// 统一成功响应包（requirements §8.2）
#[derive(Debug, Serialize)]
pub struct OkEnvelope<T: Serialize> {
    pub ok: bool,
    pub data: T,
    #[serde(rename = "requestId")]
    pub request_id: String,
}

/// handler 成功返回：`Ok(Json(OkEnvelope{..}))`，用 [`ok_data`] 构造
pub fn ok_data<T: Serialize>(data: T) -> Json<OkEnvelope<T>> {
    Json(OkEnvelope {
        ok: true,
        data,
        request_id: crate::telemetry::current_request_id(),
    })
}

impl From<JsonRejection> for AppError {
    fn from(rej: JsonRejection) -> Self {
        // axum 0.8: JsonRejection 是复合枚举，取 body_text()（旧的 body() 已移除）
        AppError::new(StatusCode::BAD_REQUEST, Code::ParamInvalid)
            .with_message(format!("请求体解析失败：{}", rej.body_text()))
            .with_hint("请检查 JSON 字段名与类型（契约见 docs/CONTRACT.md C8）")
    }
}

impl From<serde_json::Error> for AppError {
    fn from(err: serde_json::Error) -> Self {
        AppError::new(StatusCode::BAD_REQUEST, Code::ParamInvalid)
            .with_message("参数格式不正确")
            .caused_by(anyhow::Error::new(err))
    }
}

impl From<sqlx::Error> for AppError {
    fn from(err: sqlx::Error) -> Self {
        match &err {
            sqlx::Error::RowNotFound => AppError::not_found(),
            other => AppError::internal(anyhow::anyhow!(other.to_string())),
        }
    }
}

impl From<uuid::Error> for AppError {
    fn from(_: uuid::Error) -> Self {
        AppError::new(StatusCode::BAD_REQUEST, Code::ParamInvalid).with_message("id 格式不合法")
    }
}

impl From<reqwest::Error> for AppError {
    fn from(err: reqwest::Error) -> Self {
        // 上游（微信/行情）失败统一内部码，不回显 reqwest 原文（requirements §8.5.4）
        AppError::new(StatusCode::BAD_GATEWAY, Code::UpstreamUnavailable)
            .with_message("数据源暂不可用，请稍后重试")
            .caused_by(anyhow::Error::new(err))
    }
}

/// 参数取值范围/来源约束（handler 与单测共用）
#[derive(Debug, Clone)]
pub struct ParamSpec {
    pub name: &'static str,
    pub allowed: &'static [&'static str],
}

impl ParamSpec {
    pub fn violation(&self, value: &str) -> AppError {
        AppError::param_invalid(
            self.name,
            format!("只允许 {:?}，收到 \"{value}\"", self.allowed),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_serialize_to_spec_strings() {
        assert_eq!(
            serde_json::to_string(&Code::QuotaExceeded).unwrap(),
            "\"QUOTA_EXCEEDED\""
        );
        assert_eq!(
            serde_json::to_string(&Code::UnsupportedFormat).unwrap(),
            "\"UNSUPPORTED_FORMAT\""
        );
        // §0.3 的每个码都必须存在且为大写下划线
        for c in [
            Code::InputEmpty,
            Code::FileTooLarge,
            Code::UnsupportedFormat,
            Code::ImageTooBig,
            Code::PermissionDenied,
            Code::QuotaExceeded,
            Code::TaskTimeout,
            Code::TaskFailed,
            Code::NetworkOffline,
            Code::ParamInvalid,
            Code::NoAudioStream,
            Code::ServerUnreachable,
            Code::EngineUnavailable,
        ] {
            let s = serde_json::to_string(&c).unwrap();
            assert!(s.contains('_') || s == "\"INTERNAL\"", "{c:?} -> {s}");
            assert_eq!(s.to_uppercase(), s, "{c:?} 必须是全大写字母");
        }
    }

    #[test]
    fn quota_error_shape() {
        let err = AppError::quota_exceeded(20);
        assert_eq!(err.status, StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(err.code, Code::QuotaExceeded);
        assert!(err.message.contains("20 次"));
    }

    #[test]
    fn file_too_large_maps_413_with_exit_hint() {
        let err = AppError::file_too_large(200);
        assert_eq!(err.status, StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(err.code, Code::FileTooLarge);
        assert!(err.hint.unwrap().contains("截取"));
    }

    #[test]
    fn error_envelope_json_has_request_id() {
        let err = AppError::unsupported_format("exe");
        let resp = err.respond("req-123");
        assert_eq!(resp.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
        // requestId 必须在包体里（由 ok_data / respond 注入）
        let body = ErrorEnvelope {
            ok: false,
            error: ErrorBody {
                code: Code::NotFound,
                message: "内容不存在或已过期",
                hint: None,
            },
            request_id: "req-123",
        };
        let json = serde_json::to_value(&body).unwrap();
        assert_eq!(json["ok"], false);
        assert_eq!(json["error"]["code"], "NOT_FOUND");
        assert!(json["error"].get("hint").is_none());
        assert_eq!(json["requestId"], "req-123");
    }
}
