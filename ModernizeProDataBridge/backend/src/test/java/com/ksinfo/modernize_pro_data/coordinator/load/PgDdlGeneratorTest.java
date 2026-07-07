package com.ksinfo.modernize_pro_data.coordinator.load;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class PgDdlGeneratorTest {

    @Test
    void qualifiedTableWithSchema() {
        assertThat(PgDdlGenerator.qualifiedTable("hr", "emp")).isEqualTo("\"hr\".\"emp\"");
    }

    @Test
    void qualifiedTableWithoutSchema() {
        assertThat(PgDdlGenerator.qualifiedTable("", "emp")).isEqualTo("\"emp\"");
        assertThat(PgDdlGenerator.qualifiedTable(null, "emp")).isEqualTo("\"emp\"");
    }

    @Test
    void addUniqueConstraintSqlSingleColumn() {
        String sql = PgDdlGenerator.addUniqueConstraintSql("hr", "emp", "uq_emp_email", List.of("email"));
        assertThat(sql).isEqualTo(
                "ALTER TABLE \"hr\".\"emp\" ADD CONSTRAINT \"uq_emp_email\" UNIQUE (\"email\")");
    }

    @Test
    void addUniqueConstraintSqlCompositeColumns() {
        String sql = PgDdlGenerator.addUniqueConstraintSql("", "t", "uq_t_ab", List.of("a", "b"));
        assertThat(sql).isEqualTo(
                "ALTER TABLE \"t\" ADD CONSTRAINT \"uq_t_ab\" UNIQUE (\"a\", \"b\")");
    }

    @Test
    void addForeignKeyNotValidSqlNoActions() {
        String sql = PgDdlGenerator.addForeignKeyNotValidSql(
                "tobe", "child", "fk_child_parent",
                List.of("parent_id"),
                "tobe", "parent", List.of("id"),
                "NO ACTION", "NO ACTION", null);
        assertThat(sql).isEqualTo(
                "ALTER TABLE \"tobe\".\"child\" ADD CONSTRAINT \"fk_child_parent\""
                        + " FOREIGN KEY (\"parent_id\")"
                        + " REFERENCES \"tobe\".\"parent\" (\"id\")"
                        + " NOT VALID");
    }

    @Test
    void addForeignKeyNotValidSqlCascadeOnDelete() {
        String sql = PgDdlGenerator.addForeignKeyNotValidSql(
                "", "child", "fk_c",
                List.of("pid"),
                "", "parent", List.of("id"),
                "CASCADE", null, null);
        assertThat(sql).contains("ON DELETE CASCADE");
        assertThat(sql).doesNotContain("ON UPDATE");
        assertThat(sql).endsWith("NOT VALID");
    }

    @Test
    void addForeignKeyNotValidSqlCompositeColumns() {
        String sql = PgDdlGenerator.addForeignKeyNotValidSql(
                "", "child", "fk_c",
                List.of("a", "b"),
                "", "parent", List.of("x", "y"),
                "NO ACTION", "NO ACTION", null);
        assertThat(sql).contains("FOREIGN KEY (\"a\", \"b\")");
        assertThat(sql).contains("REFERENCES \"parent\" (\"x\", \"y\")");
    }

    @Test
    void addForeignKeyNotValidSqlWithDeferrable() {
        String sql = PgDdlGenerator.addForeignKeyNotValidSql(
                "", "child", "fk_c",
                List.of("pid"),
                "", "parent", List.of("id"),
                "NO ACTION", "NO ACTION",
                "DEFERRABLE INITIALLY DEFERRED");
        assertThat(sql).contains("DEFERRABLE INITIALLY DEFERRED");
        assertThat(sql).endsWith("NOT VALID");
        // 순서: REFERENCES ... DEFERRABLE ... NOT VALID
        assertThat(sql.indexOf("DEFERRABLE")).isLessThan(sql.indexOf("NOT VALID"));
    }

    @Test
    void addCheckConstraintNotValidSql() {
        String sql = PgDdlGenerator.addCheckConstraintNotValidSql(
                "tobe", "emp", "ck_emp_sal", "salary > 0");
        assertThat(sql).isEqualTo(
                "ALTER TABLE \"tobe\".\"emp\" ADD CONSTRAINT \"ck_emp_sal\""
                        + " CHECK (salary > 0) NOT VALID");
    }

    @Test
    void validateCheckConstraintSql() {
        String sql = PgDdlGenerator.validateCheckConstraintSql("tobe", "emp", "ck_emp_sal");
        assertThat(sql).isEqualTo(
                "ALTER TABLE \"tobe\".\"emp\" VALIDATE CONSTRAINT \"ck_emp_sal\"");
    }

    @Test
    void validateForeignKeySql() {
        String sql = PgDdlGenerator.validateForeignKeySql("tobe", "child", "fk_child_parent");
        assertThat(sql).isEqualTo(
                "ALTER TABLE \"tobe\".\"child\" VALIDATE CONSTRAINT \"fk_child_parent\"");
    }

    @Test
    void identifierWithDoubleQuoteIsEscaped() {
        String sql = PgDdlGenerator.addUniqueConstraintSql("", "weird\"name", "uq_x", List.of("a\"b"));
        assertThat(sql).contains("\"weird\"\"name\"");
        assertThat(sql).contains("\"a\"\"b\"");
    }
}
