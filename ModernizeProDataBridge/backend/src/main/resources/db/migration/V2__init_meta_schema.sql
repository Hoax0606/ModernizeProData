-- ModernizeProData 메타 스키마 baseline.
-- 현재 JPA Entity 가 없는 상태이므로 placeholder.
-- 앞으로 sites / projects / users / mappings / snapshots / approvals
-- / worker_nodes / audit_log 가 추가될 때마다 V3, V4 ... 로 누적.

-- 이 파일은 Flyway 가 history 테이블 (flyway_schema_history) 을 만들도록
-- 트리거 하기 위한 의도적인 placeholder. 실제 변경은 다음 V_*.sql 부터.

DO $$ BEGIN
    RAISE NOTICE 'ModernizeProData meta schema baseline (V2) applied.';
END $$;
