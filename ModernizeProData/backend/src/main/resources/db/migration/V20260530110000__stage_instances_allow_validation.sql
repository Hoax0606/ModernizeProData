-- Validation stage 를 8 번째 정식 stage 로 승격 (2026-05-30).
--
-- 원래 7-stage 모델 (check/extract/reconcile/transform/audit/load/verify) 의 CHECK constraint
-- 에 'validation' 을 추가. ValidationReportService 가 post-processing 컴포넌트였다가
-- StageRunner 로 전환되면서 stage_instances row 가 생성되어야 함.
--
-- 의도된 동작:
--   - validation 은 Verify 다음 (8 번째) 에 실행.
--   - validation stage 실패 (errorSummary 가짐) 는 run status 에 영향 X — LocalWorkerExecutor 에서
--     non-blocking 화이트리스트로 처리. 사용자가 정한 "정보성 stage" 정책 (2026-05-30).
--   - 옛 run (이 migration 적용 전) 은 stage_instances row 가 7 개. FE pipeline 은 누락 stage 를
--     idle/회색으로 표시.

ALTER TABLE stage_instances
    DROP CONSTRAINT IF EXISTS chk_stage_instances_stage_key;

ALTER TABLE stage_instances
    ADD CONSTRAINT chk_stage_instances_stage_key
        CHECK (stage_key IN ('check','extract','reconcile','transform','audit','load','verify','validation'));
