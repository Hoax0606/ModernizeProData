package com.ksinfo.modernize_pro_data.coordinator.ddl.parser;

import lombok.Getter;
import lombok.Setter;

import java.util.ArrayList;
import java.util.List;

@Getter @Setter
public class ParsedConstraint {
    public static final String TYPE_UK = "UK";
    public static final String TYPE_FK = "FK";
    public static final String TYPE_CHECK = "CHECK";

    private String schemaName = "";
    private String tableName;
    private String name;
    /** UK / FK / CHECK */
    private String type;
    /** CHECK 의 raw 표현식. FK/UK 는 null. */
    private String checkExpression;
    private List<ParsedConstraintColumn> columns = new ArrayList<>();
    /** type=FK 일 때만 채워짐. */
    private ParsedForeignKey foreignKey;
}
