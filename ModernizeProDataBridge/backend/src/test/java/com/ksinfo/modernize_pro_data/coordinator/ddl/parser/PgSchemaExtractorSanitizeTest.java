package com.ksinfo.modernize_pro_data.coordinator.ddl.parser;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** sanitizeDumpForStaging — pg_dump 의 schema 한정자/부가구문 제거 검증 (DB 불필요). */
class PgSchemaExtractorSanitizeTest {

    @Test
    void stripsAllSchemaQualifiersAndDumpCruft() {
        String dump = String.join("\n",
                "SET statement_timeout = 0;",
                "SELECT pg_catalog.set_config('search_path', '', false);",
                "CREATE TABLE banksys.customer_contacts (id integer NOT NULL, seq integer DEFAULT nextval('banksys.seq'::regclass));",
                "ALTER TABLE public.orders OWNER TO postgres;",
                "ALTER TABLE ONLY banksys.customer_contacts ADD CONSTRAINT pk PRIMARY KEY (id);",
                "CREATE INDEX idx ON banksys.customer_contacts (id);",
                "GRANT ALL ON banksys.customer_contacts TO app;");

        String out = PgSchemaExtractor.sanitizeDumpForStaging(dump);
        String low = out.toLowerCase();

        assertFalse(low.contains("banksys."), "banksys. should be stripped:\n" + out);
        assertFalse(low.contains("public."), "public. should be stripped:\n" + out);
        assertFalse(low.contains("set_config"), "set_config line should be dropped:\n" + out);
        assertFalse(low.contains("owner to"), "OWNER TO line should be dropped:\n" + out);
        assertFalse(low.contains("grant "), "GRANT line should be dropped:\n" + out);
        assertTrue(out.contains("CREATE TABLE customer_contacts"), "unqualified table should remain:\n" + out);
        assertTrue(out.contains("nextval('seq'::regclass)"), "qualifier inside default stripped:\n" + out);
    }

    @Test
    void stripsEnvironmentDependentClauses() {
        String dump = String.join("\n",
                "CREATE EXTENSION IF NOT EXISTS \"uuid-ossp\" WITH SCHEMA public;",
                "COMMENT ON EXTENSION \"uuid-ossp\" IS 'x';",
                "CREATE ROLE app_owner;",
                "SET default_tablespace = '';",
                "CREATE TABLE customers (id integer NOT NULL) TABLESPACE fast_ssd;",
                "CREATE INDEX idx ON customers (id) TABLESPACE fast_ssd;",
                "ALTER TABLE customers SET TABLESPACE fast_ssd;");

        String out = PgSchemaExtractor.sanitizeDumpForStaging(dump);
        String low = out.toLowerCase();

        assertFalse(low.contains("create extension"), "extension dropped:\n" + out);
        assertFalse(low.contains("comment on extension"), "extension comment dropped:\n" + out);
        assertFalse(low.contains("create role"), "role dropped:\n" + out);
        assertFalse(low.contains("tablespace"), "all tablespace refs removed:\n" + out);
        assertTrue(out.contains("CREATE TABLE customers (id integer NOT NULL)"), "table kept w/o tablespace:\n" + out);
    }

    @Test
    void restoresOriginalSchemaFromDump() {
        ParsedTable t = new ParsedTable();
        t.setPhysicalName("customer_contacts");
        t.setSchemaName("");   // staging 추출 후 schema 비어있는 상태
        ParsedDdl parsed = new ParsedDdl(java.util.List.of(t));

        String dump = "CREATE TABLE banksys.customer_contacts (id integer);";
        PgSchemaExtractor.restoreOriginalSchemas(parsed, dump);

        assertTrue("banksys".equals(parsed.getTables().get(0).getSchemaName()),
                "schema should be restored to banksys, was: " + parsed.getTables().get(0).getSchemaName());
    }
}
