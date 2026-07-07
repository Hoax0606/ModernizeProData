package com.ksinfo.modernize_pro_data.coordinator.ddl.parser;

import lombok.Getter;
import lombok.Setter;

@Getter @Setter
public class ParsedColumn {
    private int ordinal;
    private String physicalName;
    private String logicalName;
    private String dataTypeRaw;
    private String dataType;
    private Integer length;
    private Integer precision;
    private Integer scale;
    private boolean nullable = true;
    private Integer pkOrder;
    private String defaultValue;
    private String columnComment;
    private String inlineComment;
}
