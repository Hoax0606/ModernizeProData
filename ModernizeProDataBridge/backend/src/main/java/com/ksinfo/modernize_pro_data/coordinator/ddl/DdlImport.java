package com.ksinfo.modernize_pro_data.coordinator.ddl;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import lombok.AllArgsConstructor;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

import java.time.OffsetDateTime;
import java.util.UUID;

@Entity
@Table(name = "ddl_imports")
@Getter @Setter
@NoArgsConstructor
@AllArgsConstructor
public class DdlImport {

    @Id
    @Column(length = 40)
    private String id;

    @Column(name = "project_id", nullable = false, length = 40)
    private String projectId;

    @Column(nullable = false, length = 8)
    private String side;

    @Column(nullable = false, length = 256)
    private String filename;

    @Column(name = "file_size", nullable = false)
    private long fileSize;

    @Column(name = "file_hash", nullable = false, length = 64)
    private String fileHash;

    @Column(nullable = false, length = 16)
    private String dialect;

    @Column(nullable = false, length = 16)
    private String status;

    @Column(name = "table_count", nullable = false)
    private int tableCount;

    @Column(name = "column_count", nullable = false)
    private int columnCount;

    @Column(name = "error_message", columnDefinition = "TEXT")
    private String errorMessage;

    @Column(name = "imported_by", nullable = false, length = 64)
    private String importedBy;

    @Column(name = "imported_at", nullable = false)
    private OffsetDateTime importedAt;

    public static DdlImport create(String projectId, String side, String filename, long fileSize,
                                   String fileHash, String dialect, String importedBy) {
        DdlImport di = new DdlImport();
        di.id = "di-" + UUID.randomUUID().toString().substring(0, 8);
        di.projectId = projectId;
        di.side = side;
        di.filename = filename;
        di.fileSize = fileSize;
        di.fileHash = fileHash;
        di.dialect = dialect != null ? dialect : "oracle";
        di.status = "success";
        di.importedBy = importedBy;
        di.importedAt = OffsetDateTime.now();
        return di;
    }
}
