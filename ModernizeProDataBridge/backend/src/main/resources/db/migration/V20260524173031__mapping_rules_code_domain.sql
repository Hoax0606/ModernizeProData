-- mapping_rules 에 code_domain 컬럼 추가.
-- column_mapping CSV 의 'code_domain' 값을 받아서, 임포트 시 backend 가
-- 이 domain 의 code_maps 를 lookup → 자동 CASE 표현식 생성 → transform_sql 채움.
-- domain (값 그룹) 은 여러 컬럼에서 공유 가능 (YN_BOOL → is_deleted, mfa_enabled 등).
ALTER TABLE mapping_rules
    ADD COLUMN code_domain VARCHAR(64);
