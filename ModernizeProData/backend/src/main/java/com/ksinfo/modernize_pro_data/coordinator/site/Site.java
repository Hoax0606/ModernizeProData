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
import java.util.Map;
import java.util.UUID;

@Entity
@Table(name = "sites")
@Getter @Setter
@NoArgsConstructor
@AllArgsConstructor
public class Site {

    @Id
    @Column(length = 40)
    private String id;

    @Column(nullable = false, length = 128)
    private String name;

    @Column(name = "asis_env", nullable = false, length = 16)
    private String asisEnv;

    @Column(name = "tobe_env", nullable = false, length = 16)
    private String tobeEnv;

    @Column(name = "asis_encoding", nullable = false, length = 16)
    private String asisEncoding;

    @Column(name = "tobe_encoding", nullable = false, length = 16)
    private String tobeEncoding;

    @Column(name = "csv_path", nullable = false, length = 512)
    private String csvPath;

    /** AS-IS 측 추출 원본 DB 종류 (Oracle / DB2 / SQL Server / PostgreSQL / MySQL / Mainframe DB2 / Other). 표시용. */
    @Column(name = "asis_db_type", length = 64)
    private String asisDbType;

    /** AS-IS 측 DB 버전 (예: "11g R2", "16.0"). 표시용. */
    @Column(name = "asis_db_version", length = 64)
    private String asisDbVersion;

    @Column(columnDefinition = "TEXT")
    private String notes;

    @Column(nullable = false, length = 16)
    private String environment;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "tobe_db_by_env", columnDefinition = "jsonb")
    private Map<String, Object> tobeDbByEnv;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "tobe_db_locks", columnDefinition = "jsonb")
    private Map<String, Boolean> tobeDbLocks;

    @Column(name = "created_by", nullable = false, length = 64)
    private String createdBy;

    @Column(name = "created_at", nullable = false)
    private OffsetDateTime createdAt;

    public static Site create(String name, String asisEnv, String tobeEnv,
                              String asisEncoding, String tobeEncoding,
                              String csvPath, String notes, String environment,
                              Map<String, Object> tobeDbByEnv,
                              Map<String, Boolean> tobeDbLocks,
                              String createdBy) {
        Site s = new Site();
        s.id = "s-" + UUID.randomUUID().toString().substring(0, 8);
        s.name = name;
        s.asisEnv = asisEnv;
        s.tobeEnv = tobeEnv;
        s.asisEncoding = asisEncoding;
        s.tobeEncoding = tobeEncoding;
        s.csvPath = csvPath != null ? csvPath : "";
        s.notes = notes;
        s.environment = environment != null ? environment : "dev";
        s.tobeDbByEnv = tobeDbByEnv != null ? tobeDbByEnv : Map.of();
        s.tobeDbLocks = tobeDbLocks != null ? tobeDbLocks : Map.of();
        s.createdBy = createdBy;
        s.createdAt = OffsetDateTime.now();
        return s;
    }
}
