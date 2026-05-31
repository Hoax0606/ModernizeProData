package com.ksinfo.modernize_pro_data.coordinator.run;

import org.springframework.data.jpa.repository.JpaRepository;

import java.time.OffsetDateTime;
import java.util.Collection;
import java.util.List;

public interface RunHistoryRepository extends JpaRepository<RunHistory, String> {

    /** Project の run 履歴 (新しい順). */
    List<RunHistory> findByProjectIdOrderByStartedAtDesc(String projectId);

    /** 指定 status 群의 run (DuckDB schema sweep 시 실행 중 run 보존용). */
    List<RunHistory> findByStatusIn(Collection<RunStatus> statuses);

    /** 타임아웃 sweep — 특정 status 이면서 started_at 이 cutoff 보다 이전인 run. */
    List<RunHistory> findByStatusAndStartedAtBefore(RunStatus status, OffsetDateTime cutoff);

    /** Coordinator 起動時 Misfire 判定用 — project の最後の run. */
    RunHistory findFirstByProjectIdOrderByStartedAtDesc(String projectId);

    /** Execution Overview 用 — pin (baseline snapshot) で起動された最新 run.
     *  pin.executionContext は finishRun 時にしか박제されないため running 중の run を取れない.
     *  この query は status 問わず最新 (running 含む) を取って Overview の bar が live で動くようにする. */
    RunHistory findFirstByProjectIdAndSnapshotIdOrderByStartedAtDesc(String projectId, String snapshotId);

    /** 同じ status の run を新しい順で取得 (sweep job 等で使う). */
    List<RunHistory> findByStatusOrderByStartedAtDesc(RunStatus status);

    /** 全 project 横断의 최근 run (Dev test page / 운영 dashboard 용). */
    List<RunHistory> findTop50ByOrderByStartedAtDesc();

    /** Project 의 누적 run 수 (output dir 의 runIndex 결정용). */
    long countByProjectId(String projectId);
}
