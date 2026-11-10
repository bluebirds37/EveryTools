//! 埋点上报（C8 `POST /usage/batch {events:[...]}` → `{ok}`）。
//!
//! 前端 `utils/track.js` 每批上报 `{event, props, at}`（props 只含指标字段：
//! toolId/engine/costMs/percent/code…，绝不含用户内容）。这里把它们落到 `tool_usage`
//! （requirements §8.3「每日配额统计」数据源）：
//! - 没有 `toolId` 的事件无法定位工具（`tool_id` 是 NOT NULL）→ 跳过；
//! - `success` 由事件名推断（`*_fail`/`*_failed` → false，其余 true）——前端事件不带
//!   显式成功标志，这是契约之外唯一的启发式，已在校验报告中如实说明；
//! - `day` 取事件发生时刻 `at`（epoch ms，UTC 日期），缺省退回 `current_date`；
//! - 单条落库失败不影响整批（埋点是尽力而为，绝不因遥测让用户端报错）。

use axum::{Json, extract::State};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::Value;

use crate::{
    auth::RequiredAuth,
    error::{ok_data, AppError, OkEnvelope},
    state::AppState,
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UsageEvent {
    #[serde(default)]
    event: Option<String>,
    #[serde(default)]
    props: Option<Value>,
    #[serde(default)]
    at: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct BatchReq {
    #[serde(default)]
    events: Vec<UsageEvent>,
}

pub async fn batch(
    auth: RequiredAuth,
    State(state): State<AppState>,
    Json(req): Json<BatchReq>,
) -> Result<Json<OkEnvelope<Value>>, AppError> {
    let user_id = auth.0.user_id;
    let mut inserted = 0i64;

    for ev in req.events {
        let props = ev.props.clone().unwrap_or(Value::Null);
        let tool_id = props.get("toolId").and_then(|v| v.as_str()).unwrap_or("");
        if tool_id.is_empty() {
            continue; // tool_usage.tool_id NOT NULL，无法归属的事件直接跳过
        }
        let engine = props
            .get("engine")
            .and_then(|v| v.as_str())
            .unwrap_or("client");
        let success = !ev
            .event
            .as_deref()
            .unwrap_or("")
            .ends_with("_fail")
            && !ev
                .event
                .as_deref()
                .unwrap_or("")
                .ends_with("_failed");
        let cost_ms: Option<i32> = props
            .get("costMs")
            .and_then(|v| v.as_f64())
            .map(|v| v.clamp(0.0, i32::MAX as f64) as i32);

        let day = match ev.at {
            Some(ms) if ms > 0 => DateTime::<Utc>::from_timestamp_millis(ms)
                .map(|d| d.date_naive())
                .unwrap_or_else(|| Utc::now().date_naive()),
            _ => Utc::now().date_naive(),
        };

        let res = sqlx::query(
            "INSERT INTO tool_usage (user_id, tool_id, engine, success, cost_ms, day, created_at)
             VALUES ($1,$2,$3,$4,$5,$6, now())",
        )
        .bind(user_id)
        .bind(tool_id)
        .bind(engine)
        .bind(success)
        .bind(cost_ms)
        .bind(day)
        .execute(state.db.pool())
        .await;

        match res {
            Ok(_) => inserted += 1,
            Err(e) => tracing::debug!(error = ?e, "usage event insert skipped"),
        }
    }

    Ok(ok_data(Value::Object({
        let mut m = serde_json::Map::new();
        m.insert("ok".into(), Value::Bool(true));
        m.insert("accepted".into(), Value::from(inserted));
        m
    })))
}
