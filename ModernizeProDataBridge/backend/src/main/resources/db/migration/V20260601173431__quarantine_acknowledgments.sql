-- WARN ack 시스템 (2026-06-01)
-- 운영자가 명시적으로 "이 WARN 검토 + 진행 OK" 표시한 기록.
-- 정책 결정 (9가지):
--   1. WARN 만 있어도 차단 (failed_with_pending_warnings) — Request Review / Approve / Cutover 게이트
--   2. Ack scope: per-stageLabel (rule_name + binding_id + reason)
--   3-6. Fingerprint 조건부 carry-over (csv_mtime_ms + csv_size 일치 시)
--   7. Phase 전이: Test → Rehearsal 차단 / Rehearsal → Cutover carry-over
--   8. Cutover 분류 quick review (rehearsal default 채택 + 동의)
--   9. 자동 화이트리스트 도입 X (모든 WARN 수동 ack)

CREATE TABLE quarantine_acknowledgments (
    id                   BIGSERIAL    PRIMARY KEY,
    project_id           VARCHAR(40)  NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    binding_id           VARCHAR(40)  NOT NULL REFERENCES mapping_table_bindings(id) ON DELETE CASCADE,
    rule_name            VARCHAR(128) NOT NULL,
    reason               TEXT         NOT NULL,
    csv_mtime_ms         BIGINT,
    csv_size             BIGINT,
    phase                VARCHAR(20)  NOT NULL,
    acknowledged_by      VARCHAR(50)  NOT NULL,
    acknowledged_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    note                 TEXT,

    CONSTRAINT chk_qack_phase
        CHECK (phase IN ('test','rehearsal','cutover'))
);

-- carry-over 조회 인덱스 (project + binding + rule + phase 매칭)
CREATE INDEX idx_qack_lookup
    ON quarantine_acknowledgments (project_id, binding_id, rule_name, phase);

-- Stage status enum 확장 — failed_with_pending_warnings 추가
-- 위험 1 대응: 기존 failed 유지 + 새 상태. FE 가 amber 색상 표시.
ALTER TABLE stage_instances
    DROP CONSTRAINT chk_stage_instances_status;
ALTER TABLE stage_instances
    ADD CONSTRAINT chk_stage_instances_status
        CHECK (status IN ('pending','running','success','failed','failed_with_pending_warnings'));

ALTER TABLE stage_table_results
    DROP CONSTRAINT chk_stage_table_results_status;
ALTER TABLE stage_table_results
    ADD CONSTRAINT chk_stage_table_results_status
        CHECK (status IN ('running','success','failed','failed_with_pending_warnings'));
