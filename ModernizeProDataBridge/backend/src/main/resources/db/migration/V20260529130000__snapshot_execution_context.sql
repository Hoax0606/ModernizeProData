-- Snapshot 에 박제되는 run 실행 컨텍스트 (run 종료 시점에 freeze).
-- run_history.snapshot_id 가 있는 run 이 terminal (success/failed/aborted/timed_out) 상태가 되면
-- RunService.finishRun 이 그 snapshot 의 execution_context 를 갱신한다.
--
-- 박제 내용 (JSONB shape):
--   { runId, runType, status, startedAt, finishedAt, durationMs,
--     stages: [{ stageKey, seq, status, pct, tablesTotal, tablesSuccess, tablesFailed,
--                startedAt, finishedAt, durationMs, errorSummary,
--                tables: [{ bindingId, tobeSchema, tobeTable, status, rowCount, errorCount,
--                           errorDetail, startedAt, finishedAt, durationMs, compiledSql }] }] }
--
-- ArtifactsPage / ExecutionPage / LogViewer 가 snapshot view 모드일 때 이 컨텍스트를
-- live run 대신 사용해 "그 snapshot 시점" 의 상태로 시간 여행 표시.
--
-- 같은 snapshot 으로 여러 번 run 하면 매 run 종료 시 덮어쓴다 (사용자 결정).
-- 옛 snapshot (이 컬럼 추가 전 / run 자체가 없었던 snapshot) 은 NULL.
ALTER TABLE snapshots
    ADD COLUMN execution_context JSONB;
