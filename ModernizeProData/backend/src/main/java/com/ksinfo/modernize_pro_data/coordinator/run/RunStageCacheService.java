package com.ksinfo.modernize_pro_data.coordinator.run;

import com.ksinfo.modernize_pro_data.common.duckdb.DuckDbService;
import com.ksinfo.modernize_pro_data.common.util.HashUtil;
import com.ksinfo.modernize_pro_data.coordinator.mapping.MappingCodeMap;
import com.ksinfo.modernize_pro_data.coordinator.mapping.MappingCodeMapRepository;
import com.ksinfo.modernize_pro_data.coordinator.mapping.MappingRule;
import com.ksinfo.modernize_pro_data.coordinator.mapping.MappingRuleRepository;
import com.ksinfo.modernize_pro_data.coordinator.mapping.MappingTableBinding;
import com.ksinfo.modernize_pro_data.coordinator.worker.StageContext;
import com.ksinfo.modernize_pro_data.coordinator.worker.StageHelpers;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.sql.Statement;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.TreeSet;

/**
 * stage-cache (재실행 캐시) — 직전 성공 run 의 CP2(parquet2) 를 재사용해 extract/reconcile/transform 생략.
 *
 * 정합성 우선: CP2 입력(소스 CSV / 매핑 룰 / 코드맵 / binding)을 모두 fingerprint 에 넣고,
 * 하나라도 바뀌면 fingerprint 불일치 → cache miss → full run. (의심되면 무조건 다시 돈다.)
 * whole-run all-or-nothing — 모든 binding 의 parquet2 가 있어야 HIT. opt-in(기본 OFF), cutover 제외.
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class RunStageCacheService {

    private final MappingRuleRepository mappingRuleRepo;
    private final MappingCodeMapRepository mappingCodeMapRepo;
    private final RunHistoryRepository runHistoryRepo;
    private final DuckDbService duckDbService;

    /** CP2 유효성 지문. 같으면 직전 parquet2 재사용 가능. */
    public String computeFingerprint(StageContext ctx) {
        String projectId = ctx.getProject().getId();
        StringBuilder sb = new StringBuilder();
        sb.append("project=").append(projectId).append('\n');

        // 1. source CSV (path+size+mtime) — distinct asis table, 정렬
        Path baseDir = (ctx.getSite().getCsvPath() == null || ctx.getSite().getCsvPath().isBlank())
                ? null : Paths.get(ctx.getSite().getCsvPath()).toAbsolutePath().normalize();
        TreeSet<String> asisTables = new TreeSet<>();
        for (MappingTableBinding b : ctx.getBindings()) {
            for (var s : b.getSources()) {
                if (s.getAsisTable() != null && !s.getAsisTable().isBlank()) asisTables.add(s.getAsisTable());
            }
        }
        for (String t : asisTables) {
            Path csv = baseDir == null ? null : StageHelpers.resolveCsvFile(baseDir, t);
            if (csv != null) {
                try {
                    sb.append("csv=").append(t).append(':').append(Files.size(csv))
                      .append(':').append(Files.getLastModifiedTime(csv).toMillis()).append('\n');
                } catch (Exception e) {
                    sb.append("csv=").append(t).append(":ERR\n");
                }
            } else {
                sb.append("csv=").append(t).append(":MISSING\n");
            }
        }

        // 2. binding 구성 (composition / where), tobe_table 정렬
        ctx.getBindings().stream()
                .sorted(Comparator.comparing(MappingTableBinding::getTobeTable, Comparator.nullsFirst(Comparator.naturalOrder())))
                .forEach(b -> sb.append("bind=").append(nv(b.getTobeTable())).append('|')
                        .append(nv(b.getCompositionKind())).append('|')
                        .append(nv(b.getWhereFilter())).append('\n'));

        // 3. mapping rules (id 정렬 → 결정적)
        List<MappingRule> rules = mappingRuleRepo.findByProjectId(projectId);
        rules.stream()
                .sorted(Comparator.comparing(MappingRule::getId, Comparator.nullsFirst(Comparator.naturalOrder())))
                .forEach(r -> sb.append("rule=").append(nv(r.getTobeTable())).append('.').append(nv(r.getTobeColumn()))
                        .append('|').append(nv(r.getStrategy()))
                        .append('|').append(nv(r.getTransformRule()))
                        .append('|').append(nv(r.getTransformSql()))
                        .append('|').append(nv(r.getDefaultValue()))
                        .append('|').append(nv(r.getCodeDomain()))
                        .append('|').append(nv(r.getAsisTable()))
                        .append('|').append(r.getAsisColumn() == null ? "" : String.join(",", r.getAsisColumn()))
                        .append('\n'));

        // 4. code maps (domain/ordinal 정렬은 repo 가 처리)
        for (MappingCodeMap m : mappingCodeMapRepo.findByProjectIdOrderByDomainAscOrdinalAsc(projectId)) {
            sb.append("code=").append(nv(m.getDomain())).append('|')
              .append(nv(m.getSourceValue())).append("=>").append(nv(m.getTargetValue())).append('\n');
        }

        return HashUtil.sha256Hex(sb.toString());
    }

    /** 같은 project 의 최신 성공 run 중 fingerprint 일치 + 모든 binding 의 parquet2 존재하는 dir. */
    public Optional<Path> findUsableCache(StageContext ctx, String fingerprint) {
        String currentRunId = ctx.getRunHistory().getId();
        for (RunHistory rh : runHistoryRepo.findByProjectIdOrderByStartedAtDesc(ctx.getProject().getId())) {
            if (rh.getId().equals(currentRunId) || rh.getStatus() != RunStatus.success) continue;
            Map<String, Object> md = rh.getMetadata();
            if (md == null) continue;
            Object fp = md.get("cacheFingerprint");
            Object dir = md.get("parquet2Dir");
            if (fp == null || dir == null || !fingerprint.equals(fp.toString())) continue;
            Path p2 = Paths.get(dir.toString());
            boolean allExist = ctx.getBindings().stream()
                    .allMatch(b -> Files.isRegularFile(p2.resolve(b.getTobeTable() + ".parquet")));
            if (allExist) return Optional.of(p2);
        }
        return Optional.empty();
    }

    /** parquet2 를 DuckDB tobe_ 테이블로 적재 (extract/transform 대체). */
    public void loadCacheIntoDuckDb(StageContext ctx, Path parquet2Dir) throws Exception {
        String schema = ctx.getDuckdbSchema();
        try (Statement st = duckDbService.statement()) {
            st.execute("CREATE SCHEMA IF NOT EXISTS " + q(schema));
        }
        for (MappingTableBinding b : ctx.getBindings()) {
            Path pq = parquet2Dir.resolve(b.getTobeTable() + ".parquet");
            String esc = pq.toString().replace("\\", "/").replace("'", "''");
            String fq = q(schema) + "." + q("tobe_" + b.getTobeTable());
            try (Statement st = duckDbService.statement()) {
                st.execute("CREATE OR REPLACE TABLE " + fq + " AS SELECT * FROM read_parquet('" + esc + "')");
            }
        }
    }

    private static String nv(String s) {
        return s == null ? "" : s;
    }

    private static String q(String name) {
        return "\"" + name.replace("\"", "\"\"") + "\"";
    }
}
