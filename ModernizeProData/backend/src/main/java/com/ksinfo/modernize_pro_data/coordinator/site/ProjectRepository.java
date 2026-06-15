package com.ksinfo.modernize_pro_data.coordinator.site;

import com.ksinfo.modernize_pro_data.coordinator.run.RunStatus;
import jakarta.persistence.LockModeType;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.Optional;

public interface ProjectRepository extends JpaRepository<Project, String> {
    List<Project> findBySiteId(String siteId);
    void deleteBySiteId(String siteId);
    boolean existsBySiteIdAndName(String siteId, String name);
    boolean existsBySiteIdAndNameAndIdNot(String siteId, String name, String id);

    /**
     * Run service の冪等性ロック用 — SELECT ... FOR UPDATE.
     * 二重起動防止のため run_status を読み書きするトランザクション内で使う.
     * 呼び出し元は @Transactional 必須.
     */
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("SELECT p FROM Project p WHERE p.id = :id")
    Optional<Project> findByIdForUpdate(@Param("id") String id);

    /**
     * Coordinator 起動時 SchedulerInitializer 가 Quartz Trigger 등록할 project 列挙.
     * 참여 조건 = schedule_start_time IS NOT NULL.
     * 외부 /runs/all bulk run 의 対象 project 列挙도 兼用.
     */
    List<Project> findByScheduleStartTimeIsNotNull();

    /**
     * 起動 reconcile 専用 — run_history 에 실제 running 인 run 이 하나도 없는데
     * projects.run_status='running' 으로 박제된 orphan 을 idle 로 복귀.
     *
     * 발생 경위: 정상 abort/timeout/완료는 {@code RunService.finishRun} 이 run_history 와
     * projects.run_status 를 함께 갱신하지만, coordinator 가 OOM/crash 로 종료되면 그
     * finally 가 안 돌아 한쪽(특히 projects.run_status)만 'running' 으로 남는다. 그 결과
     * Execution Overview phase 배지가 멈췄는데도 running(주황)으로 보인다.
     *
     * 살아있을 수 있는 remote worker run (run_history 가 아직 running) 은 NOT EXISTS 로
     * 보존하고, 실제 running run 이 없는 project flag 만 정리한다. 반환 = 갱신 row 수.
     */
    @Transactional
    @Modifying
    @Query("UPDATE Project p SET p.runStatus = 'idle' WHERE p.runStatus = 'running' "
         + "AND NOT EXISTS (SELECT 1 FROM RunHistory r WHERE r.projectId = p.id AND r.status = :running)")
    int resetOrphanRunningStatus(@Param("running") RunStatus running);
}
