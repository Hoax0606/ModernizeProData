-- Pause 기능 영구 제거 후 (2026-05-29 commit 5fd9a1d) DB 잔재 row 의 status 정리.
--
-- 증상: BE 가 `RunStatus.paused` enum value 를 제거했는데 옛 Pause 테스트 시 생성된
-- run_history row 가 여전히 status='paused' 보유. UI 의 `GET /api/v1/projects/{id}/runs`
-- (RunController.listByProject) 가 그 row 매핑 시 Hibernate enum mapping 실패 → 500 error.
--
-- 'paused' → 'aborted' 로 마이그레이션. 의미상 가장 가까움 (사용자 의도적 중단, 미완료).
-- audit trail 보존 위해 error_message 에 마이그레이션 이력 남김.

UPDATE run_history
   SET status = 'aborted',
       error_message = COALESCE(error_message, '')
                       || ' [auto-migrated from paused; pause feature removed 2026-05-29]'
 WHERE status = 'paused';

-- CHECK constraint 도 정리해서 미래 동일 사고 방지.
-- V20260529150306__run_history_status_allow_paused 가 'paused' 를 추가했었음. 그 constraint
-- 이름이 환경마다 다를 수 있어 동적 lookup.
DO $$
DECLARE
    cname text;
BEGIN
    SELECT conname INTO cname
      FROM pg_constraint
     WHERE conrelid = 'run_history'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%paused%'
     LIMIT 1;
    IF cname IS NOT NULL THEN
        EXECUTE format('ALTER TABLE run_history DROP CONSTRAINT %I', cname);
        ALTER TABLE run_history ADD CONSTRAINT chk_run_history_status
            CHECK (status IN ('pending', 'running', 'success', 'failed', 'aborted', 'timed_out'));
    END IF;
END $$;
