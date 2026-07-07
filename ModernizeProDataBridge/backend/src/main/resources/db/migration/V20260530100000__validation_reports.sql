-- Validation report — Verify 직후 post-processing 으로 계산된 per-binding aggregate 결과.
--
-- Verify 는 row_count + PK lockstep 비교 (정합성). Validation report 는 그 외 통계 (Sum
-- reconciliation / NULL parity / Min-Max parity / Checksum / Row count) 의 ASIS↔TOBE 비교
-- 결과를 박제한다. 일본 금융권 이행은 잔액·거래액 SUM 일치가 감사 법적 요건이라 별도 기록 필수.
--
-- Verify 와 분리한 이유:
--   - Verify fail 은 quarantine 발생 + run status=failed (블로커).
--   - Validation report fail (예: Sum delta 0%) 은 정보성 — run status 비영향.
--   - 분리하면 audit trail 가독성 + 사용자 view 깔끔.
--
-- Stage 가 아닌 post-processing 컴포넌트 — stage_instances CHECK constraint (7 stage 限定)
-- 영향 없음, RunExecutionListener 에서 workerExecutor.execute 후에 호출.

CREATE TABLE validation_reports (
    id                   VARCHAR(40)  PRIMARY KEY,                              -- "vr-" + UUID8
    run_id               VARCHAR(40)  NOT NULL REFERENCES run_history(id) ON DELETE CASCADE,
    binding_id           VARCHAR(40)  NOT NULL REFERENCES mapping_table_bindings(id) ON DELETE CASCADE,
    tobe_schema          VARCHAR(128) NOT NULL DEFAULT '',
    tobe_table           VARCHAR(128) NOT NULL,
    generated_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    /* 전체 요약 (Overview 시트의 Total 표시용) */
    total_checks         INT          NOT NULL DEFAULT 0,
    passed_checks        INT          NOT NULL DEFAULT 0,
    /* 시트별 raw 데이터 — FE Cell[][] 변환 친화 shape.
       JSON keys: overview / sumRecon / nullParity / minMax / typeValid / rowCount / checksum */
    report_data          JSONB        NOT NULL,
    /* 계산 자체 실패 (DB 접속 / aggregate SQL 오류) 시 사유 — 정상이면 null. */
    error_summary        TEXT,

    CONSTRAINT uq_validation_reports_run_binding
        UNIQUE (run_id, binding_id)
);
CREATE INDEX idx_validation_reports_run ON validation_reports (run_id);
CREATE INDEX idx_validation_reports_binding ON validation_reports (binding_id);
