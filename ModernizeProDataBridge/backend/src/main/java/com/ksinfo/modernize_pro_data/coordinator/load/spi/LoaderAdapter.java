package com.ksinfo.modernize_pro_data.coordinator.load.spi;

import com.ksinfo.modernize_pro_data.coordinator.ddl.DdlColumn;

import java.sql.Connection;
import java.util.List;
import java.util.Map;

/**
 * TO-BE 엔진별 적재 어댑터 SPI. PG(현 PgCopyManager/PgDdlGenerator)와 Oracle 등이 각자 구현.
 *
 * <p>설계 원칙: LoadStage 는 오케스트레이션(로깅·autocommit·quarantine)을 유지하고, 어댑터는
 * (1) 연결 열기 (2) DDL SQL 문자열 생성 (3) 적재 실행 (4) 읽기용 방언({@link #sql()}) 을 제공.
 * DDL 은 SQL 문자열로 반환해 LoadStage 가 실행/멱등 처리(기존 동작 보존)한다.
 * Verify/Check/Validation 도 {@link #openConnection} + {@link #sql()} 로 엔진 중립 접근.
 */
public interface LoaderAdapter {

    /** {@link com.ksinfo.modernize_pro_data.coordinator.ddl.DialectUtil#normalize} 결과와 매칭. */
    boolean supports(String dialect);

    String dialect();

    // ── 연결 ──────────────────────────────────────────────────────────────
    /** TO-BE 연결. {@code allowLoadTuning}=false 면 대량적재 튜닝(예: PG synchronous_commit off) 금지(cutover). */
    Connection openConnection(Map<String, Object> dbConfig, boolean allowLoadTuning) throws Exception;

    // ── DDL SQL 생성 (LoadStage 가 실행) ──────────────────────────────────
    String createSchemaIfNotExists(String schema);

    /** {@code targetCharset} = Oracle VARCHAR2(n CHAR) 등 문자셋 인지 사이징용 (PG 는 무시). */
    String createTableIfNotExists(String schema, String table, List<DdlColumn> cols, String targetCharset);

    List<String> primaryKeyColumns(List<DdlColumn> cols);

    String addPrimaryKeySql(String schema, String table, List<String> pkColumns);

    String addUniqueConstraintSql(String schema, String table, String constraintName, List<String> columns);

    String addForeignKeyNotValidSql(String schema, String table, String fkName, List<String> columns,
                                    String refSchema, String refTable, List<String> refColumns,
                                    String onDelete, String onUpdate, String deferrableInfo);

    String validateForeignKeySql(String schema, String table, String fkName);

    String addCheckConstraintNotValidSql(String schema, String table, String constraintName, String checkExpression);

    String validateCheckConstraintSql(String schema, String table, String constraintName);

    // ── 적재 ──────────────────────────────────────────────────────────────
    void truncate(Connection c, String qualifiedTable) throws Exception;

    /** FK/trigger 비활성 시도(대량적재). 성공 시 caller 가 {@link #restoreConstraints} 호출. 기본 no-op. */
    default boolean tryDisableConstraints(Connection c) { return false; }

    default void restoreConstraints(Connection c) {}

    /** 실제 적재. 반환 = 적재 row 수. 하드 실패 시 throw. */
    long load(LoadRequest req) throws Exception;

    // ── 읽기 방언 ─────────────────────────────────────────────────────────
    TobeSqlDialect sql();
}
