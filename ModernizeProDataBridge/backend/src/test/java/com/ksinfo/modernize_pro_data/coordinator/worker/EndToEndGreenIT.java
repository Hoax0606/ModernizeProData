package com.ksinfo.modernize_pro_data.coordinator.worker;

import com.ksinfo.modernize_pro_data.common.duckdb.DuckDbService;
import com.ksinfo.modernize_pro_data.coordinator.ddl.DdlImportService;
import com.ksinfo.modernize_pro_data.coordinator.mapping.MappingImportService;
import com.ksinfo.modernize_pro_data.coordinator.mapping.MappingRule;
import com.ksinfo.modernize_pro_data.coordinator.mapping.MappingRuleRepository;
import com.ksinfo.modernize_pro_data.coordinator.mapping.MappingTableBinding;
import com.ksinfo.modernize_pro_data.coordinator.mapping.MappingTableBindingRepository;
import com.ksinfo.modernize_pro_data.coordinator.mapping.MappingTableBindingSource;
import com.ksinfo.modernize_pro_data.coordinator.run.RunControlRegistry;
import com.ksinfo.modernize_pro_data.coordinator.run.RunHistory;
import com.ksinfo.modernize_pro_data.coordinator.run.RunHistoryRepository;
import com.ksinfo.modernize_pro_data.coordinator.run.RunStatus;
import com.ksinfo.modernize_pro_data.coordinator.run.RunType;
import com.ksinfo.modernize_pro_data.coordinator.run.TriggerSource;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageCatalog;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageInstance;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageInstanceRepository;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageStatus;
import com.ksinfo.modernize_pro_data.coordinator.runlog.RunLogIngestService;
import com.ksinfo.modernize_pro_data.coordinator.run.validation.ValidationReport;
import com.ksinfo.modernize_pro_data.coordinator.run.validation.ValidationReportRepository;
import com.ksinfo.modernize_pro_data.coordinator.site.Project;
import com.ksinfo.modernize_pro_data.coordinator.site.ProjectRepository;
import com.ksinfo.modernize_pro_data.coordinator.site.Site;
import com.ksinfo.modernize_pro_data.coordinator.site.SiteRepository;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * End-to-end green 통합테스트 (핸드오프 E13/E14) — UTF-8 CSV 를 넣고 8 stage 전 파이프라인을
 * 실제 PostgreSQL(Testcontainers) + DuckDB 로 돌려 TO-BE 적재 데이터까지 검증한다.
 *
 * <p>판정 기준(합의): 8 stage 전부 success + row count/SUM/NULL/Min-Max/PK parity PASS.
 * checksum WARN(표시 형식 차이)은 허용.
 *
 * <p>시나리오 (점진): 1:1 단순 / 1:N expand / N:N join — ARCHITECTURE 의 BANKSYS 형태를
 * 작은 인라인 데이터로 재현. 실행 경로는 {@code RunExecutionListener} 미러링.
 */
@SpringBootTest
@Testcontainers
class EndToEndGreenIT {

    @Container
    static PostgreSQLContainer<?> pg = new PostgreSQLContainer<>("postgres:18-alpine");

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry r) {
        r.add("spring.datasource.url", pg::getJdbcUrl);
        r.add("spring.datasource.username", pg::getUsername);
        r.add("spring.datasource.password", pg::getPassword);
        r.add("spring.datasource.driver-class-name", () -> "org.postgresql.Driver");
        r.add("spring.flyway.enabled", () -> "true");
        r.add("spring.jpa.hibernate.ddl-auto", () -> "validate");
    }

    @Autowired SiteRepository siteRepo;
    @Autowired ProjectRepository projectRepo;
    @Autowired DdlImportService ddlImport;
    @Autowired MappingImportService mappingImport;
    @Autowired MappingTableBindingRepository bindingRepo;
    @Autowired MappingRuleRepository ruleRepo;
    @Autowired RunHistoryRepository runRepo;
    @Autowired StageInstanceRepository stageRepo;
    @Autowired ValidationReportRepository validationRepo;
    @Autowired WorkerExecutor workerExecutor;
    @Autowired DuckDbService duckDbService;
    @Autowired RunControlRegistry runControlRegistry;
    @Autowired RunLogIngestService runLogIngest;

    private static final String CODE_CSV = "domain,source_value,target_value\n";

    // ────────────────────────── 1:1 단순 ──────────────────────────
    @Test
    void scenario_1to1_simple(@TempDir Path csvDir, @TempDir Path outDir) throws Exception {
        Files.write(csvDir.resolve("ACCOUNTS.csv"),
                ("ACCOUNT_ID,BALANCE\n1,100.50\n2,200.00\n3,-3.14\n").getBytes(StandardCharsets.UTF_8));

        Project project = newProject(csvDir, "e2e-1to1");
        String pid = project.getId();
        ddlImport.importDdl(pid, "asis", "asis.sql",
                ("CREATE TABLE ACCOUNTS (ACCOUNT_ID NUMBER(10) NOT NULL, BALANCE NUMBER(18,2));\n")
                        .getBytes(StandardCharsets.UTF_8), "test");
        ddlImport.importDdl(pid, "tobe", "tobe.sql",
                ("CREATE TABLE accounts (account_id BIGINT PRIMARY KEY, balance NUMERIC(18,2));\n")
                        .getBytes(StandardCharsets.UTF_8), "test");
        // 쉼표 포함 타입은 반드시 인용(RFC 4180).
        String columnCsv =
                "asis_table,asis_column,asis_type,tobe_table,tobe_column,tobe_type,code_domain,default_value,transform_sql,notes\n" +
                "ACCOUNTS,ACCOUNT_ID,NUMBER(10),accounts,account_id,BIGINT,,,,\n" +
                "ACCOUNTS,BALANCE,\"NUMBER(18,2)\",accounts,balance,\"NUMERIC(18,2)\",,,,\n";
        importMapping(pid, columnCsv);
        assertThat(bindingRepo.findByProjectId(pid)).hasSize(1);

        String runId = driveRun(project, outDir);
        assertStagesGreen(runId);

        try (Connection c = pgConn(); Statement st = c.createStatement()) {
            assertRowCount(st, "accounts", 3);
            try (ResultSet rs = st.executeQuery("SELECT account_id, balance FROM accounts ORDER BY account_id")) {
                assertThat(rs.next()).isTrue();
                assertThat(rs.getLong(1)).isEqualTo(1L);
                assertThat(rs.getBigDecimal(2)).isEqualByComparingTo("100.50");
                rs.next(); rs.next();
                assertThat(rs.getLong(1)).isEqualTo(3L);
                assertThat(rs.getBigDecimal(2)).isEqualByComparingTo("-3.14");
            }
            assertPkExists(st, "accounts");
        }
        assertNoValidationFail(runId, "accounts");
    }

    // ────────────────────────── 1:N expand ──────────────────────────
    @Test
    void scenario_1toN_expand(@TempDir Path csvDir, @TempDir Path outDir) throws Exception {
        // 고객 1명 → phone/email 채널 행으로 펼침 (값 없는 채널은 제외).
        Files.write(csvDir.resolve("CUSTOMERS.csv"),
                ("CUST_ID,PHONE,EMAIL\n"
                        + "1,010-1111,a@x.com\n"
                        + "2,010-2222,\n"          // email 없음 → email 행 제외
                        + "3,,c@z.com\n")          // phone 없음 → phone 행 제외
                        .getBytes(StandardCharsets.UTF_8));

        Project project = newProject(csvDir, "e2e-1toN");
        String pid = project.getId();
        ddlImport.importDdl(pid, "asis", "asis.sql",
                ("CREATE TABLE CUSTOMERS (CUST_ID NUMBER(10) NOT NULL, PHONE VARCHAR2(20), EMAIL VARCHAR2(200));\n")
                        .getBytes(StandardCharsets.UTF_8), "test");
        ddlImport.importDdl(pid, "tobe", "tobe.sql",
                ("CREATE TABLE customer_contacts (cust_id BIGINT, channel VARCHAR(10), value VARCHAR(200));\n")
                        .getBytes(StandardCharsets.UTF_8), "test");
        String columnCsv =
                "asis_table,asis_column,asis_type,tobe_table,tobe_column,tobe_type,code_domain,default_value,transform_sql,notes\n" +
                "CUSTOMERS,CUST_ID,NUMBER(10),customer_contacts,cust_id,BIGINT,,,,\n" +
                "CUSTOMERS,PHONE,VARCHAR2(20),customer_contacts,channel,\"VARCHAR(10)\",,,,\n" +
                "CUSTOMERS,EMAIL,VARCHAR2(200),customer_contacts,value,\"VARCHAR(200)\",,,,\n";
        importMapping(pid, columnCsv);

        // CSV importer 는 expand 를 표현 못 하므로 binding 을 1:N expand 로 패치 (UI 편집과 동등).
        MappingTableBinding b = bindingOf(pid, "customer_contacts");
        String a = b.getSources().get(0).getAlias();   // primary(CUSTOMERS) alias
        b.setExpandExpr("CROSS JOIN LATERAL (VALUES ('phone', " + a + ".PHONE), ('email', " + a + ".EMAIL)) AS u(channel, value)");
        b.setWhereFilter("u.value IS NOT NULL AND TRIM(u.value) <> ''");
        bindingRepo.save(b);
        patchRule(pid, "customer_contacts", "channel", "u.channel");
        patchRule(pid, "customer_contacts", "value", "u.value");

        String runId = driveRun(project, outDir);
        assertStagesGreen(runId);

        try (Connection c = pgConn(); Statement st = c.createStatement()) {
            assertRowCount(st, "customer_contacts", 4);   // 1:2, 2:1(phone), 3:1(email)
            // 채널 값은 'phone'/'email' 만, 길이 ≤ 10.
            try (ResultSet rs = st.executeQuery("SELECT DISTINCT channel FROM customer_contacts ORDER BY channel")) {
                assertThat(rs.next()).isTrue(); assertThat(rs.getString(1)).isEqualTo("email");
                assertThat(rs.next()).isTrue(); assertThat(rs.getString(1)).isEqualTo("phone");
            }
            // 고객 1 은 두 채널.
            try (ResultSet rs = st.executeQuery(
                    "SELECT count(*) FROM customer_contacts WHERE cust_id = 1")) {
                rs.next(); assertThat(rs.getInt(1)).isEqualTo(2);
            }
            // 값 없는 채널은 안 들어감.
            try (ResultSet rs = st.executeQuery(
                    "SELECT count(*) FROM customer_contacts WHERE value IS NULL OR TRIM(value) = ''")) {
                rs.next(); assertThat(rs.getInt(1)).as("빈 값 채널 제외").isZero();
            }
        }
        assertNoValidationFail(runId, "customer_contacts");
    }

    // ────────────────────────── N:N (join) ──────────────────────────
    @Test
    void scenario_NtoN_join(@TempDir Path csvDir, @TempDir Path outDir) throws Exception {
        Files.write(csvDir.resolve("CUSTOMERS.csv"),
                ("CUST_ID,NAME\n1,Alice\n2,Bob\n").getBytes(StandardCharsets.UTF_8));
        Files.write(csvDir.resolve("CONTACT_INFO.csv"),
                ("CUST_ID,PREFERRED_CHANNEL\n1,phone\n2,email\n").getBytes(StandardCharsets.UTF_8));

        Project project = newProject(csvDir, "e2e-NtoN");
        String pid = project.getId();
        ddlImport.importDdl(pid, "asis", "asis.sql",
                ("CREATE TABLE CUSTOMERS (CUST_ID NUMBER(10) NOT NULL, NAME VARCHAR2(100));\n"
                        + "CREATE TABLE CONTACT_INFO (CUST_ID NUMBER(10) NOT NULL, PREFERRED_CHANNEL VARCHAR2(10));\n")
                        .getBytes(StandardCharsets.UTF_8), "test");
        ddlImport.importDdl(pid, "tobe", "tobe.sql",
                ("CREATE TABLE customer_full_profile (cust_id BIGINT PRIMARY KEY, name VARCHAR(100), preferred_channel VARCHAR(10));\n")
                        .getBytes(StandardCharsets.UTF_8), "test");
        String columnCsv =
                "asis_table,asis_column,asis_type,tobe_table,tobe_column,tobe_type,code_domain,default_value,transform_sql,notes\n" +
                "CUSTOMERS,CUST_ID,NUMBER(10),customer_full_profile,cust_id,BIGINT,,,,\n" +
                "CUSTOMERS,NAME,VARCHAR2(100),customer_full_profile,name,\"VARCHAR(100)\",,,,\n" +
                "CONTACT_INFO,PREFERRED_CHANNEL,VARCHAR2(10),customer_full_profile,preferred_channel,\"VARCHAR(10)\",,,,\n";
        importMapping(pid, columnCsv);

        // join binding 의 joinType/joinOn 은 import 시 null → 패치 (UI 편집과 동등).
        MappingTableBinding b = bindingOf(pid, "customer_full_profile");
        assertThat(b.getCompositionKind()).isEqualTo("join");
        MappingTableBindingSource primary = b.getSources().stream()
                .filter(s -> "primary".equals(s.getRole())).findFirst().orElseThrow();
        MappingTableBindingSource join = b.getSources().stream()
                .filter(s -> "join".equals(s.getRole())).findFirst().orElseThrow();
        join.setJoinType("LEFT");
        join.setJoinOn(join.getAlias() + ".CUST_ID = " + primary.getAlias() + ".CUST_ID");
        bindingRepo.save(b);

        String runId = driveRun(project, outDir);
        assertStagesGreen(runId);

        try (Connection c = pgConn(); Statement st = c.createStatement()) {
            assertRowCount(st, "customer_full_profile", 2);
            try (ResultSet rs = st.executeQuery(
                    "SELECT cust_id, name, preferred_channel FROM customer_full_profile ORDER BY cust_id")) {
                assertThat(rs.next()).isTrue();
                assertThat(rs.getLong("cust_id")).isEqualTo(1L);
                assertThat(rs.getString("name")).isEqualTo("Alice");
                assertThat(rs.getString("preferred_channel")).isEqualTo("phone");
                assertThat(rs.next()).isTrue();
                assertThat(rs.getString("name")).isEqualTo("Bob");
                assertThat(rs.getString("preferred_channel")).isEqualTo("email");
            }
            assertPkExists(st, "customer_full_profile");
        }
        assertNoValidationFail(runId, "customer_full_profile");
    }

    // ─────────────────── Shift-JIS 입력 (SPI 변환 seam) ───────────────────
    @Test
    void scenario_shiftJis_input_decodedToUtf8(@TempDir Path csvDir, @TempDir Path outDir) throws Exception {
        // CSV 를 Shift-JIS(MS932) 로 인코딩 + site.asisEncoding=Shift_JIS → ExtractStage 의
        // SourceReader SPI 가 UTF-8 로 변환한 뒤 파이프라인 진행 (일본어 데이터 보존 검증).
        String csv = "ACCOUNT_ID,OWNER\n1,あ\n2,髙\n";   // 髙 = 機種依存文字 (MS932 벤더확장)
        Files.write(csvDir.resolve("ACCOUNTS.csv"), csv.getBytes(Charset.forName("windows-31j")));

        Project project = newProject(csvDir, "e2e-sjis", "Shift_JIS");
        String pid = project.getId();
        ddlImport.importDdl(pid, "asis", "asis.sql",
                ("CREATE TABLE ACCOUNTS (ACCOUNT_ID NUMBER(10) NOT NULL, OWNER VARCHAR2(50));\n")
                        .getBytes(StandardCharsets.UTF_8), "test");
        ddlImport.importDdl(pid, "tobe", "tobe.sql",
                ("CREATE TABLE accounts_sj (account_id BIGINT PRIMARY KEY, owner VARCHAR(50));\n")
                        .getBytes(StandardCharsets.UTF_8), "test");
        String columnCsv =
                "asis_table,asis_column,asis_type,tobe_table,tobe_column,tobe_type,code_domain,default_value,transform_sql,notes\n" +
                "ACCOUNTS,ACCOUNT_ID,NUMBER(10),accounts_sj,account_id,BIGINT,,,,\n" +
                "ACCOUNTS,OWNER,VARCHAR2(50),accounts_sj,owner,\"VARCHAR(50)\",,,,\n";
        importMapping(pid, columnCsv);

        String runId = driveRun(project, outDir);
        assertStagesGreen(runId);

        try (Connection c = pgConn(); Statement st = c.createStatement()) {
            assertRowCount(st, "accounts_sj", 2);
            try (ResultSet rs = st.executeQuery(
                    "SELECT account_id, owner FROM accounts_sj ORDER BY account_id")) {
                assertThat(rs.next()).isTrue();
                assertThat(rs.getString("owner")).isEqualTo("あ");          // SJIS 82A0 → UTF-8
                assertThat(rs.next()).isTrue();
                assertThat(rs.getString("owner")).isEqualTo("髙");          // 벤더문자 보존
            }
        }
        assertNoValidationFail(runId, "accounts_sj");
    }

    @Test
    void scenario_ebcdic_input_decodedToUtf8(@TempDir Path csvDir, @TempDir Path outDir) throws Exception {
        /* CSV 를 EBCDIC(x-IBM930) 로 인코딩 + site.asisEncoding=ebcdic-ibm930 → ExtractStage 의
           SourceReader SPI 가 UTF-8 로 변환한 뒤 파이프라인 진행.
           EBCDIC 은 ASCII 0x0A 가 없고 NL 0x15 를 쓴다 — charset 이 LF 로 매핑해줘서
           read_csv 가 행을 정상 분리하는지까지 확인하는 것이 이 시나리오의 핵심. */
        String csv = "ACCOUNT_ID,OWNER\n1,田中太郎\n2,東京\n";
        byte[] ebcdic = csv.getBytes(Charset.forName("x-IBM930"));
        assertThat(ebcdic).as("EBCDIC 원본에 ASCII 개행이 없어야 시나리오가 의미 있음")
                .doesNotContain((byte) '\n');
        Files.write(csvDir.resolve("ACCOUNTS.csv"), ebcdic);

        Project project = newProject(csvDir, "e2e-ebcdic", "ebcdic-ibm930");
        String pid = project.getId();
        ddlImport.importDdl(pid, "asis", "asis.sql",
                ("CREATE TABLE ACCOUNTS (ACCOUNT_ID NUMBER(10) NOT NULL, OWNER VARCHAR2(50));\n")
                        .getBytes(StandardCharsets.UTF_8), "test");
        ddlImport.importDdl(pid, "tobe", "tobe.sql",
                ("CREATE TABLE accounts_eb (account_id BIGINT PRIMARY KEY, owner VARCHAR(50));\n")
                        .getBytes(StandardCharsets.UTF_8), "test");
        String columnCsv =
                "asis_table,asis_column,asis_type,tobe_table,tobe_column,tobe_type,code_domain,default_value,transform_sql,notes\n" +
                "ACCOUNTS,ACCOUNT_ID,NUMBER(10),accounts_eb,account_id,BIGINT,,,,\n" +
                "ACCOUNTS,OWNER,VARCHAR2(50),accounts_eb,owner,\"VARCHAR(50)\",,,,\n";
        importMapping(pid, columnCsv);

        String runId = driveRun(project, outDir);
        assertStagesGreen(runId);

        try (Connection c = pgConn(); Statement st = c.createStatement()) {
            assertRowCount(st, "accounts_eb", 2);
            try (ResultSet rs = st.executeQuery(
                    "SELECT account_id, owner FROM accounts_eb ORDER BY account_id")) {
                assertThat(rs.next()).isTrue();
                assertThat(rs.getString("owner")).isEqualTo("田中太郎");   // DBCS (SO/SI) 보존
                assertThat(rs.next()).isTrue();
                assertThat(rs.getString("owner")).isEqualTo("東京");
            }
        }
        assertNoValidationFail(runId, "accounts_eb");
    }

    // ────────────────────────── 헬퍼 ──────────────────────────

    private Project newProject(Path csvDir, String name) {
        return newProject(csvDir, name, "UTF-8");
    }

    private Project newProject(Path csvDir, String name, String asisEncoding) {
        Map<String, Object> tobeCfg = Map.of(
                "host", pg.getHost(), "port", pg.getFirstMappedPort(),
                "database", pg.getDatabaseName(), "username", pg.getUsername(), "password", pg.getPassword());
        Site site = Site.create(name + "-site", "prod", "dev", asisEncoding, "UTF-8",
                csvDir.toString(), null, "dev", Map.of("dev", tobeCfg), Map.of(), "test");
        siteRepo.save(site);
        Project p = Project.create(site.getId(), name, "test");
        projectRepo.save(p);
        return p;
    }

    private void importMapping(String pid, String columnCsv) {
        mappingImport.importFromCsv(pid,
                columnCsv.getBytes(StandardCharsets.UTF_8), "column_mapping.csv",
                CODE_CSV.getBytes(StandardCharsets.UTF_8), "code_mapping.csv", "test");
    }

    private MappingTableBinding bindingOf(String pid, String tobeTable) {
        return bindingRepo.findByProjectId(pid).stream()
                .filter(b -> tobeTable.equals(b.getTobeTable())).findFirst().orElseThrow();
    }

    private void patchRule(String pid, String tobeTable, String tobeColumn, String transform) {
        for (MappingRule r : ruleRepo.findByProjectIdAndTobeTable(pid, tobeTable)) {
            if (tobeColumn.equals(r.getTobeColumn())) {
                r.setTransformRule(transform);
                r.setTransformSql(transform);
                ruleRepo.save(r);
            }
        }
    }

    /** RunExecutionListener 미러링 — run+stage 생성, DuckDB run connection 바인딩, execute. */
    private String driveRun(Project project, Path outDir) throws Exception {
        String pid = project.getId();
        List<MappingTableBinding> bindings = bindingRepo.findByProjectId(pid);
        Site site = siteRepo.findById(project.getSiteId()).orElseThrow();

        RunHistory rh = RunHistory.create(pid, RunType.test, TriggerSource.internal, "test", null, null);
        rh.setStatus(RunStatus.running);
        runRepo.save(rh);
        String runId = rh.getId();

        List<StageInstance> stages = new ArrayList<>();
        int seq = 1;
        for (String key : StageCatalog.forRunType(RunType.test)) {
            StageInstance si = StageInstance.create(runId, key, seq++, bindings.size());
            stageRepo.save(si);
            stages.add(si);
        }

        Files.createDirectories(outDir.resolve("parquet1"));
        Files.createDirectories(outDir.resolve("parquet2"));
        Files.createDirectories(outDir.resolve("quarantine"));
        Files.createDirectories(outDir.resolve("duck-tmp"));

        StageContext ctx = StageContext.builder()
                .runHistory(rh).project(project).site(site)
                .bindings(bindings).stages(stages)
                .outputDir(outDir).duckdbSchema("run_" + runId.replace("-", "_"))
                .runControlRegistry(runControlRegistry).build();

        runLogIngest.openRun(runId, pid);
        runControlRegistry.register(runId);
        duckDbService.bindRunConnection("512MB", outDir.resolve("duck-tmp").toString());
        ctx.setDuckConnection(duckDbService.currentRunConnection());
        try {
            workerExecutor.execute(ctx);
        } finally {
            runControlRegistry.remove(runId);
            duckDbService.unbindRunConnection();
            try { runLogIngest.closeRun(runId); } catch (Exception ignore) { }
        }
        return runId;
    }

    private void assertStagesGreen(String runId) {
        List<StageInstance> done = stageRepo.findByRunIdOrderBySeqAsc(runId);
        assertThat(done).hasSize(8);
        assertThat(done).allSatisfy(si ->
                assertThat(si.getStatus()).as("stage %s", si.getStageKey()).isEqualTo(StageStatus.success));
    }

    private Connection pgConn() throws Exception {
        return DriverManager.getConnection(pg.getJdbcUrl(), pg.getUsername(), pg.getPassword());
    }

    private void assertRowCount(Statement st, String table, int expected) throws Exception {
        try (ResultSet rs = st.executeQuery("SELECT count(*) FROM " + table)) {
            rs.next();
            assertThat(rs.getInt(1)).as("row count %s", table).isEqualTo(expected);
        }
    }

    private void assertPkExists(Statement st, String table) throws Exception {
        try (ResultSet rs = st.executeQuery(
                "SELECT count(*) FROM information_schema.table_constraints "
                + "WHERE table_name='" + table + "' AND constraint_type='PRIMARY KEY'")) {
            rs.next();
            assertThat(rs.getInt(1)).as("PK on %s", table).isEqualTo(1);
        }
    }

    private void assertNoValidationFail(String runId, String tobeTable) {
        List<ValidationReport> reports = validationRepo.findByRunId(runId);
        assertThat(reports).as("validation report 생성").isNotEmpty();
        ValidationReport rep = reports.stream()
                .filter(r -> tobeTable.equals(r.getTobeTable())).findFirst().orElseThrow();
        assertThat(rep.getReportData().toString())
                .as("validation FAIL 없음(WARN 허용)").doesNotContain("FAIL");
    }
}
