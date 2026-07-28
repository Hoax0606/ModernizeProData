package com.ksinfo.modernize_pro_data.coordinator.ddl;

/**
 * TO-BE / AS-IS DB 타입 표시명 → dialect 코드 정규화.
 *
 * <p>DDL parser 선택뿐 아니라 <b>LoaderAdapter 선택</b>(coordinator/load/spi), 연결·헬스 분기
 * (TobeDbController / TobeDbHealthService) 가 공용으로 쓴다. 기존 {@code DdlImportService.normalizeDialect}
 * 를 추출한 것 — 동작(매핑·폴백) 동일. 한 곳에서만 유지하기 위해 static util 로.
 */
public final class DialectUtil {

    private DialectUtil() {}

    public static final String POSTGRESQL = "postgresql";
    public static final String ORACLE = "oracle";
    public static final String MSSQL = "mssql";
    public static final String MYSQL = "mysql";
    public static final String DB2 = "db2";

    /** UI 표시명을 dialect 코드로 정규화. 알려지지 않은/빈/null 값은 "oracle" 폴백 (기존 동작 유지). */
    public static String normalize(String raw) {
        if (raw == null) return ORACLE;
        String s = raw.trim().toLowerCase();
        if (s.isEmpty()) return ORACLE;
        if (s.contains("postgres")) return POSTGRESQL;
        if (s.contains("sql server") || s.equals("mssql") || s.contains("microsoft")) return MSSQL;
        if (s.contains("mysql") || s.contains("mariadb")) return MYSQL;
        if (s.contains("db2")) return DB2;
        if (s.contains("oracle")) return ORACLE;
        return ORACLE;  // 모르면 폴백
    }
}
