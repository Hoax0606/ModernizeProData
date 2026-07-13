package com.ksinfo.modernize_pro_data.coordinator.mapping;

import com.ksinfo.modernize_pro_data.coordinator.site.Project;
import com.ksinfo.modernize_pro_data.coordinator.site.ProjectRepository;
import com.ksinfo.modernize_pro_data.coordinator.site.Site;
import com.ksinfo.modernize_pro_data.coordinator.site.SiteRepository;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * MappingImportService — notes 지시자 파싱 (2026-07-13).
 *
 * 샘플 CSV 가 변환/expand/집계 로직을 {@code notes} 필드에 'transform_sql:' / 'expand_expr:'
 * 형태로 넣어둔 경우, importer 가 이를 파싱해 올바른 매핑을 만드는지 검증. (이전엔 무시돼서
 * asis_column 중복 → 'col || col' doubling 으로 깨졌음.)
 */
@SpringBootTest
@Testcontainers
class MappingImportNotesDirectiveIT {

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

    @Autowired MappingImportService importer;
    @Autowired MappingTableBindingRepository bindingRepo;
    @Autowired MappingRuleRepository ruleRepo;
    @Autowired ProjectRepository projectRepo;
    @Autowired SiteRepository siteRepo;

    private static final char SEP = ' ';  // notes 마커

    @Test
    void notesTransformSql_expand_and_aggregate_areParsed() {
        Site site = Site.create("notes-site", "prod", "dev", "UTF-8", "UTF-8",
                "C:/tmp", null, "dev", Map.of(), Map.of(), "test");
        siteRepo.save(site);
        Project project = Project.create(site.getId(), "notes-proj", "test");
        projectRepo.save(project);
        String pid = project.getId();

        String q = "\"";
        String columnCsv = String.join("\n",
            "asis_table,asis_column,asis_type,tobe_table,tobe_column,tobe_type,code_domain,default_value,transform_sql,notes",
            // n:1 aggregation → transaction_monthly
            "BANKSYS.TRANSACTIONS,TXN_DTTM,VARCHAR2(64),tm,year_month," + q + "VARCHAR(7)" + q + ",,,,"
                + q + "group key " + SEP + "Etransform_sql: SUBSTRING(t.TXN_DTTM, 1, 7)  (GROUP BY expr)" + q,
            "BANKSYS.TRANSACTIONS,ACCT_NO,VARCHAR2(20),tm,acct_no," + q + "VARCHAR(20)" + q + ",,,,"
                + q + "group key " + SEP + "Etransform_sql: t.ACCT_NO" + q,
            "BANKSYS.TRANSACTIONS,TXN_ID,NUMBER(15),tm,txn_count,BIGINT,,,,"
                + q + "aggregate " + SEP + "Etransform_sql: COUNT(*)" + q,
            "BANKSYS.TRANSACTIONS,AMOUNT," + q + "NUMBER(18,2)" + q + ",tm,total_credit," + q + "NUMERIC(20,2)" + q + ",,,,"
                + q + "aggregate " + SEP + "Etransform_sql: SUM(CASE WHEN t.TXN_TYPE = 'C' THEN CAST(t.AMOUNT AS DECIMAL(20,2)) ELSE 0 END)" + q,
            // 1:N expand → customer_contacts
            "BANKSYS.CUSTOMERS,CUST_ID,VARCHAR2(10),cc,cust_id," + q + "VARCHAR(10)" + q + ",,,,"
                + q + "1:N " + SEP + "Etransform_sql: t.CUST_ID" + q,
            "BANKSYS.CUSTOMERS,PHONE,VARCHAR2(20),cc,channel," + q + "VARCHAR(10)" + q + ",,,,"
                + q + "u.channel " + SEP + "Eexpand_expr: CROSS JOIN LATERAL (VALUES ('phone', t.PHONE), ('email', t.EMAIL)) AS u(channel, value), where: u.value IS NOT NULL AND TRIM(u.value) <> ''" + q,
            "BANKSYS.CUSTOMERS,EMAIL,VARCHAR2(200),cc,value," + q + "VARCHAR(200)" + q + ",,,,"
                + q + "u.value " + SEP + "Etransform_sql: u.value" + q,
            ""
        );
        String codeCsv = "domain,source_value,target_value\n";

        importer.importFromCsv(pid,
                columnCsv.getBytes(StandardCharsets.UTF_8), "column_mapping.csv",
                codeCsv.getBytes(StandardCharsets.UTF_8), "code_mapping.csv", "test");

        // ── n:1 aggregation (tm) ─────────────────────────────
        Map<String, String> tm = rulesOf(pid, "tm");
        assertThat(tm.get("txn_count")).isEqualTo("COUNT(*)");
        assertThat(tm.get("acct_no")).isEqualTo("t.ACCT_NO");
        assertThat(tm.get("year_month")).isEqualTo("SUBSTRING(t.TXN_DTTM, 1, 7)");  // (GROUP BY …) 주석 제거됨
        assertThat(tm.get("total_credit"))
                .isEqualTo("SUM(CASE WHEN t.TXN_TYPE = 'C' THEN CAST(t.AMOUNT AS DECIMAL(20,2)) ELSE 0 END)");
        assertThat(tm.values()).as("doubling 없음").noneMatch(v -> v.contains("||"));

        MappingTableBinding tmB = bindingOf(pid, "tm");
        assertThat(tmB.getGroupByExpr()).as("집계 → GROUP BY 도출")
                .contains("t.ACCT_NO").contains("SUBSTRING(t.TXN_DTTM, 1, 7)");

        // ── 1:N expand (cc) ─────────────────────────────────
        Map<String, String> cc = rulesOf(pid, "cc");
        assertThat(cc.get("cust_id")).isEqualTo("t.CUST_ID");
        assertThat(cc.get("channel")).isEqualTo("u.channel");   // notes 에 태그 안 됐지만 expand 출력컬럼 추론
        assertThat(cc.get("value")).isEqualTo("u.value");
        assertThat(cc.values()).as("doubling 없음").noneMatch(v -> v.contains("||"));

        MappingTableBinding ccB = bindingOf(pid, "cc");
        assertThat(ccB.getExpandExpr()).contains("CROSS JOIN LATERAL").contains("u(channel, value)");
        assertThat(ccB.getWhereFilter()).contains("u.value IS NOT NULL");
    }

    private Map<String, String> rulesOf(String pid, String tobeTable) {
        List<MappingRule> rules = ruleRepo.findByProjectIdAndTobeTable(pid, tobeTable);
        java.util.HashMap<String, String> m = new java.util.HashMap<>();
        for (MappingRule r : rules) m.put(r.getTobeColumn(), r.getTransformRule());
        return m;
    }

    private MappingTableBinding bindingOf(String pid, String tobeTable) {
        return bindingRepo.findByProjectId(pid).stream()
                .filter(b -> tobeTable.equals(b.getTobeTable())).findFirst().orElseThrow();
    }
}
