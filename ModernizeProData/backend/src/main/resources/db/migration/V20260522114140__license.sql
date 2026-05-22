-- 라이선스 테이블. .lic 파일을 import 하면 검증된 페이로드 + 원본 JWS 본문을 보관.
-- Coordinator 1대 = 1 row 가정 — singleton 처럼 사용 (가장 최근 import 가 활성 라이선스).

CREATE TABLE license (
    id              VARCHAR(40)  PRIMARY KEY,
    license_id      VARCHAR(128) NOT NULL,           -- .lic 의 payload.licenseId
    customer        VARCHAR(256) NOT NULL,
    site_id         VARCHAR(128) NOT NULL,           -- 본사가 지정한 사이트 ID (slug)
    edition         VARCHAR(32)  NOT NULL,           -- standard / pro / enterprise
    features        JSONB        NOT NULL DEFAULT '[]'::jsonb,
    issued_at       DATE         NOT NULL,
    expires_at      DATE         NOT NULL,
    grace_days      INT          NOT NULL DEFAULT 14,
    public_key_fp   VARCHAR(64)  NOT NULL,
    raw_jws         TEXT         NOT NULL,           -- .lic 파일 원본 (재검증/감사용)
    last_seen_at    TIMESTAMPTZ,                     -- 시계 조작 방지용 — 매 요청 시 갱신
    imported_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    imported_by     VARCHAR(64)  NOT NULL
);

CREATE INDEX idx_license_imported_at ON license (imported_at DESC);
