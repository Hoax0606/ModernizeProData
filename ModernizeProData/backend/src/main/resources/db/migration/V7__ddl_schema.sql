-- AS-IS / TO-BE DDL 解析結果を格納するメタ DB スキーマ.
-- side カラムで AS-IS と TO-BE を 1 統合スキーマで管理する (詳細は ONBOARDING.ja.md セクション 9 参照).
-- 構造: ddl_imports → ddl_tables → ddl_columns の 3 階層, 再インポート時は CASCADE 削除.

-- DDL インポート履歴 (1 プロジェクト × 1 side ごとに 1 アクティブ import).
CREATE TABLE ddl_imports (
    id              VARCHAR(40)  PRIMARY KEY,
    project_id      VARCHAR(40)  NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    side            VARCHAR(8)   NOT NULL,
    filename        VARCHAR(256) NOT NULL,
    file_size       BIGINT       NOT NULL,
    file_hash       VARCHAR(64)  NOT NULL,
    dialect         VARCHAR(16)  NOT NULL DEFAULT 'oracle',
    status          VARCHAR(16)  NOT NULL DEFAULT 'success',
    table_count     INT          NOT NULL DEFAULT 0,
    column_count    INT          NOT NULL DEFAULT 0,
    error_message   TEXT,
    imported_by     VARCHAR(64)  NOT NULL,
    imported_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_ddl_imports_side CHECK (side IN ('asis', 'tobe'))
);

CREATE INDEX idx_ddl_imports_project_side ON ddl_imports(project_id, side);

-- DDL 解析で得たテーブル定義.
CREATE TABLE ddl_tables (
    id              VARCHAR(40)  PRIMARY KEY,
    project_id      VARCHAR(40)  NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    side            VARCHAR(8)   NOT NULL,
    import_id       VARCHAR(40)  NOT NULL REFERENCES ddl_imports(id) ON DELETE CASCADE,
    schema_name     VARCHAR(128) NOT NULL DEFAULT '',
    physical_name   VARCHAR(128) NOT NULL,
    logical_name    VARCHAR(256),
    table_comment   TEXT,
    ordinal         INT          NOT NULL,
    CONSTRAINT chk_ddl_tables_side CHECK (side IN ('asis', 'tobe')),
    CONSTRAINT uq_ddl_tables_project_side_name UNIQUE (project_id, side, schema_name, physical_name)
);

CREATE INDEX idx_ddl_tables_import_id ON ddl_tables(import_id);
CREATE INDEX idx_ddl_tables_project_side ON ddl_tables(project_id, side);

-- DDL 解析で得たカラム定義.
-- data_type_raw = 生 DDL 文字列 (例: 'NUMBER(10,2)', 'VARCHAR2(20 BYTE)').
-- data_type    = 正規化型名 (例: 'NUMBER', 'VARCHAR2').
CREATE TABLE ddl_columns (
    id              VARCHAR(40)  PRIMARY KEY,
    table_id        VARCHAR(40)  NOT NULL REFERENCES ddl_tables(id) ON DELETE CASCADE,
    ordinal         INT          NOT NULL,
    physical_name   VARCHAR(128) NOT NULL,
    logical_name    VARCHAR(256),
    data_type_raw   VARCHAR(128) NOT NULL,
    data_type       VARCHAR(64)  NOT NULL,
    length          INT,
    precision       INT,
    scale           INT,
    nullable        BOOLEAN      NOT NULL DEFAULT TRUE,
    pk_order        INT,
    default_value   TEXT,
    column_comment  TEXT,
    CONSTRAINT uq_ddl_columns_table_ordinal UNIQUE (table_id, ordinal)
);

CREATE INDEX idx_ddl_columns_table_id ON ddl_columns(table_id);
