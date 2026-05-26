-- snapshot 생성 시점에 "이전 버전 대비 변경사항" 을 박제 저장한다.
--
-- 비교 기준 결정 규칙 (SnapshotController.create 에서):
--   1) 같은 프로젝트의 baseline snapshot 이 있으면 그것
--   2) 없으면 시간순 직전 snapshot (본인 제외)
--   3) 그것도 없으면 첫 snapshot — previous_version_id = NULL, items 의 모든 항목 = "added"
--
-- changes JSONB schema (SnapshotChanges record):
--   {
--     "previousVersionId": "ss-...|null",
--     "previousVersion":   "v1.2|null",
--     "summary":           {"added": N, "modified": N, "removed": N},
--     "items": [
--       {"kind": "added|modified|removed",
--        "category": "rule|binding|codeMap",
--        "key": "schema.table.column",
--        "detail": "...short summary..."}
--     ]
--   }
--
-- NOTE: previous_version_id 와 changes 컬럼은 옛 마이그레이션에서 이미 추가되어 있음.
--       이 마이그레이션은 idempotent 하게 (a) FK 가 없으면 추가 (b) 새 인덱스 추가 만 수행.

-- (a) previous_version_id 의 FK constraint 가 없으면 추가.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM   information_schema.table_constraints tc
        WHERE  tc.table_name      = 'snapshots'
        AND    tc.constraint_type = 'FOREIGN KEY'
        AND    tc.constraint_name = 'snapshots_previous_version_id_fkey'
    ) THEN
        ALTER TABLE snapshots
            ADD CONSTRAINT snapshots_previous_version_id_fkey
            FOREIGN KEY (previous_version_id)
            REFERENCES snapshots(id) ON DELETE SET NULL;
    END IF;
END$$;

-- (b) previous_version_id 조회용 인덱스 (NULL 제외).
CREATE INDEX IF NOT EXISTS idx_snapshots_previous_version_id
    ON snapshots (previous_version_id)
    WHERE previous_version_id IS NOT NULL;
