package com.ksinfo.modernize_pro_data.coordinator.site;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.ksinfo.modernize_pro_data.TestcontainersConfiguration;
import com.ksinfo.modernize_pro_data.coordinator.mapping.MappingTableBinding;
import com.ksinfo.modernize_pro_data.coordinator.mapping.MappingTableBindingRepository;
import com.ksinfo.modernize_pro_data.coordinator.site.frozen.FrozenAsisSkip;
import com.ksinfo.modernize_pro_data.coordinator.site.frozen.FrozenBinding;
import com.ksinfo.modernize_pro_data.coordinator.site.frozen.FrozenBindingSource;
import com.ksinfo.modernize_pro_data.coordinator.site.frozen.FrozenCodeMap;
import com.ksinfo.modernize_pro_data.coordinator.site.frozen.FrozenRule;
import com.ksinfo.modernize_pro_data.coordinator.site.frozen.SnapshotData;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.annotation.Transactional;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * baseline pin 의 PG-side restore (jsonb_to_recordset) 정확성 검증.
 *
 * <p>round-trip:
 * <ol>
 *   <li>Snapshot row 를 PG 에 raw INSERT (snapshot_data JSONB 직접 채움).
 *       FrozenRule / FrozenBinding 의 모든 필드 + JOIN/WHERE/EXPAND 텍스트 +
 *       text[] / nested sources / unicode 모두 포함.</li>
 *   <li>{@link SnapshotMappingRestoreService#restore} 호출 → mapping_* 에 INSERT.</li>
 *   <li>mapping_* 에서 row 다시 읽어 JSONB 의 의미와 비교 (id 제외 — restore 가
 *       새 UUID 부여하므로).</li>
 * </ol>
 *
 * <p>실패 = JSONB unpack 시 컬럼 spec 누락 또는 type 미스매치 — production 적용 전 catch.
 */
@SpringBootTest
@Import(TestcontainersConfiguration.class)
@Transactional
class SnapshotMappingRestoreServiceIT {

    @Autowired private SnapshotMappingRestoreService restoreService;
    @Autowired private JdbcTemplate jdbc;
    @Autowired private MappingTableBindingRepository bindingRepo;
    @Autowired private ObjectMapper mapper;

    /** Insert minimal sites + projects row to satisfy FK chain. project_id 반환. */
    private String setupSiteAndProject(String suffix) {
        String siteId = "site-it-" + suffix;
        String projectId = "p-it-" + suffix;
        jdbc.update(
                "INSERT INTO sites (id, name, asis_env, tobe_env, asis_encoding, tobe_encoding, "
                        + "csv_path, environment, tobe_db_scope, created_by, created_at) "
                        + "VALUES (?, 'IT site', 'dev', 'dev', 'UTF-8', 'UTF-8', "
                        + "'/tmp', 'dev', 'site', 'test', now())",
                siteId);
        jdbc.update(
                "INSERT INTO projects (id, site_id, name, phase, table_count, tobe_table_count, "
                        + "owner, created_at) "
                        + "VALUES (?, ?, 'IT project', 'planning', 0, 0, 'test', now())",
                projectId, siteId);
        return projectId;
    }

    @Test
    void restorePreservesAllFields() throws Exception {
        // Arrange — sample SnapshotData (모든 필드 채움)
        String projectId = setupSiteAndProject("restore-001");
        String snapshotId = "ss-test-restore-001";

        FrozenRule r1 = new FrozenRule(
                "rule-old-1", null,
                "banksys", "customers", "name",
                "BANKSYS", "CUSTOMERS",
                new String[] {"FIRST_NAME", "LAST_NAME"},
                new String[] {"VARCHAR", "VARCHAR"},
                "CD_GENDER", "expression",
                "UPPER(asis.\"FIRST_NAME\") || ' ' || asis.\"LAST_NAME\"",
                "SELECT 1 FROM dual",
                "(미상)",
                true,
                "imported",
                "테스트 노트 — JOIN/WHERE/EXPAND 특수문자 \"'`\\n",
                "alice", OffsetDateTime.parse("2026-05-01T10:00:00Z"),
                "bob",   OffsetDateTime.parse("2026-05-02T10:00:00Z")
        );

        FrozenBindingSource src1 = new FrozenBindingSource(
                "src-old-1", 0, "BANKSYS", "CUSTOMERS", "asis", "primary", "INNER",
                "asis.\"ID\" = other.\"CUST_ID\""
        );
        FrozenBindingSource src2 = new FrozenBindingSource(
                "src-old-2", 1, "BANKSYS", "ACCOUNTS", "other", "join", "LEFT", null
        );
        FrozenBinding b1 = new FrozenBinding(
                "bind-old-1", "banksys", "customers", "join",
                "asis.\"STATUS\" = 'ACTIVE'", "imported",
                "alice", OffsetDateTime.parse("2026-05-01T10:00:00Z"),
                "bob",   OffsetDateTime.parse("2026-05-02T10:00:00Z"),
                List.of(src1, src2),
                null,
                "GROUP BY asis.\"REGION\"",
                "CROSS JOIN unnest(string_to_array(asis.\"PHONES\", ',')) AS phone"
        );

        FrozenCodeMap cm1 = new FrozenCodeMap(
                "cm-old-1", "CD_GENDER", "M", "MALE",
                "남성 — 한국어 + 'quote' + \"double\"", 0
        );

        FrozenAsisSkip skip1 = new FrozenAsisSkip("BANKSYS", "CUSTOMERS", "INTERNAL_NOTES");

        SnapshotData data = new SnapshotData(
                List.of(r1), List.of(cm1), List.of(b1), List.of(skip1)
        );

        String snapshotJson = mapper.writeValueAsString(data);
        jdbc.update(
                "INSERT INTO snapshots (id, project_id, name, type, status, version, "
                        + "snapshot_data, created_by, created_at, is_baseline) "
                        + "VALUES (?, ?, ?, 'mapping', 'draft', 'v1.0', ?::jsonb, 'test', now(), false)",
                snapshotId, projectId, "test snapshot", snapshotJson
        );

        // mapping_* 비워둠 (전제: caller 가 wipe 했다)
        // 다른 project 의 row 가 있더라도 본 projectId 만 INSERT 되는지 검증.

        // Act
        restoreService.restore(snapshotId, projectId, "tester");

        // Assert — rules
        List<Map<String, Object>> rules = jdbc.queryForList(
                "SELECT * FROM mapping_rules WHERE project_id = ?", projectId);
        assertThat(rules).hasSize(1);
        Map<String, Object> rr = rules.get(0);
        assertThat(rr.get("project_id")).isEqualTo(projectId);
        assertThat(rr.get("import_id")).isNull();
        assertThat(rr.get("tobe_schema")).isEqualTo("banksys");
        assertThat(rr.get("tobe_table")).isEqualTo("customers");
        assertThat(rr.get("tobe_column")).isEqualTo("name");
        assertThat(rr.get("asis_schema")).isEqualTo("BANKSYS");
        assertThat(rr.get("asis_table")).isEqualTo("CUSTOMERS");
        assertThat((String[]) ((java.sql.Array) rr.get("asis_column")).getArray())
                .containsExactly("FIRST_NAME", "LAST_NAME");
        assertThat((String[]) ((java.sql.Array) rr.get("asis_type")).getArray())
                .containsExactly("VARCHAR", "VARCHAR");
        assertThat(rr.get("code_domain")).isEqualTo("CD_GENDER");
        assertThat(rr.get("strategy")).isEqualTo("expression");
        assertThat(rr.get("transform_rule"))
                .isEqualTo("UPPER(asis.\"FIRST_NAME\") || ' ' || asis.\"LAST_NAME\"");
        assertThat(rr.get("transform_sql")).isEqualTo("SELECT 1 FROM dual");
        assertThat(rr.get("default_value")).isEqualTo("(미상)");
        assertThat(rr.get("not_null_override")).isEqualTo(true);
        assertThat(rr.get("rule_origin")).isEqualTo("imported");
        assertThat(rr.get("notes")).isEqualTo("테스트 노트 — JOIN/WHERE/EXPAND 특수문자 \"'`\\n");
        // id 는 새 UUID — 옛 frozen id 와 다름
        assertThat(rr.get("id")).isNotEqualTo("rule-old-1");

        // Assert — codeMaps
        List<Map<String, Object>> codeMaps = jdbc.queryForList(
                "SELECT * FROM mapping_code_maps WHERE project_id = ?", projectId);
        assertThat(codeMaps).hasSize(1);
        Map<String, Object> cm = codeMaps.get(0);
        assertThat(cm.get("domain")).isEqualTo("CD_GENDER");
        assertThat(cm.get("source_value")).isEqualTo("M");
        assertThat(cm.get("target_value")).isEqualTo("MALE");
        assertThat(cm.get("description")).isEqualTo("남성 — 한국어 + 'quote' + \"double\"");
        assertThat(cm.get("ordinal")).isEqualTo(0);

        // Assert — bindings + sources (eager fetch)
        List<MappingTableBinding> bindings = bindingRepo.findByProjectIdWithSources(projectId);
        assertThat(bindings).hasSize(1);
        MappingTableBinding bb = bindings.get(0);
        assertThat(bb.getTobeSchema()).isEqualTo("banksys");
        assertThat(bb.getTobeTable()).isEqualTo("customers");
        assertThat(bb.getCompositionKind()).isEqualTo("join");
        assertThat(bb.getWhereFilter()).isEqualTo("asis.\"STATUS\" = 'ACTIVE'");
        assertThat(bb.getGroupByExpr()).isEqualTo("GROUP BY asis.\"REGION\"");
        assertThat(bb.getExpandExpr())
                .isEqualTo("CROSS JOIN unnest(string_to_array(asis.\"PHONES\", ',')) AS phone");
        assertThat(bb.getBindingOrigin()).isEqualTo("imported");
        assertThat(bb.getSharedFromProjectId()).isNull();
        assertThat(bb.getSources()).hasSize(2);

        // sources — ordinal 순
        var srcs = bb.getSources().stream()
                .sorted((a, b) -> Integer.compare(a.getOrdinal(), b.getOrdinal()))
                .toList();
        assertThat(srcs.get(0).getOrdinal()).isEqualTo(0);
        assertThat(srcs.get(0).getAsisSchema()).isEqualTo("BANKSYS");
        assertThat(srcs.get(0).getAsisTable()).isEqualTo("CUSTOMERS");
        assertThat(srcs.get(0).getAlias()).isEqualTo("asis");
        assertThat(srcs.get(0).getRole()).isEqualTo("primary");
        assertThat(srcs.get(1).getRole()).isEqualTo("join");
        assertThat(srcs.get(0).getJoinType()).isEqualTo("INNER");
        assertThat(srcs.get(0).getJoinOn()).isEqualTo("asis.\"ID\" = other.\"CUST_ID\"");
        assertThat(srcs.get(1).getOrdinal()).isEqualTo(1);
        assertThat(srcs.get(1).getJoinType()).isEqualTo("LEFT");
        assertThat(srcs.get(1).getJoinOn()).isNull();

        // Assert — asisSkips
        List<Map<String, Object>> skips = jdbc.queryForList(
                "SELECT * FROM mapping_asis_skip WHERE project_id = ?", projectId);
        assertThat(skips).hasSize(1);
        Map<String, Object> sk = skips.get(0);
        assertThat(sk.get("asis_schema")).isEqualTo("BANKSYS");
        assertThat(sk.get("asis_table")).isEqualTo("CUSTOMERS");
        assertThat(sk.get("asis_column")).isEqualTo("INTERNAL_NOTES");
        assertThat(sk.get("created_by")).isEqualTo("tester");
    }

    @Test
    void restoreHandlesEmptySnapshotData() {
        String projectId = setupSiteAndProject("empty-001");
        String snapshotId = "ss-test-empty-001";

        // snapshot_data 가 빈 array
        jdbc.update(
                "INSERT INTO snapshots (id, project_id, name, type, status, version, "
                        + "snapshot_data, created_by, created_at, is_baseline) "
                        + "VALUES (?, ?, ?, 'mapping', 'draft', 'v1.0', "
                        + "'{\"rules\":[],\"codeMaps\":[],\"bindings\":[],\"asisSkips\":[]}'::jsonb, "
                        + "'test', now(), false)",
                snapshotId, projectId, "empty"
        );

        restoreService.restore(snapshotId, projectId, "tester");

        assertThat(jdbc.queryForObject(
                "SELECT count(*) FROM mapping_rules WHERE project_id = ?", Integer.class, projectId))
                .isEqualTo(0);
        assertThat(jdbc.queryForObject(
                "SELECT count(*) FROM mapping_code_maps WHERE project_id = ?", Integer.class, projectId))
                .isEqualTo(0);
        assertThat(jdbc.queryForObject(
                "SELECT count(*) FROM mapping_table_bindings WHERE project_id = ?", Integer.class, projectId))
                .isEqualTo(0);
    }

    @Test
    void restoreHandlesBindingWithoutSources() throws Exception {
        String projectId = setupSiteAndProject("nosrc-001");
        String snapshotId = "ss-test-nosrc-001";

        // composition_kind = none 의 binding — sources 빈 list
        FrozenBinding b = new FrozenBinding(
                "bind-x", "banksys", "manual_table", "none",
                null, "imported",
                "tester", OffsetDateTime.parse("2026-06-01T00:00:00Z"),
                null, null,
                List.of(),
                null, null, null
        );
        SnapshotData data = new SnapshotData(List.of(), List.of(), List.of(b), List.of());
        String json = mapper.writeValueAsString(data);

        jdbc.update(
                "INSERT INTO snapshots (id, project_id, name, type, status, version, "
                        + "snapshot_data, created_by, created_at, is_baseline) "
                        + "VALUES (?, ?, ?, 'mapping', 'draft', 'v1.0', ?::jsonb, 'test', now(), false)",
                snapshotId, projectId, "nosrc", json
        );

        restoreService.restore(snapshotId, projectId, "tester");

        var bindings = bindingRepo.findByProjectIdWithSources(projectId);
        assertThat(bindings).hasSize(1);
        assertThat(bindings.get(0).getCompositionKind()).isEqualTo("none");
        assertThat(bindings.get(0).getSources()).isEmpty();
    }
}
