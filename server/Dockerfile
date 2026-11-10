# 关于 `# syntax=` 指令：刻意**不写**。写了会让 BuildKit 先去 Docker Hub 拉 dockerfile 前端
# 镜像，而本机 auth.docker.io 的 IPv6 解析是坏地址 → 构建第一步就 DeadlineExceeded。
# 同理不用 `COPY --chmod`（BuildKit 专属扩展），改为下面显式 `RUN chmod`，这样
# `DOCKER_BUILDKIT=0` 的经典构建器也能构建（本机就走这条路；CI 上两种构建器都可用）。
# 通用工具箱后端镜像（toolbox-server）
# 交付要求见 docs/requirements.md：M3「Docker 镜像（含 ffmpeg）」、R5「镜像内置 ffmpeg/ffprobe + CJK 字体」。
#
# ⚠️ 密钥（DATABASE_URL / JWT_SECRET / WECHAT_APPSECRET / FX_API_KEY）绝不写进本文件、
#    绝不写进镜像层、绝不写进日志：只在 `docker run -e` / compose `env_file` 里注入。

# ===========================================================================
# stage 1: 编译（Cargo.toml 是 edition = "2024" → 需要 Rust ≥ 1.85）
# ===========================================================================
FROM rust:1-trixie AS builder
# 如需固定版本可改为 `rust:1.85.1-trixie`（任何 ≥ 1.85 的 trixie/bookworm 标签都行）。

WORKDIR /app
ENV CARGO_NET_RETRY=10

# 依赖层：清单先进来，源码改动时不必重新下载 crates（本仓库无 lib/bin 分离技巧，
# 直接一次 COPY 全部源码，简单可靠；Cargo.lock 已提交，用 --locked 保证可复现）。
COPY Cargo.toml Cargo.lock ./

# src/db.rs 用的是 `sqlx::migrate!("./migrations")`：迁移 SQL 在**编译期**嵌入二进制，
# 所以 migrations/ 必须出现在构建上下文里（.dockerignore 不能排除它），
# 而运行镜像**不需要**带 migrations 目录。
COPY migrations ./migrations

COPY src ./src

# 本仓库刻意不使用 `sqlx::query!` 编译期宏（见 src/db.rs 顶部注释），
# 因此构建期不需要连接数据库，也不需要 DATABASE_URL。
RUN cargo build --release --locked --bin toolbox-server

# ===========================================================================
# stage 2: 运行（debian:trixie-slim —— 与本地已有的 pg18-trixie 镜像同一发行版）
# ===========================================================================
FROM debian:trixie-slim AS runtime

ENV DEBIAN_FRONTEND=noninteractive

# ffmpeg / ffprobe：媒体任务通过 tokio::process 调用 CLI（requirements §8.1）
# ca-certificates：reqwest 用 rustls 但仍需要系统信任库校验微信/汇率上游
# curl：HEALTHCHECK 用（选 curl，因为 trixie-slim 既不预装 curl 也不预装 wget，
#       显式装 curl 比依赖 wget 的 busybox 行为更可控）
# fonts-noto-cjk：FR-VID-08 水印/字幕，drawtext=fontfile 的默认路径
#                 /usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc 由该包提供
RUN apt-get update \
    && apt-get install --no-install-recommends -y \
        ca-certificates \
        curl \
        ffmpeg \
        fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

# 非 root 运行（uid/gid 固定 10001，便于挂载卷时 chown）
RUN groupadd --system --gid 10001 toolbox \
    && useradd --system --uid 10001 --gid 10001 \
        --home-dir /home/toolbox --create-home --shell /usr/sbin/nologin toolbox

WORKDIR /app

COPY --from=builder /app/target/release/toolbox-server /usr/local/bin/toolbox-server

# 测速静态文件（C8 `GET /static/speedtest-{1,5}m.bin`）在构建期生成并烤进镜像：
# 脚本只依赖 POSIX shell + awk + dd，不依赖 ffmpeg，产物字节级可复现。
# 不用 `COPY --chmod`：那是 BuildKit 扩展，本机走 DOCKER_BUILDKIT=0，改下一行显式 chmod。
COPY scripts/gen_speedtest_files.sh /usr/local/bin/gen_speedtest_files.sh
RUN chmod 755 /usr/local/bin/gen_speedtest_files.sh \
    && mkdir -p /data/uploads /data/static \
    && STATIC_DIR=/data/static /usr/local/bin/gen_speedtest_files.sh \
    && chown -R toolbox:toolbox /data /app

# 监听与路径（可被 compose / -e 覆盖）
ENV PORT=8080 \
    HOST=0.0.0.0 \
    LOG_LEVEL=info \
    STORAGE_DIR=/data/uploads \
    STATIC_DIR=/data/static \
    FFMPEG_BIN=ffmpeg \
    FFPROBE_BIN=ffprobe \
    WATERMARK_FONT_FILE=/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc \
    MEDIA_DRY_RUN=0 \
    WECHAT_STUB=0 \
    PROXY_ALLOW_PRIVATE_NETWORK=false

# MEDIA_DRY_RUN=0 / WECHAT_STUB=0 / PROXY_ALLOW_PRIVATE_NETWORK=false 是生产铁律：
# 镜像里给安全默认值，任何人想用 1/true 必须在部署时显式覆盖（本地开发才允许）。

EXPOSE 8080

# 上传存储目录（含分片与产物）必须挂卷，否则容器重建即丢文件
VOLUME ["/data/uploads"]

USER toolbox

# 存活探针只查 GET /healthz（不依赖 DB；就绪检查是 /readyz，供编排器单独配）
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${PORT:-8080}/healthz" || exit 1

ENTRYPOINT ["/usr/local/bin/toolbox-server"]
