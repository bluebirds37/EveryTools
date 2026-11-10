//! 开发期 HTTP 代理（FR-DEV-01 / CONTRACT C8 `POST /dev/proxy`）
//!
//! 用途：小程序「HTTP 调试」工具页勾选「后端代理」时，由服务端代发请求，
//! 绕开小程序合法域名限制，便于调试任意外部 API。
//!
//! ⚠️ 这是**服务端任意请求转发**能力，因此必须按 docs/requirements.md §8.5 做严防：
//! 1. **协议白名单**：只允许 `http` / `https`（`file://`、`gopher://` 等直接拒）。
//! 2. **SSRF 拦截**：主机名解析后的**每一个** IP 都必须是公网地址；
//!    回环（127.0.0.0/8、::1）、私有（10/8、172.16/12、192.168/16）、链路本地
//!    （169.254/16，含云厂商元数据 169.254.169.254）、运营商级 NAT 100.64/10、
//!    组播/保留段、`0.0.0.0`、IPv6 ULA（fc00::/7）全部拒绝。
//!    IP 字面量同样校验（`http://127.0.0.1:8080/healthz` 这种自检请求必须被拒）。
//! 3. **不自动跟随重定向**：`Policy::none()` + 手工循环，每一跳重新做 1/2 校验，
//!    否则公网 302 → 内网就绕过了防御；最多 5 跳。
//! 4. **响应体上限**：`Settings::proxy_max_response_bytes`（.env `PROXY_MAX_RESPONSE_BYTES`），
//!    超限截断并置 `truncated:true`，不把大文件塞进内存。
//! 5. **敏感响应头不透传**：`set-cookie` / `cookie` / `authorization` /
//!    `proxy-authenticate` / `www-authenticate` / `x-amz-*` / `x-goog-*` 一律剔除。
//! 6. **不发 Cookie**：请求侧同样过滤 `cookie`/`cookie2`，避免把用户凭据带出去。
//!
//! 响应形状是**前端契约**（`miniprogram/packageDev/pages/http/index.js` 已按此对接）：
//! ```json
//! { "status":200, "statusText":"OK", "headers":{...}, "bodyText":"...",
//!   "bodyBytes":123, "elapsedMs":45, "truncated":false, "finalUrl":"https://..." }
//! ```
//! 因此字段名（含 `status`/`bodyText`/`elapsedMs`/`truncated`/`headers`）与
//! `upstream`（`finalUrl`）都不得改动。
//!
//! 本地开发想放行内网调试地址时，显式设置 `PROXY_ALLOW_PRIVATE_NETWORK=1`
//! （`Settings::proxy_allow_private_network`）；**生产环境必须保持 false**。

use std::{
    collections::BTreeMap,
    net::{IpAddr, SocketAddr},
    time::{Duration, Instant},
};

use axum::Json;
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use reqwest::{
    Client, Url,
    header::{HeaderName, HeaderValue},
    redirect::Policy,
};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::{
    error::{AppError, Code},
    state::AppState,
};

/// 最大跟随重定向跳数（每跳都重新做 SSRF 校验）
pub const MAX_REDIRECTS: usize = 5;
/// 前端「超时」滑杆 2~30 秒（`packageDev/pages/http`），服务端再兜一层上限
pub const MAX_TIMEOUT_SECS: u64 = 60;
/// 转发请求体上限（防止代理变成上传通道）
pub const MAX_REQUEST_BODY_BYTES: usize = 512 * 1024;
/// 允许的请求方法
pub const ALLOWED_METHODS: &[&str] = &["GET", "POST", "PUT", "DELETE", "HEAD", "PATCH", "OPTIONS"];

// ---------------------------------------------------------------------------
// 请求体（C8：`{url,method,headers,body,timeoutMs}`）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyInput {
    pub url: String,
    #[serde(default)]
    pub method: Option<String>,
    /// 对象形式 `{"X-A":"b"}`；也兼容 `"K: V"` 字符串数组
    #[serde(default)]
    pub headers: Option<Value>,
    /// 文本或（会被序列化成 JSON 文本的）任意 JSON；base64 时用 `{base64: "..."}`
    #[serde(default)]
    pub body: Option<Value>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

/// `POST /dev/proxy` handler（`routes` 挂在鉴权分组里）
pub async fn proxy_handler(
    state: AppState,
    Json(input): Json<ProxyInput>,
) -> Result<Json<crate::OkEnvelope<Value>>, AppError> {
    let cfg = state.cfg();
    let method = normalize_method(input.method.as_deref())?;
    let body = decode_body(input.body.as_ref())?;
    if body.len() > MAX_REQUEST_BODY_BYTES {
        return Err(AppError::file_too_large(MAX_REQUEST_BODY_BYTES as u64 / 1024).with_message(
            format!(
                "请求体超过 {}KB，代理不支持大文件上传",
                MAX_REQUEST_BODY_BYTES / 1024
            ),
        ));
    }
    let headers = parse_headers(input.headers.as_ref())?;
    let timeout = clamp_timeout(input.timeout_ms, cfg.proxy_timeout_secs);
    let max_bytes = cfg.proxy_max_response_bytes as usize;
    let allow_private = cfg.proxy_allow_private_network;

    let outcome = forward(&method, &input.url, headers, body, timeout, max_bytes, allow_private).await?;
    Ok(crate::ok_data(outcome))
}

/// 纯转发逻辑（handler 只做解包，便于单测直接调用）
pub async fn forward(
    method: &str,
    raw_url: &str,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
    timeout: Duration,
    max_response_bytes: usize,
    allow_private_network: bool,
) -> Result<Value, AppError> {
    let started = Instant::now();
    // Policy::none()：绝不自动跟随重定向（跳数与目标在下面的循环里逐跳校验）
    let client = Client::builder()
        .redirect(Policy::none())
        .timeout(timeout)
        .connect_timeout(timeout.min(Duration::from_secs(10)))
        .build()
        .map_err(|e| AppError::internal(anyhow::anyhow!(e)))?;

    let http_method = method
        .parse::<reqwest::Method>()
        .map_err(|_| AppError::param_invalid("method", "HTTP 方法不合法"))?;
    let mut current = validate_target_async(raw_url, allow_private_network).await?;
    let mut sent_headers = headers.clone();

    for hop in 0..=MAX_REDIRECTS {
        let mut req = client
            .request(http_method.clone(), current.clone())
            .timeout(timeout);
        for (k, v) in &sent_headers {
            req = req.header(k.as_str(), v.as_str());
        }
        if !body.is_empty() && method != "GET" && method != "HEAD" {
            req = req.body(body.clone());
        }
        let resp = req.send().await.map_err(|e| {
            AppError::new(
                axum::http::StatusCode::BAD_GATEWAY,
                Code::ServerUnreachable,
            )
            .with_message("目标地址无法连接")
            .caused_by(anyhow::Error::from(e))
        })?;

        let status = resp.status();
        let from_url = current.clone();
        let header_map = filter_response_headers(resp.headers());
        let (text, bytes_read, truncated) = read_body_capped(resp, max_response_bytes).await?;

        // 3xx：只有带 Location 且跳数在预算内才继续
        if status.is_redirection() && hop < MAX_REDIRECTS {
            if let Some(loc) = header_map
                .get("location")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
            {
                let next = from_url.join(&loc).map_err(|_| {
                    AppError::ssrf_blocked("重定向地址无法解析")
                })?;
                // 关键：跳到内网/元数据地址同样拦截（先校验再请求）
                current = validate_target_async(next.as_str(), allow_private_network).await?;
                // 跨主机跳转时丢掉凭据类头，避免把 Authorization/Cookie 带到别的域
                if current.host_str() != from_url.host_str() {
                    sent_headers.retain(|(k, _)| !is_credential_header(k));
                }
                continue;
            }
        }

        return Ok(json!({
            "status": status.as_u16(),
            "statusText": status.canonical_reason().unwrap_or(""),
            "headers": header_map,
            "bodyText": text,
            "bodyBytes": bytes_read,
            "elapsedMs": started.elapsed().as_millis() as u64,
            "truncated": truncated,
            "finalUrl": from_url.to_string(),
        }));
    }
    Err(AppError::new(
        axum::http::StatusCode::BAD_GATEWAY,
        Code::ServerUnreachable,
    )
    .with_message(format!("重定向超过 {MAX_REDIRECTS} 跳，已中止"))
    .with_hint("请检查目标地址是否存在跳转循环"))
}

// ---------------------------------------------------------------------------
// 校验：协议 / 方法 / 头 / body
// ---------------------------------------------------------------------------

/// 同步校验（协议 + IP 字面量 + 保留域名），**不做 DNS**。
/// 需要完整防御请用 [`validate_target_async`]（会解析域名并逐个 IP 校验）。
pub fn validate_target(raw: &str, allow_private_network: bool) -> Result<Url, AppError> {
    let url = parse_and_check_scheme(raw)?;
    if allow_private_network {
        return Ok(url);
    }
    let host = url
        .host_str()
        .ok_or_else(|| AppError::param_invalid("url", "地址缺少主机名"))?
        .to_string();
    if let Some(ip) = ip_literal(&host) {
        if let Some(reason) = private_reason(ip) {
            return Err(ssrf_err(&host, reason));
        }
        return Ok(url);
    }
    if is_reserved_hostname(&host) {
        return Err(ssrf_err(&host, "本机/内网保留域名"));
    }
    Ok(url)
}

/// 完整校验：协议 + 主机 + 解析后的每一个 IP（handler 与重定向每一跳都走这里）
pub async fn validate_target_async(
    raw: &str,
    allow_private_network: bool,
) -> Result<Url, AppError> {
    let url = parse_and_check_scheme(raw)?;
    if allow_private_network {
        return Ok(url);
    }
    let host = url
        .host_str()
        .ok_or_else(|| AppError::param_invalid("url", "地址缺少主机名"))?
        .to_string();
    let port = url
        .port_or_known_default()
        .unwrap_or(if url.scheme() == "https" { 443 } else { 80 });
    check_host(&host, port).await?;
    Ok(url)
}

fn parse_and_check_scheme(raw: &str) -> Result<Url, AppError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(AppError::param_invalid("url", "地址不能为空"));
    }
    let scheme_end = trimmed
        .find("://")
        .ok_or_else(|| AppError::ssrf_blocked("只允许 http/https 地址（缺少协议名）"))?;
    let scheme = trimmed[..scheme_end].to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return Err(AppError::ssrf_blocked(format!(
            "只允许 http/https，收到 \"{scheme}://\""
        )));
    }
    let url = Url::parse(trimmed)
        .map_err(|e| AppError::param_invalid("url", format!("地址格式不合法：{e}")))?;
    match url.scheme() {
        "http" | "https" => {}
        other => {
            return Err(AppError::ssrf_blocked(format!("只允许 http/https，收到 \"{other}\"")));
        }
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(AppError::param_invalid(
            "url",
            "地址里不要携带账号密码，请改用请求头",
        ));
    }
    Ok(url)
}

/// `url` crate 的 `host_str()` 对 IPv6 字面量保留方括号（`"[::1]"`），
/// 直接 `parse::<IpAddr>()` 会失败并**跳过 SSRF 判定**，因此比较前先剥掉括号。
fn ip_literal(host: &str) -> Option<IpAddr> {
    let bare = host
        .strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(host);
    bare.parse::<IpAddr>().ok()
}

/// 主机（域名或 IP 字面量）→ 逐个 IP 校验，返回解析到的地址列表
pub async fn check_host(host: &str, port: u16) -> Result<Vec<IpAddr>, AppError> {
    if let Some(ip) = ip_literal(host) {
        if let Some(reason) = private_reason(ip) {
            return Err(ssrf_err(host, reason));
        }
        return Ok(vec![ip]);
    }
    if is_reserved_hostname(host) {
        return Err(ssrf_err(host, "本机/内网保留域名"));
    }
    let addrs = lookup(host, port).await?;
    if addrs.is_empty() {
        return Err(AppError::new(
            axum::http::StatusCode::BAD_GATEWAY,
            Code::ServerUnreachable,
        )
        .with_message("目标地址无法解析"));
    }
    for ip in &addrs {
        if let Some(reason) = private_reason(*ip) {
            return Err(ssrf_err(host, reason));
        }
    }
    Ok(addrs)
}

fn is_reserved_hostname(host: &str) -> bool {
    let h = host.trim_end_matches('.').to_ascii_lowercase();
    h == "localhost"
        || h.ends_with(".localhost")
        || h.ends_with(".local")
        || h.ends_with(".internal")
        || h.ends_with(".localdomain")
        || h == "metadata"
        || h == "metadata.google.internal"
}

async fn lookup(host: &str, port: u16) -> Result<Vec<IpAddr>, AppError> {
    let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host, port))
        .await
        .map_err(|e| {
            AppError::new(
                axum::http::StatusCode::BAD_GATEWAY,
                Code::ServerUnreachable,
            )
            .with_message("目标地址无法解析")
            .caused_by(anyhow::Error::new(e))
        })?
        .collect();
    Ok(addrs.into_iter().map(|a| a.ip()).collect())
}

fn ssrf_err(host: &str, reason: &str) -> AppError {
    AppError::ssrf_blocked(format!("{host} 指向{reason}，出于安全考虑不允许访问")).with_hint(
        format!("代理仅可访问公网 http/https 地址；本地调试请直连，或设置 {ENV_ALLOW_PRIVATE}=1"),
    )
}

const ENV_ALLOW_PRIVATE: &str = "PROXY_ALLOW_PRIVATE_NETWORK";

/// 内网/保留地址判定（返回中文原因，`None` 表示公网可访问）
pub fn private_reason(ip: IpAddr) -> Option<&'static str> {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            if v4.is_loopback() {
                Some("回环地址（127.0.0.0/8）")
            } else if v4.is_private() {
                // RFC1918：10/8、172.16/12、192.168/16
                Some(match o[0] {
                    10 => "内网地址（10.0.0.0/8）",
                    172 => "内网地址（172.16.0.0/12）",
                    _ => "内网地址（192.168.0.0/16）",
                })
            } else if v4.is_link_local() {
                // 169.254/16：含云厂商元数据服务 169.254.169.254
                Some("链路本地地址（169.254.0.0/16，云主机元数据服务在此段）")
            } else if o[0] == 100 && (o[1] & 0b1100_0000) == 0b0100_0000 {
                Some("运营商级 NAT 地址（100.64.0.0/10）")
            } else if o[0] == 0 {
                Some("本机地址（0.0.0.0/8）")
            } else if v4.is_multicast() {
                Some("组播地址（224.0.0.0/4）")
            } else if o[0] >= 240 {
                Some("保留地址（240.0.0.0/4）")
            } else if o[0] == 192 && o[1] == 0 {
                // 192.0.0.0/24（IETF 协议保留）与 192.0.2.0/24（TEST-NET-1）
                Some("协议保留地址（192.0.0.0/24）")
            } else if o[0] == 198 && (o[1] == 18 || o[1] == 19) {
                Some("设备基准测试地址（198.18.0.0/15）")
            } else if o[0] == 192 && o[1] == 88 && o[2] == 99 {
                Some("6to4 任播中继地址（192.88.99.0/24）")
            } else {
                None
            }
        }
        IpAddr::V6(v6) => {
            let seg = v6.segments();
            if v6.is_loopback() {
                Some("IPv6 回环地址（::1）")
            } else if v6.to_ipv4_mapped()
                .is_some_and(|v4| private_reason(IpAddr::V4(v4)).is_some())
            {
                Some("IPv4 映射的内网地址（::ffff:…）")
            } else if (seg[0] & 0xfe00) == 0xfc00 {
                Some("IPv6 本地私有地址（fc00::/7）")
            } else if (seg[0] & 0xffc0) == 0xfe80 {
                Some("IPv6 链路本地地址（fe80::/10）")
            } else if v6.is_unspecified() {
                Some("IPv6 未指定地址（::）")
            } else if seg[0] == 0x2002 {
                Some("6to4 地址（2002::/16）")
            } else if seg[0] == 0x0064 && seg[1] == 0xff9b {
                Some("IPv4 转换保留地址（64:ff9b::/96）")
            } else if v6.is_multicast() {
                Some("IPv6 组播地址（ff00::/8）")
            } else {
                None
            }
        }
    }
}

/// 凭据类请求头（跨域跳转时丢掉）
fn is_credential_header(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    matches!(
        n.as_str(),
        "authorization" | "proxy-authorization" | "cookie" | "cookie2" | "x-api-key" | "set-cookie"
    )
}

/// 响应头剔除清单（§8.5：不把上游 Cookie/鉴权信息透给前端）
const STRIPPED_RESPONSE_HEADERS: &[&str] = &[
    "set-cookie",
    "cookie",
    "cookie2",
    "authorization",
    "proxy-authenticate",
    "www-authenticate",
    "proxy-authorization",
    "x-amz-id-2",
    "x-amz-request-id",
    "x-goog-generation",
    "x-powered-by",
    "server",
    "connection",
    "keep-alive",
    "transfer-encoding",
    "upgrade",
    "content-encoding",
];

/// 请求头剔除清单（ hop-by-hop + 凭据外带 + reqwest 自己会算的 ）
const STRIPPED_REQUEST_HEADERS: &[&str] = &[
    "host",
    "connection",
    "keep-alive",
    "proxy-connection",
    "transfer-encoding",
    "upgrade",
    "te",
    "trailer",
    "content-length",
    "cookie",
    "cookie2",
    "set-cookie",
];

pub fn filter_response_headers(headers: &reqwest::header::HeaderMap) -> Value {
    let mut out: BTreeMap<String, Value> = BTreeMap::new();
    for (name, value) in headers.iter() {
        let key = name.as_str().to_ascii_lowercase();
        if STRIPPED_RESPONSE_HEADERS.contains(&key.as_str()) || key.starts_with("x-amz-") {
            continue;
        }
        let text = match value.to_str() {
            Ok(s) => s.to_string(),
            Err(_) => BASE64.encode(value.as_bytes()),
        };
        // 同名多值（如多个 via）合并成 ", " 便于前端表格展示
        out.entry(key)
            .and_modify(|e| {
                if let Some(s) = e.as_str() {
                    *e = json!(format!("{s}, {text}"));
                }
            })
            .or_insert(json!(text));
    }
    Value::Object(out.into_iter().map(|(k, v)| (k, v)).collect())
}

/// `{"K":"V"}` / `["K: V"]` / `"K: V\nK2: V2"` → 过滤后的头列表
pub fn parse_headers(input: Option<&Value>) -> Result<Vec<(String, String)>, AppError> {
    let Some(v) = input else {
        return Ok(Vec::new());
    };
    let mut pairs: Vec<(String, String)> = Vec::new();
    match v {
        Value::Null => {}
        Value::Object(map) => {
            for (k, val) in map {
                let text = value_to_header_string(val)?;
                pairs.push((k.clone(), text));
            }
        }
        Value::Array(items) => {
            for item in items {
                let line = match item {
                    Value::String(s) => s.clone(),
                    _ => {
                        return Err(AppError::param_invalid(
                            "headers",
                            "数组形式只支持字符串，如 \"Accept: application/json\"",
                        ));
                    }
                };
                let Some((k, val)) = line.split_once(':') else {
                    return Err(AppError::param_invalid(
                        "headers",
                        format!("\"{line}\" 缺少冒号，应写成 名称: 值"),
                    ));
                };
                pairs.push((k.trim().to_string(), val.trim().to_string()));
            }
        }
        Value::String(text) => {
            for line in text.lines() {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                let Some((k, val)) = line.split_once(':') else {
                    return Err(AppError::param_invalid(
                        "headers",
                        format!("\"{line}\" 缺少冒号，应写成 名称: 值"),
                    ));
                };
                pairs.push((k.trim().to_string(), val.trim().to_string()));
            }
        }
        other => {
            return Err(AppError::param_invalid(
                "headers",
                format!("必须是对象或字符串，收到 {}", other),
            ));
        }
    }
    let mut out = Vec::new();
    for (k, val) in pairs {
        if k.trim().is_empty() {
            return Err(AppError::param_invalid("headers", "头名称不能为空"));
        }
        let lower = k.to_ascii_lowercase();
        if STRIPPED_REQUEST_HEADERS.contains(&lower.as_str()) {
            tracing::debug!(header = %lower, "proxy dropped hop-by-hop/credential request header");
            continue;
        }
        // 头值必须是可见 ASCII（防止 CRLF 注入）
        if val.contains(['\r', '\n']) {
            return Err(AppError::param_invalid(
                "headers",
                format!("{lower} 的值不能包含换行"),
            ));
        }
        let name = HeaderName::try_from(lower.as_str())
            .map_err(|_| AppError::param_invalid("headers", format!("\"{k}\" 不是合法头名称")))?;
        let value = HeaderValue::from_str(&val).map_err(|_| {
            AppError::param_invalid("headers", format!("{lower} 的值含非 ASCII 字符，请改用文本"))
        })?;
        out.push((name.to_string(), value.to_str().unwrap_or_default().to_string()));
    }
    Ok(out)
}

fn value_to_header_string(val: &Value) -> Result<String, AppError> {
    match val {
        Value::String(s) => Ok(s.clone()),
        Value::Number(n) => Ok(n.to_string()),
        Value::Bool(b) => Ok(b.to_string()),
        other => Err(AppError::param_invalid(
            "headers",
            format!("头值必须是字符串/数字，收到 {other}"),
        )),
    }
}

/// `body`：字符串（含 base64 对象）按文本转发；对象/数组序列化成 JSON 文本。
pub fn decode_body(input: Option<&Value>) -> Result<Vec<u8>, AppError> {
    let Some(v) = input else {
        return Ok(Vec::new());
    };
    match v {
        Value::Null => Ok(Vec::new()),
        Value::String(s) => Ok(s.clone().into_bytes()),
        Value::Object(map) if map.get("base64").and_then(|b| b.as_str()).is_some() => {
            let raw = map.get("base64").and_then(|b| b.as_str()).unwrap_or_default();
            BASE64
                .decode(raw)
                .map_err(|_| AppError::param_invalid("body", "base64 内容无法解码"))
        }
        other => serde_json::to_vec(other).map_err(AppError::from),
    }
}

/// 方法归一化 + 白名单
pub fn normalize_method(input: Option<&str>) -> Result<String, AppError> {
    let m = input.unwrap_or("GET").trim().to_ascii_uppercase();
    let m = if m.is_empty() { "GET".to_string() } else { m };
    if ALLOWED_METHODS.contains(&m.as_str()) {
        Ok(m)
    } else {
        Err(AppError::param_invalid(
            "method",
            format!("只允许 {:?}，收到 \"{m}\"", ALLOWED_METHODS),
        ))
    }
}

/// 超时：前端 2~30s，服务端上限 60s；未给则用配置默认
pub fn clamp_timeout(input_ms: Option<u64>, cfg_secs: u64) -> Duration {
    let secs = match input_ms {
        Some(ms) if ms > 0 => (ms / 1000).max(1),
        _ => cfg_secs.max(1),
    };
    Duration::from_secs(secs.min(MAX_TIMEOUT_SECS))
}

/// 读响应体并截断（返回 `(文本, 实际读取字节数, 是否截断)`）
async fn read_body_capped(
    mut resp: reqwest::Response,
    max_bytes: usize,
) -> Result<(String, usize, bool), AppError> {
    let declared = resp.content_length().unwrap_or(0) as usize;
    let mut buf: Vec<u8> = Vec::with_capacity(declared.min(max_bytes).min(64 * 1024));
    let mut truncated = false;
    while let Some(chunk) = resp.chunk().await.map_err(|e| {
        AppError::new(
            axum::http::StatusCode::BAD_GATEWAY,
            Code::ServerUnreachable,
        )
        .with_message("读取上游响应失败")
        .caused_by(anyhow::Error::from(e))
    })? {
        if buf.len() + chunk.len() > max_bytes {
            let take = max_bytes.saturating_sub(buf.len());
            buf.extend_from_slice(&chunk[..take]);
            truncated = true;
            break;
        }
        buf.extend_from_slice(&chunk);
    }
    // 上游声明的 Content-Length 超限也标记截断（正文只保留上限内的部分）
    if declared > max_bytes {
        truncated = true;
    }
    let text = String::from_utf8_lossy(&buf).to_string();
    Ok((text, buf.len(), truncated))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn ssrf_matrix_blocks_private_loopback_linklocal_metadata() {
        // 用户给的矩阵：127. / 10. / 192.168. / 169.254.169.254 / 非 http
        for bad in [
            "127.0.0.1",
            "127.8.9.10",
            "::1",
            "10.0.0.1",
            "10.255.255.254",
            "192.168.1.1",
            "192.168.0.100",
            "172.16.0.1",
            "172.31.255.255",
            "169.254.169.254",
            "169.254.0.1",
            "100.64.0.1",
            "100.127.255.255",
            "0.0.0.0",
            "224.0.0.1",
            "240.0.0.1",
            "192.0.2.1",
            "198.18.0.1",
            "fd00::1234",
            "fe80::1",
            "::ffff:127.0.0.1",
        ] {
            let reason = private_reason(ip(bad));
            assert!(reason.is_some(), "{bad} 必须被判定为内网/保留地址");
            assert!(!reason.unwrap().is_empty(), "{bad}");
        }
    }

    #[test]
    fn ssrf_matrix_allows_public_addresses() {
        for ok in [
            "8.8.8.8",
            "1.1.1.1",
            "93.184.216.34",
            "172.15.0.1",
            "172.32.0.1",
            "100.63.0.1",
            "100.128.0.1",
            "169.253.0.1",
            "203.0.113.9", // TEST-NET-3：不是内网段，代理允许（本机无路由而已）
            "2606:4700:4700::1111",
        ] {
            assert_eq!(private_reason(ip(ok)), None, "{ok} 不该被拦");
        }
    }

    #[test]
    fn non_http_schemes_are_rejected_before_any_request() {
        for bad in [
            "file:///etc/passwd",
            "gopher://127.0.0.1:70/tcp/x",
            "ftp://example.com/file",
            "http+unix:///var/run/docker.sock",
            "dict://127.0.0.1:11211",
            "  ",
            "example.com/no-scheme",
        ] {
            let err = validate_target(bad, false).expect_err("{bad} 必须被拒");
            assert!(
                err.code == Code::SsrfBlocked || err.code == Code::ParamInvalid,
                "{bad} -> {:?}",
                err.code
            );
        }
    }

    #[test]
    fn ipv6_literals_are_parsed_despite_brackets() {
        // url::Url::host_str() 对 IPv6 保留方括号；ip_literal 必须剥掉，否则 SSRF 判定被整体跳过
        assert_eq!(ip_literal("[::1]"), Some(IpAddr::V6("::1".parse().unwrap())));
        assert_eq!(ip_literal("::1"), Some(IpAddr::V6("::1".parse().unwrap())));
        assert_eq!(ip_literal("[2001:4860:4860::8888]"), Some(IpAddr::V6("2001:4860:4860::8888".parse().unwrap())));
        assert_eq!(ip_literal("example.com"), None);
        assert_eq!(ip_literal("[not-an-ip]"), None);
    }

    #[test]
    fn literal_private_urls_are_rejected_without_dns() {
        for bad in [
            "http://127.0.0.1:8080/healthz",
            "http://localhost:8080/healthz",
            "http://169.254.169.254/latest/meta-data/",
            "http://10.0.0.5/admin",
            "http://192.168.1.1/",
            "http://[::1]:8080/",
            "http://[fd00::1234]/admin",
            "http://[fe80::1]/",
            "http://[::ffff:127.0.0.1]/",
            "http://metadata.google.internal/",
        ] {
            let err = validate_target(bad, false).expect_err("{bad} 必须被拒");
            assert_eq!(err.code, Code::SsrfBlocked, "{bad}");
            assert!(err.message.contains("不允许访问") || err.message.contains("内网") || err.message.contains("保留") || err.message.contains("回环") || err.message.contains("本机") || err.message.contains("链路本地") || err.message.contains("元数据"), "{bad}: {}", err.message);
        }
    }

    #[test]
    fn public_urls_pass_validation() {
        for ok in [
            "https://example.com/api",
            "https://93.184.216.34/",
            "http://8.8.8.8/?q=1",
        ] {
            let url = validate_target(ok, false).unwrap_or_else(|e| panic!("{ok}: {}", e.message));
            assert!(matches!(url.scheme(), "http" | "https"));
        }
        // 显式放行内网（仅本地开发）时，127.0.0.1 可以过协议校验
        let allowed = validate_target("http://127.0.0.1:8080/healthz", true).unwrap();
        assert_eq!(allowed.host_str(), Some("127.0.0.1"));
    }

    #[test]
    fn userinfo_in_url_is_rejected() {
        let err = validate_target("http://admin:p@ss@8.8.8.8/", false).unwrap_err();
        assert!(err.code == Code::ParamInvalid || err.code == Code::SsrfBlocked);
    }

    #[test]
    fn reserved_hostnames_are_blocked() {
        for h in ["localhost", "foo.local", "bar.internal", "metadata"] {
            assert!(is_reserved_hostname(h), "{h}");
        }
        assert!(!is_reserved_hostname("example.com"));
    }

    #[test]
    fn response_header_filter_drops_credentials_and_hop_by_hop() {
        let mut h = reqwest::header::HeaderMap::new();
        h.insert("set-cookie", HeaderValue::from_static("sid=secret; HttpOnly"));
        h.insert("authorization", HeaderValue::from_static("Bearer secret"));
        h.insert("www-authenticate", HeaderValue::from_static("Basic realm=x"));
        h.insert("proxy-authenticate", HeaderValue::from_static("Basic"));
        h.insert("connection", HeaderValue::from_static("keep-alive"));
        h.insert("transfer-encoding", HeaderValue::from_static("chunked"));
        h.insert("content-type", HeaderValue::from_static("application/json"));
        h.insert("x-trace", HeaderValue::from_static("abc"));
        let out = filter_response_headers(&h);
        let map = out.as_object().unwrap();
        assert!(map.contains_key("content-type"), "{out}");
        assert!(map.contains_key("x-trace"));
        for gone in [
            "set-cookie",
            "authorization",
            "www-authenticate",
            "proxy-authenticate",
            "connection",
            "transfer-encoding",
            "server",
            "x-powered-by",
        ] {
            assert!(!map.contains_key(gone), "{gone} 不该透传");
        }
        assert!(!serde_json::to_string(&out).unwrap().contains("secret"));
    }

    #[test]
    fn request_header_parsing_covers_all_three_frontend_forms() {
        let obj = json!({"Accept": "application/json", "X-Trace": 1});
        let parsed = parse_headers(Some(&obj)).unwrap();
        assert!(parsed.contains(&("accept".into(), "application/json".into())));
        assert!(parsed.iter().any(|(k, v)| k == "x-trace" && v == "1"));

        let arr = json!(["Content-Type: application/json", "X-A: b"]);
        assert_eq!(
            parse_headers(Some(&arr)).unwrap().len(),
            2
        );

        let text = json!("Content-Type: application/json\nX-A: b\n");
        assert_eq!(parse_headers(Some(&text)).unwrap().len(), 2);

        assert!(parse_headers(None).unwrap().is_empty());
        assert_eq!(parse_headers(Some(&json!(null))).unwrap().len(), 0);
    }

    #[test]
    fn request_header_filter_drops_cookies_and_host_and_rejects_crlf() {
        let h = json!({"Cookie": "sid=secret", "Host": "attacker.example", "X-Ok": "1"});
        let parsed = parse_headers(Some(&h)).unwrap();
        assert_eq!(parsed.len(), 1, "cookie/host 必须被剔除");
        assert_eq!(parsed[0].0, "x-ok");

        let err = parse_headers(Some(&json!({"X-A": "a\r\nSet-Cookie: b=1"}))).unwrap_err();
        assert_eq!(err.code, Code::ParamInvalid);
        assert!(err.message.contains("换行"));

        let bad = parse_headers(Some(&json!(["no colon here"]))).unwrap_err();
        assert_eq!(bad.code, Code::ParamInvalid);
    }

    #[test]
    fn method_and_timeout_normalization() {
        assert_eq!(normalize_method(None).unwrap(), "GET");
        assert_eq!(normalize_method(Some("post")).unwrap(), "POST");
        assert_eq!(normalize_method(Some("  ")).unwrap(), "GET");
        for bad in ["TRACE", "CONNECT", "TRACK", "get; DROP"] {
            assert_eq!(normalize_method(Some(bad)).unwrap_err().code, Code::ParamInvalid, "{bad}");
        }
        assert_eq!(clamp_timeout(Some(15_000), 15), Duration::from_secs(15));
        assert_eq!(
            clamp_timeout(Some(10), 15),
            Duration::from_secs(1),
            "入参单位是毫秒：不足 1s 的请求按 1s 下限执行"
        );
        assert_eq!(clamp_timeout(Some(999_000), 15), Duration::from_secs(MAX_TIMEOUT_SECS));
        assert_eq!(clamp_timeout(Some(0), 7), Duration::from_secs(7));
        assert_eq!(clamp_timeout(None, 0), Duration::from_secs(1));
    }

    #[test]
    fn body_decoding_covers_text_json_and_base64() {
        assert_eq!(decode_body(None).unwrap(), Vec::<u8>::new());
        assert_eq!(decode_body(Some(&json!("hello"))).unwrap(), b"hello");
        assert_eq!(
            serde_json::from_slice::<Value>(&decode_body(Some(&json!({"a": 1}))).unwrap()).unwrap(),
            json!({"a": 1})
        );
        assert_eq!(decode_body(Some(&json!({"base64": "eHl6"}))).unwrap(), b"xyz");
        assert_eq!(
            decode_body(Some(&json!({"base64": "!!"}))).unwrap_err().code,
            Code::ParamInvalid
        );
    }

    #[test]
    fn credential_headers_are_dropped_on_cross_host_redirect() {
        assert!(is_credential_header("Authorization"));
        assert!(is_credential_header("cookie"));
        assert!(!is_credential_header("accept"));
    }

    #[tokio::test]
    async fn async_validation_blocks_private_literal_hosts() {
        for bad in [
            "http://127.0.0.1:8080/healthz",
            "http://169.254.169.254/",
            "http://192.168.1.1/",
            "http://10.1.2.3/",
            "file:///etc/passwd",
        ] {
            let err = validate_target_async(bad, false).await.unwrap_err();
            assert!(
                err.code == Code::SsrfBlocked || err.code == Code::ParamInvalid,
                "{bad} -> {:?}",
                err.code
            );
        }
    }

    #[tokio::test]
    async fn forward_to_private_target_is_refused_before_connect() {
        // 不允许私网时：连 TCP 都不发起（本机 8080 是否在跑都无所谓）
        let err = forward(
            "GET",
            "http://127.0.0.1:8080/healthz",
            Vec::new(),
            Vec::new(),
            Duration::from_secs(1),
            1024,
            false,
        )
        .await
        .expect_err("必须拒绝内网目标");
        assert!(err.code == Code::SsrfBlocked || err.code == Code::ParamInvalid, "{err:?}");
    }

    #[tokio::test]
    async fn forward_rejects_unresolvable_or_down_public_target() {
        // .invalid 域名（RFC2606 保证永不解析）：不依赖真 ffmpeg/真外网
        let err = forward(
            "GET",
            "https://toolbox-nonexistent.invalid/x",
            Vec::new(),
            Vec::new(),
            Duration::from_secs(2),
            1024,
            false,
        )
        .await
        .expect_err("解析失败必须报错");
        assert!(
            err.code == Code::SsrfBlocked
                || err.code == Code::ServerUnreachable
                || err.code == Code::UpstreamUnavailable,
            "{:?}",
            err.code
        );
    }
}
