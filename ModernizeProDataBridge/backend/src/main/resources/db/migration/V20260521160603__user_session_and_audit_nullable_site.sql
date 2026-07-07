-- 동시 접속 차단 (first-wins) 지원.
-- users 에 현재 활성 세션 추적 컬럼 추가. JWT 의 `sid` claim 과 비교하여 토큰 유효성 검증.
-- audit_log.site_id 는 LOGIN / LOGOUT / LOGIN_REJECTED 같은 site 무관 이벤트를 위해 nullable.

ALTER TABLE users
    ADD COLUMN current_session_id         VARCHAR(40),
    ADD COLUMN current_session_issued_at  TIMESTAMPTZ,
    ADD COLUMN current_session_expires_at TIMESTAMPTZ;

ALTER TABLE audit_log ALTER COLUMN site_id DROP NOT NULL;
