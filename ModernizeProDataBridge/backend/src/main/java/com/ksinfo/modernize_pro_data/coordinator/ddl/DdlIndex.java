package com.ksinfo.modernize_pro_data.coordinator.ddl;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import lombok.AllArgsConstructor;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

import java.util.UUID;

@Entity
@Table(name = "ddl_indexes")
@Getter @Setter
@NoArgsConstructor
@AllArgsConstructor
public class DdlIndex {

    @Id
    @Column(length = 40)
    private String id;

    @Column(name = "project_id", nullable = false, length = 40)
    private String projectId;

    @Column(name = "table_id", nullable = false, length = 40)
    private String tableId;

    @Column(nullable = false, length = 8)
    private String side;

    @Column(nullable = false, length = 128)
    private String name;

    @Column(nullable = false, length = 32)
    private String type;

    @Column(name = "is_unique", nullable = false)
    private boolean unique;

    @Column(name = "is_partial", nullable = false)
    private boolean partial;

    @Column(name = "where_clause", columnDefinition = "TEXT")
    private String whereClause;

    @Column(columnDefinition = "TEXT")
    private String expression;

    public static DdlIndex create(String projectId, String tableId, String side,
                                  String name, String type, boolean unique) {
        DdlIndex i = new DdlIndex();
        i.id = "dx-" + UUID.randomUUID().toString().substring(0, 8);
        i.projectId = projectId;
        i.tableId = tableId;
        i.side = side;
        i.name = name;
        i.type = type != null ? type : "btree";
        i.unique = unique;
        i.partial = false;
        return i;
    }
}
