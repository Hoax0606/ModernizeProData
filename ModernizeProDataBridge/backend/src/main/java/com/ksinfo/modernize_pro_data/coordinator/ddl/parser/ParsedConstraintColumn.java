package com.ksinfo.modernize_pro_data.coordinator.ddl.parser;

import lombok.Getter;
import lombok.Setter;

@Getter @Setter
public class ParsedConstraintColumn {
    private int ordinal;
    private String columnName;
    /** FK 의 부모 컬럼명 (자식 컬럼과 ordinal 1:1 대응). UK/CHECK 은 null. */
    private String refColumnName;
}
