#!/usr/bin/env bash
# 后端快速更新（不重建镜像）：容器内增量编译 → 产物落 ./dist → 重启挂载型容器。
# 设计与取舍见 docker-compose.update.yml 顶部注释。
#
# 用法：
#   server/scripts/update.sh                 # 编译 + 重启 + 健康检查（默认）
#   server/scripts/update.sh --smoke         # 额外跑 C8 契约冒烟（live_smoke.sh）
#   server/scripts/update.sh --image         # 连基础镜像一起重建（改了 apt 包/字体时才需要）
#   server/scripts/update.sh --restart       # 只重启，不编译（改了 .env 后用）
#   server/scripts/update.sh --down          # 停掉开发栈
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

IMAGE="toolbox-server:latest"
FILE="docker-compose.update.yml"
API_PORT="${DEV_API_HOST_PORT:-8081}"
BASE="http://127.0.0.1:${API_PORT}"
COMPOSE=(docker compose -f "$FILE")

DO_BUILD=1
DO_RECREATE=1
DO_SMOKE=0
DO_IMAGE=0
DOWN_ONLY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --smoke) DO_SMOKE=1 ;;
    --image) DO_IMAGE=1 ;;
    --restart) DO_BUILD=0 ;;
    --down) DOWN_ONLY=1 ;;
    -h | --help)
      sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "未知参数：$1（-h 看用法）" >&2
      exit 2
      ;;
  esac
  shift
done

say() { printf '\033[1m▸ %s\033[0m %s\n' "$1" "$2"; }
die() {
  printf '\033[31m✗ %s\033[0m\n' "$1" >&2
  exit 1
}
# macOS 没有 md5sum（除非装 coreutils），Linux/CI 反之；两者的输出字段位置不同
file_md5() {
  if command -v md5sum >/dev/null 2>&1; then
    md5sum "$1" | awk '{print $1}'
  else
    md5 -q "$1"
  fi
}

if [ "$DOWN_ONLY" = 1 ]; then
  say "down" "停止开发栈（数据卷与 target 缓存保留）"
  "${COMPOSE[@]}" down
  exit 0
fi

[ -d dist ] || mkdir -p dist

# ---------- 0. .env 前置检查（密钥只从 .env / 环境变量注入，本脚本不写真实凭据） ----------
if [ ! -f .env ]; then
  : >.env
  chmod 600 .env
  say "env" "已创建空 .env（600 权限）"
fi

grep -qs '^DEV_DATABASE_URL=..*' .env || [ -n "${DEV_DATABASE_URL:-}" ] || die \
  ".env 里缺 DEV_DATABASE_URL。例：DEV_DATABASE_URL=postgresql://user:pass@host.docker.internal:15433/toolbox_dev
（容器内要用 host.docker.internal 才能连宿主机上的 PG，写 127.0.0.1 会连到容器自己）"

if ! grep -qs '^JWT_SECRET=..*' .env && [ -z "${JWT_SECRET:-}" ]; then
  secret="$(openssl rand -hex 32)"
  {
    echo "# 开发栈自动生成（$(date -u +%Y-%m-%dT%H:%M:%SZ)），仅本机使用；生产请另配。"
    echo "JWT_SECRET=${secret}"
  } >>.env
  chmod 600 .env
  say "env" "已往 .env 追加随机 JWT_SECRET（开发用；该文件不得提交）"
fi

# ---------- 1. 基础镜像（只当运行环境，很少重建） ----------
# 本机 BuildKit 取镜像元数据要连 auth.docker.io，而它的 AAAA 记录被解析到坏地址 → 直接
# DeadlineExceeded；`docker pull` 走的是 Docker Desktop 的 hub 代理所以没事。因此默认用
# 经典构建器（Dockerfile 已避免 `COPY --chmod` 这类 BuildKit 专属语法）。
# 网络正常的机器上想切回 BuildKit：TB_DOCKER_BUILDKIT=1 server/scripts/update.sh
image_build() {
  env DOCKER_BUILDKIT="${TB_DOCKER_BUILDKIT:-0}" docker build -t "$IMAGE" .
}
if [ "$DO_IMAGE" = 1 ]; then
  say "image" "重建基础镜像（apt ffmpeg/字体/测速文件层）…"
  image_build || die "基础镜像构建失败"
elif ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  say "image" "$IMAGE 不存在，先构建一次（之后更新不再需要）…"
  image_build || die "基础镜像构建失败"
fi

# ---------- 2. 容器内增量编译 → ./dist/toolbox-server ----------
BUILD_MD5=""
if [ "$DO_BUILD" = 1 ]; then
  started=$(date +%s)
  "${COMPOSE[@]}" run --rm --no-deps build || die "编译失败（详见上方 cargo 输出）"
  say "build" "耗时 $(( $(date +%s) - started ))s"
  [ -s dist/toolbox-server ] || die "dist/toolbox-server 没产出（检查 dist 目录挂载权限）"
  BUILD_MD5="$(file_md5 dist/toolbox-server)"
  say "build" "产物 md5=${BUILD_MD5} size=$(du -h dist/toolbox-server | cut -f1)"
elif [ ! -s dist/toolbox-server ]; then
  die "dist/toolbox-server 还不存在：先不带 --restart 跑一次 update.sh 完成首次编译"
fi

# ---------- 3. 重启运行容器（目录挂载 → restart 即拿到新二进制） ----------
if [ "$DO_RECREATE" = 1 ]; then
  "${COMPOSE[@]}" up -d --force-recreate api || die "容器启动失败"
fi

# ---------- 4. 就绪门控：/readyz 打一次真实 SELECT 1 ----------
printf '▸ health  '
ready=0
for _ in $(seq 1 40); do
  if [ "$(curl -fsS -o /dev/null -w '%{http_code}' "$BASE/readyz" 2>/dev/null)" = "200" ]; then
    ready=1
    break
  fi
  printf '.'
  sleep 1
done
echo ""
[ "$ready" = 1 ] || {
  echo "  最后 30 行日志："
  "${COMPOSE[@]}" logs --tail 30 api
  die "$BASE 未就绪（多半是 DEV_DATABASE_URL 连不上，或 JWT_SECRET 长度不足）"
}
say "health" "$BASE/readyz = 200"

# 证明跑的确实是刚编译的那份（而不是镜像里/上一次的旧 inode）
if [ -n "$BUILD_MD5" ]; then
  RUN_MD5="$(docker exec toolbox-dev-api md5sum /app/bin/toolbox-server 2>/dev/null | awk '{print $1}')"
  if [ "$RUN_MD5" = "$BUILD_MD5" ]; then
    say "verify" "容器内 /app/bin/toolbox-server md5 与本次产物一致 → 更新已生效（镜像未重建）"
  else
    say "verify" "⚠ 容器内 md5=${RUN_MD5:-取不到} ≠ 产物 ${BUILD_MD5}，请检查 dist 挂载"
  fi
fi

IMG_ID="$(docker image inspect --format '{{.Id}}' "$IMAGE" | cut -c8-19)"
say "image" "$IMAGE id=${IMG_ID}（未变即说明本次更新没有重建镜像）"
say "done" "API ${BASE} · 日志：docker compose -f $FILE logs -f api"

# ---------- 5. 可选：C8 契约冒烟 ----------
if [ "$DO_SMOKE" = 1 ]; then
  say "smoke" "BASE=$BASE scripts/live_smoke.sh"
  BASE="$BASE" bash scripts/live_smoke.sh
fi
