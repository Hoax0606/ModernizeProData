package com.ksinfo.modernize_pro_data.coordinator.site;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import java.time.OffsetDateTime;

/**
 * Baseline pin / restore 의 PG-side unpack 구현. 옛 Java-loop 패턴은
 * snapshot.snapshot_data JSONB 을 Java 로 deserialize → entity 변환 →
 * JpaRepository.save(...) loop 로 처리해 큰 mapping (수천 rule + binding) 에서
 * 30s+ 걸렸다. 이 service 는 한 PG SQL 안에서 `jsonb_to_recordset` 으로 직접
 * mapping_* 테이블에 INSERT 한다. Java unpack 비용 0, batch transfer 0.
 *
 * <p>JSONB key naming = Jackson default camelCase (`tobeSchema`, `notNullOverride`,
 * `asisColumn`). 따라서 column spec 의 식별자도 quoted camelCase. PG 의
 * case-sensitive identifier 매칭.
 *
 * <p>모든 SQL 은 옛 entity-loop 와 의미적 동치 — coalesce 로 null fallback,
 * gen_random_uuid() 로 새 id 발급 (옛 frozen id 그대로 쓰면 다음 snapshot 이 같은
 * id 를 동결하게 됨), createdBy / createdAt 누락 시 호출자 + now() 채움.
 *
 * <p>호출자 = {@code SnapshotController.restoreMappingFromSnapshot}. 단일 트랜잭션
 * 안에서 wipe (옛 코드 그대로) + 본 service 의 SQL 들 순서대로 실행.
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class SnapshotMappingRestoreService {

    private final NamedParameterJdbcTemplate jdbc;

    /**
     * snapshot.snapshot_data 의 rules / codeMaps / bindings(+sources) / asisSkips 를
     * 본 PG 안 unpack 으로 mapping_* 테이블에 INSERT. caller 가 wipe 후 호출.
     *
     * REQUIRES_NEW 아님 — caller 의 트랜잭션 그대로. 일관성 보장.
     */
    @Transactional(propagation = Propagation.MANDATORY)
    public void restore(String snapshotId, String projectId, String userId) {
        OffsetDateTime now = OffsetDateTime.now();
        MapSqlParameterSource p = new MapSqlParameterSource()
                .addValue("snapshotId", snapshotId)
                .addValue("projectId", projectId)
                .addValue("userId", userId)
                .addValue("now", now);

        int rules = jdbc.update(SQL_INSERT_RULES, p);
        int codeMaps = jdbc.update(SQL_INSERT_CODE_MAPS, p);
        int bindings = jdbc.update(SQL_INSERT_BINDINGS_WITH_SOURCES, p);
        int asisSkips = jdbc.update(SQL_INSERT_ASIS_SKIPS, p);

        log.info("Snapshot restore (PG-side) — rules={} codeMaps={} bindings(+sources)={} asisSkips={}",
                rules, codeMaps, bindings, asisSkips);
    }

    /* ============================== SQL ============================== */

    /**
     * rules INSERT. JSONB array path = snapshot_data->'rules'.
     * coalesce 로 nullable 기본값 보강 (옛 snapshot 에 없는 필드 대비).
     */
    private static final String SQL_INSERT_RULES = """
            INSERT INTO mapping_rules (
                id, project_id, import_id,
                tobe_schema, tobe_table, tobe_column,
                asis_schema, asis_table, asis_column, asis_type,
                code_domain, strategy, transform_rule, transform_sql, default_value,
                not_null_override, rule_origin, notes,
                created_by, created_at, updated_by, updated_at
            )
            SELECT
                gen_random_uuid()::text,
                :projectId,
                r."importId",
                coalesce(r."tobeSchema", ''),
                r."tobeTable",
                r."tobeColumn",
                r."asisSchema",
                r."asisTable",
                r."asisColumn",
                r."asisType",
                r."codeDomain",
                coalesce(r."strategy", 'expression'),
                r."transformRule",
                r."transformSql",
                r."defaultValue",
                coalesce(r."notNullOverride", false),
                coalesce(r."ruleOrigin", 'imported'),
                r."notes",
                coalesce(r."createdBy", :userId),
                coalesce(CASE jsonb_typeof(r."createdAt")
                    WHEN 'number' THEN to_timestamp((r."createdAt")::text::double precision)
                    WHEN 'string' THEN (r."createdAt"#>>'{}')::timestamptz
                END, :now),
                :userId,
                :now
            FROM jsonb_to_recordset(
                (SELECT snapshot_data->'rules' FROM snapshots WHERE id = :snapshotId)
            ) AS r(
                "id" text,
                "importId" text,
                "tobeSchema" text,
                "tobeTable" text,
                "tobeColumn" text,
                "asisSchema" text,
                "asisTable" text,
                "asisColumn" text[],
                "asisType" text[],
                "codeDomain" text,
                "strategy" text,
                "transformRule" text,
                "transformSql" text,
                "defaultValue" text,
                "notNullOverride" boolean,
                "ruleOrigin" text,
                "notes" text,
                "createdBy" text,
                "createdAt" jsonb,
                "updatedBy" text,
                "updatedAt" jsonb
            )
            """;

    /** codeMaps INSERT — record 단일 array. */
    private static final String SQL_INSERT_CODE_MAPS = """
            INSERT INTO mapping_code_maps (
                id, project_id, import_id,
                domain, source_value, target_value, description, ordinal
            )
            SELECT
                gen_random_uuid()::text,
                :projectId,
                null,
                m."domain",
                m."sourceValue",
                m."targetValue",
                m."description",
                coalesce(m."ordinal", 0)
            FROM jsonb_to_recordset(
                (SELECT snapshot_data->'codeMaps' FROM snapshots WHERE id = :snapshotId)
            ) AS m(
                "id" text,
                "domain" text,
                "sourceValue" text,
                "targetValue" text,
                "description" text,
                "ordinal" int
            )
            """;

    /**
     * bindings + sources 를 한 SQL 로. mutation CTE 패턴:
     *  - bindings_input = JSONB unpack + 새 binding_id 발급
     *  - ins_bindings = mapping_table_bindings 에 INSERT (RETURNING 으로 부수 효과 처리)
     *  - 최종 SELECT/INSERT = sources 의 JSONB unpack + binding_id 매칭
     */
    private static final String SQL_INSERT_BINDINGS_WITH_SOURCES = """
            WITH bindings_input AS (
                SELECT
                    gen_random_uuid()::text AS new_id,
                    b."tobeSchema", b."tobeTable", b."compositionKind",
                    b."whereFilter", b."groupByExpr", b."expandExpr",
                    b."bindingOrigin", b."sharedFromProjectId",
                    b."createdBy", b."createdAt", b."updatedBy", b."updatedAt",
                    b."sources" AS sources_jsonb
                FROM jsonb_to_recordset(
                    (SELECT snapshot_data->'bindings' FROM snapshots WHERE id = :snapshotId)
                ) AS b(
                    "id" text,
                    "tobeSchema" text,
                    "tobeTable" text,
                    "compositionKind" text,
                    "whereFilter" text,
                    "groupByExpr" text,
                    "expandExpr" text,
                    "bindingOrigin" text,
                    "sharedFromProjectId" text,
                    "createdBy" text,
                    "createdAt" jsonb,
                    "updatedBy" text,
                    "updatedAt" jsonb,
                    "sources" jsonb
                )
            ),
            ins_bindings AS (
                INSERT INTO mapping_table_bindings (
                    id, project_id, import_id,
                    tobe_schema, tobe_table, composition_kind,
                    where_filter, group_by_expr, expand_expr,
                    binding_origin, shared_from_project_id,
                    created_by, created_at, updated_by, updated_at
                )
                SELECT
                    new_id, :projectId, null,
                    coalesce("tobeSchema", ''),
                    "tobeTable",
                    coalesce("compositionKind", 'single'),
                    "whereFilter",
                    "groupByExpr",
                    "expandExpr",
                    coalesce("bindingOrigin", 'imported'),
                    "sharedFromProjectId",
                    coalesce("createdBy", :userId),
                    coalesce(CASE jsonb_typeof("createdAt")
                        WHEN 'number' THEN to_timestamp(("createdAt")::text::double precision)
                        WHEN 'string' THEN ("createdAt"#>>'{}')::timestamptz
                    END, :now),
                    :userId,
                    :now
                FROM bindings_input
                RETURNING id
            )
            INSERT INTO mapping_table_binding_sources (
                id, binding_id, ordinal,
                asis_schema, asis_table, alias, role, join_type, join_on
            )
            SELECT
                gen_random_uuid()::text,
                bi.new_id,
                coalesce(src."ordinal", 0),
                src."asisSchema",
                src."asisTable",
                src."alias",
                src."role",
                src."joinType",
                src."joinOn"
            FROM bindings_input bi
            CROSS JOIN LATERAL jsonb_to_recordset(coalesce(bi.sources_jsonb, '[]'::jsonb)) AS src(
                "id" text,
                "ordinal" int,
                "asisSchema" text,
                "asisTable" text,
                "alias" text,
                "role" text,
                "joinType" text,
                "joinOn" text
            )
            """;

    /** asisSkips — record 단일 array. createdBy/createdAt 가 FrozenAsisSkip 에 없으므로 userId/now 사용. */
    private static final String SQL_INSERT_ASIS_SKIPS = """
            INSERT INTO mapping_asis_skip (
                id, project_id,
                asis_schema, asis_table, asis_column,
                created_by, created_at
            )
            SELECT
                gen_random_uuid()::text,
                :projectId,
                coalesce(s."asisSchema", ''),
                s."asisTable",
                s."asisColumn",
                :userId,
                :now
            FROM jsonb_to_recordset(
                (SELECT coalesce(snapshot_data->'asisSkips', '[]'::jsonb) FROM snapshots WHERE id = :snapshotId)
            ) AS s(
                "asisSchema" text,
                "asisTable" text,
                "asisColumn" text
            )
            """;
}
