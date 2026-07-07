-- Site: 고객 사이트 (은행, 증권 등) 단위.
CREATE TABLE sites (
    id              VARCHAR(40)  PRIMARY KEY,
    name            VARCHAR(128) NOT NULL,
    asis_env        VARCHAR(16)  NOT NULL,
    tobe_env        VARCHAR(16)  NOT NULL,
    asis_encoding   VARCHAR(16)  NOT NULL,
    tobe_encoding   VARCHAR(16)  NOT NULL,
    csv_path        VARCHAR(512) NOT NULL DEFAULT '',
    notes           TEXT,
    environment     VARCHAR(16)  NOT NULL DEFAULT 'dev',
    tobe_db_by_env  JSONB        NOT NULL DEFAULT '{}',
    tobe_db_locks   JSONB        NOT NULL DEFAULT '{}',
    created_by      VARCHAR(64)  NOT NULL,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Project: Site 내 마이그레이션 단위.
CREATE TABLE projects (
    id              VARCHAR(40)  PRIMARY KEY,
    site_id         VARCHAR(40)  NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    name            VARCHAR(128) NOT NULL,
    phase           VARCHAR(16)  NOT NULL DEFAULT 'planning',
    table_count     INT          NOT NULL DEFAULT 0,
    ddl_files       JSONB        NOT NULL DEFAULT '[]',
    owner           VARCHAR(64)  NOT NULL,
    assignee        VARCHAR(64),
    cutover         JSONB,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_projects_site_id ON projects(site_id);
