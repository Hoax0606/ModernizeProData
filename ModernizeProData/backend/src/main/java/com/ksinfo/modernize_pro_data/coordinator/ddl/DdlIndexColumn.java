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
@Table(name = "ddl_index_columns")
@Getter @Setter
@NoArgsConstructor
@AllArgsConstructor
public class DdlIndexColumn {

    @Id
    @Column(length = 40)
    private String id;

    @Column(name = "index_id", nullable = false, length = 40)
    private String indexId;

    @Column(nullable = false)
    private int ordinal;

    @Column(name = "column_name", nullable = false, length = 128)
    private String columnName;

    @Column(name = "sort_order", length = 8)
    private String sortOrder;

    public static DdlIndexColumn create(String indexId, int ordinal, String columnName) {
        DdlIndexColumn c = new DdlIndexColumn();
        c.id = "dxc-" + UUID.randomUUID().toString().substring(0, 8);
        c.indexId = indexId;
        c.ordinal = ordinal;
        c.columnName = columnName;
        return c;
    }
}
