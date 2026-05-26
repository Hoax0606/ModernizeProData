package com.ksinfo.modernize_pro_data.coordinator.mapping;

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

    /* ── AS-IS 식별 — combine 케이스를 위해 column/type 은 PG 배열 ── */
    @Column(name = "asis_schema", length = 128)
    private String asisSchema;

    @Column(name = "asis_table", length = 128)
    private String asisTable;

    /**
     * AS-IS source 컬럼명 리스트. 단일 매핑이면 원소 1개, combine 이면 여러 개
     * (예: ['BIRTH_YEAR','BIRTH_MONTH','BIRTH_DAY']). PG TEXT[] 로 영속.
     * 자바 String[] 로 매핑 — Hibernate 6.6 PG dialect 가 List<String> 은 jsonb 으로,
     * String[] 는 native ARRAY 로 처리한다. ARRAY 가 우리 의도이므로 배열 선택.
     */
    @JdbcTypeCode(SqlTypes.ARRAY)
    @Column(name = "asis_column")
    private String[] asisColumn;

    /**
     * asisColumn 각 원소에 대응하는 AS-IS 원본 타입 (예: ['NUMBER(4)','NUMBER(2)','NUMBER(2)']).
     * read_csv 의 column_types 에 사용. 길이는 asisColumn 과 일치하는 것을 기대.
     */
    @JdbcTypeCode(SqlTypes.ARRAY)
    @Column(name = "asis_type")
    private String[] asisType;

    /**
     * 이 컬럼이 사용하는 code_map domain 이름 (예: 'GENDER', 'YN_BOOL').
     * 임포트 시 mapping_code_maps 에서 해당 domain 조회 → CASE 자동 생성.
     */
    @Column(name = "code_domain", length = 64)
    private String codeDomain;

    /* ── 변환 전략 ── */
    @Column(nullable = false, length = 16)
    private String strategy = "expression";

    @Column(name = "transform_rule", columnDefinition = "TEXT")
    private String transformRule;

    /** 멀티라인 / 서브쿼리 / CTE 포함한 풀 SQL 단편 — 복잡한 변환식 보관용. */
    @Column(name = "transform_sql", columnDefinition = "TEXT")
    private String transformSql;

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
