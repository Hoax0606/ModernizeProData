package com.ksinfo.modernize_pro_data.coordinator.site;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import lombok.AllArgsConstructor;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.time.LocalTime;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;
import java.util.UUID;

@Entity
@Table(name = "projects")
@Getter @Setter
@NoArgsConstructor
@AllArgsConstructor
public class Project {

    @Id
    @Column(length = 40)
    private String id;

    @Column(name = "site_id", nullable = false, length = 40)
    private String siteId;

    @Column(nullable = false, length = 128)
    private String name;

    @Column(nullable = false, length = 16)
    private String phase;

    @Column(name = "table_count", nullable = false)
    private int tableCount;

    @Column(name = "tobe_table_count", nullable = false)
    private int tobeTableCount;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "ddl_files", columnDefinition = "jsonb")
    private List<Map<String, Object>> ddlFiles;

    /** Per-project TO-BE DB 연결. Site.tobeDbScope=="project" 일 때만 사용.
     *  scope="site" 인 동안은 비어 있어도 무방 (Site.tobeDbByEnv 가 권위). */
    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "tobe_db_by_env", columnDefinition = "jsonb")
    private Map<String, Object> tobeDbByEnv;

    /** Per-project lock 상태. tobeDbByEnv 와 동일 조건으로 사용. */
    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "tobe_db_locks", columnDefinition = "jsonb")
    private Map<String, Boolean> tobeDbLocks;

    @Column(nullable = false, length = 64)
    private String owner;

    @Column(length = 64)
    private String assignee;

    @Column(name = "execution_assignee", length = 64)
    private String executionAssignee;

    @Column(name = "run_status", length = 16)
    private String runStatus;

    /**
     * Nightly rehearsal 시작 시각 (TZ 는 site 설정 기준).
     * solution_settings.internal_mode="individual" 일 때만 의미가 있음 (mode="common"
     * 이면 solution_settings.internal_common_time 가 사용됨).
     * Individual mode 에서는 모든 project 에 값이 들어 있어야 Save 가능 (FE 강제).
     */
    @Column(name = "schedule_start_time")
    private LocalTime scheduleStartTime;

    @Column(name = "schedule_last_run_at")
    private OffsetDateTime scheduleLastRunAt;

    @Column(name = "schedule_next_run_at")
    private OffsetDateTime scheduleNextRunAt;

    @Column(name = "created_at", nullable = false)
    private OffsetDateTime createdAt;

    public static Project create(String siteId, String name, String owner) {
        Project p = new Project();
        p.id = "p-" + UUID.randomUUID().toString().substring(0, 8);
        p.siteId = siteId;
        p.name = name;
        p.phase = "planning";
        p.tableCount = 0;
        p.tobeTableCount = 0;
        p.ddlFiles = List.of();
        p.tobeDbByEnv = Map.of();
        p.tobeDbLocks = Map.of();
        p.owner = owner;
        p.createdAt = OffsetDateTime.now();
        return p;
    }
}
