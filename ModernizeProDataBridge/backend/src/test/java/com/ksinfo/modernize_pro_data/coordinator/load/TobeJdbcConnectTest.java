package com.ksinfo.modernize_pro_data.coordinator.load;

import org.junit.jupiter.api.Test;

import java.util.HashMap;
import java.util.Map;
import java.util.Properties;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** TobeJdbcConnect — dialect별 URL/props/포트 + 하위호환 기본(PG) + 미지원 판별. */
class TobeJdbcConnectTest {

    private static Map<String, Object> cfg(String type, Object port) {
        Map<String, Object> m = new HashMap<>();
        if (type != null) m.put("type", type);
        m.put("host", "h");
        m.put("database", "DB");
        m.put("username", "u");
        m.put("password", "p");
        if (port != null) m.put("port", port);
        return m;
    }

    @Test
    void postgresUrlAndDefaultPort() {
        assertEquals("jdbc:postgresql://h:5432/DB", TobeJdbcConnect.url(cfg("PostgreSQL", null)));
        assertEquals("jdbc:postgresql://h:6000/DB", TobeJdbcConnect.url(cfg("postgres", 6000)));
    }

    @Test
    void absentTypeDefaultsToPostgres() {
        assertEquals("postgresql", TobeJdbcConnect.dialect(cfg(null, null)));
        assertEquals("jdbc:postgresql://h:5432/DB", TobeJdbcConnect.url(cfg(null, null)));
    }

    @Test
    void oracleUrlAndDefaultPort() {
        assertEquals("jdbc:oracle:thin:@//h:1521/DB", TobeJdbcConnect.url(cfg("oracle", null)));
        assertEquals("jdbc:oracle:thin:@//h:1600/DB", TobeJdbcConnect.url(cfg("Oracle", "1600")));
    }

    @Test
    void supportedEngines() {
        assertTrue(TobeJdbcConnect.isSupported("postgresql"));
        assertTrue(TobeJdbcConnect.isSupported("oracle"));
        assertFalse(TobeJdbcConnect.isSupported("mysql"));
        assertFalse(TobeJdbcConnect.isSupported("mssql"));
    }

    @Test
    void timeoutProps_perDialect() {
        Properties pg = TobeJdbcConnect.props(cfg("postgresql", null), 3);
        assertEquals("3", pg.getProperty("connectTimeout"));
        assertEquals("3", pg.getProperty("loginTimeout"));
        assertEquals("4", pg.getProperty("socketTimeout"));
        assertEquals("u", pg.getProperty("user"));

        Properties ora = TobeJdbcConnect.props(cfg("oracle", null), 3);
        assertEquals("3000", ora.getProperty("oracle.net.CONNECT_TIMEOUT"));
        assertEquals("4000", ora.getProperty("oracle.jdbc.ReadTimeout"));
    }
}
