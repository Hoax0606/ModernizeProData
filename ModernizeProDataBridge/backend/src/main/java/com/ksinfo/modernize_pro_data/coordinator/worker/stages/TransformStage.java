package com.ksinfo.modernize_pro_data.coordinator.worker.stages;

import com.ksinfo.modernize_pro_data.common.duckdb.DuckDbService;
import com.ksinfo.modernize_pro_data.coordinator.mapping.MappingCodeMap;
import com.ksinfo.modernize_pro_data.coordinator.mapping.MappingCodeMapRepository;
import com.ksinfo.modernize_pro_data.coordinator.mapping.MappingRule;
import com.ksinfo.modernize_pro_data.coordinator.mapping.MappingRuleRepository;
import com.ksinfo.modernize_pro_data.coordinator.mapping.MappingTableBinding;
import com.ksinfo.modernize_pro_data.coordinator.mapping.MappingTableBindingSource;
import com.ksinfo.modernize_pro_data.coordinator.mapping.MappingTableBindingRepository;
import com.ksinfo.modernize_pro_data.coordinator.quarantine.QuarantineService;
import com.ksinfo.modernize_pro_data.coordinator.quarantine.QuarantineSeverity;
import com.ksinfo.modernize_pro_data.coordinator.run.RunType;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageInstance;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageInstanceRepository;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageStatus;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageTableResult;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageTableResultRepository;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageTableStatus;
import com.ksinfo.modernize_pro_data.coordinator.runlog.RunLogIngestService;
import com.ksinfo.modernize_pro_data.coordinator.worker.SqlComposer;
import com.ksinfo.modernize_pro_data.coordinator.ddl.DdlColumn;
import com.ksinfo.modernize_pro_data.coordinator.ddl.DdlColumnRepository;
import com.ksinfo.modernize_pro_data.coordinator.ddl.DdlTable;
import com.ksinfo.modernize_pro_data.coordinator.ddl.DdlTableRepository;
import com.ksinfo.modernize_pro_data.coordinator.worker.StageContext;
import com.ksinfo.modernize_pro_data.coordinator.worker.StageHelpers;
import com.ksinfo.modernize_pro_data.coordinator.worker.StageProgressBroadcaster;
import com.ksinfo.modernize_pro_data.coordinator.worker.StageRunner;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.nio.file.Path;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.Statement;
import java.time.Duration;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Transform stage — mapping_rules + mapping_code_maps 로부터 DuckDB SQL 생성 + 실행.
 *
 * 단순화 범위:
 *   - composition_kind = single / join / union 모두 실행 (FROM 절은 SqlComposer 가 생성 — 아래 참조)
 *   - asis_column 다중 = NULL-safe CONCAT combine (날짜 조립 등 복잡 결합은 transform_rule 로)
 *   - transform_sql multiline 은 skip (transform_rule 짧은 expression 만)
 *   - strategy='expression' + transform_rule + code_domain 만
 *   - where_filter 있으면 WHERE clause 추가
 *
 * 생성 SQL 예:
 *   CREATE OR REPLACE TABLE "run_xxx"."tobe_users" AS
 *   SELECT
 *     asis."USER_ID" AS "id",
 *     UPPER(asis."USER_NAME") AS "name",         -- transform_rule 사용
 *     CASE asis."SEX_CD" WHEN 'M' THEN 'MALE' WHEN 'F' THEN 'FEMALE' ELSE NULL END AS "gender",  -- code_domain 사용
 *     CAST(asis."BIRTH_DATE" AS DATE) AS "birth_date",
 *     NULL AS "deleted_at"                        -- strategy='null'
 *   FROM "run_xxx"."asis_users" AS asis
 *   [WHERE binding.where_filter]
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class TransformStage implements StageRunner {

    private static final String STAGE_KEY = "transform";
    /** 시각손실 WARN quarantine 의 sample row 상한 (AuditStage 와 동일 정책). */
    private static final int SAMPLE_LIMIT = 1000;

    private final StageInstanceRepository stageInstanceRepo;
    private final StageTableResultRepository stageTableResultRepo;
    private final MappingRuleRepository mappingRuleRepo;
    private final MappingTableBindingRepository bindingRepo;
    private final MappingCodeMapRepository mappingCodeMapRepo;
    private final DdlTableRepository ddlTableRepo;
    private final DdlColumnRepository ddlColumnRepo;
    private final DuckDbService duckDbService;
    private final QuarantineService quarantineService;
    private final RunLogIngestService runLogIngest;
    private final StageProgressBroadcaster broadcaster;

    @Override
    public String stageKey() {
        return STAGE_KEY;
    }

    @Override
    public void run(StageContext ctx, StageInstance stage) {
        OffsetDateTime startedAt = OffsetDateTime.now();
        stage.setStatus(StageStatus.running);
        stage.setStartedAt(startedAt);
        stageInstanceRepo.save(stage);

        String runId = ctx.getRunHistory().getId();
        String projectId = ctx.getProject().getId();
        String schema = ctx.getDuckdbSchema();

        ingest(ctx, "Stage transform started — " + ctx.getBindings().size() + " bindings", true);

        // code_domain → CASE WHEN clause cache (project 단위)
        Map<String, List<MappingCodeMap>> codeMapsByDomain = new HashMap<>();
        for (MappingCodeMap m : mappingCodeMapRepo.findByProjectIdOrderByDomainAscOrdinalAsc(projectId)) {
            codeMapsByDomain.computeIfAbsent(m.getDomain(), k -> new java.util.ArrayList<>()).add(m);
        }

        // TO-BE DDL 컬럼 타입 (tobeTable → colName → dataType) — DATE 시각손실 검출용.
        Map<String, Map<String, String>> tobeColTypes = new HashMap<>();
        for (DdlTable t : ddlTableRepo.findByProjectIdAndSideOrderByOrdinalAsc(projectId, "tobe")) {
            Map<String, String> byCol = new HashMap<>();
            for (DdlColumn col : ddlColumnRepo.findByTableIdOrderByOrdinalAsc(t.getId())) {
                byCol.put(col.getPhysicalName(), col.getDataType());
            }
            tobeColTypes.put(t.getPhysicalName(), byCol);
        }

        int successCount = 0;
        int failedCount = 0;

        for (MappingTableBinding childBinding : ctx.getBindings()) {
            ctx.throwIfCancelled();   // abort/timeout 신호 시 RunCancelledException → LocalWorkerExecutor 가 stage failed 마킹.
            // 자식 link swap — sources + rules 모두 master 사용. MappingReportService 와 같은 패턴.
            // binding 변수는 master entity 로 swap (SQL 생성 시 master 의 sources/whereFilter 등).
            // childBinding 의 id 는 stage_table_results 키로 별도 보존.
            MappingTableBinding binding = childBinding;
            String ruleProjectId = projectId;
            if (childBinding.getSharedFromProjectId() != null) {
                String masterPid = childBinding.getSharedFromProjectId();
                String mSchema = childBinding.getTobeSchema() == null ? "" : childBinding.getTobeSchema();
                MappingTableBinding mb = bindingRepo
                        .findByProjectIdAndTobeSchemaAndTobeTable(masterPid, mSchema, childBinding.getTobeTable())
                        .orElse(null);
                if (mb != null) {
                    binding = mb;
                    ruleProjectId = masterPid;
                }
            }
            String childBindingId = childBinding.getId();
            OffsetDateTime tableStart = OffsetDateTime.now();
            String tobeSchema = binding.getTobeSchema() == null ? "" : binding.getTobeSchema();
            String tobeTable  = binding.getTobeTable();
            /* Quarantine 표시용 — schema 있으면 'banksys.customers' 식 식별성 강한 라벨. */
            String tableLabel = tobeSchema.isBlank() ? tobeTable : tobeSchema + "." + tobeTable;

            StageTableResult result = stageTableResultRepo
                    .findByStageInstanceIdAndBindingId(stage.getId(), childBindingId)
                    .orElseGet(() -> StageTableResult.create(stage.getId(), childBindingId, tobeSchema, tobeTable));
            result.setStartedAt(tableStart);

            try {
                List<MappingRule> rules = mappingRuleRepo.findByProjectIdAndTobeTable(ruleProjectId, tobeTable);
                if (rules.isEmpty()) {
                    throw new IllegalStateException("no mapping rules for " + tobeTable);
                }

                // B6 방어 — union binding 은 SELECT * UNION ALL 이 위치로 붙어 소스 컬럼 순서가
                // 다르면 silent 오정렬. source 컬럼 시그니처 불일치를 여기서 fail-fast 로 표면화.
                if ("union".equals(binding.getCompositionKind())) {
                    assertUnionSourcesAligned(schema, binding);
                }

                String sql = buildTransformSql(schema, tobeTable, rules, binding, codeMapsByDomain);
                // run 시점의 SQL 을 result 에 박제 (성공/실패 무관하게 디버깅에 도움).
                // Artifacts 가 보여주는 건 frontend 가 성공 테이블만 필터하므로 여기선 무조건 set.
                result.setCompiledSql(sql);

                long rowCount;
                try (Statement st = duckDbService.statement()) {
                    ctx.throwIfCancelled();   // (D) sub-step — 대용량 transform SQL 직전 cancel 체크.
                    // runCancellable: transform 쿼리 도중 abort 시 statement.cancel() 로 즉시 interrupt.
                    ctx.runCancellable(st, () -> st.execute(sql));

                    String fqTobe = quoteIdent(schema) + "." + quoteIdent("tobe_" + tobeTable);
                    try (ResultSet rs = st.executeQuery("SELECT COUNT(*) FROM " + fqTobe)) {
                        rs.next();
                        rowCount = rs.getLong(1);
                    }

                    // CP2 체크포인트 parquet2 — test/rehearsal 만 생성 (반복 실행 재사용).
                    // cutover 는 1회성이라 skip — Load/Verify 가 DuckDB tobe_ 테이블을 직접 읽으므로 안전.
                    if (ctx.getRunHistory().getRunType() != RunType.cutover) {
                        Path parquet = ctx.parquet2Dir().resolve(tobeTable + ".parquet");
                        String escapedParquet = parquet.toString().replace("\\", "/").replace("'", "''");
                        ctx.runCancellable(st, () -> st.execute("COPY " + fqTobe + " TO '" + escapedParquet + "' (FORMAT PARQUET)"));
                    }
                }

                OffsetDateTime tableEnd = OffsetDateTime.now();
                result.setStatus(StageTableStatus.success);
                result.setRowCount(rowCount);
                result.setFinishedAt(tableEnd);
                result.setDurationMs(Duration.between(tableStart, tableEnd).toMillis());
                stageTableResultRepo.save(result);

                // DATE 시각 silent 손실 진단 — AS-IS 시각(시·분·초)이 TO-BE date 컬럼으로 잘리는
                // 행을 WARN Quarantine 으로 표면화. Load 차단 X, 행은 정상 적재. probe 실패는 transform
                // 을 깨지 않게 격리.
                try {
                    checkDateTimeLoss(ctx, stage, childBinding, binding, rules, codeMapsByDomain, schema, tableLabel,
                            tobeColTypes.getOrDefault(tobeTable, java.util.Map.of()));
                } catch (Exception probeEx) {
                    log.warn("date time-loss probe failed for {} : {}", tobeTable, probeEx.toString());
                }

                ingest(ctx, "Transformed " + tobeTable + ": " + rowCount + " rows", true);
                successCount++;
                stage.setTablesSuccess(successCount);
                stage.setTablesFailed(failedCount);
                stageInstanceRepo.save(stage);
                broadcaster.stageProgress(runId, stage);
            } catch (com.ksinfo.modernize_pro_data.coordinator.worker.RunCancelledException ce) {
                // cancel(statement interrupt 포함)은 table 실패가 아니라 run 중단 — 그대로 전파.
                throw ce;
            } catch (Exception e) {
                OffsetDateTime tableEnd = OffsetDateTime.now();
                result.setStatus(StageTableStatus.failed);
                Map<String, Object> detail = new HashMap<>();
                detail.put("message", e.getMessage());
                result.setErrorDetail(detail);
                result.setFinishedAt(tableEnd);
                result.setDurationMs(Duration.between(tableStart, tableEnd).toMillis());
                stageTableResultRepo.save(result);

                /* 구조적 stage 실패도 Quarantine 카드로 노출 — 공통 헬퍼 사용. */
                StageHelpers.recordStageFailureQuarantine(ctx, quarantineService, stage, childBinding,
                        tableLabel, "Transform", "transform.failure", e.getMessage());

                log.warn("TransformStage failed for {} : {}", tobeTable, e.getMessage());
                ingest(ctx, "Transform failed for " + tableLabel + ": " + e.getMessage(), false);
                failedCount++;
                stage.setTablesSuccess(successCount);
                stage.setTablesFailed(failedCount);
                stageInstanceRepo.save(stage);
                broadcaster.stageProgress(runId, stage);
            }
        }

        OffsetDateTime finishedAt = OffsetDateTime.now();
        stage.setFinishedAt(finishedAt);
        stage.setDurationMs(Duration.between(startedAt, finishedAt).toMillis());
        stage.setTablesSuccess(successCount);
        stage.setTablesFailed(failedCount);
        stage.setStatus(failedCount == 0 ? StageStatus.success : StageStatus.failed);
        if (failedCount > 0) {
            stage.setErrorSummary(failedCount + " tables failed in transform stage");
        }
        stageInstanceRepo.save(stage);

        ingest(ctx, "Stage transform completed — " + successCount + " success, " + failedCount + " failed", true);
        log.info("TransformStage runId={} success={} failed={}", runId, successCount, failedCount);
    }

    /**
     * Mapping rules → CREATE OR REPLACE TABLE schema.tobe_xxx AS SELECT ... FROM {composition}
     * FROM 절은 SqlComposer 가 composition_kind (single/join/union) 별로 생성.
     */
    /**
     * union binding 의 각 AS-IS source 테이블 컬럼 시그니처(이름+순서)를 DuckDB 에서 읽어
     * {@link SqlComposer#assertUnionColumnsAligned} 로 일치 검사. 불일치 시 IllegalStateException
     * → per-table catch → 해당 테이블 failed + Quarantine (silent 오정렬 대신 visible failure).
     * source 는 extract stage 가 만든 {@code {schema}.asis_{table}} 로 이미 존재.
     */
    private void assertUnionSourcesAligned(String schema, MappingTableBinding binding) throws Exception {
        List<MappingTableBindingSource> sources = binding.getSources();
        if (sources == null || sources.size() < 2) return;
        List<String> tables = new ArrayList<>();
        List<List<String>> signatures = new ArrayList<>();
        try (Statement st = duckDbService.statement()) {
            for (MappingTableBindingSource s : sources) {
                String fq = quoteIdent(schema) + "." + quoteIdent("asis_" + s.getAsisTable());
                List<String> cols = new ArrayList<>();
                try (ResultSet rs = st.executeQuery("SELECT * FROM " + fq + " LIMIT 0")) {
                    ResultSetMetaData md = rs.getMetaData();
                    for (int i = 1; i <= md.getColumnCount(); i++) cols.add(md.getColumnLabel(i));
                }
                tables.add(s.getAsisTable());
                signatures.add(cols);
            }
        }
        SqlComposer.assertUnionColumnsAligned(tables, signatures);
    }

    private String buildTransformSql(String schema, String tobeTable, List<MappingRule> rules,
                                     MappingTableBinding binding,
                                     Map<String, List<MappingCodeMap>> codeMapsByDomain) {
        String fqTobe = quoteIdent(schema) + "." + quoteIdent("tobe_" + tobeTable);

        // 가독성을 위해 여러 줄로 포맷팅 — DuckDB 는 whitespace 무관. ArtifactsPage 의 SQL view
        // 가 이 텍스트를 그대로 보여주므로 컬럼/절 구분이 분명해야 한다.
        StringBuilder sb = new StringBuilder();
        sb.append("CREATE OR REPLACE TABLE ").append(fqTobe).append(" AS\n");
        sb.append("SELECT\n");

        // skip 이 아닌 rule 만 모아 한 번에 join — 쉼표를 줄 끝에 두고 마지막엔 안 붙인다.
        java.util.List<String> colLines = new java.util.ArrayList<>();
        for (MappingRule rule : rules) {
            if ("skip".equals(rule.getStrategy())) continue;
            String expr = buildColumnExpr(rule, binding, codeMapsByDomain);
            colLines.add("  " + expr + " AS " + quoteIdent(rule.getTobeColumn()));
        }
        if (colLines.isEmpty()) {
            // 모든 rule 이 skip 이면 SELECT 가 비어 SQL 깨짐
            throw new IllegalStateException("all rules are 'skip' for " + tobeTable);
        }
        sb.append(String.join(",\n", colLines));

        sb.append(sourceClause(schema, binding));
        return sb.toString();
    }

    /**
     * FROM [JOIN] [expand] [WHERE] [GROUP BY] 절 — SELECT 뒤에 붙는 source 부분.
     * buildTransformSql 과 시각손실 probe(checkDateTimeLoss)가 동일 source 컨텍스트를 쓰도록 공유.
     * sources 가 없으면 "" (FROM-less SELECT).
     */
    private String sourceClause(String schema, MappingTableBinding binding) {
        StringBuilder sb = new StringBuilder();
        // composition_kind 별 FROM 절. sources 없으면 (none) FROM 생략 — DuckDB FROM-less SELECT.
        String fromClause = SqlComposer.fromClause(schema, binding);
        if (fromClause != null) {
            sb.append("\nFROM ").append(fromClause);
        }
        // Row 1:N 펼침 — sources/JOIN 뒤, WHERE 앞에 그대로 인젝션.
        if (binding.getExpandExpr() != null && !binding.getExpandExpr().isBlank()) {
            sb.append("\n").append(binding.getExpandExpr());
        }
        if (binding.getWhereFilter() != null && !binding.getWhereFilter().isBlank()) {
            sb.append("\nWHERE ").append(stripLeadingKw(binding.getWhereFilter(), "WHERE"));
        }
        // Row N:1 집계 — GROUP BY 표현식이 있으면 인젝션.
        if (binding.getGroupByExpr() != null && !binding.getGroupByExpr().isBlank()) {
            sb.append("\nGROUP BY ").append(stripLeadingKw(binding.getGroupByExpr(), "GROUP BY"));
        }
        return sb.toString();
    }

    /** "WHERE col=x" / "GROUP BY col" 처럼 사용자가 키워드 포함 입력해도 중복 안 박히게 strip. */
    private static String stripLeadingKw(String expr, String keyword) {
        if (expr == null) return null;
        String trimmed = expr.trim();
        String upper = trimmed.toUpperCase();
        String kwUp = keyword.toUpperCase();
        if (upper.startsWith(kwUp + " ") || upper.startsWith(kwUp + "\t") || upper.startsWith(kwUp + "\n")) {
            return trimmed.substring(keyword.length()).trim();
        }
        return trimmed;
    }

    /**
     * 한 mapping rule → SELECT expression. AS-IS 컬럼 참조 alias 는 SqlComposer.aliasFor
     * (single="asis", join=source 매칭, union="u").
     * 우선순위:
     *   1. strategy='null'    → NULL
     *   2. strategy='default' → '<default_value>'
     *   3. code_domain 있으면 → CASE {alias}.col WHEN 'src' THEN 'tgt' ... END
     *   4. transform_rule 있으면 → transform_rule (raw SQL expression, 사용자 입력)
     *   5. default → {alias}."<asis_column[0]>"
     */
    private String buildColumnExpr(MappingRule rule, MappingTableBinding binding,
                                   Map<String, List<MappingCodeMap>> codeMapsByDomain) {
        if ("null".equals(rule.getStrategy())) {
            return "NULL";
        }
        if ("default".equals(rule.getStrategy())) {
            String dv = rule.getDefaultValue();
            return dv == null ? "NULL" : "'" + sqlEscape(dv) + "'";
        }

        String alias = SqlComposer.aliasFor(rule, binding);
        String[] asisCols = rule.getAsisColumn();
        String firstAsisCol = (asisCols != null && asisCols.length > 0) ? asisCols[0] : null;

        if (rule.getCodeDomain() != null && !rule.getCodeDomain().isBlank()) {
            List<MappingCodeMap> codes = codeMapsByDomain.get(rule.getCodeDomain());
            if (codes != null && !codes.isEmpty() && firstAsisCol != null) {
                StringBuilder cb = new StringBuilder("CASE ")
                        .append(alias).append(".").append(quoteIdent(firstAsisCol));
                for (MappingCodeMap m : codes) {
                    cb.append(" WHEN '").append(sqlEscape(m.getSourceValue()))
                      .append("' THEN '").append(sqlEscape(m.getTargetValue())).append("'");
                }
                cb.append(" ELSE NULL END");
                return cb.toString();
            }
        }

        if (rule.getTransformRule() != null && !rule.getTransformRule().isBlank()) {
            return rule.getTransformRule();
        }

        // 기본: AS-IS 컬럼 참조. asisColumn 이 여러 개면 NULL-safe CONCAT 으로 combine
        // (날짜 조립 등 구조적 결합은 transform_rule 로 — 위에서 이미 처리됨).
        if (asisCols != null) {
            java.util.List<String> valid = new java.util.ArrayList<>();
            for (String c : asisCols) {
                if (c != null && !c.isBlank()) valid.add(c.trim());
            }
            if (valid.size() == 1) {
                return alias + "." + quoteIdent(valid.get(0));
            }
            if (valid.size() > 1) {
                String joined = valid.stream()
                        .map(c -> alias + "." + quoteIdent(c))
                        .collect(java.util.stream.Collectors.joining(", "));
                return "CONCAT(" + joined + ")";
            }
        }
        return "NULL";
    }

    /**
     * DATE 시각 silent 손실 진단. 각 TO-BE date(date-only) 컬럼의 변환식을 AS-IS source 에 대고
     * TIMESTAMP 로 평가 → 시·분·초가 0 이 아닌 행(= PG date 적재 시 시각 절삭 예정)을 센다.
     * count>0 면 severity=warning Quarantine + sample. Load 는 차단하지 않는다.
     *
     * 직접 매핑·transform_rule 식 모두 커버(변환식 그대로 평가). 식이 안에서 명시적으로
     * CAST(x AS DATE) 하면 이미 절삭돼 못 잡음(작성자 의도) — 알려진 한계.
     */
    private void checkDateTimeLoss(StageContext ctx, StageInstance stage,
                                   MappingTableBinding childBinding, MappingTableBinding binding,
                                   List<MappingRule> rules,
                                   Map<String, List<MappingCodeMap>> codeMapsByDomain,
                                   String schema, String tableLabel,
                                   Map<String, String> colTypeByName) throws Exception {
        String src = sourceClause(schema, binding);
        if (src.isBlank()) return;   // source 없음(defaults only) — 시각 손실 무관.

        for (MappingRule rule : rules) {
            if ("skip".equals(rule.getStrategy())) continue;
            if (!isDateOnly(colTypeByName.get(rule.getTobeColumn()))) continue;   // TO-BE date-only 컬럼만

            String expr = buildColumnExpr(rule, binding, codeMapsByDomain);
            String col  = rule.getTobeColumn();
            // 변환식 값을 TIMESTAMP 로 평가. TRY_CAST 라 타임스탬프로 못 읽는 값은 NULL(무시).
            String inner = "SELECT TRY_CAST((" + expr + ") AS TIMESTAMP) AS __ts" + src;
            String cond  = "__ts IS NOT NULL AND (EXTRACT(hour FROM __ts) <> 0"
                    + " OR EXTRACT(minute FROM __ts) <> 0 OR EXTRACT(second FROM __ts) <> 0)";

            long count;
            try (Statement st = duckDbService.statement();
                 ResultSet rs = st.executeQuery("SELECT COUNT(*) FROM (" + inner + ") _t WHERE " + cond)) {
                rs.next();
                count = rs.getLong(1);
            }
            if (count <= 0) continue;

            java.util.List<java.util.List<Object>> sampleRows = new java.util.ArrayList<>();
            try (Statement st = duckDbService.statement();
                 ResultSet rs = st.executeQuery("SELECT CAST(__ts AS VARCHAR) FROM (" + inner + ") _t WHERE "
                         + cond + " LIMIT " + SAMPLE_LIMIT)) {
                while (rs.next()) {
                    Object v = rs.getObject(1);
                    sampleRows.add(java.util.List.of(v == null ? "" : v));
                }
            }

            String reason = "Time component truncated by DATE mapping";
            Map<String, Object> data = new HashMap<>();
            data.put("reason", reason);
            data.put("detail", tableLabel + "." + col + " — AS-IS 시각(시·분·초)이 date 변환으로 절삭됨");
            data.put("severity", "warning");
            data.put("stageLabel", "Transform");
            data.put("table", tableLabel);
            data.put("columns", List.of(col));
            data.put("columnRoles", List.of("violated"));
            data.put("sampleRows", sampleRows);

            quarantineService.record(ctx.getRunHistory().getId(), stage.getId(), childBinding.getId(),
                    null, reason + " — " + col, QuarantineSeverity.warning, data, count,
                    ctx.getLogLineSeqCursor());
            ingest(ctx, "Time-loss WARN in " + tableLabel + "." + col + " (" + count + " rows)", true);
        }
    }

    /** TO-BE 타입이 date-only(PG date)인가 — timestamp/timestamptz/datetime 은 시각 보존이라 제외. */
    static boolean isDateOnly(String tobeType) {
        return tobeType != null && tobeType.trim().toLowerCase().equals("date");
    }

    private void ingest(StageContext ctx, String message, boolean info) {
        long seq = ctx.nextLogSeq();
        var line = info
                ? StageHelpers.info(seq, ctx.getRunHistory().getId(), STAGE_KEY, message)
                : StageHelpers.error(seq, ctx.getRunHistory().getId(), STAGE_KEY, message);
        runLogIngest.ingest(ctx.getRunHistory().getId(), ctx.getProject().getId(), List.of(line));
    }

    private static String quoteIdent(String name) {
        return "\"" + name.replace("\"", "\"\"") + "\"";
    }

    private static String sqlEscape(String s) {
        return s == null ? "" : s.replace("'", "''");
    }
}
