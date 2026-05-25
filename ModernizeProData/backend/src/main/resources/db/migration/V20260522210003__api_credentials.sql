-- feature/schedule: 外部スケジューラ用 API token credential.
--
-- 案 A (solution-wide single token) 採用 — 通常 1 row (name='default') 運用.
-- 発行方向: 外部スケジューラが発行した token を本ツールが登録 (register) するのみ.
--
-- ⚠ 平文 token も DB に保管している (token_plain).
--   要件として「別 session / 別 master でも plain 表示」「コマンド例に埋め込み済み表示」を満たす目的.
--   security 上は本来 hash のみ保管が正しいが、PoC 要件で平文保管を許容している.
--   production deploy 前に客先 security policy と整合性確認が必要 (FISC / J-SOX / PCI 監査時に問題化する可能性).
--   暗号化保管 (案 B) に切り替える場合は本列を bytea + cipher にする.
--
-- scope_*: 案 C (per-credential scope) への退路 — 案 A 時点では常に 'all'.

CREATE TABLE api_credentials (
    id                  VARCHAR(40)  PRIMARY KEY,                                  -- "cred-" + UUID8
    name                VARCHAR(64)  NOT NULL,                                     -- 案 A は 'default'
    token_hash          VARCHAR(64)  NOT NULL,                                     -- SHA-256 hex (64 chars), 認証 hot path 用
    token_plain         VARCHAR(256),                                              -- ⚠ 平文 (PoC 要件、security 妥協)
    display_prefix      VARCHAR(8)   NOT NULL,                                     -- 登録 token の先頭 4 chars (masked display 用)
    display_last4       VARCHAR(4)   NOT NULL,                                     -- 登録 token の末尾 4 chars (masked display 用)
    scope_type          VARCHAR(16)  NOT NULL DEFAULT 'all'
                        CHECK (scope_type IN ('all', 'project_list')),
    scope_project_ids   JSONB,
    generated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    generated_by        VARCHAR(64)  NOT NULL,
    last_used_at        TIMESTAMPTZ,
    revoked_at          TIMESTAMPTZ                                                 -- 論理削除 (監査トレース保持)
);

-- 활성 credential 의 고속 lookup 用 partial index.
CREATE INDEX idx_api_credentials_active
    ON api_credentials (revoked_at)
    WHERE revoked_at IS NULL;
