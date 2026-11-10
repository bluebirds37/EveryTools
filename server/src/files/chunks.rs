//! 分片合并顺序与校验（tools-spec FR-V-00.2）。
//! 纯函数 + 无状态，便于单测；实际读写在 `Storage::merge_chunks`。

use anyhow::{Result, bail};
use sha2::{Digest, Sha256};

/// 计算合并顺序：必须 0..total 全覆盖，缺片报 `UploadIncomplete`，重复/越界安全忽略。
pub fn plan_merge(total: usize, uploaded: &[usize]) -> Result<Vec<usize>> {
    if total == 0 {
        bail!("total chunks must be > 0");
    }
    let mut present = vec![false; total];
    for &idx in uploaded {
        if idx < total {
            present[idx] = true;
        }
    }
    let missing: Vec<usize> = (0..total).filter(|i| !present[*i]).collect();
    if !missing.is_empty() {
        let shown: Vec<String> = missing
            .iter()
            .take(10)
            .map(|i| i.to_string())
            .collect();
        bail!(
            "missing chunks: {} of {} [{}]",
            missing.len(),
            total,
            shown.join(",")
        );
    }
    Ok((0..total).collect())
}

/// 分片数：ceil(size / chunk_size)，size=0 → 1（空文件也走一次 complete 校验）
pub fn chunk_count(size: u64, chunk_size: u64) -> usize {
    if size == 0 {
        return 1;
    }
    ((size + chunk_size - 1) / chunk_size) as usize
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex(&hasher.finalize())
}

/// 流式计算文件 sha256（大文件不整块进内存）
pub async fn sha256_file_hex(path: &std::path::Path) -> Result<String> {
    use tokio::io::{AsyncReadExt, BufReader};
    let file = tokio::fs::File::open(path).await?;
    let mut reader = BufReader::with_capacity(1024 * 1024, file);
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        let n = reader.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex(&hasher.finalize()))
}

pub fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        let _ = write!(out, "{b:02x}");
    }
    out
}

/// sha256 校验：`expected` 为空表示客户端未提供（只做记录不校验）
pub fn verify_sha(expected: Option<&str>, actual_hex: &str) -> bool {
    match expected {
        None => true,
        Some(raw) => {
            let norm = raw.trim().trim_start_matches("sha256-").to_ascii_lowercase();
            norm == actual_hex.to_ascii_lowercase()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_plan_is_index_order_regardless_of_upload_completion_order() {
        // 分片乱序到达（并发 2/3 上传必然发生）
        let uploaded = vec![4, 0, 2, 1, 3];
        assert_eq!(plan_merge(5, &uploaded).unwrap(), vec![0, 1, 2, 3, 4]);
    }

    #[test]
    fn merge_plan_reports_missing_chunk() {
        let err = plan_merge(5, &[0, 1, 3, 4]).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("missing chunks"), "{msg}");
        assert!(msg.contains("2"), "缺失索引 2 必须出现在消息里: {msg}");
    }

    #[test]
    fn merge_plan_dedups_and_ignores_out_of_range() {
        assert_eq!(plan_merge(3, &[0, 0, 1, 2, 9]).unwrap(), vec![0, 1, 2]);
    }

    #[test]
    fn merge_plan_rejects_empty_total() {
        assert!(plan_merge(0, &[0]).is_err());
    }

    #[test]
    fn chunk_count_math() {
        assert_eq!(chunk_count(200 * 1024 * 1024, 4 * 1024 * 1024), 50);
        assert_eq!(chunk_count(4 * 1024 * 1024 + 1, 4 * 1024 * 1024), 2);
        assert_eq!(chunk_count(1, 4 * 1024 * 1024), 1);
        assert_eq!(chunk_count(0, 4 * 1024 * 1024), 1);
    }

    #[test]
    fn sha256_known_vectors() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[tokio::test]
    async fn sha256_file_matches_incremental_of_merged_chunks() {
        let dir = std::env::temp_dir().join(format!("tb-sha-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("merged.bin");
        // 模拟分片按 plan_merge 顺序落盘
        let parts: [&[u8]; 3] = [b"chunk-0-", b"chunk-1-", b"chunk-2"];
        let mut acc: Vec<u8> = Vec::new();
        for p in parts.iter() {
            acc.extend_from_slice(p);
        }
        tokio::fs::write(&path, &acc).await.unwrap();
        assert_eq!(
            sha256_file_hex(&path).await.unwrap(),
            sha256_hex(&acc),
            "流式与整块结果必须一致"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn verify_sha_accepts_prefix_and_case_variants() {
        let hex = sha256_hex(b"abc");
        assert!(verify_sha(Some(&hex), &hex));
        assert!(verify_sha(Some(&hex.to_uppercase()), &hex));
        assert!(verify_sha(Some(&format!("sha256-{hex}")), &hex));
        assert!(!verify_sha(Some("deadbeef"), &hex));
        assert!(verify_sha(None, &hex));
    }
}
