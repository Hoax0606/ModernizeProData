-- Re-review 기능 도입 (2026-06-02)
-- 같은 (project, binding, rule, reason, phase, fingerprint) 의 다중 ack 허용 —
-- 운영자가 "다시 검토함" 으로 기록 누적. 가장 최근 ack 가 carry-over 매칭 기준
-- (findLatestCarryOver 의 ORDER BY acknowledged_at DESC LIMIT 1).
--
-- 이전 V20260601195058 가 만든 UNIQUE INDEX 제거. 일반 lookup index 는 유지.

DROP INDEX IF EXISTS ux_qack_dedup;
