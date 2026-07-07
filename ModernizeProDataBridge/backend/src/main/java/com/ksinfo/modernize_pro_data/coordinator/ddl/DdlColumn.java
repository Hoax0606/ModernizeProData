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
@Table(name = "ddl_columns")
@Getter @Setter
@NoArgsConstructor
@AllArgsConstructor
public class DdlColumn {

    @Id
    @Column(length = 40)
    private String id;

    @Column(name = "table_id", nullable = false, length = 40)
    private String tableId;

    @Column(nullable = false)
    private int ordinal;

    @Column(name = "physical_name", nullable = false, length = 128)
    private String physicalName;

    @Column(name = "logical_name", length = 256)
    private String logicalName;

    @Column(name = "data_type_raw", nullable = false, length = 128)
    private String dataTypeRaw;

    @Column(name = "data_type", nullable = false, length = 64)
    private String dataType;

    private Integer length;

    private Integer precision;

    private Integer scale;

    @Column(nullable = false)
    private boolean nullable;

    @Column(name = "pk_order")
    private Integer pkOrder;

    @Column(name = "default_value", columnDefinition = "TEXT")
    private String defaultValue;

    @Column(name = "column_comment", columnDefinition = "TEXT")
    private String columnComment;

    public static DdlColumn create(String tableId, int ordinal, String physicalName,
                                   String dataTypeRaw, String dataType) {
        DdlColumn c = new DdlColumn();
        c.id = "dc-" + UUID.randomUUID().toString().substring(0, 8);
        c.tableId = tableId;
        c.ordinal = ordinal;
        c.physicalName = physicalName;
        c.dataTypeRaw = dataTypeRaw;
        c.dataType = dataType;
        c.nullable = true;
        return c;
    }
}
