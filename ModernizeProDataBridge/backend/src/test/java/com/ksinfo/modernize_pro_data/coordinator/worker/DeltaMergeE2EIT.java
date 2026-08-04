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
import com.ksinfo.modernize_pro_data.coordinator.run.delta.DeltaWatermark;
import com.ksinfo.modernize_pro_data.coordinator.run.delta.DeltaWatermarkRepository;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageCatalog;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageInstance;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageInstanceRepository;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageStatus;
import com.ksinfo.modernize_pro_data.coordinator.runlog.RunLogIngestService;
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

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 델타(CDC 증분) 병합 E2E — 초기 전량적재(test) 이후 {@code RunType.delta} run 이
 * 전 스테이지(check/extract/transform/load-merge)를 실제로 통과해 타깃에 I/U/D 를 반영하는지
 * 검증. {@link PgDeltaMergeIT}(엔진 단독)와 달리 <b>오케스트레이션 이음새</b>(Extract 가 __op 를
 * 싣고, Transform 이 passthrough, StageCatalog 가 delta 스테이지, LoadStage 가 병합 모드)를 확인.
 *
 * <p>실행 경로는 {@code RunExecutionListener} 미러링(EndToEndGreenIT 와 동일 방식).
 */
@SpringBootTest
@Testcontainers
class DeltaMergeE2EIT {

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
    @Autowired WorkerExecutor workerExecutor;
    @Autowired DuckDbService duckDbService;
    @Autowired RunControlRegistry runControlRegistry;
    @Autowired RunLogIngestService runLogIngest;
    @Autowired DeltaWatermarkRepository deltaWatermarkRepo;

    private static final String CODE_CSV = "domain,source_value,target_value\n";

    @Test
    void deltaRunAppliesInsertUpdateDelete(@TempDir Path csvDir,
                                           @TempDir Path outInitial,
                                           @TempDir Path outDelta) throws Exception {
        // ── 초기 전량적재 (test run) — accounts = {1:A, 2:B, 3:C} + PK ──
        Files.write(csvDir.resolve("ACCOUNTS.csv"),
                ("ACCOUNT_ID,OWNER\n1,A\n2,B\n3,C\n").getBytes(StandardCharsets.UTF_8));

        Project project = newProject(csvDir, "e2e-delta");
        String pid = project.getId();
        ddlImport.importDdl(pid, "asis", "asis.sql",
                ("CREATE TABLE ACCOUNTS (ACCOUNT_ID NUMBER(10) NOT NULL, OWNER VARCHAR2(50));\n")
                        .getBytes(StandardCharsets.UTF_8), "test");
        ddlImport.importDdl(pid, "tobe", "tobe.sql",
                ("CREATE TABLE accounts (account_id BIGINT PRIMARY KEY, owner VARCHAR(50));\n")
                        .getBytes(StandardCharsets.UTF_8), "test");
        String columnCsv =
                "asis_table,asis_column,asis_type,tobe_table,tobe_column,tobe_type,code_domain,default_value,transform_sql,notes\n" +
                "ACCOUNTS,ACCOUNT_ID,NUMBER(10),accounts,account_id,BIGINT,,,,\n" +
                "ACCOUNTS,OWNER,VARCHAR2(50),accounts,owner,\"VARCHAR(50)\",,,,\n";
        importMapping(pid, columnCsv);

        String initialRunId = driveRun(project, outInitial, RunType.test);
        assertStagesGreen(initialRunId, StageCatalog.forRunType(RunType.test).size());
        try (Connection c = pgConn(); Statement st = c.createStatement()) {
            assertOwners(st, Map.of(1, "A", 2, "B", 3, "C"));
        }

        // ── 델타 run — id1=UPDATE, id4=INSERT, id2=DELETE (id3 미변경) ──
        Files.write(csvDir.resolve("ACCOUNTS.csv"),
                ("ACCOUNT_ID,OWNER,__op\n1,A2,U\n4,D,I\n2,,D\n").getBytes(StandardCharsets.UTF_8));

        String deltaRunId = driveRun(project, outDelta, RunType.delta);
        // delta 스테이지 = check/extract/reconcile/transform/load (verify/validation 생략).
        assertStagesGreen(deltaRunId, StageCatalog.forRunType(RunType.delta).size());
        assertThat(StageCatalog.forRunType(RunType.delta)).doesNotContain("verify", "validation");

        try (Connection c = pgConn(); Statement st = c.createStatement()) {
            // id2 삭제, id1 갱신, id4 삽입, id3 불변.
            assertOwners(st, Map.of(1, "A2", 3, "C", 4, "D"));
            // 제어 컬럼 __op 이 타깃 본테이블에 새면 안 됨.
            try (ResultSet rs = st.executeQuery("SELECT * FROM accounts LIMIT 0")) {
                ResultSetMetaData md = rs.getMetaData();
                for (int i = 1; i <= md.getColumnCount(); i++) {
                    assertThat(md.getColumnLabel(i)).isNotEqualToIgnoringCase("__op");
                }
            }
        }

        // 워터마크 갱신(__scn 없어 SCN 은 null 이나 커서 row 는 이 delta run 으로 기록).
        assertThat(deltaWatermarkRepo.findByProjectId(pid))
                .anyMatch(w -> "accounts".equals(w.getTobeTable()) && deltaRunId.equals(w.getLastRunId()));
    }

    @Test
    void deltaRun_expand1toN_insertUpdateDelete(@TempDir Path csvDir,
                                                @TempDir Path outInitial,
                                                @TempDir Path outDelta) throws Exception {
        // ── 초기: cust1(phone+email), cust2(phone만) → customer_contacts 3행 (expand 1:N) ──
        Files.write(csvDir.resolve("CUSTOMERS.csv"),
                ("CUST_ID,PHONE,EMAIL\n1,010-1,a@x.com\n2,010-2,\n").getBytes(StandardCharsets.UTF_8));

        Project project = newProject(csvDir, "e2e-delta-expand");
        String pid = project.getId();
        ddlImport.importDdl(pid, "asis", "asis.sql",
                ("CREATE TABLE CUSTOMERS (CUST_ID NUMBER(10) NOT NULL, PHONE VARCHAR2(20), EMAIL VARCHAR2(200));\n")
                        .getBytes(StandardCharsets.UTF_8), "test");
        // expand 타깃 — 병합 PK 는 (cust_id, channel) 복합키.
        ddlImport.importDdl(pid, "tobe", "tobe.sql",
                ("CREATE TABLE customer_contacts (cust_id BIGINT NOT NULL, channel VARCHAR(10) NOT NULL, "
                        + "value VARCHAR(200), PRIMARY KEY (cust_id, channel));\n")
                        .getBytes(StandardCharsets.UTF_8), "test");
        String columnCsv =
                "asis_table,asis_column,asis_type,tobe_table,tobe_column,tobe_type,code_domain,default_value,transform_sql,notes\n" +
                "CUSTOMERS,CUST_ID,NUMBER(10),customer_contacts,cust_id,BIGINT,,,,\n" +
                "CUSTOMERS,PHONE,VARCHAR2(20),customer_contacts,channel,\"VARCHAR(10)\",,,,\n" +
                "CUSTOMERS,EMAIL,VARCHAR2(200),customer_contacts,value,\"VARCHAR(200)\",,,,\n";
        importMapping(pid, columnCsv);

        // expand 패치 (EndToEndGreenIT 와 동일 방식 — CSV importer 는 expand 표현 불가).
        MappingTableBinding b = bindingOf(pid, "customer_contacts");
        String a = b.getSources().get(0).getAlias();
        b.setExpandExpr("CROSS JOIN LATERAL (VALUES ('phone', " + a + ".PHONE), ('email', " + a + ".EMAIL)) AS u(channel, value)");
        b.setWhereFilter("u.value IS NOT NULL AND TRIM(u.value) <> ''");
        bindingRepo.save(b);
        patchRule(pid, "customer_contacts", "channel", "u.channel");
        patchRule(pid, "customer_contacts", "value", "u.value");

        String initialRunId = driveRun(project, outInitial, RunType.test);
        assertStagesGreen(initialRunId, StageCatalog.forRunType(RunType.test).size());
        try (Connection c = pgConn(); Statement st = c.createStatement()) {
            assertContacts(st, Map.of("1|phone", "010-1", "1|email", "a@x.com", "2|phone", "010-2"));
        }

        // ── 델타: cust1 U(phone 값 변경), cust3 I(phone), cust2 D(삭제 — before-image phone 포함) ──
        Files.write(csvDir.resolve("CUSTOMERS.csv"),
                ("CUST_ID,PHONE,EMAIL,__op\n1,010-1X,a@x.com,U\n3,010-3,,I\n2,010-2,,D\n")
                        .getBytes(StandardCharsets.UTF_8));

        String deltaRunId = driveRun(project, outDelta, RunType.delta);
        assertStagesGreen(deltaRunId, StageCatalog.forRunType(RunType.delta).size());

        try (Connection c = pgConn(); Statement st = c.createStatement()) {
            // cust1 phone 갱신 + email 유지 / cust3 phone 삽입 / cust2 phone 삭제.
            assertContacts(st, Map.of("1|phone", "010-1X", "1|email", "a@x.com", "3|phone", "010-3"));
        }
    }

    @Test
    void deltaRun_join_fullRederive(@TempDir Path csvDir,
                                    @TempDir Path outInitial,
                                    @TempDir Path outDelta) throws Exception {
        // ── 초기: CUSTOMERS ⋈ CONTACT_INFO → customer_full_profile 2행 (join) ──
        Files.write(csvDir.resolve("CUSTOMERS.csv"),
                ("CUST_ID,NAME\n1,Alice\n2,Bob\n").getBytes(StandardCharsets.UTF_8));
        Files.write(csvDir.resolve("CONTACT_INFO.csv"),
                ("CUST_ID,PREFERRED_CHANNEL\n1,phone\n2,email\n").getBytes(StandardCharsets.UTF_8));

        Project project = newProject(csvDir, "e2e-delta-join");
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

        // join 패치 (EndToEndGreenIT 와 동일 — import 시 joinType/joinOn 은 null).
        MappingTableBinding b = bindingOf(pid, "customer_full_profile");
        MappingTableBindingSource primary = b.getSources().stream()
                .filter(s -> "primary".equals(s.getRole())).findFirst().orElseThrow();
        MappingTableBindingSource join = b.getSources().stream()
                .filter(s -> "join".equals(s.getRole())).findFirst().orElseThrow();
        join.setJoinType("LEFT");
        join.setJoinOn(join.getAlias() + ".CUST_ID = " + primary.getAlias() + ".CUST_ID");
        bindingRepo.save(b);

        String initialRunId = driveRun(project, outInitial, RunType.test);
        assertStagesGreen(initialRunId, StageCatalog.forRunType(RunType.test).size());
        try (Connection c = pgConn(); Statement st = c.createStatement()) {
            assertProfile(st, Map.of("1", "Alice|phone", "2", "Bob|email"));
        }

        // ── 델타 run — join 테이블은 소스 full 스냅샷(__op 없음) → 전량 재파생 ──
        // 1번 채널 phone→email 변경, 3번 신규. (delta CSV 지만 __op 없음 = full 스냅샷.)
        Files.write(csvDir.resolve("CUSTOMERS.csv"),
                ("CUST_ID,NAME\n1,Alice\n2,Bob\n3,Carol\n").getBytes(StandardCharsets.UTF_8));
        Files.write(csvDir.resolve("CONTACT_INFO.csv"),
                ("CUST_ID,PREFERRED_CHANNEL\n1,email\n2,email\n3,phone\n").getBytes(StandardCharsets.UTF_8));

        String deltaRunId = driveRun(project, outDelta, RunType.delta);
        assertStagesGreen(deltaRunId, StageCatalog.forRunType(RunType.delta).size());

        try (Connection c = pgConn(); Statement st = c.createStatement()) {
            // 전량 재파생 → 새 전체 상태 반영 (1 채널 email 로, 3 신규).
            assertProfile(st, Map.of("1", "Alice|email", "2", "Bob|email", "3", "Carol|phone"));
        }
    }

    // ────────────────────────── 헬퍼 (EndToEndGreenIT 미러링) ──────────────────────────

    private Project newProject(Path csvDir, String name) {
        Map<String, Object> tobeCfg = Map.of(
                "host", pg.getHost(), "port", pg.getFirstMappedPort(),
                "database", pg.getDatabaseName(), "username", pg.getUsername(), "password", pg.getPassword());
        Site site = Site.create(name + "-site", "prod", "dev", "UTF-8", "UTF-8",
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

    private void assertContacts(Statement st, Map<String, String> expected) throws Exception {
        Map<String, String> got = new LinkedHashMap<>();
        try (ResultSet rs = st.executeQuery(
                "SELECT cust_id, channel, value FROM customer_contacts ORDER BY cust_id, channel")) {
            while (rs.next()) got.put(rs.getInt(1) + "|" + rs.getString(2), rs.getString(3));
        }
        assertThat(got).isEqualTo(expected);
    }

    private void assertProfile(Statement st, Map<String, String> expected) throws Exception {
        Map<String, String> got = new LinkedHashMap<>();
        try (ResultSet rs = st.executeQuery(
                "SELECT cust_id, name, preferred_channel FROM customer_full_profile ORDER BY cust_id")) {
            while (rs.next()) got.put(String.valueOf(rs.getInt(1)), rs.getString(2) + "|" + rs.getString(3));
        }
        assertThat(got).isEqualTo(expected);
    }

    private String driveRun(Project project, Path outDir, RunType runType) throws Exception {
        String pid = project.getId();
        List<MappingTableBinding> bindings = bindingRepo.findByProjectId(pid);
        Site site = siteRepo.findById(project.getSiteId()).orElseThrow();

        RunHistory rh = RunHistory.create(pid, runType, TriggerSource.internal, "test", null, null);
        rh.setStatus(RunStatus.running);
        runRepo.save(rh);
        String runId = rh.getId();

        List<StageInstance> stages = new ArrayList<>();
        int seq = 1;
        for (String key : StageCatalog.forRunType(runType)) {
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

    private void assertStagesGreen(String runId, int expectedCount) {
        List<StageInstance> done = stageRepo.findByRunIdOrderBySeqAsc(runId);
        assertThat(done).hasSize(expectedCount);
        assertThat(done).allSatisfy(si ->
                assertThat(si.getStatus()).as("stage %s", si.getStageKey()).isEqualTo(StageStatus.success));
    }

    private Connection pgConn() throws Exception {
        return DriverManager.getConnection(pg.getJdbcUrl(), pg.getUsername(), pg.getPassword());
    }

    private void assertOwners(Statement st, Map<Integer, String> expected) throws Exception {
        Map<Integer, String> got = new LinkedHashMap<>();
        try (ResultSet rs = st.executeQuery("SELECT account_id, owner FROM accounts ORDER BY account_id")) {
            while (rs.next()) got.put(rs.getInt(1), rs.getString(2));
        }
        assertThat(got).isEqualTo(expected);
    }
}
