package com.ksinfo.modernize_pro_data.coordinator.ddl.parser;

import lombok.Getter;
import lombok.Setter;

import java.util.ArrayList;
import java.util.List;

@Getter @Setter
public class ParsedDdl {
    private List<ParsedTable> tables;
    private List<ParsedIndex> indexes = new ArrayList<>();
    private List<ParsedConstraint> constraints = new ArrayList<>();

    public ParsedDdl(List<ParsedTable> tables) {
        this.tables = tables;
    }

    public int totalColumnCount() {
        return tables.stream().mapToInt(t -> t.getColumns().size()).sum();
    }
}
