//! 文件存储 + `files` 表仓储（requirements §8.3 / §8.5.2）。
//!
//! 磁盘布局（`STORAGE_DIR`）：
//! ```text
//! blobs/<storage_key>            最终文件（input/output/asset 都在这里）
//! incoming/<file_id>/<index>.part  分片临时文件
//! ```
//! `storage_key` 一律是服务端生成的 uuid（**不使用用户文件名**），用户原始文件名
//! 只做 sanitize 后存在 `files.name` 里用于展示与下载名。

pub mod chunks;
pub mod cleanup;
pub mod magic;
pub mod sign;

use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use sqlx::Row;
use uuid::Uuid;

use crate::{db::Db, error::AppError};

#[derive(Debug, Clone)]
pub struct FileRecord {
    pub id: Uuid,
    pub user_id: i64,
    pub name: String,
    pub mime: Option<String>,
    pub size: i64,
    pub sha256: Option<String>,
    pub storage_key: String,
    pub kind: String,
    pub status: String,
    pub created_at: DateTime<Utc>,
    pub uploaded_at: Option<DateTime<Utc>>,
    pub expires_at: Option<DateTime<Utc>>,
}

impl FileRecord {
    pub fn is_ready(&self) -> bool {
        self.status == "ready"
    }

    pub fn is_expired_at(&self, now: DateTime<Utc>) -> bool {
        match self.expires_at {
            Some(exp) => exp <= now,
            None => false,
        }
    }

    /// 下载文件名（sanitize + 真实扩展名）
    pub fn download_name(&self) -> String {
        let ext = self
            .mime
            .as_deref()
            .and_then(mime_to_ext)
            .unwrap_or_else(|| "bin".to_string());
        let base = sanitize_file_name(&self.name)
            .rsplit_once('.')
            .map(|(b, _)| b.to_string())
            .unwrap_or_else(|| sanitize_file_name(&self.name));
        let base = if base.is_empty() { "result" } else { &base };
        format!("{base}.{ext}")
    }
}

fn mime_to_ext(mime: &str) -> Option<String> {
    Some(match mime {
        "image/jpeg" => "jpg",
        "image/png" => "png",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/bmp" => "bmp",
        "video/mp4" | "audio/mp4" => "mp4",
        "video/quicktime" => "mov",
        "video/webm" => "webm",
        "video/x-matroska" => "mkv",
        "audio/mpeg" => "mp3",
        "audio/wav" => "wav",
        "audio/flac" => "flac",
        "application/pdf" => "pdf",
        _ => return None,
    }
    .to_string())
}

/// 文件名 sanitize：只保留「中日英数字 + . _ -」，长度 ≤120，去掉路径分隔与控制字符
pub fn sanitize_file_name(raw: &str) -> String {
    let trimmed = raw.trim();
    // 只取最后一段，防目录穿越；末段为空（如 "rm -rf /"）时退回整串，
    // 分隔符本身仍会被下面的白名单过滤掉，不会漏出 "/" 或 "\"
    let last = trimmed
        .rsplit(['/', '\\'])
        .next()
        .filter(|seg| !seg.is_empty())
        .unwrap_or(trimmed);
    let mut out = String::new();
    for ch in last.chars() {
        if ch.is_alphanumeric() || ch == '.' || ch == '_' || ch == '-' {
            out.push(ch);
        } else if ch.is_whitespace() {
            if !out.ends_with('_') {
                out.push('_');
            }
        }
        if out.chars().count() >= 120 {
            break;
        }
    }
    let out = out.trim_matches('.').to_string(); // 防 ".." 与 ".hidden"
    if out.is_empty() { "unnamed".to_string() } else { out }
}

#[derive(Debug, Clone)]
pub struct Storage {
    pub root: PathBuf,
    pub chunk_size: u64,
}

impl Storage {
    pub fn new(root: PathBuf, chunk_size: u64) -> Result<Self> {
        let me = Self { root, chunk_size };
        std::fs::create_dir_all(me.blobs_dir())
            .with_context(|| format!("create blobs dir {}", me.blobs_dir().display()))?;
        std::fs::create_dir_all(me.incoming_dir_placeholder())
            .with_context(|| "create incoming dir")?;
        Ok(me)
    }

    pub fn blobs_dir(&self) -> PathBuf {
        self.root.join("blobs")
    }
    fn incoming_dir_placeholder(&self) -> PathBuf {
        self.root.join("incoming")
    }
    pub fn incoming_dir(&self, file_id: Uuid) -> PathBuf {
        self.root.join("incoming").join(file_id.simple().to_string())
    }
    pub fn chunk_path(&self, file_id: Uuid, index: usize) -> PathBuf {
        self.incoming_dir(file_id).join(format!("{index:06}.part"))
    }
    pub fn blob_path(&self, storage_key: &str) -> PathBuf {
        self.blobs_dir().join(storage_key)
    }
    /// 新建输出文件：返回 (storage_key, path)
    pub fn alloc_output(&self, ext: &str) -> Result<(String, PathBuf)> {
        let key = format!("{}{}", Uuid::new_v4().simple(), if ext.is_empty() { String::new() } else { format!(".{ext}") });
        let path = self.blob_path(&key);
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).ok();
        }
        Ok((key, path))
    }

    pub fn ensure_incoming_dir(&self, file_id: Uuid) -> Result<PathBuf> {
        let dir = self.incoming_dir(file_id);
        std::fs::create_dir_all(&dir).with_context(|| format!("create {}", dir.display()))?;
        Ok(dir)
    }

    pub async fn write_chunk(&self, file_id: Uuid, index: usize, bytes: &[u8]) -> Result<u64> {
        self.ensure_incoming_dir(file_id)?;
        let path = self.chunk_path(file_id, index);
        let bytes_len = bytes.len() as u64;
        tokio::fs::write(&path, bytes)
            .await
            .with_context(|| format!("write chunk {index}"))?;
        Ok(bytes_len)
    }

    /// 合并分片（顺序 = index 升序）到 blob；成功后删除分片目录
    pub async fn merge_chunks(
        &self,
        file_id: Uuid,
        total: usize,
        uploaded: &[usize],
        storage_key: &str,
    ) -> Result<u64> {
        let plan = chunks::plan_merge(total, uploaded)
            .with_context(|| "chunk plan invalid")?;
        let dst = self.blob_path(storage_key);
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        let mut file = tokio::fs::File::create(&dst)
            .await
            .with_context(|| format!("create blob {}", dst.display()))?;
        let mut written = 0u64;
        for idx in plan {
            use tokio::io::AsyncWriteExt;
            let src = self.chunk_path(file_id, idx);
            let bytes = tokio::fs::read(&src)
                .await
                .with_context(|| format!("read chunk {idx}"))?;
            file.write_all(&bytes)
                .await
                .with_context(|| format!("append chunk {idx}"))?;
            written += bytes.len() as u64;
        }
        drop(file);
        let dir = self.incoming_dir(file_id);
        let _ = tokio::fs::remove_dir_all(&dir).await;
        Ok(written)
    }

    /// 读取文件头部（magic number 判定用）
    pub async fn read_head(&self, storage_key: &str, n: usize) -> Result<Vec<u8>> {
        use tokio::io::AsyncReadExt;
        let path = self.blob_path(storage_key);
        let mut file = tokio::fs::File::open(&path)
            .await
            .with_context(|| format!("open blob {}", path.display()))?;
        let mut buf = vec![0u8; n];
        let got = file
            .read(&mut buf)
            .await
            .context("read blob head")?;
        buf.truncate(got);
        Ok(buf)
    }

    pub async fn sha256_hex(&self, storage_key: &str) -> Result<String> {
        chunks::sha256_file_hex(&self.blob_path(storage_key)).await
    }

    pub async fn remove_blob(&self, storage_key: &str) -> Result<bool> {
        let path = self.blob_path(storage_key);
        match tokio::fs::remove_file(&path).await {
            Ok(()) => Ok(true),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(anyhow::Error::new(e).context("remove blob")),
        }
    }

    pub fn exists(&self, storage_key: &str) -> bool {
        self.blob_path(storage_key).exists()
    }
}

// ---------------------------------------------------------------------------
// files 表
// ---------------------------------------------------------------------------

fn row_to_file(row: &sqlx::postgres::PgRow) -> Result<FileRecord> {
    Ok(FileRecord {
        id: row.try_get("id")?,
        user_id: row.try_get("user_id")?,
        name: row.try_get("name")?,
        mime: row.try_get("mime")?,
        size: row.try_get("size")?,
        sha256: row.try_get("sha256")?,
        storage_key: row.try_get("storage_key")?,
        kind: row.try_get("kind")?,
        status: row.try_get("status")?,
        created_at: row.try_get("created_at")?,
        uploaded_at: row.try_get("uploaded_at")?,
        expires_at: row.try_get("expires_at")?,
    })
}

const FILE_COLS: &str = "id, user_id, name, mime, size, sha256, storage_key, kind, status, created_at, uploaded_at, expires_at";

/// `POST /files/init`：建记录（status=uploading），storage_key 由服务端 uuid 决定
pub async fn create_uploading(
    db: &Db,
    user_id: i64,
    name: &str,
    mime_hint: Option<&str>,
    size: i64,
    sha256: Option<&str>,
    kind: &str,
    ttl_hours: i64,
) -> Result<Uuid, AppError> {
    let id = Uuid::new_v4();
    let storage_key = format!("{}", Uuid::new_v4().simple());
    let expires_at = Utc::now() + chrono::Duration::hours(ttl_hours);
    sqlx::query(
        "INSERT INTO files (id, user_id, name, mime, size, sha256, storage_key, kind, status, created_at, updated_at, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'uploading', now(), now(), $9)",
    )
    .bind(id)
    .bind(user_id)
    .bind(sanitize_file_name(name))
    .bind(mime_hint)
    .bind(size)
    .bind(sha256)
    .bind(&storage_key)
    .bind(kind)
    .bind(expires_at)
    .execute(db.pool())
    .await
    .map_err(|e| AppError::internal(anyhow::anyhow!(e)))?;
    Ok(id)
}

pub async fn get(db: &Db, id: Uuid) -> Result<Option<FileRecord>, AppError> {
    let sql = format!("SELECT {FILE_COLS} FROM files WHERE id = $1");
    let row = sqlx::query(&sql)
        .bind(id)
        .fetch_optional(db.pool())
        .await
        .map_err(|e| AppError::internal(anyhow::anyhow!(e)))?;
    match row {
        Some(r) => row_to_file(&r).map(Some).map_err(AppError::internal),
        None => Ok(None),
    }
}

/// complete 之后的实际大小/sha/mime 回写
pub async fn mark_ready(
    db: &Db,
    id: Uuid,
    size: i64,
    sha256: &str,
    mime: &str,
    ttl_hours: i64,
) -> Result<(), AppError> {
    let expires_at = Utc::now() + chrono::Duration::hours(ttl_hours);
    sqlx::query(
        "UPDATE files SET status='ready', size=$2, sha256=$3, mime=$4, uploaded_at=now(), expires_at=$5, updated_at=now()
          WHERE id=$1",
    )
    .bind(id)
    .bind(size)
    .bind(sha256)
    .bind(mime)
    .bind(expires_at)
    .execute(db.pool())
    .await
    .map_err(|e| AppError::internal(anyhow::anyhow!(e)))?;
    Ok(())
}

/// 输出文件登记（任务产物）
pub async fn insert_output(
    db: &Db,
    user_id: i64,
    name: &str,
    storage_key: &str,
    mime: &str,
    size: i64,
    sha256: &str,
    ttl_hours: i64,
) -> Result<Uuid, AppError> {
    let id = Uuid::new_v4();
    let expires_at = Utc::now() + chrono::Duration::hours(ttl_hours);
    sqlx::query(
        "INSERT INTO files (id, user_id, name, mime, size, sha256, storage_key, kind, status, created_at, updated_at, uploaded_at, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'output','ready', now(), now(), now(), $8)",
    )
    .bind(id)
    .bind(user_id)
    .bind(sanitize_file_name(name))
    .bind(mime)
    .bind(size)
    .bind(sha256)
    .bind(storage_key)
    .bind(expires_at)
    .execute(db.pool())
    .await
    .map_err(|e| AppError::internal(anyhow::anyhow!(e)))?;
    Ok(id)
}

/// TTL 扫描：ready/uploading 且已过期
pub async fn list_expired(db: &Db, limit: i64) -> Result<Vec<FileRecord>, AppError> {
    let sql = format!(
        "SELECT {FILE_COLS} FROM files
          WHERE status IN ('ready','uploading') AND expires_at IS NOT NULL AND expires_at <= now()
          ORDER BY expires_at LIMIT $1"
    );
    let rows = sqlx::query(&sql)
        .bind(limit)
        .fetch_all(db.pool())
        .await
        .map_err(|e| AppError::internal(anyhow::anyhow!(e)))?;
    rows.iter().map(row_to_file).collect::<Result<Vec<_>, _>>()
        .map_err(AppError::internal)
}

pub async fn mark_status(db: &Db, id: Uuid, status: &str) -> Result<(), AppError> {
    sqlx::query("UPDATE files SET status=$2, updated_at=now() WHERE id=$1")
        .bind(id)
        .bind(status)
        .execute(db.pool())
        .await
        .map_err(|e| AppError::internal(anyhow::anyhow!(e)))?;
    Ok(())
}

/// 已上传分片索引（断点续传答复用）
pub fn uploaded_chunk_indexes(dir: &Path) -> Vec<usize> {
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if let Some(stem) = name.strip_suffix(".part") {
                if let Ok(idx) = stem.parse::<usize>() {
                    out.push(idx);
                }
            }
        }
    }
    out.sort_unstable();
    out
}

pub type StorageRef = Arc<Storage>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_blocks_traversal_and_weird_chars() {
        assert_eq!(sanitize_file_name("../../etc/passwd"), "passwd");
        assert_eq!(sanitize_file_name(".."), "unnamed");
        assert_eq!(
            sanitize_file_name("a b/../c.jpg"),
            "c.jpg",
            "路径分隔后只取最后一段"
        );
        assert_eq!(sanitize_file_name("截图 2026-10-13 15.30.png"), "截图_2026-10-13_15.30.png");
        assert_eq!(sanitize_file_name("rm -rf /"), "rm_-rf_");
        assert_eq!(sanitize_file_name(""), "unnamed");
        let long = "a".repeat(500);
        assert!(sanitize_file_name(&long).chars().count() <= 120);
        // 绝对不允许出现分隔符
        for v in ["a/b", "..\\x", "$(cmd)", "`id`"] {
            let s = sanitize_file_name(v);
            assert!(!s.contains('/') && !s.contains('\\') && !s.contains('$'), "{s}");
        }
    }

    #[test]
    fn download_name_uses_real_mime_ext() {
        let f = FileRecord {
            id: Uuid::nil(),
            user_id: 1,
            name: "视频.MOV".into(),
            mime: Some("video/mp4".into()),
            size: 1,
            sha256: None,
            storage_key: "k".into(),
            kind: "output".into(),
            status: "ready".into(),
            created_at: Utc::now(),
            uploaded_at: None,
            expires_at: None,
        };
        assert_eq!(f.download_name(), "视频.mp4");
    }

    #[test]
    fn expiry_check() {
        let mut f = FileRecord {
            id: Uuid::nil(),
            user_id: 1,
            name: "a.jpg".into(),
            mime: Some("image/jpeg".into()),
            size: 1,
            sha256: None,
            storage_key: "k".into(),
            kind: "input".into(),
            status: "ready".into(),
            created_at: Utc::now(),
            uploaded_at: None,
            expires_at: None,
        };
        assert!(!f.is_expired_at(Utc::now()));
        f.expires_at = Some(Utc::now() - chrono::Duration::seconds(1));
        assert!(f.is_expired_at(Utc::now()));
        f.expires_at = Some(Utc::now() + chrono::Duration::hours(24));
        assert!(!f.is_expired_at(Utc::now()));
    }

    #[tokio::test]
    async fn storage_dir_layout_roundtrip() {
        let dir = std::env::temp_dir().join(format!("tb-storage-test-{}", Uuid::new_v4()));
        let storage = Storage::new(dir.clone(), 1024).unwrap();
        let file_id = Uuid::new_v4();
        storage.write_chunk(file_id, 0, b"hello ").await.unwrap();
        storage.write_chunk(file_id, 1, b"world").await.unwrap();
        let uploaded = uploaded_chunk_indexes(&storage.incoming_dir(file_id));
        assert_eq!(uploaded, vec![0, 1]);
        let (key, _path) = storage.alloc_output("bin").unwrap();
        let total = storage.merge_chunks(file_id, 2, &uploaded, &key).await.unwrap();
        assert_eq!(total, 11);
        let head = storage.read_head(&key, 5).await.unwrap();
        assert_eq!(head, b"hello");
        assert_eq!(
            storage.sha256_hex(&key).await.unwrap(),
            chunks::sha256_hex(b"hello world")
        );
        assert!(storage.remove_blob(&key).await.unwrap());
        assert!(!storage.exists(&key));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
