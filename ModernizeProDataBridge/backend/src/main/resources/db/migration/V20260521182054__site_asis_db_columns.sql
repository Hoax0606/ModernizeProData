-- AS-IS DB 메타정보 — 도구는 외부 DB 에 직접 접속 안 함 (CSV 만 수신) 이지만
-- "어떤 DB 에서 나온 CSV 인가" 가 매핑/이행 의사결정에 필요.
-- type/version 정보만, host/credential 은 일절 저장 안 함.
ALTER TABLE sites
    ADD COLUMN asis_db_type    VARCHAR(64),
    ADD COLUMN asis_db_version VARCHAR(64);
-- 기존 notes 컬럼은 보존 (UI 에서만 입력란 제거).
