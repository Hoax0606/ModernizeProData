package com.ksinfo.modernize_pro_data.common.duckdb;

import org.junit.jupiter.api.Test;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.Statement;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * ValidationReportService 가 md5→SHA-256 으로 바뀌면서, DuckDB 의 sha256() 가 PG 의
 * encode(sha256(convert_to(...,'UTF8')),'hex') 와 <b>같은 hex</b> 를 내는지 검증.
 * (다르면 모든 checksum 비교가 FAIL 됨.) 표준값 sha256("abc") 와 대조.
 */
class DuckDbSha256Test {

    private static final String SHA256_ABC =
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

    @Test
    void duckdbSha256MatchesStandardHex() throws Exception {
        try (Connection conn = DriverManager.getConnection("jdbc:duckdb:");
             Statement st = conn.createStatement();
             ResultSet rs = st.executeQuery("SELECT sha256('abc')")) {
            rs.next();
            assertEquals(SHA256_ABC, rs.getString(1),
                    "DuckDB sha256('abc') 가 표준 SHA-256 hex 와 달라 PG 와 매칭 실패");
        }
    }
}
