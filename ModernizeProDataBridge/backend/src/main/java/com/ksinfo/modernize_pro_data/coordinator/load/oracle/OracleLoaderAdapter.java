package com.ksinfo.modernize_pro_data.coordinator.load.oracle;

import com.ksinfo.modernize_pro_data.coordinator.ddl.DdlColumn;
import com.ksinfo.modernize_pro_data.coordinator.ddl.DialectUtil;
import com.ksinfo.modernize_pro_data.coordinator.load.charset.TargetCharset;
import com.ksinfo.modernize_pro_data.coordinator.load.charset.TargetCharsetMapper;
import com.ksinfo.modernize_pro_data.coordinator.load.charset.TargetCharsetValidator;
import com.ksinfo.modernize_pro_data.coordinator.load.spi.LoadRequest;
import com.ksinfo.modernize_pro_data.coordinator.load.spi.LoaderAdapter;
import com.ksinfo.modernize_pro_data.coordinator.load.spi.TobeSqlDialect;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.nio.charset.CharsetEncoder;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Properties;
import java.util.concurrent.CancellationException;
import java.util.stream.Collectors;

/**
 * Oracle 적재 어댑터 (B2) — DuckDB ResultSet 을 <b>JDBC batch INSERT</b> 로 Oracle 에 직접 스트리밍.
 *
 * <p>PG 는 {@code PgCopyManager.copyInFromResultSet} 로 COPY 직결. Oracle 도 마찬가지로 <b>중간 파일 없이</b>
 * ojdbc PreparedStatement 배치로 적재한다. <b>문자셋 변환(UTF-8 → 타깃 NLS_CHARACTERSET)은 ojdbc 드라이버가
 * INSERT 시점에 수행</b>하므로 별도 인코딩 파일(.dat)·sqlldr·Oracle Instant Client 가 불필요하다.
 *
 * <p>보존 계약:
 * <ul>
 *   <li><b>원자성</b>: {@code autoCommit=false} → 전 배치 후 commit, 실패 시 rollback 후 throw (부분 적재 없음).</li>
 *   <li><b>fail-fast</b>: 드라이버가 표현 불가 문자를 조용히 {@code ?} 치환할 수 있어, String 바인딩 전
 *       {@link TargetCharsetValidator} 로 타깃 charset 표현 가능성을 검사(금융 무손실).</li>
 *   <li><b>취소</b>: 4096행마다 cancel 검사 → {@link CancellationException} (LoadStage 가 Stop 으로 처리).</li>
 *   <li>Oracle 의 {@code ''}=NULL 의미상 빈 문자열은 NULL 로 저장(기존 sqlldr 경로와 동일).</li>
 * </ul>
 *
 * <p>DDL/제약 SQL 은 {@link OracleDdlGenerator}, 읽기 방언은 {@link OracleSqlDialect}.
 */
@Component
@Slf4j
public class OracleLoaderAdapter implements LoaderAdapter {

    /** 배치 실행 단위(행). 취소 검사 경계와 동일. */
    private static final int BATCH_SIZE = 4096;

    @Override
    public boolean supports(String dialect) {
        return DialectUtil.ORACLE.equals(dialect);
    }

    @Override
    public String dialect() {
        return DialectUtil.ORACLE;
    }

    @Override
    public Connection openConnection(Map<String, Object> dbConfig, boolean allowLoadTuning) throws Exception {
        String host = str(dbConfig.get("host"));
        String service = str(dbConfig.get("database"));
        String user = str(dbConfig.get("username"));
        String pass = str(dbConfig.get("password"));
        Object portObj = dbConfig.get("port");
        int port = portObj instanceof Number n ? n.intValue()
                : portObj instanceof String s && !s.isBlank() ? Integer.parseInt(s) : 1521;
        if (host.isBlank() || service.isBlank()) {
            throw new IllegalStateException("host or database(service) missing in tobe DB config");
        }
        String url = "jdbc:oracle:thin:@//" + host + ":" + port + "/" + service;
        Properties props = new Properties();
        if (!user.isBlank()) props.setProperty("user", user);
        if (!pass.isBlank()) props.setProperty("password", pass);
        return DriverManager.getConnection(url, props);
    }

    /* ── DDL (LoadStage 가 실행; OracleDdlGenerator 가 멱등/문법 담당) ── */

    @Override
    public String createSchemaIfNotExists(String schema) {
        return OracleDdlGenerator.createSchemaIfNotExists(schema);
    }

    @Override
    public String createTableIfNotExists(String schema, String table, List<DdlColumn> cols, String targetCharset) {
        return OracleDdlGenerator.createTableIfNotExists(schema, table, cols, targetCharset);
    }

    @Override
    public List<String> primaryKeyColumns(List<DdlColumn> cols) {
        return OracleDdlGenerator.primaryKeyColumns(cols);
    }

    @Override
    public String addPrimaryKeySql(String schema, String table, List<String> pkColumns) {
        return OracleDdlGenerator.addPrimaryKeySql(schema, table, pkColumns);
    }

    @Override
    public String addUniqueConstraintSql(String schema, String table, String constraintName, List<String> columns) {
        return OracleDdlGenerator.addUniqueConstraintSql(schema, table, constraintName, columns);
    }

    @Override
    public String addForeignKeyNotValidSql(String schema, String table, String fkName, List<String> columns,
                                           String refSchema, String refTable, List<String> refColumns,
                                           String onDelete, String onUpdate, String deferrableInfo) {
        return OracleDdlGenerator.addForeignKeyNotValidSql(schema, table, fkName, columns,
                refSchema, refTable, refColumns, onDelete, onUpdate, deferrableInfo);
    }

    @Override
    public String validateForeignKeySql(String schema, String table, String fkName) {
        return OracleDdlGenerator.validateForeignKeySql(schema, table, fkName);
    }

    @Override
    public String addCheckConstraintNotValidSql(String schema, String table, String constraintName, String checkExpression) {
        return OracleDdlGenerator.addCheckConstraintNotValidSql(schema, table, constraintName, checkExpression);
    }

    @Override
    public String validateCheckConstraintSql(String schema, String table, String constraintName) {
        return OracleDdlGenerator.validateCheckConstraintSql(schema, table, constraintName);
    }

    /* ── 적재 (JDBC batch) ── */

    @Override
    public void truncate(Connection c, String qualifiedTable) throws Exception {
        try (var st = c.createStatement()) {
            st.executeUpdate("TRUNCATE TABLE " + qualifiedTable);
        }
    }

    @Override
    public long load(LoadRequest req) throws Exception {
        List<DdlColumn> meta = req.columnMeta();
        if (meta == null || meta.isEmpty()) {
            throw new IllegalStateException("Oracle 적재는 TO-BE 컬럼 메타(DDL)가 필요합니다 — "
                    + req.tobeTable() + " 의 DDL 이 임포트됐는지 확인하세요.");
        }
        List<String> columns = req.columns();

        // 타깃 charset fail-fast 검사기 — 비-UTF8(SJIS/EUC)일 때만. UTF-8/미지정이면 검사 불필요.
        Optional<TargetCharset> tc = TargetCharsetMapper.find(req.targetCharset());
        CharsetEncoder enc = (tc.isPresent() && tc.get() != TargetCharset.AL32UTF8)
                ? TargetCharsetValidator.reportingEncoder(tc.get().charset()) : null;

        String insertSql = buildInsert(req.qualifiedTable(), columns);
        Connection conn = req.connection();
        boolean prevAuto = conn.getAutoCommit();
        conn.setAutoCommit(false);
        long rows = 0;
        try (PreparedStatement ps = conn.prepareStatement(insertSql)) {
            ResultSet rs = req.resultSet();
            int colCount = columns.size();
            int inBatch = 0;
            while (rs.next()) {
                if ((rows & 0xFFF) == 0 && req.cancelled().getAsBoolean()) {
                    throw new CancellationException(
                            "load cancelled after " + rows + " rows into " + req.qualifiedTable());
                }
                for (int i = 1; i <= colCount; i++) {
                    Object v = rs.getObject(i);
                    if (enc != null && v instanceof String s) {
                        TargetCharsetValidator.checkEncodable(enc, s, rows + 1, columns.get(i - 1));
                    }
                    ps.setObject(i, v);   // v==null → SQL NULL (Oracle 은 ''도 NULL)
                }
                ps.addBatch();
                rows++;
                if (++inBatch >= BATCH_SIZE) { ps.executeBatch(); inBatch = 0; }
            }
            if (inBatch > 0) ps.executeBatch();
            conn.commit();
        } catch (Exception e) {
            try { conn.rollback(); } catch (Exception ignore) { /* best-effort */ }
            throw e;
        } finally {
            try { conn.setAutoCommit(prevAuto); } catch (Exception ignore) { /* best-effort */ }
        }
        log.info("Oracle JDBC batch load {} : {} rows", req.qualifiedTable(), rows);
        return rows;
    }

    /** {@code INSERT INTO "schema"."table" ("c1","c2",…) VALUES (?,?,…)}. */
    private static String buildInsert(String qualifiedTable, List<String> columns) {
        String cols = columns.stream().map(OracleDdlGenerator::ident).collect(Collectors.joining(", "));
        String qs = columns.stream().map(c -> "?").collect(Collectors.joining(", "));
        return "INSERT INTO " + qualifiedTable + " (" + cols + ") VALUES (" + qs + ")";
    }

    @Override
    public TobeSqlDialect sql() {
        return OracleSqlDialect.INSTANCE;
    }

    private static String str(Object o) {
        return o == null ? "" : o.toString();
    }
}
