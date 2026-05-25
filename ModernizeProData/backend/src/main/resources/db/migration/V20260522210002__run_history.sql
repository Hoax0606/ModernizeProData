-- feature/schedule: Run service 의 실행 이력.
--
-- projects.run_status (3 값: idle/running/completed) 는 UI 표시용 "현재 상태",
-- run_history 는 監査 / 분석 用 전체 이력 (6 값 status, 모든 발화 기록).
--
-- trigger_source 의 값:
--   internal  — Quartz Nightly 발화 (solution_settings.internal_enabled=true 時)
--   external  — 외부 스케줄러로부터 REST POST /api/v1/runs (api_token 인증)
--   cli       — modernize-cli 바이너리에서 호출
--   manual    — UI 의 Run 버튼

CREATE TABLE run_history (
    id                      VARCHAR(40)  PRIMARY KEY,                              -- "r-" + UUID8
    project_id              VARCHAR(40)  NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    run_type                VARCHAR(16)  NOT NULL
                            CHECK (run_type IN ('test', 'rehearsal', 'cutover')),
    trigger_source          VARCHAR(16)  NOT NULL
                            CHECK (trigger_source IN ('internal', 'external', 'cli', 'manual')),
    requested_by            VARCHAR(64)  NOT NULL,                                 -- user id or 'Quartz nightly' 等
    credential_id           VARCHAR(40),                                           -- 案 A 는 NULL or 'default', 案 C 退路
    worker_id               VARCHAR(40),                                           -- 발화 시점 project 의 execution_assignee
    status                  VARCHAR(16)  NOT NULL
                            CHECK (status IN ('pending','running','success','failed','aborted','timed_out')),
    started_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    finished_at             TIMESTAMPTZ,
    duration_ms             BIGINT,                                                 -- 集計 AVG 高速化 用 冗長 컬럼
    snapshot_id             VARCHAR(40),
    batch_job_execution_id  BIGINT,                                                 -- Spring Batch JOB_EXECUTION_ID
    error_message           TEXT,
    metadata                JSONB        NOT NULL DEFAULT '{}'
);

CREATE INDEX idx_run_history_project_started ON run_history (project_id, started_at DESC);
CREATE INDEX idx_run_history_status_started  ON run_history (status, started_at DESC);
