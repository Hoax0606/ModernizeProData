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

    @Column(nullable = false, length = 64)
    private String owner;

    @Column(length = 64)
    private String assignee;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(columnDefinition = "jsonb")
    private Map<String, Object> cutover;

    @Column(name = "run_status", length = 16)
    private String runStatus;

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
        p.owner = owner;
        p.createdAt = OffsetDateTime.now();
        return p;
    }
}
