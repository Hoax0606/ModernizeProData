package com.ksinfo.modernize_pro_data.coordinator.mapping;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import lombok.AllArgsConstructor;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

/**
 * 코드값 변환 마스터 (M→MALE, Y→TRUE 등).
 * V20260523174402__mapping_rules.sql 의 mapping_code_maps 와 매핑.
 *
 * (project_id, domain, source_value) unique. domain 은 'GENDER', 'YN_BOOL' 같은
 * 사용자 정의 그룹.
 */
@Entity
@Table(name = "mapping_code_maps")
@Getter @Setter
@NoArgsConstructor
@AllArgsConstructor
public class MappingCodeMap {

    @Id
    @Column(length = 40)
    private String id;

    @Column(name = "project_id", nullable = false, length = 40)
    private String projectId;

    @Column(name = "import_id", length = 40)
    private String importId;

    @Column(nullable = false, length = 64)
    private String domain;

    @Column(name = "source_value", nullable = false, length = 128)
    private String sourceValue;

    @Column(name = "target_value", nullable = false, length = 128)
    private String targetValue;

    @Column(columnDefinition = "TEXT")
    private String description;

    @Column(nullable = false)
    private int ordinal = 0;
}
