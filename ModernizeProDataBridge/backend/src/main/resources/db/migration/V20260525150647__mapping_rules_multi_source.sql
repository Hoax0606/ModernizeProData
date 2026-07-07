-- mapping_rules.asis_column / asis_type 다중 source 대응.
--
-- 한 TO-BE 컬럼이 여러 AS-IS 컬럼의 조합으로 만들어지는 케이스
-- (예: BIRTH_YEAR/MONTH/DAY 3 컬럼 → birth_date DATE 1 컬럼) 를 위해
-- asis_column / asis_type 셀에 ';' 구분자로 여러 source 컬럼을 저장한다.
--
--   예) asis_column = 'BIRTH_YEAR;BIRTH_MONTH;BIRTH_DAY'
--       asis_type   = 'NUMBER(4);NUMBER(2);NUMBER(2)'
--
-- 단일 source 인 경우 ';' 없이 그대로 저장 — 기존 데이터 호환.
--
-- 길이 확장 이유: 단일 컬럼명은 보통 30 자 이내라 VARCHAR(128) 로 충분했지만,
-- 다중 source 묶음은 컬럼명 × N + 구분자 합산이라 여유 필요.
-- VARCHAR(512) = 평균 30 자 컬럼 × 약 16 개까지 안전.
-- asis_type 도 NUMBER(p,s)/VARCHAR2(n CHAR) 같이 한 항목이 길어 256 자로.

ALTER TABLE mapping_rules
    ALTER COLUMN asis_column TYPE VARCHAR(512),
    ALTER COLUMN asis_type   TYPE VARCHAR(256);
