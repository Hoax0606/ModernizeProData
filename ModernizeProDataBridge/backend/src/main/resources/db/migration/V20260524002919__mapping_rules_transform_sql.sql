-- 복잡한 변환식을 SQL 문 형태로 별도 저장하는 컬럼 추가.
-- 기존 transform_rule 은 짧은 SQL 식 (예: c.CUST_ID, NULLIF(c.X, '')).
-- transform_sql 은 멀티라인 / 서브쿼리 / CTE 포함한 풀 SQL 단편을 위함.
-- 둘 다 nullable — 룰의 형태에 맞게 한쪽 또는 양쪽 사용.
ALTER TABLE mapping_rules
    ADD COLUMN transform_sql TEXT;
