package com.ksinfo.modernize_pro_data.coordinator.mapping;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

import java.time.OffsetDateTime;

/**
 * AS-IS 컬럼 단위 명시적 skip 마킹.
 *
 * 의미: 해당 AS-IS 컬럼은 어떤 TO-BE 와도 매핑되지 않음 (의도적 미사용).
 * mapping_rules.strategy='skip' 은 TO-BE 컬럼 측. 이 테이블은 AS-IS 측 보강.
 */
@Entity
@Table(name = "mapping_asis_skip")
@Getter @Setter
@NoArgsConstructor
public class MappingAsisSkip {

    @Id
    @Column(length = 40)
    private String id;

    @Column(name = "project_id", nullable = false, length = 40)
    private String projectId;

    @Column(name = "asis_schema", nullable = false, length = 128)
    private String asisSchema = "";

    @Column(name = "asis_table", nullable = false, length = 128)
    private String asisTable;

    @Column(name = "asis_column", nullable = false, length = 128)
    private String asisColumn;

    @Column(name = "created_by", nullable = false, length = 64)
    private String createdBy;

    @Column(name = "created_at", nullable = false)
    private OffsetDateTime createdAt;
}
