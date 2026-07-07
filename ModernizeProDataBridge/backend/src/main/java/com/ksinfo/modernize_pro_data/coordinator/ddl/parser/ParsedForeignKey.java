package com.ksinfo.modernize_pro_data.coordinator.ddl.parser;

import lombok.Getter;
import lombok.Setter;

@Getter @Setter
public class ParsedForeignKey {
    private String refSchemaName = "";
    private String refTableName;
    /** NO ACTION / CASCADE / SET NULL / SET DEFAULT / RESTRICT */
    private String onDelete = "NO ACTION";
    private String onUpdate = "NO ACTION";
    /** DEFERRABLE INITIALLY DEFERRED 등의 raw 문자열. */
    private String deferrableInfo;
}
