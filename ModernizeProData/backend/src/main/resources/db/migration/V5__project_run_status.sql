-- Project 실행 상태 (test/rehearsal/cutover 단계의 sub-status).
ALTER TABLE projects ADD COLUMN run_status VARCHAR(16);
