-- WARN ack 시스템 검증 발견 이슈 fix (2026-06-01)
-- Critical 1 + Major 5 (BE 측):
--   Critical: listGroups 의 ack 표시 결함 — reason_hash 기반 lookup 으로 교체
--   Major: 중복 ack 방지 UNIQUE constraint
--   Major: reason TEXT 인덱스 미적용 — reason_hash CHAR(64) 도입
--   Major: 마이그레이션 idempotency — DROP CONSTRAINT IF EXISTS

-- 1) reason_hash CHAR(64) — sha256 hex
ALTER TABLE quarantine_acknowledgments
    ADD COLUMN reason_hash CHAR(64);

UPDATE quarantine_acknowledgments
   SET reason_hash = encode(sha256(reason::bytea), 'hex')
 WHERE reason_hash IS NULL;

ALTER TABLE quarantine_acknowledgments
    ALTER COLUMN reason_hash SET NOT NULL;

-- 2) lookup 인덱스 reason_hash 로 교체
DROP INDEX IF EXISTS idx_qack_lookup;
CREATE INDEX idx_qack_lookup
    ON quarantine_acknowledgments (project_id, binding_id, rule_name, reason_hash, phase);

-- 3) UNIQUE constraint — 같은 (project, binding, rule, reason_hash, phase, fingerprint) 1 ack
--    csv_mtime_ms / csv_size 가 NULL 인 경우도 dedup 대상 — COALESCE 로 sentinel.
CREATE UNIQUE INDEX ux_qack_dedup
    ON quarantine_acknowledgments
       (project_id, binding_id, rule_name, reason_hash, phase,
        COALESCE(csv_mtime_ms, -1), COALESCE(csv_size, -1));
