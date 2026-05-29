package com.ksinfo.modernize_pro_data.coordinator.api;

import com.ksinfo.modernize_pro_data.common.dto.ApiResponse;
import com.ksinfo.modernize_pro_data.common.exception.ApiException;
import com.ksinfo.modernize_pro_data.coordinator.run.RunHistory;
import com.ksinfo.modernize_pro_data.coordinator.run.RunHistoryRepository;
import com.ksinfo.modernize_pro_data.coordinator.run.RunService;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageInstance;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageTableResult;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageTableStatus;
import lombok.RequiredArgsConstructor;

import java.util.Map;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

/**
 * Worker → Coordinator REST callback (worker_token 認証).
 *
 * Worker 가 WS RUN_START 受領後、本 controller 의 /payload 로 詳細を fetch し、
 * 実行中에 /progress, 完了 시 /complete or /fail 을 callback.
 *
 * /api/v1/internal/** 은 WorkerTokenAuthFilter (Task #6) 이 認証.
 * PoC 1 차 시점에서는 worker_nodes 테이블이 별 branch 이므로, heartbeat 는
 * log only.
 */
@Slf4j
@RestController
@RequiredArgsConstructor
@PreAuthorize("hasAnyRole('WORKER', 'MASTER', 'ADMIN')")
public class InternalRunController {

    private final RunService runService;
    private final RunHistoryRepository runHistoryRepo;
    private final SimpMessagingTemplate messagingTemplate;

    /* ── DTOs ──────────────────────────────────────── */

    public record ProgressDto(
            Long rowsProcessed,
            Long rowsTotal,
            String currentTable,
            String phase           // transform | load | validate
    ) {}

    public record CompleteDto(
            Long batchJobExecutionId,
            Long durationMs
    ) {}

    public record FailDto(
            Long batchJobExecutionId,
            Long durationMs,
            String errorMessage,
            String errorCode
    ) {}

    public record AbortDto(
            String reason
    ) {}

    public record StageCompleteDto(
            Integer tablesSuccess,
            Integer tablesFailed,
            String errorSummary
    ) {}

    public record StageTableResultDto(
            String bindingId,
            StageTableStatus status,
            Long rowCount,
            Integer errorCount,
            Map<String, Object> errorDetail,
            Long durationMs
    ) {}

    /* ── Endpoints ─────────────────────────────────── */

    /**
     * Worker 가 RUN_START 受領 후 詳細을 fetch.
     * PoC 1 차 시점에서는 RunHistory entity 자체를 返す (snapshot rules 등 詳細은
     * 別 branch 에서 추가될 때 拡張).
     */
    @GetMapping("/api/v1/internal/runs/{runId}/payload")
    public ApiResponse<RunHistory> getPayload(@PathVariable String runId) {
        RunHistory rh = runHistoryRepo.findById(runId)
                .orElseThrow(() -> new ApiException("RUN_NOT_FOUND",
                        "run not found: " + runId, HttpStatus.NOT_FOUND));
        return ApiResponse.ok(rh);
    }

    /** Worker 가 RUN_START 받았다는 受領 confirmation. PoC 는 log only. */
    @PostMapping("/api/v1/internal/runs/{runId}/ack")
    public ApiResponse<Void> ack(@PathVariable String runId) {
        log.info("Worker ack runId={}", runId);
        return ApiResponse.ok(null);
    }

    /**
     * 진행 상황 보고. FE 의 /topic/run/{runId}/progress 에 re-broadcast 하여
     * progress bar 가 리얼타임 업데이트되도록 한다.
     */
    @PostMapping("/api/v1/internal/runs/{runId}/progress")
    public ApiResponse<Void> progress(@PathVariable String runId,
                                      @RequestBody ProgressDto dto) {
        messagingTemplate.convertAndSend("/topic/run/" + runId + "/progress", dto);
        return ApiResponse.ok(null);
    }

    /** 성공 완료. run_history.status='success' + projects.run_status='idle'. */
    @PostMapping("/api/v1/internal/runs/{runId}/complete")
    public ApiResponse<RunHistory> complete(@PathVariable String runId,
                                            @RequestBody CompleteDto dto) {
        RunHistory rh = runService.completeRun(runId, dto.batchJobExecutionId(), dto.durationMs());
        log.info("Worker complete runId={} durationMs={}", runId, dto.durationMs());
        return ApiResponse.ok(rh);
    }

    /** 失敗 完了. run_history.status='failed' + projects.run_status='idle'. */
    @PostMapping("/api/v1/internal/runs/{runId}/fail")
    public ApiResponse<RunHistory> fail(@PathVariable String runId,
                                        @RequestBody FailDto dto) {
        RunHistory rh = runService.failRun(runId,
                dto.batchJobExecutionId(), dto.durationMs(), dto.errorMessage());
        log.warn("Worker fail runId={} errorCode={} message={}",
                runId, dto.errorCode(), dto.errorMessage());
        return ApiResponse.ok(rh);
    }

    /**
     * 中断. run_history.status='aborted' + projects.run_status='idle'.
     * 用途: 명시적 cancel / dev 환경에서 stuck 한 run 을 復旧.
     */
    @PostMapping("/api/v1/internal/runs/{runId}/abort")
    public ApiResponse<RunHistory> abort(@PathVariable String runId,
                                         @RequestBody AbortDto dto) {
        RunHistory rh = runService.abortRun(runId, dto.reason());
        log.info("Run aborted runId={} reason={}", runId, dto.reason());
        return ApiResponse.ok(rh);
    }

    /**
     * Worker 생존 통보 (30 초 간격). PoC 시점에서는 log only.
     * worker_nodes 테이블 도입 후 last_heartbeat 갱신으로 확장.
     */
    @PostMapping("/api/v1/internal/workers/{workerId}/heartbeat")
    public ApiResponse<Void> heartbeat(@PathVariable String workerId) {
        log.debug("Worker heartbeat workerId={}", workerId);
        return ApiResponse.ok(null);
    }

    /* ── Stage lifecycle callbacks ─────────────────── */

    /** Stage 開始. pending → running, started_at 셋. */
    @PostMapping("/api/v1/internal/runs/{runId}/stages/{stageKey}/start")
    public ApiResponse<StageInstance> startStage(@PathVariable String runId,
                                                 @PathVariable String stageKey) {
        StageInstance si = runService.startStage(runId, stageKey);
        log.info("Worker stage start runId={} stageKey={}", runId, stageKey);
        return ApiResponse.ok(si);
    }

    /**
     * Stage 完了. tablesFailed > 0 이면 stage status=failed, 아니면 success.
     * continue-on-error 모델 — worker 가 stage 안 모든 table 처리 끝낸 후 호출.
     */
    @PostMapping("/api/v1/internal/runs/{runId}/stages/{stageKey}/complete")
    public ApiResponse<StageInstance> completeStage(@PathVariable String runId,
                                                    @PathVariable String stageKey,
                                                    @RequestBody StageCompleteDto dto) {
        StageInstance si = runService.completeStage(runId, stageKey,
                dto.tablesSuccess() == null ? 0 : dto.tablesSuccess(),
                dto.tablesFailed() == null ? 0 : dto.tablesFailed(),
                dto.errorSummary());
        log.info("Worker stage complete runId={} stageKey={} success={} failed={}",
                runId, stageKey, dto.tablesSuccess(), dto.tablesFailed());
        return ApiResponse.ok(si);
    }

    /**
     * Stage 안 1 테이블 처리 결과 upsert.
     * 같은 (stage, binding) 으로 여러 번 호출 가능 — running → success/failed 전이를 표현.
     */
    @PostMapping("/api/v1/internal/runs/{runId}/stages/{stageKey}/tables")
    public ApiResponse<StageTableResult> recordTable(@PathVariable String runId,
                                                     @PathVariable String stageKey,
                                                     @RequestBody StageTableResultDto dto) {
        StageTableResult str = runService.recordTableResult(runId, stageKey,
                dto.bindingId(), dto.status(),
                dto.rowCount(), dto.errorCount(),
                dto.errorDetail(), dto.durationMs());
        return ApiResponse.ok(str);
    }
}
