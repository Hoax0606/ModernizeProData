-- mapping_rules.asis_column / asis_type 을 PG 배열 (TEXT[]) 로 전환.
--
-- 직전 마이그레이션 (V20260525150647) 에서 길이만 늘려 ';' 구분자 문자열로
-- multi-source 를 표현하던 것을 PG 네이티브 배열로 정규화. 이유:
--   - JPA 사용 시점에서 split 안 해도 List<String> 그대로 받음
--   - DB 검색 시 'BIRTH_YEAR' = ANY(asis_column) 같이 정확 매칭
--   - 길이 / 순서 정합성을 DB 가 보장
--
-- 데이터 마이그레이션: 기존 ';' 묶음 값을 string_to_array() 로 배열 변환.
-- NULL / 빈 문자열은 NULL 유지.

ALTER TABLE mapping_rules
    ALTER COLUMN asis_column TYPE TEXT[] USING (
        CASE
            WHEN asis_column IS NULL OR asis_column = '' THEN NULL
            ELSE string_to_array(asis_column, ';')
        END
    ),
    ALTER COLUMN asis_type TYPE TEXT[] USING (
        CASE
            WHEN asis_type IS NULL OR asis_type = '' THEN NULL
            ELSE string_to_array(asis_type, ';')
        END
    );
