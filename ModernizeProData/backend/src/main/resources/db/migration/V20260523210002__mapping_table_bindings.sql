-- TO-BE 테이블 ↔ AS-IS 테이블 바인딩 저장.
-- 임포트 시 column_mapping.csv 의 row 들을 grouping 해서 자동 derive.
-- composition_kind / where_filter 같이 TO-BE 1개당 1개인 값은 parent 에,
-- AS-IS 소스 (primary 1 + join/union N) 는 child 테이블에.

-- ------------------------------------------------------------
-- mapping_table_bindings — TO-BE 테이블 1개당 1 row
-- ------------------------------------------------------------
CREATE TABLE mapping_table_bindings (
    id                   VARCHAR(40)  PRIMARY KEY,
    project_id           VARCHAR(40)  NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    import_id            VARCHAR(40)  REFERENCES mapping_imports(id) ON DELETE SET NULL,

    tobe_schema          VARCHAR(128) NOT NULL DEFAULT '',
    tobe_table           VARCHAR(128) NOT NULL,

    composition_kind     VARCHAR(16)  NOT NULL DEFAULT 'single',  -- single/join/union/none
    where_filter         TEXT,

    binding_origin       VARCHAR(16)  NOT NULL DEFAULT 'imported', -- imported/manual
    created_by           VARCHAR(64)  NOT NULL,
    created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_by           VARCHAR(64),
    updated_at           TIMESTAMPTZ,

    CONSTRAINT chk_mtb_composition
        CHECK (composition_kind IN ('single','join','union','none')),
    CONSTRAINT chk_mtb_origin
        CHECK (binding_origin IN ('imported','manual')),
    CONSTRAINT uq_mtb_target
        UNIQUE (project_id, tobe_schema, tobe_table)
);
CREATE INDEX idx_mtb_project ON mapping_table_bindings(project_id);
CREATE INDEX idx_mtb_import  ON mapping_table_bindings(import_id);

-- ------------------------------------------------------------
-- mapping_table_binding_sources — AS-IS 소스 (1+ per binding)
-- ------------------------------------------------------------
CREATE TABLE mapping_table_binding_sources (
    id                   VARCHAR(40)  PRIMARY KEY,
    binding_id           VARCHAR(40)  NOT NULL REFERENCES mapping_table_bindings(id) ON DELETE CASCADE,
    ordinal              INT          NOT NULL DEFAULT 0,

    asis_schema          VARCHAR(128),
    asis_table           VARCHAR(128) NOT NULL,
    alias                VARCHAR(16)  NOT NULL,
    role                 VARCHAR(16)  NOT NULL,             -- primary/join/union

    join_type            VARCHAR(16),                        -- LEFT/INNER/RIGHT/FULL (JOIN role 만)
    join_on              TEXT,                               -- ON clause (JOIN role 만)

    CONSTRAINT chk_mtbs_role
        CHECK (role IN ('primary','join','union')),
    CONSTRAINT uq_mtbs_alias
        UNIQUE (binding_id, alias)
);
CREATE INDEX idx_mtbs_binding ON mapping_table_binding_sources(binding_id);
