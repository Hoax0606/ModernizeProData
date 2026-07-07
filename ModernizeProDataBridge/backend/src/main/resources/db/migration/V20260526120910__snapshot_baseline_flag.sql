-- snapshot 에 "고정핀(baseline)" 표식.
-- 프로젝트 당 단일 baseline 만 유지. 다른 snapshot 을 baseline 으로 지정하면
-- 컨트롤러가 단일 트랜잭션 안에서 기존 row 의 is_baseline 을 false 로 내리고
-- 새 row 를 true 로 올린다.
ALTER TABLE snapshots
    ADD COLUMN is_baseline BOOLEAN NOT NULL DEFAULT FALSE;

-- partial unique index — same project_id 의 is_baseline=true 가 둘이 되는 것을 DB 가 거부.
CREATE UNIQUE INDEX uq_snapshot_baseline_per_project
    ON snapshots (project_id)
    WHERE is_baseline = TRUE;
