-- Phase 5: Worker registration.
--
-- A worker_node row is created by the Coordinator master when issuing a new
-- Worker token. The raw "WK-<32-chars>" token is shown to the master once;
-- only sha256(token) is stored as token_hash so the secret is recoverable
-- exactly once and cannot leak from the DB. A short token_prefix is kept for
-- UI display (operators can identify which worker a token belongs to without
-- seeing the secret).
--
-- Status transitions:
--   PROVISIONED  -- token issued, worker has not connected yet
--   REGISTERED   -- worker called POST /api/v1/workers/register at least once
--   REVOKED      -- master revoked the token; auth filter rejects it
CREATE TABLE worker_node (
    worker_id     varchar(40)  PRIMARY KEY,
    name          varchar(128) NOT NULL,
    site_id       varchar(40)  REFERENCES sites(id) ON DELETE SET NULL,
    token_hash    varchar(64)  NOT NULL UNIQUE,
    token_prefix  varchar(16)  NOT NULL,
    status        varchar(16)  NOT NULL DEFAULT 'PROVISIONED',
    registered_at timestamptz,
    last_seen_at  timestamptz,
    created_at    timestamptz  NOT NULL DEFAULT now(),
    created_by    varchar(64)  NOT NULL
);

CREATE INDEX idx_worker_node_site ON worker_node (site_id);
CREATE INDEX idx_worker_node_status ON worker_node (status);
