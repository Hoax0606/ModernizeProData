-- mapping_asis_skip — AS-IS 컬럼 단위 명시적 skip 마킹.
--
-- 의미: 해당 AS-IS 컬럼은 어떤 TO-BE 와도 매핑되지 않음 (의도적 미사용).
-- 기존 mapping_rules 의 strategy='skip' 은 TO-BE 컬럼 측. 이 테이블은 AS-IS 측 보강.
-- unrouted AS-IS 테이블의 모든 컬럼이 skip 표시되면 UI 가 'skipped' badge 로 표시.
--
-- snapshot freeze 시 SnapshotData.asisSkips 에 동결 — has-changes diff 에 카운트.

CREATE TABLE mapping_asis_skip (
    id            VARCHAR(40)  PRIMARY KEY,
    project_id    VARCHAR(40)  NOT NULL,
    asis_schema   VARCHAR(128) NOT NULL DEFAULT '',
    asis_table    VARCHAR(128) NOT NULL,
    asis_column   VARCHAR(128) NOT NULL,
    created_by    VARCHAR(64)  NOT NULL,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (project_id, asis_schema, asis_table, asis_column)
);

CREATE INDEX idx_mapping_asis_skip_project ON mapping_asis_skip(project_id);
