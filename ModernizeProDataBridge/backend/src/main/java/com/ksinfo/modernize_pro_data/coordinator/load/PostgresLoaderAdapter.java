package com.ksinfo.modernize_pro_data.coordinator.load;

import com.ksinfo.modernize_pro_data.coordinator.ddl.DdlColumn;
import com.ksinfo.modernize_pro_data.coordinator.ddl.DialectUtil;
import com.ksinfo.modernize_pro_data.coordinator.load.spi.LoadRequest;
import com.ksinfo.modernize_pro_data.coordinator.load.spi.LoaderAdapter;
import com.ksinfo.modernize_pro_data.coordinator.load.spi.MergeRequest;
import com.ksinfo.modernize_pro_data.coordinator.load.spi.TobeSqlDialect;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

import java.sql.Connection;
import java.util.List;
import java.util.Map;

/**
 * PostgreSQL 적재 어댑터 — 기존 {@link PgCopyManager} + {@link PgDdlGenerator} 를 위임 래핑.
 * <b>동작 불변</b>: 모든 SQL·COPY·세션튜닝은 기존 구현 그대로. LoaderAdapter SPI 도입을 위한 얇은 래퍼.
 */
@Component
@RequiredArgsConstructor
public class PostgresLoaderAdapter implements LoaderAdapter {

    private final PgCopyManager pgCopyManager;

    @Override
    public boolean supports(String dialect) {
        return DialectUtil.POSTGRESQL.equals(dialect);
    }

    @Override
    public String dialect() {
        return DialectUtil.POSTGRESQL;
    }

    @Override
    public Connection openConnection(Map<String, Object> dbConfig, boolean allowLoadTuning) throws Exception {
        return pgCopyManager.openConnection(dbConfig, allowLoadTuning);
    }

    @Override
    public String createSchemaIfNotExists(String schema) {
        return PgDdlGenerator.createSchemaIfNotExists(schema);
    }

    @Override
    public String createTableIfNotExists(String schema, String table, List<DdlColumn> cols, String targetCharset) {
        // PG 는 UTF-8 고정 — targetCharset 무시 (기존 동작).
        return PgDdlGenerator.createTableIfNotExists(schema, table, cols);
    }

    @Override
    public List<String> primaryKeyColumns(List<DdlColumn> cols) {
        return PgDdlGenerator.primaryKeyColumns(cols);
    }

    @Override
    public String addPrimaryKeySql(String schema, String table, List<String> pkColumns) {
        return PgDdlGenerator.addPrimaryKeySql(schema, table, pkColumns);
    }

    @Override
    public String addUniqueConstraintSql(String schema, String table, String constraintName, List<String> columns) {
        return PgDdlGenerator.addUniqueConstraintSql(schema, table, constraintName, columns);
    }

    @Override
    public String addForeignKeyNotValidSql(String schema, String table, String fkName, List<String> columns,
                                           String refSchema, String refTable, List<String> refColumns,
                                           String onDelete, String onUpdate, String deferrableInfo) {
        return PgDdlGenerator.addForeignKeyNotValidSql(schema, table, fkName, columns,
                refSchema, refTable, refColumns, onDelete, onUpdate, deferrableInfo);
    }

    @Override
    public String validateForeignKeySql(String schema, String table, String fkName) {
        return PgDdlGenerator.validateForeignKeySql(schema, table, fkName);
    }

    @Override
    public String addCheckConstraintNotValidSql(String schema, String table, String constraintName, String checkExpression) {
        return PgDdlGenerator.addCheckConstraintNotValidSql(schema, table, constraintName, checkExpression);
    }

    @Override
    public String validateCheckConstraintSql(String schema, String table, String constraintName) {
        return PgDdlGenerator.validateCheckConstraintSql(schema, table, constraintName);
    }

    @Override
    public void truncate(Connection c, String qualifiedTable) throws Exception {
        pgCopyManager.truncate(c, qualifiedTable);
    }

    @Override
    public boolean tryDisableConstraints(Connection c) {
        return pgCopyManager.tryDisableConstraints(c);
    }

    @Override
    public void restoreConstraints(Connection c) {
        pgCopyManager.restoreConstraints(c);
    }

    @Override
    public long load(LoadRequest req) throws Exception {
        return pgCopyManager.copyInFromResultSet(
                req.connection(), req.qualifiedTable(), req.columns(), req.resultSet(), req.cancelled());
    }

    @Override
    public long merge(MergeRequest req) throws Exception {
        // PG 는 ON CONFLICT 네이티브 — staging COPY 후 upsert + delete (PgCopyManager 캡슐화).
        return pgCopyManager.mergeFromResultSet(
                req.connection(), req.qualifiedTable(), req.columns(), req.opColumn(),
                req.pkColumns(), req.resultSet(), req.cancelled());
    }

    @Override
    public TobeSqlDialect sql() {
        return PostgresSqlDialect.INSTANCE;
    }
}
