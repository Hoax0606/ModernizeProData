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
@Table(name = "ddl_foreign_keys")
@Getter @Setter
@NoArgsConstructor
@AllArgsConstructor
public class DdlForeignKey {

    public static final String ACTION_NO_ACTION = "NO ACTION";
    public static final String ACTION_CASCADE = "CASCADE";
    public static final String ACTION_SET_NULL = "SET NULL";
    public static final String ACTION_SET_DEFAULT = "SET DEFAULT";
    public static final String ACTION_RESTRICT = "RESTRICT";

    @Id
    @Column(length = 40)
    private String id;

    @Column(name = "constraint_id", nullable = false, length = 40)
    private String constraintId;

    @Column(name = "ref_schema_name", nullable = false, length = 128)
    private String refSchemaName;

    @Column(name = "ref_table_name", nullable = false, length = 128)
    private String refTableName;

    @Column(name = "on_delete", nullable = false, length = 16)
    private String onDelete;

    @Column(name = "on_update", nullable = false, length = 16)
    private String onUpdate;

    @Column(name = "deferrable_info", length = 64)
    private String deferrableInfo;

    public static DdlForeignKey create(String constraintId, String refSchemaName,
                                       String refTableName) {
        DdlForeignKey f = new DdlForeignKey();
        f.id = "dfk-" + UUID.randomUUID().toString().substring(0, 8);
        f.constraintId = constraintId;
        f.refSchemaName = refSchemaName != null ? refSchemaName : "";
        f.refTableName = refTableName;
        f.onDelete = ACTION_NO_ACTION;
        f.onUpdate = ACTION_NO_ACTION;
        return f;
    }
}
