-- Stage-level run progression.
-- 한 RunHistory 안에 7개 stage (test/rehearsal) 또는 6개 stage (cutover, Audit 제외).
--   - stage_instances: (run, stage) 단위 진행 — startRun 시점 pre-create (모두 status=pending)
--   - stage_table_results: (stage_instance, binding) 단위 결과 — worker 가 table dispatch 시점에 upsert
-- continue-on-error 모델 (Sprint 0 결정): 한 table fail 시에도 stage 의 다른 table 계속 처리,
-- stage 종료 시점에 tables_failed > 0 이면 stage status=failed.

-- ------------------------------------------------------------
-- stage_instances — (run, stage) 1 row
-- ------------------------------------------------------------
CREATE TABLE stage_instances (
    id                   VARCHAR(40)  PRIMARY KEY,                              -- "si-" + UUID8
    run_id               VARCHAR(40)  NOT NULL REFERENCES run_history(id) ON DELETE CASCADE,
    stage_key            VARCHAR(16)  NOT NULL,                                 -- check/extract/reconcile/transform/audit/load/verify
    seq                  SMALLINT     NOT NULL,                                 -- 1..7 (cutover 1..6)
    status               VARCHAR(16)  NOT NULL DEFAULT 'pending',               -- pending/running/success/failed
    started_at           TIMESTAMPTZ,                                            -- 첫 table dispatch 시점
    finished_at          TIMESTAMPTZ,
    duration_ms          BIGINT,
    tables_total         INT          NOT NULL DEFAULT 0,                       -- run start 시점 materialize
    tables_success       INT          NOT NULL DEFAULT 0,
    tables_failed        INT          NOT NULL DEFAULT 0,
    error_summary        TEXT,                                                   -- one-line digest

    CONSTRAINT chk_stage_instances_stage_key
        CHECK (stage_key IN ('check','extract','reconcile','transform','audit','load','verify')),
    CONSTRAINT chk_stage_instances_status
        CHECK (status IN ('pending','running','success','failed')),
    CONSTRAINT uq_stage_instances_run_stage
        UNIQUE (run_id, stage_key)
);
CREATE INDEX idx_stage_instances_run_seq ON stage_instances (run_id, seq);

-- ------------------------------------------------------------
-- stage_table_results — (stage_instance, binding) 1 row, lazy insert
-- ------------------------------------------------------------
-- tobe_schema / tobe_table 은 비정규화 — binding 이 rehearsal/cutover 사이에 수정되어도
-- run 의 audit 기록이 그대로 읽혀야 하기 때문.
CREATE TABLE stage_table_results (
    id                   VARCHAR(40)  PRIMARY KEY,                              -- "str-" + UUID8
    stage_instance_id    VARCHAR(40)  NOT NULL REFERENCES stage_instances(id) ON DELETE CASCADE,
    binding_id           VARCHAR(40)  NOT NULL REFERENCES mapping_table_bindings(id) ON DELETE RESTRICT,
    tobe_schema          VARCHAR(128) NOT NULL DEFAULT '',
    tobe_table           VARCHAR(128) NOT NULL,
    status               VARCHAR(16)  NOT NULL DEFAULT 'running',               -- running/success/failed
    started_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    finished_at          TIMESTAMPTZ,
    duration_ms          BIGINT,
    row_count            BIGINT,                                                 -- stage 별 의미 (load=적재, verify=비교)
    error_count          INT,
    error_detail         JSONB,                                                  -- {code, message, sample} 자유 형식

    CONSTRAINT chk_stage_table_results_status
        CHECK (status IN ('running','success','failed')),
    CONSTRAINT uq_stage_table_results_stage_binding
        UNIQUE (stage_instance_id, binding_id)
);
CREATE INDEX idx_stage_table_results_stage ON stage_table_results (stage_instance_id);
