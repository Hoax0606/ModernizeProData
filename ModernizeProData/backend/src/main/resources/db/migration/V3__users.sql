-- 사용자 계정 테이블.
-- master 시드는 CommandLineRunner (UserBootstrap) 가 BCryptPasswordEncoder 로 첫 부팅 시 생성.

CREATE TABLE users (
    id              VARCHAR(40)  PRIMARY KEY,
    username        VARCHAR(64)  NOT NULL UNIQUE,
    password_hash   VARCHAR(255) NOT NULL,
    role            VARCHAR(16)  NOT NULL CHECK (role IN ('master', 'admin', 'viewer')),
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    last_signin_at  TIMESTAMPTZ
);

CREATE INDEX idx_users_username ON users(username);
CREATE INDEX idx_users_role     ON users(role);
