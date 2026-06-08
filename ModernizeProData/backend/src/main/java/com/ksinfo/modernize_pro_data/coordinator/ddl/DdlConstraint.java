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
@Table(name = "ddl_constraints")
@Getter @Setter
@NoArgsConstructor
@AllArgsConstructor
public class DdlConstraint {

    public static final String TYPE_UK = "UK";
    public static final String TYPE_FK = "FK";
    public static final String TYPE_CHECK = "CHECK";

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

    @Column(nullable = false, length = 16)
    private String type;

    @Column(name = "check_expression", columnDefinition = "TEXT")
    private String checkExpression;

    public static DdlConstraint create(String projectId, String tableId, String side,
                                       String name, String type) {
        DdlConstraint c = new DdlConstraint();
        c.id = "dk-" + UUID.randomUUID().toString().substring(0, 8);
        c.projectId = projectId;
        c.tableId = tableId;
        c.side = side;
        c.name = name;
        c.type = type;
        return c;
    }
}
