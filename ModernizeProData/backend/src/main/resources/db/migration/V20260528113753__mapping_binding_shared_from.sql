-- mapping_table_bindings.shared_from_project_id
--
-- 같은 site 의 다른 project 가 master 인 mapping 을 inherit 하는 자식 binding 의 마킹.
-- null = 자체 정의 (default, 기존 동작).
-- 값 있음 = 자식. 그 project_id 의 같은 (tobe_schema, tobe_table) 의 binding sources +
--           mapping_rules 를 read 시점에 inherit. row editor 는 read-only.

ALTER TABLE mapping_table_bindings
    ADD COLUMN shared_from_project_id VARCHAR(40)
        REFERENCES projects(id) ON DELETE SET NULL;

CREATE INDEX idx_mapping_table_bindings_shared_from
    ON mapping_table_bindings(shared_from_project_id)
    WHERE shared_from_project_id IS NOT NULL;
