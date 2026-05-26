-- snapshot 생성 시점에 mapping working set (rules + codeMaps + bindings) 을
-- 한 JSON 객체로 동결 보관하는 컬럼.
--
-- 정책 (2026-05-26 결정):
--   - snapshot row 1개 = freeze 1세트. 자식 테이블 없음 (정규화 폐기, JSONB 단일 컬럼).
--   - 이후 live mapping_* 가 변해도 snapshot.snapshot_data 는 절대 안 변한다 (immutable).
--   - code_map_count 컬럼도 같이 추가 — table_count / rule_count 와 동일하게 freeze 카운트 보존.

ALTER TABLE snapshots
    ADD COLUMN code_map_count INT NOT NULL DEFAULT 0;

ALTER TABLE snapshots
    ADD COLUMN snapshot_data JSONB;

CREATE INDEX idx_snapshots_data_gin
    ON snapshots USING GIN (snapshot_data);
