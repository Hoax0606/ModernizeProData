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

        Project p = new Project();
        p.setId("p-" + UUID.randomUUID().toString().substring(0, 8));
        p.setSiteId(site.getId());
        p.setName("test-project");
        p.setPhase("planning");
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
    void rejectsTobeOracleSyntax() {
        // TO-BE 는 PG 라고 가정 — Oracle 의 NUMBER, VARCHAR2 는 PG 에 없음 → PG 거부
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
