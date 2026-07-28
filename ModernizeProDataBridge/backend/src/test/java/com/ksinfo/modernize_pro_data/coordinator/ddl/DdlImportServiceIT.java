package com.ksinfo.modernize_pro_data.coordinator.ddl;

import com.ksinfo.modernize_pro_data.common.exception.ApiException;
import com.ksinfo.modernize_pro_data.coordinator.site.Project;
import com.ksinfo.modernize_pro_data.coordinator.site.ProjectRepository;
import com.ksinfo.modernize_pro_data.coordinator.site.Site;
import com.ksinfo.modernize_pro_data.coordinator.site.SiteRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * DdlImportService 통합 테스트 (Spring Boot + Testcontainers + Flyway).
 *
 * AS-IS / TO-BE 양쪽 흐름 + indexes/constraints 메타 DB 저장까지 E2E 검증.
 * Testcontainers PG 18 컨테이너 위에 Flyway 가 모든 마이그레이션을 적용 (V1 ~ V20260608*).
 */
@SpringBootTest
@Testcontainers
class DdlImportServiceIT {

    @Container
    static PostgreSQLContainer<?> pg = new PostgreSQLContainer<>("postgres:18-alpine");

    @DynamicPropertySource
    static void overrideDataSource(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", pg::getJdbcUrl);
        registry.add("spring.datasource.username", pg::getUsername);
        registry.add("spring.datasource.password", pg::getPassword);
        registry.add("spring.datasource.driver-class-name", () -> "org.postgresql.Driver");
        registry.add("spring.flyway.enabled", () -> "true");
        registry.add("spring.jpa.hibernate.ddl-auto", () -> "validate");
    }

    @Autowired DdlImportService service;
    @Autowired ProjectRepository projectRepo;
    @Autowired SiteRepository siteRepo;
    @Autowired DdlTableRepository ddlTableRepo;
    @Autowired DdlColumnRepository ddlColumnRepo;
    @Autowired DdlIndexRepository ddlIndexRepo;
    @Autowired DdlConstraintRepository ddlConstraintRepo;
    @Autowired DdlForeignKeyRepository ddlForeignKeyRepo;

    private String projectId;

    @BeforeEach
    void setUp() {
        Site site = Site.create(
                "test-site-" + UUID.randomUUID().toString().substring(0, 4),
                "prod", "dev", "UTF-8", "UTF-8", "/tmp/csv", null, "dev",
                Map.of(), Map.of(), "tester");
        siteRepo.save(site);

        Project p = Project.create(site.getId(), "test-project", "tester");
        projectRepo.save(p);
        this.projectId = p.getId();
    }

    @Test
    void importsTobePgDdlAndStoresIndexesAndConstraints() {
        String ddl = """
                CREATE TABLE parent (id INTEGER PRIMARY KEY);
                CREATE TABLE child (
                    id INTEGER PRIMARY KEY,
                    parent_id INTEGER,
                    email VARCHAR(100),
                    CONSTRAINT fk_child_parent FOREIGN KEY (parent_id) REFERENCES parent(id) ON DELETE CASCADE,
                    CONSTRAINT uq_child_email UNIQUE (email)
                );
                CREATE INDEX idx_child_parent_id ON child (parent_id);
                """;
        service.importDdl(projectId, DdlImportService.SIDE_TOBE, "tobe.sql", ddl.getBytes(), "tester");

        List<DdlTable> tables = ddlTableRepo.findByProjectIdAndSideOrderByOrdinalAsc(projectId, "tobe");
        assertThat(tables).extracting(DdlTable::getPhysicalName).containsExactlyInAnyOrder("parent", "child");

        List<DdlConstraint> uks = ddlConstraintRepo.findByProjectIdAndSideAndType(
                projectId, "tobe", DdlConstraint.TYPE_UK);
        assertThat(uks).hasSize(1);
        assertThat(uks.get(0).getName()).isEqualTo("uq_child_email");

        List<DdlConstraint> fks = ddlConstraintRepo.findByProjectIdAndSideAndType(
                projectId, "tobe", DdlConstraint.TYPE_FK);
        assertThat(fks).hasSize(1);
        assertThat(fks.get(0).getName()).isEqualTo("fk_child_parent");

        DdlForeignKey fk = ddlForeignKeyRepo.findByConstraintId(fks.get(0).getId()).orElseThrow();
        assertThat(fk.getRefTableName()).isEqualTo("parent");
        assertThat(fk.getOnDelete()).isEqualTo("CASCADE");

        List<DdlIndex> indexes = ddlIndexRepo.findByProjectIdAndSide(projectId, "tobe");
        assertThat(indexes).anyMatch(i -> "idx_child_parent_id".equals(i.getName()));
    }

    @Test
    void importsAsisOracleDdlWithInlineConstraints() {
        String oracle = """
                CREATE TABLE EMP (
                    EMP_ID NUMBER(10),
                    EMAIL VARCHAR2(200),
                    CONSTRAINT PK_EMP PRIMARY KEY (EMP_ID),
                    CONSTRAINT UQ_EMP_EMAIL UNIQUE (EMAIL)
                );
                ALTER TABLE EMP ADD CONSTRAINT CK_EMP_EMAIL CHECK (EMAIL LIKE '%@%');
                CREATE INDEX IDX_EMP_EMAIL ON EMP (EMAIL);
                """;
        service.importDdl(projectId, DdlImportService.SIDE_ASIS, "asis.sql", oracle.getBytes(), "tester");

        List<DdlConstraint> uks = ddlConstraintRepo.findByProjectIdAndSideAndType(
                projectId, "asis", DdlConstraint.TYPE_UK);
        assertThat(uks).hasSize(1);
        assertThat(uks.get(0).getName()).isEqualTo("UQ_EMP_EMAIL");

        List<DdlConstraint> checks = ddlConstraintRepo.findByProjectIdAndSideAndType(
                projectId, "asis", DdlConstraint.TYPE_CHECK);
        assertThat(checks).hasSize(1);
        assertThat(checks.get(0).getName()).isEqualTo("CK_EMP_EMAIL");

        List<DdlIndex> indexes = ddlIndexRepo.findByProjectIdAndSide(projectId, "asis");
        assertThat(indexes).anyMatch(i -> "IDX_EMP_EMAIL".equals(i.getName()));
    }

    @Test
    void importsAsisPgDdlWhenSourceIsPostgres() {
        // AS-IS type=PostgreSQL 이면 AS-IS DDL 도 PgSchemaExtractor 로 파싱 (Oracle 파서 아님).
        // → postgres→oracle / postgres→postgres 이행에서 AS-IS 파싱이 PG staging 을 밟는 경로.
        Site pgSite = Site.create(
                "pg-src-" + UUID.randomUUID().toString().substring(0, 4),
                "prod", "dev", "UTF-8", "UTF-8", "/tmp/csv", null, "dev",
                Map.of(), Map.of(), "tester");
        pgSite.setAsisDbType("PostgreSQL");
        siteRepo.save(pgSite);
        Project p = Project.create(pgSite.getId(), "pg-src-project", "tester");
        projectRepo.save(p);

        String pgDdl = """
                CREATE TABLE CUSTOMERS (
                    CUST_ID   INTEGER PRIMARY KEY,
                    CUST_NAME VARCHAR(100),
                    BALANCE   NUMERIC(15,2)
                );
                """;
        service.importDdl(p.getId(), DdlImportService.SIDE_ASIS, "asis.sql", pgDdl.getBytes(), "tester");

        List<DdlTable> tables = ddlTableRepo.findByProjectIdAndSideOrderByOrdinalAsc(p.getId(), "asis");
        // PgSchemaExtractor 는 unquoted 식별자를 PG staging apply 로 소문자化 →
        // casing 보존하는 OracleDdlParser 와 구분되는 결정적 신호.
        assertThat(tables).extracting(DdlTable::getPhysicalName).containsExactly("customers");

        List<DdlColumn> cols = ddlColumnRepo.findByTableIdOrderByOrdinalAsc(tables.get(0).getId());
        assertThat(cols).extracting(DdlColumn::getPhysicalName)
                .containsExactly("cust_id", "cust_name", "balance");
        // PG udt 이름(INT4/NUMERIC) — Oracle 파서였다면 INTEGER/NUMBER 원문이 들어감.
        assertThat(cols).extracting(DdlColumn::getDataType).contains("INT4", "NUMERIC");
        DdlColumn balance = cols.stream().filter(c -> "balance".equals(c.getPhysicalName())).findFirst().orElseThrow();
        assertThat(balance.getScale()).isEqualTo(2);
    }

    @Test
    void importsTobeOracleDdlWhenTargetIsOracle() {
        // TO-BE type=Oracle 이면 TO-BE DDL 도 OracleDdlParser 로 파싱 (PG 스테이징 없이, 메타-PG 불필요).
        Site oraSite = Site.create(
                "ora-site-" + UUID.randomUUID().toString().substring(0, 4),
                "prod", "dev", "UTF-8", "UTF-8", "/tmp/csv", null, "dev",
                Map.of("dev", Map.of("type", "Oracle", "host", "h", "database", "FREEPDB1", "username", "app")),
                Map.of(), "tester");
        siteRepo.save(oraSite);
        Project p = Project.create(oraSite.getId(), "ora-project", "tester");
        projectRepo.save(p);

        String oracleDdl = """
                CREATE TABLE ACCOUNTS (
                    ACCT_ID  NUMBER(10) NOT NULL,
                    OWNER_NM VARCHAR2(100),
                    BALANCE  NUMBER(15,2),
                    CONSTRAINT PK_ACCOUNTS PRIMARY KEY (ACCT_ID)
                );
                """;
        // 예전엔 PG 거부(TOBE_DDL_APPLY_FAILED) 였으나, TO-BE=Oracle 이므로 성공해야 함.
        service.importDdl(p.getId(), DdlImportService.SIDE_TOBE, "tobe.sql", oracleDdl.getBytes(), "tester");

        List<DdlTable> tables = ddlTableRepo.findByProjectIdAndSideOrderByOrdinalAsc(p.getId(), "tobe");
        assertThat(tables).extracting(DdlTable::getPhysicalName).containsExactly("ACCOUNTS");

        List<DdlColumn> cols = ddlColumnRepo.findByTableIdOrderByOrdinalAsc(tables.get(0).getId());
        assertThat(cols).extracting(DdlColumn::getPhysicalName).containsExactly("ACCT_ID", "OWNER_NM", "BALANCE");
        // Oracle 타입 문자열이 저장됨(PG udt 이름 아님) + scale 캡처.
        assertThat(cols).extracting(DdlColumn::getDataType).contains("NUMBER", "VARCHAR2");
        DdlColumn balance = cols.stream().filter(c -> "BALANCE".equals(c.getPhysicalName())).findFirst().orElseThrow();
        assertThat(balance.getScale()).isEqualTo(2);
    }

    @Test
    void rejectsTobeOracleSyntax() {
        // TO-BE type 미설정 → 기본 PG. Oracle 의 NUMBER, VARCHAR2 는 PG 에 없음 → PG 거부.
        String oracleDdl = "CREATE TABLE t (id NUMBER(10), name VARCHAR2(50));";
        assertThatThrownBy(() ->
                service.importDdl(projectId, DdlImportService.SIDE_TOBE, "bad.sql", oracleDdl.getBytes(), "tester"))
                .isInstanceOf(ApiException.class)
                .hasFieldOrPropertyWithValue("code", "TOBE_DDL_APPLY_FAILED");
    }

    @Test
    void cascadeDeletesAllChildrenWhenDdlReImported() {
        String ddl1 = """
                CREATE TABLE t1 (
                    id INTEGER PRIMARY KEY,
                    val VARCHAR(50),
                    CONSTRAINT uq_t1_val UNIQUE (val)
                );
                CREATE INDEX idx_t1_val ON t1 (val);
                """;
        service.importDdl(projectId, DdlImportService.SIDE_TOBE, "v1.sql", ddl1.getBytes(), "tester");

        assertThat(ddlConstraintRepo.findByProjectIdAndSideAndType(projectId, "tobe", DdlConstraint.TYPE_UK))
                .hasSize(1);
        assertThat(ddlIndexRepo.findByProjectIdAndSide(projectId, "tobe")).hasSize(1);

        // 재 import — 기존 메타 CASCADE 삭제 후 새로 저장.
        String ddl2 = "CREATE TABLE t2 (id INTEGER PRIMARY KEY);";
        service.importDdl(projectId, DdlImportService.SIDE_TOBE, "v2.sql", ddl2.getBytes(), "tester");

        // ddl_constraints, ddl_indexes 모두 CASCADE 로 비워졌어야.
        assertThat(ddlConstraintRepo.findByProjectIdAndSideAndType(projectId, "tobe", DdlConstraint.TYPE_UK))
                .isEmpty();
        assertThat(ddlIndexRepo.findByProjectIdAndSide(projectId, "tobe")).isEmpty();

        List<DdlTable> tables = ddlTableRepo.findByProjectIdAndSideOrderByOrdinalAsc(projectId, "tobe");
        assertThat(tables).hasSize(1);
        assertThat(tables.get(0).getPhysicalName()).isEqualTo("t2");
    }
}
