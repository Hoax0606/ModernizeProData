package com.ksinfo.modernize_pro_data.coordinator.worker.stages;

import com.ksinfo.modernize_pro_data.coordinator.ddl.DdlImport;
import com.ksinfo.modernize_pro_data.coordinator.ddl.DdlImportRepository;
import com.ksinfo.modernize_pro_data.coordinator.mapping.MappingTableBinding;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageInstance;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageInstanceRepository;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageStatus;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageTableResult;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageTableResultRepository;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageTableStatus;
import com.ksinfo.modernize_pro_data.coordinator.runlog.RunLogIngestService;
import com.ksinfo.modernize_pro_data.coordinator.site.Site;
import com.ksinfo.modernize_pro_data.coordinator.worker.StageContext;
import com.ksinfo.modernize_pro_data.coordinator.worker.StageHelpers;
import com.ksinfo.modernize_pro_data.coordinator.worker.StageRunner;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.nio.file.Path;
import java.nio.file.Paths;
import java.sql.Connection;
import java.sql.DriverManager;
import java.time.Duration;
import java.time.OffsetDateTime;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Properties;

/**
 * Check stage — 입력 자산 존재 검증.
 *
 * Project 단위:
 *   - AS-IS DDL 등록 여부 (ddl_imports 의 status='success')
 *   - TO-BE DDL 등록 여부
 *   - TO-BE DB 접속 ping (DriverManager 5초 timeout)
 *
 * 각 binding 별:
 *   - AS-IS CSV 파일 존재 (sites.csv_path 의 {tobe_table}.csv)
 *
 * Pre-flight 가 frontend 1차 방어선이지만 backend 도 한 번 더 검증.
 * continue-on-error: 일부 binding 실패해도 다른 binding 처리, stage end 시 fail/success 결정.
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class CheckStage implements StageRunner {

    private static final String STAGE_KEY = "check";
    private static final int DB_CONNECT_TIMEOUT_SEC = 5;

    private final StageInstanceRepository stageInstanceRepo;
    private final StageTableResultRepository stageTableResultRepo;
    private final DdlImportRepository ddlImportRepo;
    private final RunLogIngestService runLogIngest;

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
        Site site = ctx.getSite();
        List<MappingTableBinding> bindings = ctx.getBindings();

        ingest(ctx, "Stage check started — " + bindings.size() + " bindings");

        // Project 단위 사전 검증 — 한 번만 (전체 실패 시 모든 binding 을 동일 사유로 fail).
        String projectError = validateProjectAssets(projectId, site, ctx);

        int successCount = 0;
        int failedCount = 0;

        for (MappingTableBinding binding : bindings) {
            OffsetDateTime tableStart = OffsetDateTime.now();
            String tobeSchema = binding.getTobeSchema() == null ? "" : binding.getTobeSchema();
            String tobeTable  = binding.getTobeTable();

            StageTableResult result = stageTableResultRepo
                    .findByStageInstanceIdAndBindingId(stage.getId(), binding.getId())
                    .orElseGet(() -> StageTableResult.create(stage.getId(), binding.getId(), tobeSchema, tobeTable));
            result.setStartedAt(tableStart);

            String error = projectError;
            if (error == null) {
                error = validateBindingCsv(site, binding);
            }

            OffsetDateTime tableEnd = OffsetDateTime.now();
            result.setFinishedAt(tableEnd);
            result.setDurationMs(Duration.between(tableStart, tableEnd).toMillis());

            if (error != null) {
                result.setStatus(StageTableStatus.failed);
                Map<String, Object> detail = new HashMap<>();
                detail.put("message", error);
                result.setErrorDetail(detail);
                ingest(ctx, "Check failed for " + tobeTable + ": " + error, false);
                failedCount++;
            } else {
                result.setStatus(StageTableStatus.success);
                ingest(ctx, "Check OK for " + tobeTable);
                successCount++;
            }
            stageTableResultRepo.save(result);
        }

        OffsetDateTime finishedAt = OffsetDateTime.now();
        stage.setFinishedAt(finishedAt);
        stage.setDurationMs(Duration.between(startedAt, finishedAt).toMillis());
        stage.setTablesSuccess(successCount);
        stage.setTablesFailed(failedCount);
        stage.setStatus(failedCount == 0 ? StageStatus.success : StageStatus.failed);
        if (failedCount > 0) {
            stage.setErrorSummary(failedCount + " tables failed in check stage");
        }
        stageInstanceRepo.save(stage);

        ingest(ctx, "Stage check completed — " + successCount + " success, " + failedCount + " failed");
        log.info("CheckStage runId={} success={} failed={}", runId, successCount, failedCount);
    }

    /** project 단위 검증. 통과 = null, 실패 = 이유 메시지. */
    private String validateProjectAssets(String projectId, Site site, StageContext ctx) {
        // AS-IS DDL
        Optional<DdlImport> asisDdl = ddlImportRepo.findFirstByProjectIdAndSideOrderByImportedAtDesc(projectId, "asis");
        if (asisDdl.isEmpty() || !"success".equals(asisDdl.get().getStatus())) {
            return "AS-IS DDL not imported";
        }
        // TO-BE DDL
        Optional<DdlImport> tobeDdl = ddlImportRepo.findFirstByProjectIdAndSideOrderByImportedAtDesc(projectId, "tobe");
        if (tobeDdl.isEmpty() || !"success".equals(tobeDdl.get().getStatus())) {
            return "TO-BE DDL not imported";
        }
        // TO-BE DB ping
        String pingError = pingTobeDb(site);
        if (pingError != null) {
            return "TO-BE DB connection failed: " + pingError;
        }
        return null;
    }

    /** binding 단위 검증 — 각 AS-IS source 의 CSV 파일 존재 ({asis_table}.csv). */
    private String validateBindingCsv(Site site, MappingTableBinding binding) {
        if (site.getCsvPath() == null || site.getCsvPath().isBlank()) {
            return "site.csv_path not set";
        }
        Path baseDir = Paths.get(site.getCsvPath()).toAbsolutePath().normalize();
        for (var src : binding.getSources()) {
            String asisTable = src.getAsisTable();
            if (asisTable == null || asisTable.isBlank()) continue;
            Path csv = StageHelpers.resolveCsvFile(baseDir, asisTable);
            if (csv == null) {
                return "CSV not found: " + asisTable + ".csv in " + baseDir;
            }
        }
        return null;
    }

    /** TO-BE DB connection ping. site.tobeDbByEnv[site.environment] 에서 host/port/database/username/password. */
    private String pingTobeDb(Site site) {
        Map<String, Object> byEnv = site.getTobeDbByEnv();
        if (byEnv == null) return "tobe_db_by_env not set";
        Map<String, Object> cfg = site.getActiveTobeDbConfig();
        if (cfg == null) return "tobe DB config not set for env=" + site.getEnvironment();
        String host = (String) cfg.get("host");
        Object portObj = cfg.get("port");
        String database = (String) cfg.get("database");
        String username = (String) cfg.get("username");
        String password = (String) cfg.get("password");
        if (host == null || database == null) return "host or database missing in tobe DB config";
        int port = portObj instanceof Number ? ((Number) portObj).intValue()
                : portObj instanceof String ? Integer.parseInt((String) portObj) : 5432;

        String url = "jdbc:postgresql://" + host + ":" + port + "/" + database;
        Properties props = new Properties();
        if (username != null) props.setProperty("user", username);
        if (password != null) props.setProperty("password", password);
        props.setProperty("loginTimeout", String.valueOf(DB_CONNECT_TIMEOUT_SEC));
        props.setProperty("connectTimeout", String.valueOf(DB_CONNECT_TIMEOUT_SEC));
        try (Connection ignored = DriverManager.getConnection(url, props)) {
            return null;
        } catch (Exception e) {
            return e.getMessage();
        }
    }

    private void ingest(StageContext ctx, String message) {
        ingest(ctx, message, true);
    }

    private void ingest(StageContext ctx, String message, boolean info) {
        long seq = ctx.nextLogSeq();
        var line = info
                ? StageHelpers.info(seq, ctx.getRunHistory().getId(), STAGE_KEY, message)
                : StageHelpers.error(seq, ctx.getRunHistory().getId(), STAGE_KEY, message);
        runLogIngest.ingest(ctx.getRunHistory().getId(), ctx.getProject().getId(), List.of(line));
    }
}
