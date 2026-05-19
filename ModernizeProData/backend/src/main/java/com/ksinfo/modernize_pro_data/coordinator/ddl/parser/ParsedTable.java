package com.ksinfo.modernize_pro_data.coordinator.ddl.parser;

import lombok.Getter;
import lombok.Setter;

import java.util.ArrayList;
import java.util.List;

@Getter @Setter
public class ParsedTable {
    private String schemaName;
    private String physicalName;
    private String logicalName;
    private String tableComment;
    private int ordinal;
    private List<ParsedColumn> columns = new ArrayList<>();
}
