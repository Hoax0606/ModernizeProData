package com.ksinfo.modernize_pro_data.common.duckdb.udf;

import org.duckdb.DuckDBFunctions;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.sql.Connection;
import java.sql.SQLException;
import java.util.HexFormat;
import java.util.function.Function;

/**
 * hash_sha256(VARCHAR input) → VARCHAR
 *
 * 입력 문자열을 UTF-8 로 인코딩 후 SHA-256 해시. 64 자리 lowercase hex 반환.
 * 동일 입력에 대해 항상 같은 출력 (deterministic) — `withVolatile()` 안 씀.
 *
 *   "hello"  → "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
 *   ""       → "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
 *   null     → null
 *
 * 용도: PII 토큰화 (irreversible), 데이터 무결성 검증 (체크섬), GDPR 가명화 등.
 * **주의**: 단순 SHA-256 은 rainbow table 공격에 취약 — salt 가 필요한 케이스는
 * 별도 UDF (`hash_sha256_salted` 등) 로 분리.
 */
public final class HashSha256Udf {

    private HashSha256Udf() {}

    public static void register(Connection conn) throws SQLException {
        DuckDBFunctions.scalarFunction()
                .withName("hash_sha256")
                .withParameter(String.class)
                .withReturnType(String.class)
                .withFunction((Function<String, String>) HashSha256Udf::apply)
                .withNullInNullOut()
                .register(conn);
    }

    static String apply(String input) {
        if (input == null) return null;
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] digest = md.digest(input.getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(digest);
        } catch (Exception e) {
            return null;
        }
    }
}
