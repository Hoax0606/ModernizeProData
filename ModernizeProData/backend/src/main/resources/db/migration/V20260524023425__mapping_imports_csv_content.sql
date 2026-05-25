-- 임포트한 CSV 의 원본 텍스트를 mapping_imports 에 보관 → "Apply" 만 눌러도
-- 마지막 임포트 내용으로 룰을 재적용할 수 있게 (사용자 수동 수정 reset).
-- 50MB cap 은 컨트롤러에서 검증하므로 TEXT 그대로.
ALTER TABLE mapping_imports
    ADD COLUMN column_csv_content TEXT;
ALTER TABLE mapping_imports
    ADD COLUMN code_csv_content TEXT;
