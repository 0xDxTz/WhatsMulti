-- Shared schema. Owned by the spec, implemented by both runtimes.
--
-- These tables carry WhatsMulti's own bookkeeping: the session registry and the
-- distributed lock. They are deliberately independent of how Signal/auth material is
-- stored, which each driver owns and which is NOT interoperable between runtimes
-- (see README.md). A Go instance and a TypeScript instance sharing one database can
-- therefore see the same session list and fence each other correctly, even though
-- neither can resume the other's paired sessions.
--
-- Written in portable SQL. Per-engine notes are inline.

CREATE TABLE IF NOT EXISTS whatsmulti_session (
    id            VARCHAR(64)  NOT NULL,   -- matches config.yaml#session_id.pattern
    storage       VARCHAR(32)  NOT NULL,   -- adapter name
    runtime       VARCHAR(16)  NOT NULL,   -- 'ts' | 'go' -- which build created it
    state         VARCHAR(24)  NOT NULL,   -- states.yaml#states
    jid           VARCHAR(128),            -- populated once paired
    config        TEXT,                    -- JSON, per-session socket config overrides
    created_at    BIGINT       NOT NULL,   -- unix milliseconds
    updated_at    BIGINT       NOT NULL,
    PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS whatsmulti_session_state_idx
    ON whatsmulti_session (state);

CREATE TABLE IF NOT EXISTS whatsmulti_lock (
    lock_key      VARCHAR(128) NOT NULL,   -- 'session:<id>'
    token         VARCHAR(64)  NOT NULL,   -- random per acquisition; required to renew/release
    owner         VARCHAR(128) NOT NULL,   -- instance_id
    expires_at    BIGINT       NOT NULL,   -- unix milliseconds
    PRIMARY KEY (lock_key)
);

CREATE INDEX IF NOT EXISTS whatsmulti_lock_expires_idx
    ON whatsmulti_lock (expires_at);

-- Acquire: succeeds only when no row exists or the existing row has expired.
-- Expressed here for PostgreSQL; MySQL uses INSERT ... ON DUPLICATE KEY UPDATE with
-- the same expiry predicate, and SQLite uses INSERT ... ON CONFLICT DO UPDATE.
--
--   INSERT INTO whatsmulti_lock (lock_key, token, owner, expires_at)
--   VALUES ($1, $2, $3, $4)
--   ON CONFLICT (lock_key) DO UPDATE
--     SET token = EXCLUDED.token,
--         owner = EXCLUDED.owner,
--         expires_at = EXCLUDED.expires_at
--     WHERE whatsmulti_lock.expires_at < $5;      -- $5 = now
--
-- Renew and release MUST both match on token, never on owner alone. Matching on
-- owner would let a stale process release a lock a newer incarnation of itself has
-- since acquired.
--
--   UPDATE whatsmulti_lock SET expires_at = $1 WHERE lock_key = $2 AND token = $3;
--   DELETE FROM whatsmulti_lock            WHERE lock_key = $1 AND token = $2;

-- Optional. Only used by adapters that keep Signal material in SQL. The Go build
-- uses whatsmeow's own sqlstore tables instead and leaves this one empty.
CREATE TABLE IF NOT EXISTS whatsmulti_auth (
    session_id    VARCHAR(64)  NOT NULL,
    auth_key      VARCHAR(512) NOT NULL,   -- percent-encoded, algorithms.md section 3
    value         BLOB         NOT NULL,   -- opaque to the adapter
    updated_at    BIGINT       NOT NULL,
    PRIMARY KEY (session_id, auth_key)
);
