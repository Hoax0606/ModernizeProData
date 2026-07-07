package com.ksinfo.modernize_pro_data.coordinator.mapping;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import lombok.AllArgsConstructor;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

import java.time.OffsetDateTime;

/**
 * 맵핑정의서 1회 임포트 단위 메타데이터.
 * V20260523174402__mapping_rules.sql 의 mapping_imports 와 매핑.
 */
@Entity
@Table(name = "mapping_imports")
@Getter @Setter
@NoArgsConstructor
@AllArgsConstructor
public class MappingImport {

    @Id
    @Column(length = 40)
    private String id;

    @Column(name = "project_id", nullable = false, length = 40)
    private String projectId;

    @Column(length = 256)
    private String filename;

    @Column(name = "code_filename", length = 256)
    private String codeFilename;

    /** 임포트한 column_mapping CSV 의 텍스트 원본 — re-apply 에 사용. */
    @Column(name = "column_csv_content", columnDefinition = "TEXT")
    private String columnCsvContent;

    /** 임포트한 code_mapping CSV 의 텍스트 원본. */
    @Column(name = "code_csv_content", columnDefinition = "TEXT")
    private String codeCsvContent;

    @Column(name = "file_size", nullable = false)
    private long fileSize;

    @Column(name = "file_hash", nullable = false, length = 64)
    private String fileHash;

    @Column(nullable = false, length = 16)
    private String format;

    @Column(nullable = false, length = 16)
    private String status;

    @Column(name = "rule_count", nullable = false)
    private int ruleCount;

    @Column(name = "code_map_count", nullable = false)
    private int codeMapCount;

    @Column(name = "error_message", columnDefinition = "TEXT")
    private String errorMessage;

    @Column(name = "imported_by", nullable = false, length = 64)
    private String importedBy;

    @Column(name = "imported_at", nullable = false)
    private OffsetDateTime importedAt;
}
