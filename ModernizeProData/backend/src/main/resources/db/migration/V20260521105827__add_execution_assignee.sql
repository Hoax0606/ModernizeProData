-- Project 에 execution_assignee 컬럼 추가.
-- assignee 와 의미 분리:
--   * assignee           = 개발/매핑 담당 (Site overview 에서 지정)
--   * execution_assignee = 실행 담당 (Execution overview 에서 지정)
-- 두 컬럼 모두 nullable — 미배정 가능.
ALTER TABLE projects ADD COLUMN execution_assignee VARCHAR(64);
