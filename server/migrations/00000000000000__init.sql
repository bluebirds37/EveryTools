-- 通用工具箱 · 初始表结构（docs/requirements.md §8.3）
-- 所有表时间列使用 timestamptz；软删除用 status，不用 deleted_at。

-- users ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id            bigserial PRIMARY KEY,
    openid        varchar NOT NULL UNIQUE,
    unionid       varchar NULL,
    nickname      varchar NULL,                 -- v1 恒为空（未授权头像昵称）
    avatar_url    varchar NULL,                 -- v1 恒为空
    status        smallint NOT NULL DEFAULT 1,  -- 1=active, 0=disabled
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    last_login_at timestamptz NULL
);

CREATE INDEX IF NOT EXISTS idx_users_openid ON users (openid);

-- sessions ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
    id                 uuid PRIMARY KEY,
    user_id            bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    refresh_token_hash varchar NOT NULL,          -- 只存 hash（SHA-256），不存明文
    session_key_enc    bytea NULL,                -- 微信 session_key（加密列，v1 不使用其内容）
    device_info        jsonb NOT NULL DEFAULT '{}'::jsonb,
    expires_at         timestamptz NOT NULL,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_refresh_hash ON sessions (refresh_token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id, expires_at);

-- files ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS files (
    id          uuid PRIMARY KEY,
    user_id     bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name        varchar NOT NULL,                 -- sanitize 后的展示名，不作为存储路径
    mime        varchar NULL,                     -- magic number 判定出的真实类型
    size        bigint NOT NULL DEFAULT 0,
    sha256      varchar NULL,                     -- complete 时计算/校验
    storage_key varchar NOT NULL,                 -- uuid 作为存储 key（不含用户文件名）
    kind        varchar NOT NULL DEFAULT 'input', -- input|output|asset
    status      varchar NOT NULL DEFAULT 'uploading', -- uploading|ready|expired|deleted
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    uploaded_at timestamptz NULL,
    expires_at  timestamptz NULL,
    CONSTRAINT ck_files_kind CHECK (kind IN ('input', 'output', 'asset')),
    CONSTRAINT ck_files_status CHECK (status IN ('uploading', 'ready', 'expired', 'deleted'))
);

CREATE INDEX IF NOT EXISTS idx_files_user ON files (user_id, created_at DESC);
-- TTL 清理任务扫描用
CREATE INDEX IF NOT EXISTS idx_files_expiry ON files (status, expires_at) WHERE status IN ('ready', 'uploading');

-- media_tasks ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS media_tasks (
    id            uuid PRIMARY KEY,
    user_id       bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    tool_id       varchar NOT NULL,
    type          varchar NOT NULL,               -- image|video|image2pdf ...
    status        varchar NOT NULL,               -- queued|uploading|processing|succeeded|failed|canceled
    input_file_id uuid NULL REFERENCES files (id) ON DELETE SET NULL,
    output_file_id uuid NULL REFERENCES files (id) ON DELETE SET NULL,
    params        jsonb NOT NULL DEFAULT '{}'::jsonb,
    progress      smallint NOT NULL DEFAULT 0,    -- 0..100
    error_code    varchar NULL,
    error_message varchar NULL,
    engine_used   varchar NULL,                   -- ffmpeg|image|pdf
    cost_ms       integer NULL,
    bytes_in      bigint NULL,
    bytes_out     bigint NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    started_at    timestamptz NULL,
    finished_at   timestamptz NULL,
    expires_at    timestamptz NULL,
    CONSTRAINT ck_media_tasks_status CHECK (
        status IN ('queued', 'uploading', 'processing', 'succeeded', 'failed', 'canceled')
    )
);

CREATE INDEX IF NOT EXISTS idx_media_tasks_user ON media_tasks (user_id, created_at DESC);
-- 队列/恢复扫描：只索引活跃状态（部分索引）
CREATE INDEX IF NOT EXISTS idx_media_tasks_active
    ON media_tasks (status, created_at)
    WHERE status IN ('queued', 'processing');

-- tool_usage -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tool_usage (
    id         bigserial PRIMARY KEY,
    user_id    bigint NULL REFERENCES users (id) ON DELETE SET NULL,
    tool_id    varchar NOT NULL,
    engine     varchar NOT NULL DEFAULT 'client', -- client|server
    success    boolean NOT NULL DEFAULT true,
    cost_ms    integer NULL,
    day        date NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tool_usage_tool_day ON tool_usage (tool_id, day);
-- 每日配额统计（user + day 命中）
CREATE INDEX IF NOT EXISTS idx_tool_usage_user_day ON tool_usage (user_id, day);

-- favorites --------------------------------------------------------------
CREATE TABLE IF NOT EXISTS favorites (
    id         bigserial PRIMARY KEY,
    user_id    bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    tool_id    varchar NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_favorites_user_tool UNIQUE (user_id, tool_id)
);

-- tool_flags -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tool_flags (
    tool_id      varchar PRIMARY KEY,
    enabled      boolean NOT NULL DEFAULT true,
    sort         integer NOT NULL DEFAULT 0,
    min_version  varchar NOT NULL DEFAULT '1.0.0',
    gray_percent integer NOT NULL DEFAULT 100,
    updated_at   timestamptz NOT NULL DEFAULT now()
);

-- rate_limits ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rate_limits (
    id         bigserial PRIMARY KEY,
    scope      varchar NOT NULL,             -- user|ip
    key        varchar NOT NULL,
    day        date NOT NULL,
    count      integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_rate_limits_scope_key_day UNIQUE (scope, key, day),
    CONSTRAINT ck_rate_limits_scope CHECK (scope IN ('user', 'ip'))
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_day ON rate_limits (day);
