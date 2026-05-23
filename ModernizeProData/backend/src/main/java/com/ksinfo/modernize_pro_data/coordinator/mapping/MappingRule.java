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
 * 컬럼 단위 매핑 룰 (활성 working set).
 * V20260523174402__mapping_rules.sql 의 mapping_rules 와 매핑.
 *
 * TO-BE 식별은 (project_id, tobe_schema, tobe_table, tobe_column) name 기반 unique.
 * DDL 재임포트로 ddl_columns.id 가 바뀌어도 이름이 같으면 자동 재연결.
 */
@Entity
@Table(name = "mapping_rules")
@Getter @Setter
@NoArgsConstructor
@AllArgsConstructor
public class MappingRule {

    @Id
    @Column(length = 40)
    private String id;

    @Column(name = "project_id", nullable = false, length = 40)
    private String projectId;

    /** SET NULL when the import row is deleted — rule stays alive. */
    @Column(name = "import_id", length = 40)
    private String importId;

    /* ── TO-BE 식별 ── */
    @Column(name = "tobe_schema", nullable = false, length = 128)
    private String tobeSchema = "";

    @Column(name = "tobe_table", nullable = false, length = 128)
    private String tobeTable;

    @Column(name = "tobe_column", nullable = false, length = 128)
    private String tobeColumn;

    /* ── AS-IS 식별 (단일 source) ── */
    @Column(name = "asis_schema", length = 128)
    private String asisSchema;

    @Column(name = "asis_table", length = 128)
    private String asisTable;

    @Column(name = "asis_column", length = 128)
    private String asisColumn;

    /* ── 변환 전략 ── */
    @Column(nullable = false, length = 16)
    private String strategy = "expression";

    @Column(name = "transform_rule", columnDefinition = "TEXT")
    private String transformRule;

    @Column(name = "default_value", columnDefinition = "TEXT")
    private String defaultValue;

    @Column(name = "not_null_override", nullable = false)
    private boolean notNullOverride = false;

    /* ── 메타 ── */
    @Column(name = "rule_origin", nullable = false, length = 16)
    private String ruleOrigin = "imported";

    @Column(columnDefinition = "TEXT")
    private String notes;

    @Column(name = "created_by", nullable = false, length = 64)
    private String createdBy;

    @Column(name = "created_at", nullable = false)
    private OffsetDateTime createdAt;

    @Column(name = "updated_by", length = 64)
    private String updatedBy;

    @Column(name = "updated_at")
    private OffsetDateTime updatedAt;
}
