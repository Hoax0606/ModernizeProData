-- TO-BE DDL 인포트된 테이블 수. AS-IS 측은 기존 table_count 컬럼을 그대로 사용.
ALTER TABLE projects ADD COLUMN tobe_table_count INT NOT NULL DEFAULT 0;
