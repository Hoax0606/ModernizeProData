package com.ksinfo.modernize_pro_data.coordinator.ddl.parser;

import lombok.Getter;
import lombok.Setter;

import java.util.List;

@Getter @Setter
public class ParsedDdl {
    private List<ParsedTable> tables;

    public ParsedDdl(List<ParsedTable> tables) {
        this.tables = tables;
    }

    public int totalColumnCount() {
        return tables.stream().mapToInt(t -> t.getColumns().size()).sum();
    }
}
