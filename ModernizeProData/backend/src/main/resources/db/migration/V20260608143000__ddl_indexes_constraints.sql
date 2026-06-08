-- AS-IS / TO-BE DDL の インデックス・制約 メタ.
-- ddl_tables (V7) を親に持つ. side カラムは ddl_tables から継承するが,
-- 直接条件指定の利便性のため重複保存する.
-- PK は ddl_columns.pk_order で表現済 — ここには含めない.
-- 全テーブル CASCADE: ddl_tables 削除時に自動消滅.

-- ===== インデックス =====
CREATE TABLE ddl_indexes (
    id              VARCHAR(40)  PRIMARY KEY,
    project_id      VARCHAR(40)  NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    table_id        VARCHAR(40)  NOT NULL REFERENCES ddl_tables(id) ON DELETE CASCADE,
    side            VARCHAR(8)   NOT NULL,
    name            VARCHAR(128) NOT NULL,
    -- type: btree / hash / gin / gist / brin / spgist / bitmap(oracle) / functional(oracle) / reverse(oracle) / unknown
    type            VARCHAR(32)  NOT NULL DEFAULT 'btree',
    is_unique       BOOLEAN      NOT NULL DEFAULT FALSE,
    is_partial      BOOLEAN      NOT NULL DEFAULT FALSE,
    -- 部分インデックス (PG) の WHERE 句. 原文そのまま.
    where_clause    TEXT,
    -- 式インデックス (PG / oracle function-based) — カラムでなく式を使う場合の原文.
    expression      TEXT,
    CONSTRAINT chk_ddl_indexes_side CHECK (side IN ('asis', 'tobe')),
    CONSTRAINT uq_ddl_indexes_project_side_name UNIQUE (project_id, side, name)
);

CREATE INDEX idx_ddl_indexes_table_id ON ddl_indexes(table_id);
CREATE INDEX idx_ddl_indexes_project_side ON ddl_indexes(project_id, side);

CREATE TABLE ddl_index_columns (
    id              VARCHAR(40)  PRIMARY KEY,
    index_id        VARCHAR(40)  NOT NULL REFERENCES ddl_indexes(id) ON DELETE CASCADE,
    ordinal         INT          NOT NULL,
    column_name     VARCHAR(128) NOT NULL,
    -- ASC / DESC. NULL = デフォルト (BE 任せ).
    sort_order      VARCHAR(8),
    CONSTRAINT uq_ddl_index_columns_index_ordinal UNIQUE (index_id, ordinal)
);

CREATE INDEX idx_ddl_index_columns_index_id ON ddl_index_columns(index_id);


-- ===== 制約 (UK / FK / CHECK) =====
CREATE TABLE ddl_constraints (
    id               VARCHAR(40)  PRIMARY KEY,
    project_id       VARCHAR(40)  NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    table_id         VARCHAR(40)  NOT NULL REFERENCES ddl_tables(id) ON DELETE CASCADE,
    side             VARCHAR(8)   NOT NULL,
    name             VARCHAR(128) NOT NULL,
    -- type: UK / FK / CHECK
    type             VARCHAR(16)  NOT NULL,
    -- CHECK 制約の式 (原文). FK / UK は NULL.
    check_expression TEXT,
    CONSTRAINT chk_ddl_constraints_side CHECK (side IN ('asis', 'tobe')),
    CONSTRAINT chk_ddl_constraints_type CHECK (type IN ('UK', 'FK', 'CHECK')),
    CONSTRAINT uq_ddl_constraints_project_side_name UNIQUE (project_id, side, name)
);

CREATE INDEX idx_ddl_constraints_table_id ON ddl_constraints(table_id);
CREATE INDEX idx_ddl_constraints_project_side ON ddl_constraints(project_id, side);

-- UK / FK は 1 行 = 1 子カラム. FK の場合 ref_column_name に親カラム名を入れる
-- (子と親は ordinal で 1:1 対応).
CREATE TABLE ddl_constraint_columns (
    id              VARCHAR(40)  PRIMARY KEY,
    constraint_id   VARCHAR(40)  NOT NULL REFERENCES ddl_constraints(id) ON DELETE CASCADE,
    ordinal         INT          NOT NULL,
    column_name     VARCHAR(128) NOT NULL,
    -- FK の場合は親カラム名. UK / CHECK は NULL.
    ref_column_name VARCHAR(128),
    CONSTRAINT uq_ddl_constraint_columns_constraint_ordinal UNIQUE (constraint_id, ordinal)
);

CREATE INDEX idx_ddl_constraint_columns_constraint_id ON ddl_constraint_columns(constraint_id);


-- ===== FK 専用補足 (1:1 with ddl_constraints WHERE type='FK') =====
CREATE TABLE ddl_foreign_keys (
    id              VARCHAR(40)  PRIMARY KEY,
    constraint_id   VARCHAR(40)  NOT NULL UNIQUE REFERENCES ddl_constraints(id) ON DELETE CASCADE,
    ref_schema_name VARCHAR(128) NOT NULL DEFAULT '',
    ref_table_name  VARCHAR(128) NOT NULL,
    -- ON DELETE / ON UPDATE: 'NO ACTION' | 'CASCADE' | 'SET NULL' | 'SET DEFAULT' | 'RESTRICT'
    on_delete       VARCHAR(16)  NOT NULL DEFAULT 'NO ACTION',
    on_update       VARCHAR(16)  NOT NULL DEFAULT 'NO ACTION',
    -- DEFERRABLE INITIALLY DEFERRED など. 単純化のため text そのまま.
    deferrable_info VARCHAR(64)
);

CREATE INDEX idx_ddl_foreign_keys_constraint_id ON ddl_foreign_keys(constraint_id);
