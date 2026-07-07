package com.ksinfo.modernize_pro_data.coordinator.load;

import com.ksinfo.modernize_pro_data.coordinator.ddl.DdlColumn;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * index 후행(PK defer) — createTableIfNotExists 는 inline PK 를 더 이상 넣지 않고,
 * 적재 후 addPrimaryKeySql 로 일괄 부착. (COPY 중 PK 인덱스 매행 유지 제거 = 대용량 빠름.)
 */
class PgDdlGeneratorPkTest {

    private static DdlColumn col(int ord, String name, String type, Integer pkOrder) {
        DdlColumn c = DdlColumn.create("t", ord, name, type, type.toLowerCase());
        c.setNullable(pkOrder == null);
        c.setPkOrder(pkOrder);
        return c;
    }

    @Test
    void createTableHasNoInlinePrimaryKey() {
        List<DdlColumn> cols = List.of(
                col(0, "id", "NUMBER", 1),
                col(1, "name", "VARCHAR2", null));
        String sql = PgDdlGenerator.createTableIfNotExists("biz", "customers", cols);
        assertFalse(sql.toUpperCase().contains("PRIMARY KEY"),
                "createTableIfNotExists 는 inline PRIMARY KEY 를 넣지 않아야 한다 (후행 부착)");
        assertTrue(sql.contains("customers"));
        assertTrue(sql.contains("id"));
        assertTrue(sql.contains("name"));
    }

    @Test
    void primaryKeyColumnsInPkOrder() {
        List<DdlColumn> cols = List.of(
                col(0, "b", "NUMBER", 2),
                col(1, "a", "NUMBER", 1),
                col(2, "x", "VARCHAR2", null));
        assertEquals(List.of("a", "b"), PgDdlGenerator.primaryKeyColumns(cols),
                "pk_order 순으로 a(1), b(2)");
    }

    @Test
    void primaryKeyColumnsEmptyWhenNoPk() {
        List<DdlColumn> cols = List.of(col(0, "x", "VARCHAR2", null));
        assertTrue(PgDdlGenerator.primaryKeyColumns(cols).isEmpty());
    }

    @Test
    void addPrimaryKeySqlForm() {
        String sql = PgDdlGenerator.addPrimaryKeySql("biz", "customers", List.of("id"));
        assertTrue(sql.toUpperCase().contains("ALTER TABLE"));
        assertTrue(sql.toUpperCase().contains("ADD PRIMARY KEY"));
        assertTrue(sql.contains("id"));
        assertTrue(sql.contains("customers"));
    }
}
