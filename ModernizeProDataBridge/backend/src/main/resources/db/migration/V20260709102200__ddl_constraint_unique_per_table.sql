-- 파티션 테이블 대응 — DDL 제약/인덱스 유니크 키를 "테이블별"로 정정.
--
-- 문제: ddl_constraints / ddl_indexes 의 유니크가 (project_id, side, name) 였다.
-- 그런데 제약(및 일부 인덱스) 이름은 PostgreSQL 에서 "테이블별"로만 유니크하다.
-- PARTITION BY ... 로 파티션된 테이블은 부모와 각 파티션 자식이 같은 이름의
-- CHECK/PK/FK/UK 제약을 상속한다 (예: BSM.transactions 연도 RANGE 파티션 →
-- transactions_channel_check 가 부모+4파티션에 각각 존재). pg_catalog 추출 시
-- 같은 이름이 여러 table_id 로 나타나 (project_id, side, name) 유니크를 위반한다
-- → TO-BE DDL 임포트가 "내부 오류(23505 duplicate key)" 로 실패.
--
-- 해결: table_id 를 유니크에 포함 (테이블별 유니크). 키가 더 넓어질(permissive) 뿐이라
-- 기존 데이터 위반은 없다.

ALTER TABLE ddl_constraints DROP CONSTRAINT IF EXISTS uq_ddl_constraints_project_side_name;
ALTER TABLE ddl_constraints ADD  CONSTRAINT uq_ddl_constraints_project_side_table_name
    UNIQUE (project_id, side, table_id, name);

ALTER TABLE ddl_indexes DROP CONSTRAINT IF EXISTS uq_ddl_indexes_project_side_name;
ALTER TABLE ddl_indexes ADD  CONSTRAINT uq_ddl_indexes_project_side_table_name
    UNIQUE (project_id, side, table_id, name);
