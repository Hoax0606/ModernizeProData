-- stage status 컬럼 폭 확장 (VARCHAR(16) → VARCHAR(40)).
--
-- 배경: WARN 승인 시스템(V20260601173431)이 새 상태값 'failed_with_pending_warnings'(28자)를
--       CHECK 제약에는 추가했지만 컬럼 폭(VARCHAR(16))은 그대로 둠.
--       → Validation stage 가 WARN-only 결과를 적재할 때
--         "ERROR: value too long for type character varying(16)" 로 INSERT 실패.
-- 수정: 두 status 컬럼을 VARCHAR(40)으로 확장 (엔티티 @Column(length=40)와 일치).
--       기존 CHECK 제약(chk_*_status)은 컬럼 길이와 무관하므로 그대로 유지됨.

ALTER TABLE stage_instances     ALTER COLUMN status TYPE VARCHAR(40);
ALTER TABLE stage_table_results ALTER COLUMN status TYPE VARCHAR(40);
