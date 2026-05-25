-- Run log — Spring Batch / 이행 실행이 찍는 운영 로그.
-- 한 cutover run = 최대 12억 라인이 가능하므로, raw 전체를 PG 에 다 넣지 않는다.
-- PG = 인덱스/핫 검색 스토어 (WARN/ERROR + sampled INFO 1%).
-- Parquet 디렉터리 (coordinator.data.dir/logs/{runId}/) 가 진짜 저장소이지만,
-- 본 마이그레이션에서는 PG 측 스키마만 만든다.

-- 1) 메타: 한 run = 한 줄. 카운터·경로·상태.
CREATE TABLE run_log_meta (
    run_id        VARCHAR(40)  PRIMARY KEY,
    project_id    VARCHAR(40)  NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    started_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    ended_at      TIMESTAMPTZ,
    parquet_root  TEXT,
    total_lines   BIGINT       NOT NULL DEFAULT 0,
    error_count   BIGINT       NOT NULL DEFAULT 0,
    warn_count    BIGINT       NOT NULL DEFAULT 0,
    info_count    BIGINT       NOT NULL DEFAULT 0
);

CREATE INDEX idx_run_log_meta_project_started
    ON run_log_meta (project_id, started_at DESC);

-- 2) 로그: WARN/ERROR + INFO 1% 샘플. LIST partition by run_id.
--    Partition 은 Coordinator 가 ingest 시작 시 동적으로 CREATE/ATTACH.
--    Run 종료 후 retention 초과 시 DETACH + DROP — 메타는 살린다.
CREATE TABLE run_log (
    seq          BIGINT       NOT NULL,         -- per-run 단조 증가 (Worker 가 부여)
    run_id       VARCHAR(40)  NOT NULL,
    ts           TIMESTAMPTZ  NOT NULL,
    level        SMALLINT     NOT NULL,          -- 0=INFO 1=WARN 2=ERROR
    stage        VARCHAR(64)  NOT NULL,
    message      TEXT         NOT NULL,
    suggestion   TEXT,
    PRIMARY KEY (run_id, seq)
) PARTITION BY LIST (run_id);

-- 핫 인덱스: keyset paging (run_id, ts DESC, seq DESC) — OFFSET 안 쓰는 무한 스크롤
CREATE INDEX idx_run_log_keyset
    ON run_log (run_id, ts DESC, seq DESC);

-- WARN/ERROR 빠른 필터 (partial index — 1% INFO 는 인덱스 비포함)
CREATE INDEX idx_run_log_level_high
    ON run_log (run_id, level, ts DESC)
    WHERE level >= 1;

-- pg_trgm GIN 은 Phase B opt-in. 여기서 만들지 않는다.
