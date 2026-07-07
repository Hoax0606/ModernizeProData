-- mapping_imports 에 code mapping 파일명 컬럼 추가 + 부분 임포트 지원.
-- 부분 임포트: column 만 / code 만 업로드 시 해당 슬롯만 덮어쓰기 위해
-- filename 을 nullable 로 변경.
ALTER TABLE mapping_imports
    ADD COLUMN code_filename VARCHAR(256);
ALTER TABLE mapping_imports
    ALTER COLUMN filename DROP NOT NULL;
