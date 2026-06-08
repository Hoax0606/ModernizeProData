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
@Table(name = "ddl_constraint_columns")
@Getter @Setter
@NoArgsConstructor
@AllArgsConstructor
public class DdlConstraintColumn {

    @Id
    @Column(length = 40)
    private String id;

    @Column(name = "constraint_id", nullable = false, length = 40)
    private String constraintId;

    @Column(nullable = false)
    private int ordinal;

    @Column(name = "column_name", nullable = false, length = 128)
    private String columnName;

    @Column(name = "ref_column_name", length = 128)
    private String refColumnName;

    public static DdlConstraintColumn create(String constraintId, int ordinal,
                                             String columnName, String refColumnName) {
        DdlConstraintColumn c = new DdlConstraintColumn();
        c.id = "dkc-" + UUID.randomUUID().toString().substring(0, 8);
        c.constraintId = constraintId;
        c.ordinal = ordinal;
        c.columnName = columnName;
        c.refColumnName = refColumnName;
        return c;
    }
}
