-- Per-table compiled SQL — TransformStage 가 buildTransformSql() 결과 (CREATE OR REPLACE TABLE
-- schema.tobe_xxx AS SELECT ...) 를 그대로 텍스트로 보존.
--
-- ArtifactsPage > MIGRATION SQL 카테고리가 latest run 의 성공 테이블만 골라 이 텍스트를
-- VSCode-style SQL view 로 표시한다. (run-time 동적 생성이라 이 컬럼이 없으면 어디에도
-- SQL 텍스트가 남지 않는다.)
--
-- 마이그레이션 이전에 실행된 run 의 stage_table_results 행에서는 NULL 인 채로 남는다.
ALTER TABLE stage_table_results
    ADD COLUMN compiled_sql TEXT;
