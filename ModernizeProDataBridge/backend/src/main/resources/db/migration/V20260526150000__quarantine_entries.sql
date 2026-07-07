-- Stage 실행 중 validation rule 위반 row 의 격리 기록.
-- rule 별 group 화는 query 단계에서 (별도 group entity 없음).
-- 전체 위반 row 의 raw data 는 output/{projectId}/{runIndex}-{ts}/quarantine/ 의 parquet 파일에 저장,
-- 이 테이블은 group summary (rule, severity, row_count, 첫 N row sample) 만 보관.

CREATE TABLE quarantine_entries (
    id                   VARCHAR(40)  PRIMARY KEY,                              -- "q-" + UUID8
    run_id               VARCHAR(40)  NOT NULL REFERENCES run_history(id) ON DELETE CASCADE,
    stage_instance_id    VARCHAR(40)  NOT NULL REFERENCES stage_instances(id) ON DELETE CASCADE,
    binding_id           VARCHAR(40)  NOT NULL REFERENCES mapping_table_bindings(id) ON DELETE RESTRICT,
    rule_id              VARCHAR(40),                                            -- mapping_rules(id) 또는 builtin rule (NULL 가능)
    rule_name            VARCHAR(128) NOT NULL,                                  -- 비정규화 (rule 이 rename/삭제되어도 historic readable)
    severity             VARCHAR(16)  NOT NULL DEFAULT 'error',                  -- error / warning
    sample_data          JSONB,                                                  -- 첫 5 row sample
    row_count            BIGINT       NOT NULL DEFAULT 0,                        -- rule 위반 총 row 수
    log_line_seq         BIGINT,                                                 -- Log viewer 의 해당 line seq (jump 용)
    created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_quarantine_severity
        CHECK (severity IN ('error','warning'))
);

CREATE INDEX idx_quarantine_run_stage ON quarantine_entries (run_id, stage_instance_id);
CREATE INDEX idx_quarantine_run_rule  ON quarantine_entries (run_id, rule_id);
CREATE INDEX idx_quarantine_binding   ON quarantine_entries (binding_id);
