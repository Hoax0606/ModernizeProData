-- feature/schedule: V4__sites_projects.sql 에서 도입된 projects.cutover (JSONB) 컬럼을 완전 삭제.
--
-- 향후 cutover 기능을 재도입할 가능성은 있지만, 그때는 별도 design (per-environment cutover
-- 단계, 승인 워크플로우 등) 으로 다시 설계할 예정.

ALTER TABLE projects DROP COLUMN cutover;
