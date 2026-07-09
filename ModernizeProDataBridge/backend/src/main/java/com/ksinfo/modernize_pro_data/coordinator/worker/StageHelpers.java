package com.ksinfo.modernize_pro_data.coordinator.worker;

import com.ksinfo.modernize_pro_data.coordinator.mapping.MappingTableBinding;
import com.ksinfo.modernize_pro_data.coordinator.quarantine.QuarantineService;
import com.ksinfo.modernize_pro_data.coordinator.quarantine.QuarantineSeverity;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageInstance;
import com.ksinfo.modernize_pro_data.coordinator.runlog.RunLogLine;
import lombok.extern.slf4j.Slf4j;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.OffsetDateTime;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;

/**
 * Stage runner 공통 유틸 (static methods).
 *   - CSV 파일 해석 (SiteCsvPreviewController 패턴 그대로 — case-insensitive fallback)
 *   - RunLogLine 빌더 헬퍼
 *   - Stage-level 실패의 Quarantine 카드 기록 (모든 stage 가 일관 사용)
 */
@Slf4j
public final class StageHelpers {

    private StageHelpers() {}

    /**
     * AS-IS source 의 CSV 파일 해석. 다음 순서로 시도 (둘 다 case-insensitive):
     *   1) {schema}.{table}.csv  (예: RECRUIT.APPLICANTS.csv) — 문서화된 추출 규칙
     *   2) {table}.csv           (예: m_employee.csv)
     * binding 은 schema 를 따로 보존(asis_schema)하므로 schema 한정 추출 파일도 찾을 수 있다.
     * 없으면 null. (MappingReportService.resolveCsvFile 와 동일 규칙.)
     */
    public static Path resolveCsvFile(Path baseDir, String schema, String tableName) {
        if (schema != null && !schema.isBlank()) {
            Path qualified = resolveCsvFile(baseDir, schema + "." + tableName);
            if (qualified != null) return qualified;
        }
        return resolveCsvFile(baseDir, tableName);
    }

    /**
     * Resolve {baseDir}/{tableName}.csv. 대소문자 fallback. 없으면 null.
     * bare 테이블명(점 없음)일 때는, 정확/대소문자 매칭이 없으면 {schema}.{tableName}.csv
     * 형태의 스키마 접두 파일도 시도한다(유일할 때만). DDL 이 스키마 없이 import 됐는데 추출
     * 파일은 스키마 포함(BANKSYS.CONTACT_INFO.csv)인 경우 대응 — SiteCsvPreviewController
     * (preview/Trial 게이트)와 동일 규칙을 유지해 run 과 게이트가 같은 파일을 찾게 한다.
     */
    public static Path resolveCsvFile(Path baseDir, String tableName) {
        if (baseDir == null || !Files.isDirectory(baseDir)) return null;
        Path exact = baseDir.resolve(tableName + ".csv").normalize();
        if (!exact.startsWith(baseDir)) return null;
        if (Files.isRegularFile(exact)) return exact;

        String want = (tableName + ".csv").toLowerCase();
        try (Stream<Path> stream = Files.list(baseDir)) {
            Path ci = stream
                    .filter(Files::isRegularFile)
                    .filter(p -> p.getFileName().toString().toLowerCase().equals(want))
                    .findFirst()
                    .orElse(null);
            if (ci != null) return ci;
        } catch (IOException e) {
            return null;
        }
        // bare 테이블명 → {schema}.{tableName}.csv (유일할 때만). 여러 스키마 중복 시 모호 → null.
        if (tableName.indexOf('.') < 0) {
            String suffix = ("." + tableName + ".csv").toLowerCase();
            try (Stream<Path> stream = Files.list(baseDir)) {
                List<Path> matches = stream
                        .filter(Files::isRegularFile)
                        .filter(p -> p.getFileName().toString().toLowerCase().endsWith(suffix))
                        .limit(2)
                        .toList();
                if (matches.size() == 1) return matches.get(0);
            } catch (IOException e) {
                return null;
            }
        }
        return null;
    }

    public static RunLogLine line(long seq, String runId, String stage, short level, String message) {
        return RunLogLine.builder()
                .seq(seq)
                .runId(runId)
                .ts(OffsetDateTime.now())
                .level(level)
                .stage(stage)
                .message(message)
                .build();
    }

    public static RunLogLine info(long seq, String runId, String stage, String message) {
        return line(seq, runId, stage, RunLogLine.LEVEL_INFO, message);
    }

    public static RunLogLine warn(long seq, String runId, String stage, String message) {
        return line(seq, runId, stage, RunLogLine.LEVEL_WARN, message);
    }

    public static RunLogLine error(long seq, String runId, String stage, String message) {
        return line(seq, runId, stage, RunLogLine.LEVEL_ERROR, message);
    }

    /**
     * Stage 실행 중 binding-level 실패 (timezone 파싱 / SQL syntax / 파일 부재 / encoding 등 구조적 에러)
     * 를 Quarantine 카드로 노출. row-level 검증 위반과 달리 sample row 가 없으므로
     * columns=["error"] / sampleRows=[[errorMessage]] 형태로 message 만 표시.
     * LogViewer 의 Quarantine 탭에 카드로 나타나 사용자가 stream ERROR 만 보지 않아도 인지 가능.
     *
     * 사용처: 모든 stage 의 binding-level catch 절 — Check / Extract / Reconcile / Transform / Load.
     * Audit / Verify 는 row-level / mismatch 카드를 자체 생성하므로 별개.
     *
     * @param stageDisplayName 카드 reason / detail 에 사용되는 stage 이름 (예: 'Transform', 'Extract').
     * @param stageLabel       quarantineMock.ts 의 humanize 분기용 라벨 (예: 'transform.failure', 'encode').
     */
    public static void recordStageFailureQuarantine(
            StageContext ctx,
            QuarantineService quarantineService,
            StageInstance stage,
            MappingTableBinding binding,
            String tableLabel,
            String stageDisplayName,
            String stageLabel,
            String errorMessage) {
        try {
            String msg = errorMessage == null ? "(no message)" : errorMessage;
            Map<String, Object> data = new HashMap<>();
            data.put("reason", stageDisplayName + " failure");
            data.put("detail", tableLabel + ": " + msg);
            data.put("severity", "error");
            data.put("stageLabel", stageLabel);
            data.put("table", tableLabel);
            data.put("columns", List.of("error"));
            data.put("columnRoles", List.of("violated"));
            data.put("sampleRows", List.of(List.of(msg)));
            quarantineService.record(
                    ctx.getRunHistory().getId(),
                    stage.getId(),
                    binding.getId(),
                    null,
                    stageDisplayName + " failure — " + tableLabel,
                    QuarantineSeverity.error,
                    data,
                    1L,
                    ctx.getLogLineSeqCursor());
        } catch (Exception ex) {
            // quarantine 기록 자체가 실패해도 stage 처리에 영향 X.
            log.warn("Stage failure quarantine record failed for {} ({}): {}",
                    tableLabel, stageDisplayName, ex.getMessage());
        }
    }
}
