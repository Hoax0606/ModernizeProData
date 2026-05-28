-- 매핑/cutover 스냅샷 테이블.
CREATE TABLE snapshots (
    id              VARCHAR(40)  PRIMARY KEY,
    project_id      VARCHAR(40)  NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name            VARCHAR(128) NOT NULL,
    description     TEXT,
    type            VARCHAR(16)  NOT NULL DEFAULT 'mapping',
    status          VARCHAR(16)  NOT NULL DEFAULT 'draft',
    created_by      VARCHAR(64)  NOT NULL,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    approved_by     VARCHAR(64),
    approved_at     TIMESTAMPTZ,
    rejected_by     VARCHAR(64),
    rejected_at     TIMESTAMPTZ,
    rejection_reason TEXT,
    table_count     INT          NOT NULL DEFAULT 0,
    rule_count      INT          NOT NULL DEFAULT 0
);

CREATE INDEX idx_snapshots_project_id ON snapshots(project_id);
CREATE INDEX idx_snapshots_status ON snapshots(status);
