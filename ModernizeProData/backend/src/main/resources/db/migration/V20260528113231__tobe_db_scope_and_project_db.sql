-- TO-BE DB 연결 범위 토글 + Project 의 자기 TO-BE DB 컬럼.
--
-- scope='site' (기본, 기존 동작) → 모든 Project 가 Site.tobe_db_by_env 공유.
-- scope='project'                → 각 Project 의 tobe_db_by_env 사용 (Site 값은 dormant).
--
-- site→project 전환 시 Site 값을 그 Site 의 모든 Project 로 복사하는 로직은
-- backend (SiteController PATCH) 에서 처리. 본 마이그레이션은 스키마 변경만 담당.

ALTER TABLE sites
    ADD COLUMN tobe_db_scope VARCHAR(16) NOT NULL DEFAULT 'site';

ALTER TABLE projects
    ADD COLUMN tobe_db_by_env JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE projects
    ADD COLUMN tobe_db_locks JSONB NOT NULL DEFAULT '{}'::jsonb;
