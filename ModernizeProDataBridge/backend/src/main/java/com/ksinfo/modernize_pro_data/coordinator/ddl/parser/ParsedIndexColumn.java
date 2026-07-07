package com.ksinfo.modernize_pro_data.coordinator.ddl.parser;

import lombok.Getter;
import lombok.Setter;

@Getter @Setter
public class ParsedIndexColumn {
    private int ordinal;
    private String columnName;
    /** ASC / DESC / null (default). */
    private String sortOrder;
}
