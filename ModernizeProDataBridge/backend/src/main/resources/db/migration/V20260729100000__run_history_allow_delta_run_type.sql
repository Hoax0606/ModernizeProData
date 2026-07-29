-- run_history.run_type CHECK 제약에 'delta' 추가 (CDC 증분 catch-up 실행 모드).
-- 인라인 CHECK 라 PG 가 run_history_run_type_check 로 자동 명명 — drop 후 재정의.
-- (선례: V20260529150306__run_history_status_allow_paused.sql 의 status CHECK 재정의 패턴)

ALTER TABLE run_history DROP CONSTRAINT run_history_run_type_check;
ALTER TABLE run_history
    ADD CONSTRAINT run_history_run_type_check
    CHECK (run_type IN ('test', 'rehearsal', 'cutover', 'delta'));
