-- 스냅샷에 version 필드 추가 (v1.0, v1.1, v1.2... 형태로 자동 증가)
ALTER TABLE snapshots 
ADD COLUMN version VARCHAR(16) NOT NULL DEFAULT 'v1.0';

CREATE INDEX idx_snapshots_project_version ON snapshots(project_id, version);