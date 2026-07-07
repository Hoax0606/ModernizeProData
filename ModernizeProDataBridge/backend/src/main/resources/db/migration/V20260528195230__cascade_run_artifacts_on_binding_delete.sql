-- run 한 번 돌면 stage_table_results / quarantine_entries 가 mapping_table_bindings 를
-- ON DELETE RESTRICT 로 잠그던 문제를 CASCADE 로 전환.
--
-- 증상: 첫 run 이후 DDL 삭제 / 프로젝트 삭제가 FK 위반으로 실패. project 삭제 cascade →
-- mapping_table_bindings 삭제 시도 → 위 두 테이블의 RESTRICT FK 가 막아 트랜잭션 통째로 롤백.
--
-- 이력 정합성 영향: 없음 — binding 이 사라지면 그 binding 의 stage_table_results /
-- quarantine_entries 는 orphan 이라 의미 없다. project 자체가 사라지면 run_history 도
-- cascade 로 사라지고 그 하위(stage_instances 등) 도 같이 정리되는 게 자연스러운 동작.

ALTER TABLE stage_table_results
    DROP CONSTRAINT stage_table_results_binding_id_fkey;
ALTER TABLE stage_table_results
    ADD CONSTRAINT stage_table_results_binding_id_fkey
    FOREIGN KEY (binding_id) REFERENCES mapping_table_bindings(id) ON DELETE CASCADE;

ALTER TABLE quarantine_entries
    DROP CONSTRAINT quarantine_entries_binding_id_fkey;
ALTER TABLE quarantine_entries
    ADD CONSTRAINT quarantine_entries_binding_id_fkey
    FOREIGN KEY (binding_id) REFERENCES mapping_table_bindings(id) ON DELETE CASCADE;
