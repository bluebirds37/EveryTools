//! 工具开关（C8 `GET /tools/flags` → `{flags:{[toolId]:{enabled,sort}}}`）。
//!
//! 游客可访问（不挂 `RequiredAuth`）：前端 `request.js` 对 `/tools/flags` 走 `auth:false`
//! 分支时可能不带 token，灰度/开关本身不含用户数据，泄露无风险。
//! DB `tool_flags` 为空时返回空对象，前端据此退回本地 registry 默认值。

use axum::{extract::State, Json};
use serde_json::{Value, json};
use sqlx::Row;

use crate::{
    error::{ok_data, AppError, OkEnvelope},
    state::AppState,
};

pub async fn flags(State(state): State<AppState>) -> Result<Json<OkEnvelope<Value>>, AppError> {
    let rows = sqlx::query("SELECT tool_id, enabled, sort FROM tool_flags ORDER BY sort, tool_id")
        .fetch_all(state.db.pool())
        .await
        .map_err(|e| AppError::internal(anyhow::anyhow!(e)))?;

    let mut map = serde_json::Map::new();
    for row in rows {
        let tool_id: String = row
            .try_get("tool_id")
            .map_err(|e| AppError::internal(anyhow::anyhow!(e)))?;
        let enabled: bool = row
            .try_get("enabled")
            .map_err(|e| AppError::internal(anyhow::anyhow!(e)))?;
        let sort: i32 = row
            .try_get("sort")
            .map_err(|e| AppError::internal(anyhow::anyhow!(e)))?;
        map.insert(tool_id, json!({ "enabled": enabled, "sort": sort }));
    }

    Ok(ok_data(json!({ "flags": Value::Object(map) })))
}
