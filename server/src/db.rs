//! DB 连接与迁移。sqlx（无 ORM 魔法，requirements §8.1）。
//!
//! 说明：本仓库不使用 `query!` 编译期宏（避免 `cargo build` 依赖在线 DB），
//! 统一用 `sqlx::query` + 手写行映射；SQL 全部集中在各模块顶部便于审计。

use std::time::Duration;

use anyhow::{Context, Result};
use sqlx::{
    PgPool,
    postgres::{PgPoolOptions, PgRow},
    Row,
};

use crate::config::Settings;

#[derive(Clone)]
pub struct Db {
    pub pool: PgPool,
}

impl Db {
    pub async fn connect(cfg: &Settings) -> Result<Self> {
        let pool = PgPoolOptions::new()
            .max_connections(cfg.db_max_connections)
            .acquire_timeout(Duration::from_secs(10))
            .test_before_acquire(true)
            .connect(&cfg.database_url)
            .await
            .context("failed to connect PostgreSQL (check DATABASE_URL)")?;
        Ok(Self { pool })
    }

    /// 应用 `server/migrations/`（编译期嵌入，容器内无需带源码）
    pub async fn migrate(&self) -> Result<()> {
        sqlx::migrate!("./migrations")
            .run(&self.pool)
            .await
            .context("failed to run migrations")?;
        tracing::info!("migrations applied");
        Ok(())
    }

    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    pub async fn ping(&self) -> Result<()> {
        sqlx::query("SELECT 1").execute(&self.pool).await?;
        Ok(())
    }
}

/// 行读取辅助：列缺失/类型不符时返回错误而不是 panic
pub fn col<T>(row: &PgRow, name: &str) -> Result<T>
where
    T: for<'r> sqlx::Decode<'r, sqlx::Postgres> + sqlx::Type<sqlx::Postgres>,
{
    row.try_get::<T, _>(name)
        .with_context(|| format!("column `{name}` decode failed"))
}

pub fn col_opt<T>(row: &PgRow, name: &str) -> Result<Option<T>>
where
    T: for<'r> sqlx::Decode<'r, sqlx::Postgres> + sqlx::Type<sqlx::Postgres>,
{
    row.try_get::<Option<T>, _>(name)
        .with_context(|| format!("column `{name}` decode failed"))
}

#[cfg(test)]
mod tests {
    #[test]
    fn migrations_are_discoverable_at_compile_time() {
        // sqlx::migrate! 已把 server/migrations 编进二进制；这里断言目录非空。
        let mut count = 0;
        for entry in std::fs::read_dir("./migrations").expect("migrations dir missing") {
            let p = entry.expect("entry").path();
            if p.extension().and_then(|e| e.to_str()) == Some("sql") {
                count += 1;
            }
        }
        assert!(count >= 2, "expected >=2 migration files, got {count}");
    }
}
