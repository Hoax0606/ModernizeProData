package com.ksinfo.modernize_pro_data.coordinator.run;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;

public interface RunHistoryRepository extends JpaRepository<RunHistory, String> {

    /** Project の run 履歴 (新しい順). */
    List<RunHistory> findByProjectIdOrderByStartedAtDesc(String projectId);

    /** Coordinator 起動時 Misfire 判定用 — project の最後の run. */
    RunHistory findFirstByProjectIdOrderByStartedAtDesc(String projectId);

    /** 同じ status の run を新しい順で取得 (sweep job 等で使う). */
    List<RunHistory> findByStatusOrderByStartedAtDesc(RunStatus status);

    /** 全 project 横断의 최근 run (Dev test page / 운영 dashboard 용). */
    List<RunHistory> findTop50ByOrderByStartedAtDesc();

    /** Project 의 누적 run 수 (output dir 의 runIndex 결정용). */
    long countByProjectId(String projectId);
}
