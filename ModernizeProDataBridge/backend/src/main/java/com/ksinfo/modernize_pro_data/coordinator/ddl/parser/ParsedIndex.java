package com.ksinfo.modernize_pro_data.coordinator.ddl.parser;

import lombok.Getter;
import lombok.Setter;

import java.util.ArrayList;
import java.util.List;

@Getter @Setter
public class ParsedIndex {
    private String schemaName = "";
    private String tableName;
    private String name;
    /** btree / hash / gin / gist / brin / spgist / bitmap(oracle) / functional(oracle) / reverse(oracle) / unknown */
    private String type = "btree";
    private boolean unique;
    private boolean partial;
    /** PG partial index 의 WHERE 절. raw text. */
    private String whereClause;
    /** Oracle function-based 또는 PG expression index 의 원문. */
    private String expression;
    private List<ParsedIndexColumn> columns = new ArrayList<>();
}
