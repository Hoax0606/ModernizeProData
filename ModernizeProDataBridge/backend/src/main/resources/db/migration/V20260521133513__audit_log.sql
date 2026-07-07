-- Audit log — site 단위 모든 사용자 액션 기록. 모든 계정에서 동일하게 조회.
-- 기존 client-side localStorage 기반 audit 를 backend 로 이관.

CREATE TABLE audit_log (
    id              VARCHAR(40)  PRIMARY KEY,
    site_id         VARCHAR(40)  NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    project_id      VARCHAR(40)             REFERENCES projects(id) ON DELETE CASCADE,
    username        VARCHAR(64)  NOT NULL,
    action          VARCHAR(64)  NOT NULL,
    target          VARCHAR(256),
    details         TEXT,
    snapshot_id     VARCHAR(40),
    snapshot_name   VARCHAR(256),
    timestamp       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_log_site_ts    ON audit_log (site_id, timestamp DESC);
CREATE INDEX idx_audit_log_project_ts ON audit_log (project_id, timestamp DESC);
