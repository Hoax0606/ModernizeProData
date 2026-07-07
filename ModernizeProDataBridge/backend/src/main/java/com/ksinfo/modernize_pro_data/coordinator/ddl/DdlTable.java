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
@Table(name = "ddl_tables")
@Getter @Setter
@NoArgsConstructor
@AllArgsConstructor
public class DdlTable {

    @Id
    @Column(length = 40)
    private String id;

    @Column(name = "project_id", nullable = false, length = 40)
    private String projectId;

    @Column(nullable = false, length = 8)
    private String side;

    @Column(name = "import_id", nullable = false, length = 40)
    private String importId;

    @Column(name = "schema_name", nullable = false, length = 128)
    private String schemaName;

    @Column(name = "physical_name", nullable = false, length = 128)
    private String physicalName;

    @Column(name = "logical_name", length = 256)
    private String logicalName;

    @Column(name = "table_comment", columnDefinition = "TEXT")
    private String tableComment;

    @Column(nullable = false)
    private int ordinal;

    public static DdlTable create(String projectId, String side, String importId,
                                  String schemaName, String physicalName, int ordinal) {
        DdlTable t = new DdlTable();
        t.id = "dt-" + UUID.randomUUID().toString().substring(0, 8);
        t.projectId = projectId;
        t.side = side;
        t.importId = importId;
        t.schemaName = schemaName != null ? schemaName : "";
        t.physicalName = physicalName;
        t.ordinal = ordinal;
        return t;
    }
}
