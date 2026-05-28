package com.ksinfo.modernize_pro_data.coordinator.site;

import jakarta.persistence.LockModeType;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

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
}
