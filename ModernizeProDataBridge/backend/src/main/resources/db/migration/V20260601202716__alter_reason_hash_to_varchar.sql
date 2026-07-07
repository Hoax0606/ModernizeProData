-- V20260601195058 에서 reason_hash 를 CHAR(64) 로 만들었으나 JPA Entity 의 디폴트
-- 매핑은 VARCHAR(64) (length=64). Hibernate schema-validation (ddl-auto=validate) 가
-- bpchar vs varchar 충돌로 부팅 실패. ALTER COLUMN TYPE 으로 일치시킴.
--
-- sha256 hex 는 항상 정확히 64 char 라 CHAR(64) ↔ VARCHAR(64) 데이터 의미 동등.

ALTER TABLE quarantine_acknowledgments
    ALTER COLUMN reason_hash TYPE VARCHAR(64);
