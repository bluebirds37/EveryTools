#!/usr/bin/env bash
# 生成前端测速工具（FR-LIF-07 / docs/CONTRACT.md C8）所需的静态文件：
#   data/static/speedtest-1m.bin  → 恰好 1 MiB  (1048576 字节)
#   data/static/speedtest-5m.bin  → 恰好 5 MiB  (5242880 字节)
#
# 特性：
# - **不依赖 ffmpeg**：只用 POSIX shell + awk + dd + wc（本机与 debian:trixie-slim 都能跑），
#   所以 Dockerfile 的 runtime 阶段可以直接调用它把文件烤进镜像。
# - **可复现**：内容来自固定种子的 Lehmer 同余伪随机流（16807 / 2^31-1），
#   同一份脚本在任何机器上产出完全相同的字节序列（便于比对 sha256）。
# - **幂等**：已存在且大小正确的文件默认跳过；`FORCE=1` 强制重新生成。
#
# 用法：
#   scripts/gen_speedtest_files.sh                    # 生成到 server/data/static
#   STATIC_DIR=/data/static scripts/gen_speedtest_files.sh   # 容器内/自定义输出目录
set -euo pipefail

# --- 路径：脚本在 server/scripts/ 下，输出默认 server/data/static -------------------
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
STATIC_DIR="${STATIC_DIR:-${SERVER_DIR}/data/static}"
FORCE="${FORCE:-0}"

# 每块 64 KiB：1 MiB = 16 块，5 MiB = 80 块（块间用不同种子，整文件都有字节分布变化）
BLOCK_BYTES=65536

FILES="speedtest-1m.bin:1048576:1000003 speedtest-5m.bin:5242880:2000011"

log() { printf '%s\n' "$*"; }
die() { printf 'gen_speedtest_files: %s\n' "$*" >&2; exit 1; }

# 生成 1 个 BLOCK_BYTES 字节的确定性伪随机块（LCG：s = 16807*s mod 2147483647）
# 取高位字节 int(s/8192)%256，避开 LCG 低位周期短的问题；LC_ALL=C 保证 %c 输出单字节。
gen_block() {
  LC_ALL=C awk -v seed="$1" 'BEGIN {
    s = seed % 2147483647
    if (s <= 0) s += 2147483646
    for (i = 0; i < 65536; i++) {
      s = (16807 * s) % 2147483647
      printf "%c", int(s / 8192) % 256
    }
  }'
}

file_size() { wc -c < "$1" | tr -d '[:space:]'; }

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/speedtest-files.XXXXXX")"
cleanup() { rm -rf "${TMP_DIR}"; }
trap cleanup EXIT

mkdir -p "${STATIC_DIR}"

log "输出目录: ${STATIC_DIR}"

for entry in ${FILES}; do
  name="${entry%%:*}"
  rest="${entry#*:}"
  want_bytes="${rest%%:*}"
  seed_base="${rest##*:}"
  target="${STATIC_DIR}/${name}"

  if [ "${FORCE}" != "1" ] && [ -f "${target}" ] && [ "$(file_size "${target}")" = "${want_bytes}" ]; then
    log "跳过（已存在且大小正确）: ${target}  ${want_bytes} bytes"
    continue
  fi

  blocks=$((want_bytes / BLOCK_BYTES))
  [ $((blocks * BLOCK_BYTES)) -eq "${want_bytes}" ] \
    || die "want_bytes=${want_bytes} 不是 ${BLOCK_BYTES} 的整数倍"

  tmp="${TMP_DIR}/${name}"
  : >"${tmp}"
  i=0
  while [ "${i}" -lt "${blocks}" ]; do
    gen_block "$((seed_base + i))" >>"${tmp}"
    i=$((i + 1))
  done

  got="$(file_size "${tmp}")"
  [ "${got}" = "${want_bytes}" ] || die "${name} 生成后大小 ${got} != ${want_bytes}"

  # 原子替换，避免半成品被 lib.rs 的 ServeDir 读到
  mv -f "${tmp}" "${target}"
  chmod 644 "${target}"
  log "已生成: ${target}  ${want_bytes} bytes"
done

log "完成。后端启动后由 GET /static/speedtest-1m.bin、GET /static/speedtest-5m.bin 提供（CONTRACT.md C8）。"
log "校验示例: ls -l ${STATIC_DIR} && (cd ${STATIC_DIR} && shasum -a 256 speedtest-1m.bin speedtest-5m.bin)"
