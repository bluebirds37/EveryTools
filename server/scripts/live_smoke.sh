#!/usr/bin/env bash
# 后端契约级联调冒烟（docs/CONTRACT.md C8 全链路）
#
# 用途：对一个**已经启动**的 toolbox-server 逐接口验证真实行为，覆盖
#   静默登录 → 参数下发 → 分片上传 → 完成校验 → 媒体任务 → 签名下载 → 埋点 → 汇率
#   → 开发代理（含 SSRF 负例）→ 越权负例。
# 本机没有 ffmpeg 也没有微信凭据，因此服务端需以 `WECHAT_STUB=1 MEDIA_DRY_RUN=1` 启动。
#
# 用法：
#   BASE=http://127.0.0.1:8080 server/scripts/live_smoke.sh
set -uo pipefail

BASE="${BASE:-http://127.0.0.1:8080}"
API="$BASE/api/v1"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PASS=0
FAIL=0
SKIP=0
BODY="$TMP/body.json"

pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  \033[31m✗\033[0m %s — %s\n' "$1" "$2"; FAIL=$((FAIL + 1)); }
skip() { printf '  \033[33m•\033[0m %s — %s\n' "$1" "$2"; SKIP=$((SKIP + 1)); }
head_() { printf '\033[1m%s\033[0m\n' "$1"; }

# req METHOD PATH TOKEN [JSON_BODY] [EXTRA_CURL_ARGS...]
# 设 CODE=HTTP 状态码，BODY=响应体
req() {
  local method="$1" path="$2" token="$3" json="${4:-}"
  if [ "$#" -gt 4 ]; then shift 4; else shift "$#"; fi
  local args=(-sS -o "$BODY" -w '%{http_code}' -X "$method" "$path"
    -H 'content-type: application/json' --max-time 25)
  [ -n "$token" ] && args+=(-H "authorization: Bearer $token")
  [ -n "$json" ] && args+=(-d "$json")
  args+=("$@")
  CODE="$(curl "${args[@]}" 2>"$TMP/curl.err")" || CODE="000"
  [ -s "$TMP/curl.err" ] && cp "$TMP/curl.err" "$TMP/last-curl.err"
  RESPONSE="$(cat "$BODY" 2>/dev/null || echo '')"
}

jqv() { printf '%s' "$RESPONSE" | jq -r "$1" 2>/dev/null; }
code_is() { [ "$CODE" = "$1" ]; }

head_ "toolbox-server 级联调冒烟  $BASE"

# ---------------------------------------------------------------- 存活/就绪
head_ "1. 健康检查"
req GET "$BASE/healthz" ""
if code_is 200 && [ "$(jqv '.data.status // .status // "ok"')" != "null" ]; then
  pass "GET /healthz → $CODE"
else
  fail "GET /healthz" "HTTP $CODE: $(printf '%.160s' "$RESPONSE")"
fi
req GET "$BASE/readyz" ""
if code_is 200 && [ "$(jqv '.status // .data.status // empty')" = "ready" ]; then
  pass "GET /readyz → $CODE（db=$(jqv '.db // "?"')）"
else
  fail "GET /readyz" "HTTP $CODE: $(printf '%.200s' "$RESPONSE")"
fi

# ---------------------------------------------------------------- 静默登录
head_ "2. 静默登录（stub 模式，绝不下发 openid）"
req GET "$API/files/00000000-0000-0000-0000-000000000000/download" ""
if code_is 401 || code_is 403 || code_is 404; then
  pass "未带签名/令牌的下载请求被拒（HTTP $CODE）"
else
  fail "未授权下载" "期望 401/403/404，实得 $CODE"
fi

req POST "$API/files/init" "" '{"name":"x.png","size":100,"mime":"image/png"}'
if code_is 401; then
  pass "写接口无令牌 → 401 AUTH_REQUIRED"
else
  fail "写接口无令牌" "期望 401，实得 $CODE: $(printf '%.160s' "$RESPONSE")"
fi

TOKEN=""
req POST "$API/auth/silent" "" '{"code":"live-smoke-code","appId":"wxsmokeappid"}'
TOKEN="$(jqv '.data.accessToken // empty')"
REFRESH="$(jqv '.data.refreshToken // empty')"
USER_A="$(jqv '.data.userId // empty')"
if [ -n "$TOKEN" ] && [ -n "$REFRESH" ] && [ -n "$USER_A" ]; then
  pass "POST /auth/silent → userId + access/refresh 双令牌"
else
  fail "POST /auth/silent" "HTTP $CODE: $(printf '%.200s' "$RESPONSE")"
fi
if printf '%s' "$RESPONSE" | grep -q -i 'openid'; then
  fail "响应泄露 openid" "C8/§8.5 禁止把 openid 下发给前端"
else
  pass "响应不含 openid"
fi

req POST "$API/auth/refresh" "" "{\"refreshToken\":\"$REFRESH\"}"
NEWTOKEN="$(jqv '.data.accessToken // empty')"
if [ -n "$NEWTOKEN" ]; then
  pass "POST /auth/refresh → 新 accessToken"
else
  fail "POST /auth/refresh" "HTTP $CODE: $(printf '%.200s' "$RESPONSE")"
fi

# 第二个用户（越权负例用）
req POST "$API/auth/silent" "" '{"code":"live-smoke-other","appId":"wxsmokeappid"}'
TOKEN_B="$(jqv '.data.accessToken // empty')"
USER_B="$(jqv '.data.userId // empty')"
if [ -n "$TOKEN_B" ] && [ "$USER_B" != "$USER_A" ]; then
  pass "stub 登录按 code 区分用户（B=$USER_B）"
else
  fail "第二用户" "HTTP $CODE: $(printf '%.200s' "$RESPONSE")"
fi

head_ "3. 工具开关（游客可用）"
req GET "$API/tools/flags" ""
if code_is 200 && printf '%s' "$RESPONSE" | jq -e '.data.flags | type=="object"' >/dev/null; then
  pass "GET /tools/flags → $(printf '%s' "$RESPONSE" | jq -r '.data.flags | length') 个工具开关"
else
  fail "GET /tools/flags" "HTTP $CODE: $(printf '%.160s' "$RESPONSE")"
fi

# ---------------------------------------------------------------- 上传链路
head_ "4. 分片上传（真实 PNG 字节 + magic number 校验）"
if ! python3 - "$TMP/t.png" <<'PY' 2>/dev/null; then
import sys
from PIL import Image
im = Image.new('RGB', (640, 480))
px = im.load()
for y in range(480):
    for x in range(640):
        px[x, y] = ((x * 3 + y) % 256, (y * 2) % 256, (x ^ y) % 256)
im.save(sys.argv[1], 'PNG')
PY
  skip "生成测试 PNG" "python3/PIL 不可用，跳过上传链路"
else
  SIZE="$(wc -c <"$TMP/t.png" | tr -d ' ')"
  SHA="$(shasum -a 256 "$TMP/t.png" | cut -d' ' -f1)"
  req POST "$API/files/init" "$TOKEN" \
    "{\"name\":\"smoke.png\",\"size\":$SIZE,\"sha256\":\"$SHA\",\"mime\":\"image/png\"}"
  FID="$(jqv '.data.fileId // empty')"
  CHUNK="$(jqv '.data.chunkSize // 4194304')"
  if [ -n "$FID" ]; then
    pass "POST /files/init → fileId, chunkSize=$CHUNK"
  else
    fail "POST /files/init" "HTTP $CODE: $(printf '%.200s' "$RESPONSE")"
  fi

  UPIDX="$(curl -sS -o "$BODY" -w '%{http_code}' -X POST "$API/files/upload" \
    -H "authorization: Bearer $TOKEN" \
    -F "fileId=$FID" -F "index=0" -F "chunk=@$TMP/t.png;type=application/octet-stream" 2>/dev/null)"
  RESPONSE="$(cat "$BODY")"
  if [ "$UPIDX" = "200" ] && [ "$(jqv '.data.received // 0')" = "$SIZE" ]; then
    pass "POST /files/upload（multipart）→ received=$SIZE 字节"
  else
    fail "POST /files/upload" "HTTP $UPIDX: $(printf '%.200s' "$RESPONSE")"
  fi

  req POST "$API/files/$FID/complete" "$TOKEN" '{}'
  if code_is 200 && [ "$(jqv '.data.ready // false')" = "true" ]; then
    pass "POST /files/:id/complete → ready（sha256 自校验 + magic 判定通过）"
  else
    fail "POST /files/:id/complete" "HTTP $CODE: $(printf '%.200s' "$RESPONSE")"
  fi

  # 伪装可执行文件必须被 magic 拦下
  printf 'MZ\x90\x00fake exe' > "$TMP/fake.exe"
  req POST "$API/files/init" "$TOKEN" \
    "{\"name\":\"fake.png\",\"size\":10,\"sha256\":\"\",\"mime\":\"image/png\"}"
  FAKE_ID="$(jqv '.data.fileId // empty')"
  curl -sS -o /dev/null -X POST "$API/files/upload" -H "authorization: Bearer $TOKEN" \
    -F "fileId=$FAKE_ID" -F "index=0" -F "chunk=@$TMP/fake.exe;type=application/octet-stream" 2>/dev/null
  req POST "$API/files/$FAKE_ID/complete" "$TOKEN" '{}'
  EC="$(printf '%s' "$RESPONSE" | jq -r '.error.code // empty')"
  if ! code_is 200 && [ -n "$EC" ]; then
    pass "可执行伪装在 complete 阶段被拒（$EC, HTTP $CODE）"
  else
    fail "magic number 拦截" "期望拒绝，实得 HTTP $CODE: $(printf '%.160s' "$RESPONSE")"
  fi
fi

# ---------------------------------------------------------------- 媒体任务
head_ "5. 媒体任务（image-compress 全链路）"
if [ -n "${FID:-}" ]; then
  req POST "$API/media/tasks" "$TOKEN" \
    "{\"toolId\":\"image-compress\",\"type\":\"image-compress\",\"params\":{\"quality\":80},\"fileIds\":[\"$FID\"]}"
  TASK="$(jqv '.data.taskId // .data.id // empty')"
  TSTATUS="$(jqv '.data.status // empty')"
  if [ -n "$TASK" ]; then
    pass "POST /media/tasks → taskId=$TASK status=$TSTATUS"
  else
    fail "POST /media/tasks" "HTTP $CODE: $(printf '%.200s' "$RESPONSE")"
  fi

  # 终态：worker 写库 succeeded，对外状态按前端 utils/video-task.js 映射为 success
  FINAL=""
  for _ in $(seq 1 60); do
    req GET "$API/media/tasks/$TASK" "$TOKEN"
    FINAL="$(jqv '.data.status // empty')"
    case "$FINAL" in
      success|succeeded|failed|error|cancelled) break ;;
    esac
    sleep 0.5
  done
  case "$FINAL" in
    success|succeeded) pass "GET /media/tasks/:id → $FINAL（progress=$(jqv '.data.progress'), stage=$(jqv '.data.stage')）";;
    *) fail "任务终态" "status=$FINAL: $(printf '%.240s' "$RESPONSE")";;
  esac

  DL="$(jqv '.data.result.url // empty')"
  KIND="$(jqv '.data.result.kind // empty')"
  if [ -n "$DL" ] && [ -n "$KIND" ]; then
    pass "result.kind=$KIND，url=$DL"
    RAW="$TMP/dl.bin"
    HC="$(curl -sS -o "$RAW" -w '%{http_code}' "$API$DL" 2>/dev/null)"
    if [ "$HC" = "200" ] && [ -s "$RAW" ]; then
      HEX="$(od -An -tx1 -N4 "$RAW" 2>/dev/null | tr -s ' ')"
      if printf '%s' "$HEX" | grep -Eq '89 50 4e 47|ff d8 ff'; then
        pass "签名下载 → $(wc -c <"$RAW" | tr -d ' ') 字节，图片魔数正确（$HEX）"
      else
        fail "签名下载内容" "前 4 字节 = $HEX，不是 PNG/JPEG 魔数"
      fi
    else
      fail "签名下载" "HTTP $HC"
    fi
    # 篡改签名必须 403
    BAD="${DL%?}x"
    HC2="$(curl -sS -o /dev/null -w '%{http_code}' "$API$BAD" 2>/dev/null)"
    if [ "$HC2" = "403" ]; then
      pass "签名被篡改 → 403"
    else
      fail "签名篡改校验" "期望 403，实得 $HC2"
    fi
  else
    skip "签名下载" "result.url 缺失（HTTP $CODE）"
  fi

  req GET "$API/media/tasks" "$TOKEN"
  if code_is 200 && printf '%s' "$RESPONSE" | jq -e '.data.items | type=="array"' >/dev/null; then
    pass "GET /media/tasks → $(printf '%s' "$RESPONSE" | jq -r '.data.items | length') 条历史"
  else
    fail "GET /media/tasks" "HTTP $CODE: $(printf '%.160s' "$RESPONSE")"
  fi

  req POST "$API/media/tasks/$TASK/cancel" "$TOKEN"
  if code_is 200 || printf '%s' "$RESPONSE" | jq -e '.error.code' >/dev/null; then
    pass "POST /media/tasks/:id/cancel → HTTP $CODE $(jqv '.error.code // "ok"')"
  else
    fail "cancel" "HTTP $CODE: $(printf '%.160s' "$RESPONSE")"
  fi

  # 越权：B 用户拿 A 的文件建任务
  req POST "$API/media/tasks" "$TOKEN_B" \
    "{\"toolId\":\"image-compress\",\"type\":\"image-compress\",\"params\":{},\"fileIds\":[\"$FID\"]}"
  if code_is 403; then
    pass "跨用户引用他人文件 → 403"
  else
    fail "跨用户校验" "期望 403，实得 $CODE: $(printf '%.160s' "$RESPONSE")"
  fi

  # 未知类型：明确 4xx 而非静默入队
  req POST "$API/media/tasks" "$TOKEN" \
    "{\"toolId\":\"evil\",\"type\":\"rm-rf\",\"params\":{},\"fileIds\":[\"$FID\"]}"
  if ! code_is 200 && printf '%s' "$RESPONSE" | jq -e '.error.code' >/dev/null; then
    pass "未知任务类型被拒（$(jqv '.error.code'), HTTP $CODE）"
  else
    fail "未知任务类型" "期望 4xx，实得 $CODE"
  fi
else
  skip "媒体任务" "缺少已就绪文件（上传链路未跑通）"
fi

head_ "5b. 视频任务"
# 输入用哪种 mp4 取决于目标服务的环境：
#  - 服务跑在 toolbox-server 镜像里（有 ffmpeg）→ 现场编一段**真实** 1s mp4，
#    这一步就把「上传 → worker → ffmpeg 转码 → 签名下载」整条真链路验穿；
#  - 否则（本机没有 ffmpeg，服务以 MEDIA_DRY_RUN=1 起）→ 只能喂占位字节，
#    真实 ffmpeg 会正确地以 UNSUPPORTED_FORMAT 拒掉它，此时必须走 dry-run。
VSIZE=1572864
VSRC="$TMP/t.mp4"
REAL_VIDEO=0
SMOKE_CONTAINER="${SMOKE_CONTAINER-toolbox-dev-api}"
if [ -n "$SMOKE_CONTAINER" ] && docker inspect "$SMOKE_CONTAINER" >/dev/null 2>&1; then
  if docker exec "$SMOKE_CONTAINER" sh -c \
       'ffmpeg -v error -y -f lavfi -i testsrc=size=640x480:rate=24:duration=1 \
          -f lavfi -i sine=frequency=440:duration=1 \
          -c:v libx264 -pix_fmt yuv420p -preset ultrafast -c:a aac -shortest /tmp/smoke-real.mp4' \
       >/dev/null 2>&1 \
     && docker cp "$SMOKE_CONTAINER:/tmp/smoke-real.mp4" "$TMP/real.mp4" >/dev/null 2>&1 \
     && [ -s "$TMP/real.mp4" ]; then
    VSRC="$TMP/real.mp4"
    REAL_VIDEO=1
  fi
fi
if [ "$REAL_VIDEO" = 1 ]; then
  pass "视频输入：容器内 ffmpeg 生成的真实 mp4（$(wc -c <"$VSRC" | tr -d ' ') 字节）"
else
  { printf '\000\000\000\034ftypisom\000\000\000\000isomiso2avc1mp41'; head -c $((VSIZE - 32)) /dev/zero; } > "$VSRC"
fi
VBYTES="$(wc -c <"$VSRC" | tr -d ' ')"
VRES="720p"
[ "$REAL_VIDEO" = 1 ] && VRES="360p"
if [ -z "$TOKEN" ]; then
  skip "视频任务" "未拿到令牌"
else
  req POST "$API/files/init" "$TOKEN" \
    "{\"name\":\"smoke.mp4\",\"size\":$VBYTES,\"sha256\":\"\",\"mime\":\"video/mp4\"}"
  VFID="$(jqv '.data.fileId // empty')"
  curl -sS -o /dev/null -X POST "$API/files/upload" -H "authorization: Bearer $TOKEN" \
    -F "fileId=$VFID" -F "index=0" -F "chunk=@$VSRC;type=application/octet-stream" 2>/dev/null
  req POST "$API/files/$VFID/complete" "$TOKEN" '{}'
  if code_is 200; then
    pass "视频输入文件就绪（magic=mp4，$VBYTES 字节）"
  else
    fail "视频输入文件" "HTTP $CODE: $(printf '%.200s' "$RESPONSE")"
  fi

  req POST "$API/media/tasks" "$TOKEN" \
    "{\"toolId\":\"video-compress\",\"type\":\"video-compress\",\"params\":{\"resolution\":\"$VRES\",\"fps\":24},\"fileIds\":[\"$VFID\"]}"
  VTASK="$(jqv '.data.taskId // .data.id // empty')"
  for _ in $(seq 1 60); do
    req GET "$API/media/tasks/$VTASK" "$TOKEN"
    VST="$(jqv '.data.status // empty')"
    case "$VST" in
      success|succeeded|failed|error|cancelled) break ;;
    esac
    sleep 0.5
  done
  if [ "$VST" = "success" ] || [ "$VST" = "succeeded" ]; then
    pass "video-compress 任务完成（kind=$(jqv '.data.result.kind'), sizeMB=$(jqv '.data.result.sizeMB'), engine=$(jqv '.data.engineUsed')）"
    VURL="$(jqv '.data.result.url // empty')"
    if [ -n "$VURL" ]; then
      VHC="$(curl -sS -o "$TMP/v.out" -w '%{http_code}' "$API$VURL" 2>/dev/null)"
      if [ "$VHC" = "200" ] && [ -s "$TMP/v.out" ]; then
        pass "视频产物签名下载 → $(wc -c <"$TMP/v.out" | tr -d ' ') 字节"
        if [ "$REAL_VIDEO" = 1 ]; then
          # 真实转码的产物必须是能解析出视频轨的 mp4，而不只是「有字节」
          BOX="$(od -An -c -j4 -N4 "$TMP/v.out" 2>/dev/null | tr -d ' \n')"
          if [ "$BOX" = "ftyp" ]; then
            pass "产物是 mp4 容器（ftyp box），源时长 1s → 走的是真实 ffmpeg 编码"
          else
            fail "产物容器" "前 8 字节不是 ftyp：$BOX"
          fi
        fi
      else
        fail "视频产物下载" "HTTP $VHC"
      fi
    else
      fail "视频产物 url" "result.url 缺失"
    fi
  else
    fail "video-compress 任务" "status=$VST: $(printf '%.240s' "$RESPONSE")"
  fi
fi

# ---------------------------------------------------------------- 其余接口
head_ "6. 埋点 / 汇率 / 开发代理"
req POST "$API/usage/batch" "$TOKEN" \
  '{"events":[{"event":"image_compress_success","props":{"toolId":"image-compress","durationMs":120}}]}'
if code_is 200 && [ "$(jqv '.data.ok // false')" = "true" ]; then
  pass "POST /usage/batch → accepted=$(jqv '.data.accepted')"
else
  fail "POST /usage/batch" "HTTP $CODE: $(printf '%.200s' "$RESPONSE")"
fi

req GET "$API/fx/rates?base=CNY" ""
if code_is 200 && printf '%s' "$RESPONSE" | jq -e '.data.rates | type=="object"' >/dev/null; then
  pass "GET /fx/rates → $(printf '%s' "$RESPONSE" | jq -r '.data.rates | length') 个币种（更新 $(jqv '.data.updatedAt // "?"')）"
elif printf '%s' "$RESPONSE" | jq -e '.error.code' >/dev/null; then
  skip "GET /fx/rates" "未配 FX_API_KEY 时按降级返回 $(jqv '.error.code')"
else
  fail "GET /fx/rates" "HTTP $CODE: $(printf '%.200s' "$RESPONSE")"
fi

for PRIV in "http://127.0.0.1:8080/healthz" "http://[::1]:8080/" "http://169.254.169.254/latest/meta-data/" "http://10.0.0.5/" "http://localhost:8080/"; do
  req POST "$API/dev/proxy" "$TOKEN" "{\"url\":\"$PRIV\",\"method\":\"GET\"}"
  EC="$(jqv '.error.code // empty')"
  if [ "$CODE" != "200" ] && printf '%s' "$EC" | grep -qi 'SSRF'; then
    pass "代理拒绝内网目标 $PRIV（$EC）"
  else
    fail "SSRF 防线" "$PRIV → HTTP $CODE, code=$EC"
  fi
done
req POST "$API/dev/proxy" "$TOKEN" '{"url":"file:///etc/passwd","method":"GET"}'
if [ "$CODE" != "200" ]; then
  pass "代理拒绝非 http(s) 协议（$(jqv '.error.code // "?"'), HTTP $CODE）"
else
  fail "协议白名单" "file:// 竟然通过"
fi

head_ "7. 测速静态文件（C8 要求 Cache-Control: no-store）"
for TIER in 1 5; do
  WANT=$((TIER * 1048576))
  META="$(curl -sS -D "$TMP/h-$TIER.txt" -o "$TMP/sb.bin" -w '%{http_code} %{size_download}' \
    "$BASE/static/speedtest-${TIER}m.bin" 2>/dev/null)"
  if [ "$META" = "200 $WANT" ]; then
    pass "GET /static/speedtest-${TIER}m.bin → $WANT 字节"
  else
    fail "测速文件 ${TIER}m" "期望 200 $WANT，实得 $META"
  fi
  if grep -qi '^cache-control: *no-store' "$TMP/h-$TIER.txt"; then
    pass "speedtest-${TIER}m 带 Cache-Control: no-store"
  else
    fail "speedtest-${TIER}m 缓存头" "缺 no-store（测速会命中缓存）"
  fi
done
HC404="$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/static/speedtest-999m.bin" 2>/dev/null)"
if [ "$HC404" = "404" ]; then
  pass "未知档位 → 404（不列举目录）"
else
  fail "未知档位" "期望 404，实得 $HC404"
fi

printf '\n'
head_ "结果：通过 $PASS · 失败 $FAIL · 跳过 $SKIP"
[ "$FAIL" -eq 0 ] || exit 1
