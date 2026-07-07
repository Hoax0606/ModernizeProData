-- run_history.status CHECK constraint 에 'paused' 추가.
-- 누락 원인: V20260522210002__run_history.sql 작성 후 RunStatus enum 에 paused 가 추가됐으나
-- CHECK constraint 의 IN (...) 리스트는 갱신되지 않음. pauseRun 호출 시 constraint violation 발생.
--
-- 증상: pause 버튼 클릭 → 'ERROR: 새 행이 run_history_status_check 검사 제약을 위반' → 500
-- 그러나 SnapshotExecutionContextService 가 finishRun hook 으로 abort 처리 시도 → state 어중간.
--
-- 잠재 누락 commit: 44fa3eb (feat(execution): run control — threadpool, stage gate,
-- timeout, pause/resume). RunStatus.paused enum 추가 시점에 같이 들어왔어야 함.

ALTER TABLE run_history DROP CONSTRAINT run_history_status_check;
ALTER TABLE run_history
    ADD CONSTRAINT run_history_status_check
    CHECK (status IN ('pending','running','paused','success','failed','aborted','timed_out'));
