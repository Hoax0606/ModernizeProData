package com.ksinfo.modernize_pro_data.coordinator.api;

import com.ksinfo.modernize_pro_data.common.dto.ApiResponse;
import com.ksinfo.modernize_pro_data.common.exception.ApiException;
import com.ksinfo.modernize_pro_data.coordinator.runlog.RunLogIngestService;
import com.ksinfo.modernize_pro_data.coordinator.runlog.RunLogLine;
import com.ksinfo.modernize_pro_data.coordinator.runlog.RunLogQueryService;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.List;
import java.util.Optional;

/**
 * RunLog REST endpoints.
 *
 *  - POST  /api/v1/runs/{runId}/open                — meta + partition 생성
 *  - POST  /api/v1/runs/{runId}/logs/ingest         — Worker 가 chunk push (JSON; Arrow 는 Phase B)
 *  - POST  /api/v1/runs/{runId}/close               — meta.ended_at 기록
 *  - GET   /api/v1/runs/{runId}/logs                — keyset paging
 *  - GET   /api/v1/runs/{runId}/logs/around         — ±window context
 *  - GET   /api/v1/runs/{runId}/logs/{seq}          — 단건
 *  - GET   /api/v1/runs/{runId}/logs/counts         — 메타 카운트
 *  - GET   /api/v1/runs/{runId}/logs/export         — CSV 동기 export (10만 라인 cap)
 */
@Slf4j
@RestController
@RequiredArgsConstructor
public class RunLogController {

    private final RunLogIngestService ingest;
    private final RunLogQueryService query;

    private static final int EXPORT_LIMIT = 100_000;

    /* ────────────────────────── ingest side ─────────────────────────── */

    @PostMapping("/api/v1/runs/{runId}/open")
    public ApiResponse<Void> open(@PathVariable String runId,
                                  @Valid @RequestBody OpenRunRequest req) {
        ingest.openRun(runId, req.projectId());
        return ApiResponse.ok(null);
    }

    @PostMapping("/api/v1/runs/{runId}/logs/ingest")
    public ApiResponse<RunLogIngestService.IngestResult> ingest(
            @PathVariable String runId,
            @Valid @RequestBody IngestRequest req) {
        if (req.projectId() == null || req.projectId().isBlank()) {
            throw new ApiException("PROJECT_REQUIRED", "projectId 가 필요합니다", HttpStatus.BAD_REQUEST);
        }
        List<RunLogLine> lines = req.lines() == null ? List.of() :
            req.lines().stream().map(d -> RunLogLine.builder()
                .seq(d.seq())
                .runId(runId)
                .ts(d.ts())
                .level(RunLogLine.parseLevel(d.level()))
                .stage(d.stage())
                .message(d.message())
                .suggestion(d.suggestion())
                .build()).toList();
        return ApiResponse.ok(ingest.ingest(runId, req.projectId(), lines));
    }

    @PostMapping("/api/v1/runs/{runId}/close")
    public ApiResponse<Void> close(@PathVariable String runId) {
        ingest.closeRun(runId);
        return ApiResponse.ok(null);
    }

    /* ─────────────────────────── query side ─────────────────────────── */

    @GetMapping("/api/v1/runs/{runId}/logs")
    public ApiResponse<RunLogQueryService.Page> list(
            @PathVariable String runId,
            @RequestParam(required = false) String cursor,
            @RequestParam(required = false) String level,
            @RequestParam(required = false) String q,
            @RequestParam(defaultValue = "500") int limit) {
        List<Short> levels = parseLevels(level);
        return ApiResponse.ok(query.list(runId, cursor, levels, q, limit));
    }

    @GetMapping("/api/v1/runs/{runId}/logs/around")
    public ApiResponse<List<RunLogLine>> around(
            @PathVariable String runId,
            @RequestParam long seq,
            @RequestParam(defaultValue = "10") int window) {
        return ApiResponse.ok(query.around(runId, seq, window));
    }

    @GetMapping("/api/v1/runs/{runId}/logs/{seq}")
    public ApiResponse<RunLogLine> one(@PathVariable String runId, @PathVariable long seq) {
        Optional<RunLogLine> hit = query.findOne(runId, seq);
        return hit.map(ApiResponse::ok)
            .orElseThrow(() -> new ApiException("LOG_NOT_FOUND",
                "로그 항목을 찾을 수 없습니다", HttpStatus.NOT_FOUND));
    }

    @GetMapping("/api/v1/runs/{runId}/logs/counts")
    public ApiResponse<RunLogQueryService.Counts> counts(@PathVariable String runId) {
        return ApiResponse.ok(query.counts(runId));
    }

    @GetMapping("/api/v1/runs/{runId}/logs/export")
    public ResponseEntity<byte[]> exportCsv(
            @PathVariable String runId,
            @RequestParam(required = false) String level,
            @RequestParam(required = false) String q) {
        List<Short> levels = parseLevels(level);

        // 캡 — Phase B 에서 비동기 job 으로 교체. 폐쇄망에서 거대한 응답을 동기로 흘리지 않는다.
        RunLogQueryService.Page page = query.list(runId, null, levels, q, EXPORT_LIMIT);
        if (page.lines().size() == EXPORT_LIMIT) {
            log.warn("CSV export hit cap ({} lines) for run {}", EXPORT_LIMIT, runId);
        }

        byte[] csv = toCsv(page.lines());
        return ResponseEntity.ok()
            .header(HttpHeaders.CONTENT_DISPOSITION,
                "attachment; filename=\"" + runId + ".csv\"")
            .contentType(MediaType.parseMediaType("text/csv; charset=utf-8"))
            .body(csv);
    }

    /* ─────────────────────────── helpers ────────────────────────────── */

    private static List<Short> parseLevels(String level) {
        if (level == null || level.isBlank()) return List.of();
        return Arrays.stream(level.split(","))
            .map(String::trim)
            .filter(s -> !s.isEmpty())
            .map(RunLogLine::parseLevel)
            .map(Short::valueOf)
            .distinct()
            .toList();
    }

    private static byte[] toCsv(List<RunLogLine> lines) {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        try (Writer w = new OutputStreamWriter(bos, StandardCharsets.UTF_8)) {
            w.write("seq,ts,level,stage,message\n");
            for (RunLogLine l : lines) {
                w.write(l.getSeq() + ",");
                w.write((l.getTs() == null ? "" : l.getTs().toString()) + ",");
                w.write(RunLogLine.formatLevel(l.getLevel()) + ",");
                w.write(csvField(l.getStage()) + ",");
                w.write(csvField(l.getMessage()));
                w.write('\n');
            }
        } catch (IOException e) {
            throw new ApiException("EXPORT_FAILED", "CSV 생성 실패", HttpStatus.INTERNAL_SERVER_ERROR);
        }
        return bos.toByteArray();
    }

    private static String csvField(String v) {
        if (v == null) return "";
        return "\"" + v.replace("\"", "\"\"") + "\"";
    }

    /* ─────────────────────────────── DTO ────────────────────────────── */

    public record OpenRunRequest(@NotBlank @Size(max = 40) String projectId) { }

    public record IngestRequest(
            @NotBlank @Size(max = 40) String projectId,
            List<LineDto> lines
    ) { }

    public record LineDto(
            long seq,
            java.time.OffsetDateTime ts,
            String level,
            String stage,
            String message,
            String suggestion
    ) { }
}
