package com.ksinfo.modernize_pro_data.coordinator.mapping;

import com.fasterxml.jackson.annotation.JsonIgnore;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.FetchType;
import jakarta.persistence.Id;
import jakarta.persistence.JoinColumn;
import jakarta.persistence.ManyToOne;
import jakarta.persistence.Table;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

/**
 * 한 binding 의 AS-IS 소스 1개.
 * role:
 *   - primary: composition=single 일 때 단독, 또는 join 의 기준 테이블
 *   - join:    LEFT/INNER/... join 으로 붙는 테이블 (join_type/join_on 필수)
 *   - union:   union 합산되는 테이블
 */
@Entity
@Table(name = "mapping_table_binding_sources")
@Getter @Setter
@NoArgsConstructor
public class MappingTableBindingSource {

    @Id
    @Column(length = 40)
    private String id;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "binding_id", nullable = false)
    @JsonIgnore
    private MappingTableBinding binding;

    @Column(nullable = false)
    private int ordinal;

    @Column(name = "asis_schema", length = 128)
    private String asisSchema;

    @Column(name = "asis_table", nullable = false, length = 128)
    private String asisTable;

    @Column(nullable = false, length = 16)
    private String alias;

    @Column(nullable = false, length = 16)
    private String role;

    @Column(name = "join_type", length = 16)
    private String joinType;

    @Column(name = "join_on", columnDefinition = "TEXT")
    private String joinOn;
}
