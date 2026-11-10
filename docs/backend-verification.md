# 后端验证报告（toolbox-server）

> 本文件记录 `server/` 的**真实验证过程与结果**，而不是设计意图。
> 所有数字都可用「复现步骤」一节的命令在本机重跑得到。
> 契约依据：`docs/CONTRACT.md` C8；需求依据：`docs/requirements.md` §8。

## 1. 验证环境（本机事实）

| 项 | 实际情况 | 对验证的影响 |
| --- | --- | --- |
| PostgreSQL | Docker 容器 `pg18-trixie`，`127.0.0.1:15433`，用户/密码 `postgre`，库 `toolbox_dev` | 迁移、真实 SQL 读写全部实测通过 |
| ffmpeg / ffprobe | **本机未安装；构建出的镜像内为 7.1.5** | 本机跑 worker 全链路需 `MEDIA_DRY_RUN=1`（占位产物）；真实元信息与编解码在热更新容器内 `MEDIA_DRY_RUN=0` 实测通过（§5 第 1 条、§7B） |
| 微信小程序凭据 | **无 AppID/AppSecret** | 以 `WECHAT_STUB=1` 走 `auth/wechat.rs` 的开发桩，`code2session` 的真实网络分支由单元测试覆盖 |
| 汇率数据源 | 未配 `FX_API_KEY` | `GET /fx/rates` 返回可识别的 `UPSTREAM_UNAVAILABLE`，不编造数据 |
| 截图 / 开发者工具 | 不可用 | 只做静态校验 + 无头冒烟 + 已知向量断言 |

## 2. 三层验证矩阵

| 层次 | 手段 | 覆盖 | 结果 |
| --- | --- | --- | --- |
| 单元 / 属性 | `cargo test`（`src/**` 内 `#[cfg(test)]`） | JWT 签发校验、错误码序列化、SSRF IP 矩阵、分片计划、magic number、签名、参数校验、ffmpeg 命令行构造、`ProcessRunner` stdout 透传、PDF 字节流（lopdf 反解析）、dry-run 合成元信息 | **134 passed / 0 failed** |
| 契约级联调 | `server/scripts/live_smoke.sh`（对**运行中**的服务逐接口真实 HTTP，40 项检查 = 39 断言 + 1 降级说明） | C8 全部端点 + 越权/篡改/伪装/未知类型负例 + 任务轮询到终态 + 产物下载（含容器内 ffmpeg 真实转码产物）+ 静态文件与缓存头 | **39 通过 / 0 失败 / 1 跳过**（退出码 0） |
| 编译质量 | `cargo check` | 全 crate | **0 error / 0 warning** |

跳过项说明（环境依赖，非代码缺失）：
`GET /fx/rates` 需要 `FX_API_KEY`，无 key 时返回可识别的 `UPSTREAM_UNAVAILABLE`（脚本记为 skip 而非 fail）。

## 3. 端点覆盖（live_smoke.sh 实测）

| 端点 | 实测结果 |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true,"status":"alive"}` |
| `GET /readyz` | 200 `{"ok":true,"db":"up","status":"ready"}` |
| `POST /api/v1/auth/silent` | 200 → `accessToken` / `refreshToken` / `userId`；**响应体不含 openid**（脚本用 grep 断言） |
| `POST /api/v1/auth/refresh` | 200 → 新 accessToken |
| `GET /api/v1/tools/flags` | 200，游客可用，`data.flags` 19 项 |
| `POST /api/v1/files/init` | 200 → `fileId`/`chunkSize=4194304`/`uploaded[]` |
| `POST /api/v1/files/upload` | multipart 单片 9221 字节 → `received` 与实体字节数一致 |
| `POST /api/v1/files/:id/complete` | 200 `ready:true`（服务端自算 sha256 比对 + magic 判定真实 mime） |
| `POST /api/v1/media/tasks` | 200 → `taskId`，`status=queued` |
| `GET /api/v1/media/tasks/:id` | 轮询到 `status=success`（DB 为 `succeeded`，对外按 `miniprogram/utils/video-task.js` 映射）、`progress=100`、`stage=done`、`result.{url,kind,sizeMB,meta}` |
| `GET /api/v1/files/:id/download?token=` | 200 → 61161 字节，首 4 字节 `ff d8 ff e0`（JPEG 魔数正确）；篡改 token → 403 |
| `GET /api/v1/media/tasks` | 200 → `data.items[]` |
| `POST /api/v1/media/tasks/:id/cancel` | 200 `{ok:true,...}`（终态任务返回可读错误码） |
| `POST /api/v1/usage/batch` | 200 `{ok:true,accepted:1}` |
| `GET /api/v1/fx/rates?base=CNY` | 无 key → `UPSTREAM_UNAVAILABLE`（见 §2） |
| `POST /api/v1/dev/proxy` | 见 §4 |

视频链路（真实 ffmpeg，`MEDIA_DRY_RUN=0`，服务跑在 `toolbox-server:latest` 容器内）：
输入是脚本现场用容器内 ffmpeg 合成的 1s 测试片（`testsrc`+`sine`，42700 字节，`ftyp` 头部合法）→
`video-compress` 经队列到终态 → `result.kind=video`、`engine=ffmpeg`、`sizeMB=0.08` →
产物经签名 URL 下载 87429 字节，并用 `od` 断言偏移 4 处为 `ftyp`（确系 mp4 容器，不是占位文件）。
> 注意：产物比 1s 源片大属正常（`360p` 档位对 640×480/1s 素材的码率下限），
> 断言目标是「真引擎产出可解码容器」，压缩率属独立调参问题。

测速静态文件（`GET /static/speedtest-{1,5}m.bin`）：
```
HTTP/1.1 200 OK · content-type: application/octet-stream · cache-control: no-store · content-length: 1048576
5 MiB 同样通过；未知档位（speedtest-999m.bin）→ 404，不做目录列举
```
> 这里**刻意不用** `tower_http::services::ServeDir`：它无法附加 `Cache-Control`，而 C8 要求
> `no-store`（否则小程序命中缓存导致测速失真）。改为 `src/routes/static_files.rs` 白名单固定文件名 +
> 流式响应。实现过程中撞到 axum 路由约束「一个路径段只允许一个参数」，
> `/static/speedtest-{mb}.bin` 会在启动时 panic，故路由写作 `/static/{name}` 并在 handler 内校验。

## 4. 安全项实测

**SSRF 防线（`POST /dev/proxy`）** — 全部返回 `SSRF_BLOCKED`：

```
http://127.0.0.1:8080/healthz      ✓   http://10.0.0.5/                ✓
http://[::1]:8080/                 ✓   http://169.254.169.254/latest/meta-data/  ✓
http://localhost:8080/             ✓   file:///etc/passwd              ✓（协议白名单）
http://[fd00::1234]/、[fe80::1]/、[::ffff:127.0.0.1]/  ✓（单元测试）
```

> 级联调过程中发现并修复的**真实缺陷**：`url` crate 的 `Url::host_str()` 对 IPv6 字面量**保留方括号**
> （`"[::1]"`），而原实现直接 `host.parse::<IpAddr>()`，解析失败即**跳过整段 IP 内网判定**，
> 等于 `http://[::1]:8080/` 可以打到本机。修复方式是在共享模块 `src/dev_proxy.rs` 增加
> `ip_literal()`（剥括号后再判 `private_reason`），`validate_target` 与 `check_host` 同时改用，
> 并补了 `ipv6_literals_are_parsed_despite_brackets` 单元测试与级联调负例。

**其他防线**：
- 上传内容：伪装成 `fake.png` 的 `MZ` 可执行文件在 `complete` 阶段被拒（`UNSUPPORTED_FORMAT` / 415）。
- 越权：用户 B 引用用户 A 的 `fileId` 建任务 → 403；上传/完成他人文件 → 403。
- 下载签名：token 绑定 `fileId + userId + exp`，改一个字符 → 403；未带 token → 404/403。
- 无令牌写接口 → 401 `AUTH_REQUIRED`（前端 `request.js` 自动 refresh 一次后回落游客）。
- 未知任务类型（`type:"rm-rf"`）→ 400 `PARAM_INVALID`，绝不静默入队。
- 配额与并发：`rate_limit::guard_task_creation`（日配额 + IP 软限流）与 `active_count_for_user` 并发上限生效。
- 日志：`telemetry` 只记 method/path/status/latency/requestId；`x-request-id` 只接受可见 ASCII 字符，
  空白/非 ASCII/非法 UTF-8/超长一律重新生成（防日志注入与响应头拆分）。
- 密钥：`JWT_SECRET`/`WECHAT_APPSECRET`/`FX_API_KEY`/`DATABASE_URL` 只从环境变量读取；
  `Settings::validate()` 在 `JWT_SECRET` 短于 32 字节时直接拒绝启动；仓库内只有 `.env.example` 占位符。

## 5. 已知偏差与限制（如实记录，不粉饰）

1. **真实编解码已在镜像内验证**（2026-10-14，此前为「本机无 ffmpeg → 只能 dry-run」）：
   镜像内 ffmpeg 7.1.5，`MEDIA_DRY_RUN=0` 下 `image-compress`（PNG→JPEG，61161 字节，魔数
   `ff d8 ff e0`）与 `video-compress`（1s 测试片 42700 → 87429 字节，产物含 `ftyp` box、
   `engine=ffmpeg`）全部跑通。**这一步第一次执行就暴露了一个真缺陷**：
   `ProcessRunner::run` 采集了子进程 stdout 却返回 `stdout: String::new()`，于是
   `resolve_media_info` 永远拿不到 ffprobe 的 JSON，装好 ffmpeg 也只会退化成
   `ENGINE_UNAVAILABLE`；`MEDIA_DRY_RUN=1` 的合成元信息分支恰好掩盖了它。
   已修复并加回归测试 `media::ffmpeg::tests::process_runner_forwards_stdout`
   （用 `/bin/echo` 冒充 ffprobe，不依赖真引擎，本机也能跑）。
   **推论：dry-run 全绿 ≠ 真引擎链路可用**；改动媒体执行路径后必须跑一次镜像内
   `server/scripts/update.sh --smoke`（见 §6 热更新）。
2. **下载 token 不是严格「一次性」**：`files` 表没有 `used_at` 列（迁移已冻结），
   实现为「短 TTL + 绑定 file/user + HMAC」，同一 TTL 内可重复下载。
   若要真正单次消费需加列并改 `sign::verify`，属于 schema 变更，未擅自进行。
3. **响应包略有出入**：`/healthz`、`/readyz` 返回扁平 `{ok,status[,db]}`，未套 `{ok,data}`；
   这两个端点前端不调用，仅给探针/容器健康检查用。
4. **C8 响应字段为超集**：`GET /media/tasks/:id` 等除契约字段外附带
   `taskId/toolId/type/dbStatus/params/createdAt…` 便于排查；契约要求的字段全部存在。
5. **小程序 Worker 未实现**（与 `docs/requirements.md` 偏差一致）：FR-TXT-05 的 >2 MB 哈希、
   FR-TXT-01 的 1 MB JSON 解析仍受主线程限制；这些能力在服务端不可用（属前端职责），
   需要后续以 Worker 方式补齐。
6. `POST /usage/batch` 的 `success` 由事件名启发式判定（`*_fail`/`*_failed` → false），
   因为前端事件负载没有显式成功标志位；无 `toolId` 的事件被跳过（`tool_usage.tool_id` NOT NULL）。

## 6. 部署产物

| 文件 | 内容 | 验证方式与结论 |
| --- | --- | --- |
| `server/Dockerfile` | 两阶段：`rust:1-trixie` 编译（`--release --locked`，edition 2024 需 ≥1.85）→ `debian:trixie-slim` 运行；运行层 apt 安装 `ffmpeg`、`fonts-noto-cjk`、`ca-certificates`、`curl`；非 root（uid 10001）；`EXPOSE 8080`、`VOLUME /data/uploads`、`HEALTHCHECK curl /healthz`；安全默认 `MEDIA_DRY_RUN=0`、`WECHAT_STUB=0`、`PROXY_ALLOW_PRIVATE_NETWORK=false`。**不写 `# syntax=`、不用 `COPY --chmod`**：两者都依赖 BuildKit 联网取 dockerfile 前端/扩展，本机 BuildKit 因 `auth.docker.io` IPv6 解析异常直接失败，而经典构建器（`DOCKER_BUILDKIT=0`）可完整构建 | **已实际构建并运行**：`toolbox-server:latest`（id `d38f14d77e3c`；`docker image inspect` 内容层 285797232 字节，`docker images` 计 939 MB）。容器内核对 `ffmpeg 7.1.5` / `ffprobe 7.1.5`、`NotoSansCJK-Regular.ttc`、`/data/static/speedtest-{1,5}m.bin` 就位、`id` 为 uid 10001、`ENTRYPOINT=/usr/local/bin/toolbox-server`。§3 的 39 项断言打在**同一镜像**起的热更新容器上（`toolbox-dev-api`，只把 entrypoint 换成 `./dist` 挂载的二进制，见 §7B）；镜像**烤进去的**二进制另起临时容器验证：PID 1 = `/usr/local/bin/toolbox-server`、`/readyz`=200 `db:up`、`/healthz`=200、`/static/speedtest-1m.bin` 带 `no-store` |
| `server/.dockerignore` | 排除 `target/`、`dist/`、`data/`、`.env`/`.env.*`、部署工件（`Dockerfile`、`docker-compose*.yml`）、`scripts/*`（只 `!scripts/gen_speedtest_files.sh` 例外）；**不排除** `migrations/` | 构建上下文实测通过（`COPY migrations`、`COPY scripts/gen_speedtest_files.sh` 均成功，产物烤进镜像层）；本机 `server/.env`（含真实开发 `JWT_SECRET`）确认未进上下文 |
| `server/docker-compose.yml` | 生产编排：`pg`（`postgres:15`，命名卷 + `pg_isready` healthcheck）+ `api`（`build: .`，`depends_on: condition: service_healthy`，卷 `uploads:/data/uploads`，端口 `${API_HOST_PORT:-8080}`）；凭据全部 `${POSTGRES_*}` 间接引用 | `docker compose config` 通过；镜像与 `api` 服务在 §7B 的热更新栈里被同一份二进制实测 |
| `server/docker-compose.update.yml` | **热更新栈（开发/联调）**：`build`（`rust:1-trixie`，`./`→`/src` 只读源码 + `cargo-target`/`cargo-registry` 命名卷，产物 `install` 到 `./dist`）+ `api`（同一份 `toolbox-server:latest`，但 `entrypoint=/app/bin/toolbox-server`，`./dist`→`/app/bin` **目录**挂载，默认宿主端口 8081） | 实测：无改动时整条链路 1s（cargo `Finished in 0.08s`）；有改动时容器 md5 与新产物一致且 `docker image inspect` id 不变 → 证明「不重建镜像也能更新」成立。容器 PID 1 `readlink /proc/1/exe` = `/app/bin/toolbox-server`，即运行的确实是挂载进去的二进制 |
| `server/scripts/update.sh` | 一条命令封装：`.env` 前置检查（缺 `JWT_SECRET` 自动生成本机随机值并 `chmod 600`）→ 缺镜像才构建 → 容器内增量编译 → `up -d --force-recreate api` → 轮询 `/readyz` → 宿主/容器产物 md5 比对 → 可选 `--smoke` 跑 §3 契约；`--restart`/`--image`/`--down` 为辅助开关 | `bash -n` 通过；`--smoke` 全链路实测（39 通过 / 0 失败 / 1 跳过） |
| `server/.env.example` | 45 个键位（默认值/占位符，密钥一律 `CHANGE_ME_*`）：38 个由 `src/config.rs::apply_env` 读取，其余为 `src/tasks/queue.rs::worker_count`、`src/fx/mod.rs::ENV_FX_API_BASE` 等零散读取位，以及 compose/热更新栈专用（`POSTGRES_*`、`API_HOST_PORT`、`PG_HOST_PORT`、`DEV_DATABASE_URL`、`DEV_API_HOST_PORT`、`DEV_LOG_LEVEL`、`DEV_PROXY_ALLOW_PRIVATE_NETWORK`，均已注明「Rust 代码不读取」） | 反向逐键比对：代码里 `env_str("…")` 读取的键 **100% 出现在示例中**（脚本化 diff，缺项为 0）；示例里不存在臆造键；文件内无任何真实凭据 |
| `server/scripts/gen_speedtest_files.sh` | 纯 POSIX shell + awk + dd 生成 `speedtest-1m.bin` / `speedtest-5m.bin`，字节级可复现（LCG 确定性）、与 ffmpeg 无关 | 实际执行两次：尺寸精确 `1048576` / `5242880`；`FORCE=1` 重跑 sha256 不变；换 `STATIC_DIR` 产物 `cmp` 一致；`gzip -9` 后 1048701 字节（不可压缩，确为随机态字节）。级联调 §3 已验证服务端下发与 `no-store` |

## 7. 复现步骤

### 7A. 本机（无 ffmpeg，dry-run 全链路）

```bash
# 0) 依赖：PG 容器（15433 / postgre / postgre）
docker exec pg18-trixie psql -U postgre -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='toolbox_dev'" \
  || docker exec pg18-trixie psql -U postgre -d postgres -c "CREATE DATABASE toolbox_dev OWNER postgre"

cd server

# 1) 单元测试（迁移无需运行服务）
DATABASE_URL="postgres://postgre:postgre@127.0.0.1:15433/toolbox_dev" cargo test

# 2) 启动（开发桩 + dry-run；密钥仅来自环境变量）
mkdir -p data/static
DATABASE_URL="postgres://postgre:postgre@127.0.0.1:15433/toolbox_dev" \
JWT_SECRET="$(openssl rand -hex 32)" \
WECHAT_STUB=1 MEDIA_DRY_RUN=1 \
STORAGE_DIR="$PWD/data/uploads" STATIC_DIR="$PWD/data/static" \
HOST=127.0.0.1 PORT=8080 \
  cargo run

# 3) 契约级联调（另开终端）
bash server/scripts/gen_speedtest_files.sh          # 生成 /static 测速文件
BASE=http://127.0.0.1:8080 bash server/scripts/live_smoke.sh
```

### 7B. 镜像 + 磁盘映射热更新（真实 ffmpeg，日常推荐）

镜像只需构建一次；之后改 Rust 代码**不再重建镜像**，编译在容器里做、产物落 `./dist`、
运行容器通过目录挂载换新二进制。

```bash
cd server

# 0) 一次性：准备 .env（600 权限，绝不提交；密钥只进这里）
#    DEV_DATABASE_URL 必须是容器可达地址 —— 连宿主机 PG 用 host.docker.internal，
#    写 127.0.0.1 会连到容器自己。
cp .env.example .env          # 然后填 DEV_DATABASE_URL；JWT_SECRET 缺失时脚本会自动生成
grep -E '^(DEV_DATABASE_URL|JWT_SECRET)=' .env

# 1) 一条命令：（缺镜像才构建）→ 容器内增量编译 → 重启 api → /readyz 门控 → md5 比对
bash scripts/update.sh                # 默认
bash scripts/update.sh --smoke        # 顺带跑 §3 的 39 项契约断言
bash scripts/update.sh --image        # 改了 apt 包/字体/测速文件才需要重建基础镜像
bash scripts/update.sh --restart      # 只重启（改了 .env）
bash scripts/update.sh --down         # 停栈，保留数据卷与 target 编译缓存

# 2) 观察
docker compose -f docker-compose.update.yml logs -f api
curl -s http://127.0.0.1:8081/readyz
```

关键事实与踩坑（已逐项验证）：

- **必须用经典构建器**：本机 BuildKit 要连 `auth.docker.io` 取镜像元数据，而其 IPv6 记录解析到坏地址
  → 第一步就 `DeadlineExceeded`（`docker pull` 走 Docker Desktop 的 hub 代理所以没事）。
  脚本默认 `DOCKER_BUILDKIT=0`，Dockerfile 因此不写 `# syntax=`、不用 `COPY --chmod`；
  网络正常的机器上切回 BuildKit：`TB_DOCKER_BUILDKIT=1 bash scripts/update.sh`。
- **产物必须是 Linux ELF**：本机 `cargo build` 出的是 Mach-O，挂进容器跑不了，
  所以编译也在容器里做（`rust:1-trixie` 与运行层 `debian:trixie-slim` glibc 同代，链接无问题）。
- **挂载用目录而非单文件**：bind mount 会钉住 inode，`mv`/重新下载产物会换 inode，
  而覆盖写又常撞 `Text file busy`；挂 `./dist` → `/app/bin` 目录 + `install` 到临时名再 `mv -f` 才稳。
- **时效**：无改动 1s（cargo `Finished in 0.08s`）；改动约 60s 增量编译 + 重启。
  `target/` 与 cargo registry 用命名卷，避开 macOS virtiofs 上的慢 IO。
- **`IMAGE` 不重建的证据**：脚本末尾打印 `docker image inspect` 的 id，跨多次更新保持不变。

`live_smoke.sh` 以退出码 0/1 表示通过/失败，可直接接入 CI。
对容器跑契约时用 `SMOKE_CONTAINER=toolbox-dev-api BASE=http://127.0.0.1:8081 bash scripts/live_smoke.sh`
（`SMOKE_CONTAINER` 供 §3 的「容器内 ffmpeg 合成真实 mp4 输入」步骤使用）。

> §3 表格里的响应字节数来自**同一镜像的 dry-run 运行**（§7A 的宿主进程）：
> 契约断言的条数在两种引擎模式下都是 39/0/1，差别只在 5b 视频一节
> ——dry-run 下产物是占位文件，容器内 `MEDIA_DRY_RUN=0` 才会真转码并被 `od` 校验 `ftyp`。

## 8. 数据库

迁移由 `sqlx::migrate!("./migrations")` 编译进二进制，启动时自动执行（无需 `psql`）：

| 文件 | 内容 |
| --- | --- |
| `00000000000000__init.sql` | `users` / `sessions` / `files` / `media_tasks` / `tool_usage` / `favorites` / `tool_flags` / `rate_limits` + 部分索引（`idx_files_expiry`、`idx_media_tasks_active`） |
| `00000000000001__seed_tool_flags.sql` | 上线初期工具开关种子 |

级联调后的真实数据（`toolbox_dev`）：`users`、`files`、`media_tasks`、`tool_usage` 均按预期写入，
`_sqlx_migrations` 记录 2 条已应用迁移。
