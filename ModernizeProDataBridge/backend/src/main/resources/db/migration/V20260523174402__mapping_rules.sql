-- 매핑정의서 임포트·룰 저장 스키마.
--
-- 3 계층: mapping_imports (파일 임포트 1회 단위) → mapping_rules (컬럼별 룰)
--          ↘ mapping_code_maps (코드값 변환 마스터, M→MALE 등)
--
-- 정책 (2026-05-23 협의):
--   - 임포트 시 해당 project 의 mapping_rules · mapping_code_maps 전체를
--     덮어쓴다 (DELETE + INSERT). origin='manual' 룰도 같이 날아감.
--   - TO-BE 식별은 name 기반 (schema/table/column) — DDL 재임포트로 ddl_columns.id
--     가 바뀌어도 이름이 같으면 자동 재연결.
--   - import_id 는 SET NULL — 임포트 레코드를 지워도 룰 자체는 살아있음.
--   - snapshots 와 별개. snapshot 승인 시점에 mapping_rules 를 snapshot_rules
--     child 로 복사하는 건 추후 마이그레이션에서.

-- ------------------------------------------------------------
-- mapping_imports — 파일 임포트 메타데이터
-- ------------------------------------------------------------
CREATE TABLE mapping_imports (
    id                  VARCHAR(40)  PRIMARY KEY,
    project_id          VARCHAR(40)  NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    filename            VARCHAR(256) NOT NULL,
    file_size           BIGINT       NOT NULL,
    file_hash           VARCHAR(64)  NOT NULL,
    format              VARCHAR(16)  NOT NULL DEFAULT 'csv',     -- csv / xlsx
    status              VARCHAR(16)  NOT NULL DEFAULT 'success', -- success / failed
    rule_count          INT          NOT NULL DEFAULT 0,
    code_map_count      INT          NOT NULL DEFAULT 0,
    error_message       TEXT,
    imported_by         VARCHAR(64)  NOT NULL,
    imported_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_mapping_imports_status CHECK (status IN ('success','failed')),
    CONSTRAINT chk_mapping_imports_format CHECK (format IN ('csv','xlsx'))
);
CREATE INDEX idx_mapping_imports_project ON mapping_imports(project_id);

-- ------------------------------------------------------------
-- mapping_rules — 활성 매핑 룰 (project 당 working set)
-- ------------------------------------------------------------
CREATE TABLE mapping_rules (
    id                  VARCHAR(40)  PRIMARY KEY,
    project_id          VARCHAR(40)  NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    import_id           VARCHAR(40)  REFERENCES mapping_imports(id) ON DELETE SET NULL,

    -- TO-BE 식별 (name 기반)
    tobe_schema         VARCHAR(128) NOT NULL DEFAULT '',
    tobe_table          VARCHAR(128) NOT NULL,
    tobe_column         VARCHAR(128) NOT NULL,

    -- AS-IS 식별 (단일 source. JOIN/UNION 다중 source 는 v2)
    asis_schema         VARCHAR(128),
    asis_table          VARCHAR(128),
    asis_column         VARCHAR(128),

    -- 변환 전략 — 프론트 RowEdit.savedStrategy 와 1:1
    strategy            VARCHAR(16)  NOT NULL DEFAULT 'expression',
    transform_rule      TEXT,                                       -- strategy=expression
    default_value       TEXT,                                       -- strategy=default
    not_null_override   BOOLEAN      NOT NULL DEFAULT FALSE,

    rule_origin         VARCHAR(16)  NOT NULL DEFAULT 'imported',   -- imported / manual
    notes               TEXT,

    created_by          VARCHAR(64)  NOT NULL,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_by          VARCHAR(64),
    updated_at          TIMESTAMPTZ,

    CONSTRAINT chk_mapping_rules_strategy
        CHECK (strategy IN ('expression','null','default','skip')),
    CONSTRAINT chk_mapping_rules_origin
        CHECK (rule_origin IN ('imported','manual')),
    CONSTRAINT uq_mapping_rules_target
        UNIQUE (project_id, tobe_schema, tobe_table, tobe_column)
);
CREATE INDEX idx_mapping_rules_project ON mapping_rules(project_id);
CREATE INDEX idx_mapping_rules_tobe    ON mapping_rules(project_id, tobe_schema, tobe_table);
CREATE INDEX idx_mapping_rules_import  ON mapping_rules(import_id);

-- ------------------------------------------------------------
-- mapping_code_maps — 코드값 변환 마스터
-- ------------------------------------------------------------
CREATE TABLE mapping_code_maps (
    id                  VARCHAR(40)  PRIMARY KEY,
    project_id          VARCHAR(40)  NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    import_id           VARCHAR(40)  REFERENCES mapping_imports(id) ON DELETE SET NULL,
    domain              VARCHAR(64)  NOT NULL,                      -- 'GENDER','YN_BOOL' 등
    source_value        VARCHAR(128) NOT NULL,
    target_value        VARCHAR(128) NOT NULL,
    description         TEXT,
    ordinal             INT          NOT NULL DEFAULT 0,
    CONSTRAINT uq_mapping_code_maps_key
        UNIQUE (project_id, domain, source_value)
);
CREATE INDEX idx_mapping_code_maps_project_domain ON mapping_code_maps(project_id, domain);
