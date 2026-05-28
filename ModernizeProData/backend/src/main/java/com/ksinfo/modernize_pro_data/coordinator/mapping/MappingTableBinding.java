package com.ksinfo.modernize_pro_data.coordinator.mapping;

import jakarta.persistence.CascadeType;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.FetchType;
import jakarta.persistence.Id;
import jakarta.persistence.JoinColumn;
import jakarta.persistence.OneToMany;
import jakarta.persistence.OrderBy;
import jakarta.persistence.Table;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.List;

/**
 * TO-BE 테이블 1개의 바인딩 정의.
 *
 * composition_kind:
 *   - single: 1 source
 *   - join:   N sources, 첫 row 가 primary, 나머지 join
 *   - union:  N sources, 모두 union 동일 역할
 *   - none:   소스 없음 (added/default/null 룰만 있는 테이블)
 */
@Entity
@Table(name = "mapping_table_bindings")
@Getter @Setter
@NoArgsConstructor
public class MappingTableBinding {

    @Id
    @Column(length = 40)
    private String id;

    @Column(name = "project_id", nullable = false, length = 40)
    private String projectId;

    @Column(name = "import_id", length = 40)
    private String importId;

    @Column(name = "tobe_schema", nullable = false, length = 128)
    private String tobeSchema = "";

    @Column(name = "tobe_table", nullable = false, length = 128)
    private String tobeTable;

    @Column(name = "composition_kind", nullable = false, length = 16)
    private String compositionKind = "single";

    @Column(name = "where_filter", columnDefinition = "TEXT")
    private String whereFilter;

    @Column(name = "binding_origin", nullable = false, length = 16)
    private String bindingOrigin = "imported";

    /**
     * 자식 link 마킹. null = 자체 정의 (기본). 값 있음 = master project_id —
     * 그 project 의 같은 (tobe_schema, tobe_table) 의 binding sources + mapping_rules 를
     * read 시점에 inherit. row editor 는 read-only.
     */
    @Column(name = "shared_from_project_id", length = 40)
    private String sharedFromProjectId;

    @Column(name = "created_by", nullable = false, length = 64)
    private String createdBy;

    @Column(name = "created_at", nullable = false)
    private OffsetDateTime createdAt;

    @Column(name = "updated_by", length = 64)
    private String updatedBy;

    @Column(name = "updated_at")
    private OffsetDateTime updatedAt;

    @OneToMany(mappedBy = "binding", cascade = CascadeType.ALL, orphanRemoval = true, fetch = FetchType.EAGER)
    @OrderBy("ordinal ASC")
    private List<MappingTableBindingSource> sources = new ArrayList<>();

    public void addSource(MappingTableBindingSource s) {
        s.setBinding(this);
        sources.add(s);
    }
}
