-- mapping_rules 에 AS-IS 원본 타입 저장.
-- Report 실행 시 read_csv(types=...) 에 넘겨서 DuckDB 자동 추론 오버라이드.
-- 예: ADDR_ZIP (VARCHAR2(7)) 값이 전부 숫자라 자동 추론은 BIGINT 가 되지만
-- 의도는 VARCHAR 라 SUBSTR 같은 string 함수가 작동해야 함.
ALTER TABLE mapping_rules
    ADD COLUMN asis_type VARCHAR(64);
