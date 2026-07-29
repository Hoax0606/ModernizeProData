-- CDC 증분(delta) 이행의 SCN 워터마크 — 프로젝트 × TO-BE 테이블별로
-- "어느 SCN 까지 델타를 적용했는지" 지속(cross-run) 커서.
--   * snapshots.execution_context 는 매 run 덮어써서 부적합.
--   * run_history.metadata 는 per-run 이라 감사용(적용 SCN 범위)으로만 병행 기록.
-- 이 테이블이 유일한 단조 증가 커서. 델타 run 성공 후 upsert.

CREATE TABLE delta_watermark (
    id                VARCHAR(40)  PRIMARY KEY,                                   -- "dw-" + UUID8
    project_id        VARCHAR(40)  NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    tobe_schema       VARCHAR(128) NOT NULL DEFAULT '',
    tobe_table        VARCHAR(128) NOT NULL,
    last_applied_scn  BIGINT,                                                     -- 마지막 적용 SCN (Oracle SCN ≤ 2^48 → BIGINT)
    last_run_id       VARCHAR(40),                                               -- 마지막으로 갱신한 delta run
    updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_delta_watermark UNIQUE (project_id, tobe_schema, tobe_table)
);

CREATE INDEX idx_delta_watermark_project ON delta_watermark (project_id);
