package com.ksinfo.modernize_pro_data.coordinator.api;

import com.ksinfo.modernize_pro_data.common.dto.ApiResponse;
import com.ksinfo.modernize_pro_data.common.exception.ApiException;
import com.ksinfo.modernize_pro_data.coordinator.auth.ApiCredential;
import com.ksinfo.modernize_pro_data.coordinator.auth.ApiCredentialRepository;
import com.ksinfo.modernize_pro_data.coordinator.common.SolutionSettingsRepository;
import com.ksinfo.modernize_pro_data.coordinator.run.ProjectRunReadinessService;
import com.ksinfo.modernize_pro_data.coordinator.run.ProjectRunReadinessService.ProjectRunReadinessDto;
import com.ksinfo.modernize_pro_data.coordinator.run.RunHistory;
import com.ksinfo.modernize_pro_data.coordinator.run.RunHistoryRepository;
import com.ksinfo.modernize_pro_data.coordinator.run.RunResult;
import com.ksinfo.modernize_pro_data.coordinator.run.RunService;
import com.ksinfo.modernize_pro_data.coordinator.run.RunTableResultsService;
import com.ksinfo.modernize_pro_data.coordinator.run.RunTableResultsService.TableResultDto;
import com.ksinfo.modernize_pro_data.coordinator.run.RunTableResultsService.TableSummaryDto;
import com.ksinfo.modernize_pro_data.coordinator.run.RunStartStatus;
import com.ksinfo.modernize_pro_data.coordinator.run.RunStatus;
import com.ksinfo.modernize_pro_data.coordinator.run.RunType;
import com.ksinfo.modernize_pro_data.coordinator.run.TriggerSource;
import com.ksinfo.modernize_pro_data.coordinator.site.Project;
import com.ksinfo.modernize_pro_data.coordinator.site.ProjectRepository;
import com.ksinfo.modernize_pro_data.coordinator.site.SiteRepository;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.stream.Collectors;

/**
 * Run 起動 API — 外部スケジューラ (Control-M / Jenkins / cron) と CLI から叩かれる入口.
 *
 * /api/v1/runs/**  認証は api_token (ApiTokenAuthFilter).
 * /api/v1/projects/{id}/runs  履歴一覧は user session.
 */
@Slf4j
@RestController
@RequiredArgsConstructor
public class RunController {

    private final RunService runService;
    private final RunHistoryRepository runHistoryRepo;
    private final ProjectRepository projectRepo;
    private final SiteRepository siteRepo;
    private final ApiCredentialRepository apiCredentialRepo;
    private final SolutionSettingsRepository solutionSettingsRepo;
    private final ProjectRunReadinessService runReadinessService;
    private final RunTableResultsService tableResultsService;

    /* ── DTOs ──────────────────────────────────────── */

    /**
     * 単一 project 起動 リクエスト. runType 省略時은 BE 가 project.phase 로부터 자동 결정
     * (test/rehearsal/cutover 中 phase 에 매칭되는 type. 그 외 phase 이면 REJECTED).
     */
    public record StartRunRequest(
            @NotBlank String projectId,
            RunType runType,
            List<String> tables,   // 선택한 TO-BE 테이블명. null/empty = 전체 실행.
            boolean useCache       // true 면 직전 성공 run 의 CP2 재사용 시도 (stage-cache). 기본 false.
    ) {}

    public record RunResultDto(
            String runId,
            String projectId,
            String projectName,
            String status,        // STARTED / REJECTED / LOCKED
            String reason
    ) {
        /** Single trigger: caller 가 project 정보를 가지고 있으므로 셋해서 빌드. */
        public static RunResultDto of(RunResult r, String projectId, String projectName) {
            return new RunResultDto(r.runId(), projectId, projectName, r.status().name(), r.reason());
        }
    }

    public record BulkRunResultDto(
            int totalProjects,
            int started,
            int rejected,
            int locked,
            List<RunResultDto> results
    ) {}

    /**
     * UI 표시용 run history view DTO.
     * RunHistory entity + Project 의 name 을 join 해서 보낸다 —
     * FE 에서 project ID 만 보여서 어떤 project 인지 알 수 없는 문제 해결.
     *
     * requestedBy 는 작성 時점에 표시용 텍스트 ("Quartz nightly" / "external (default)" /
     * username) 로 그대로 저장하므로、display 측 변환은 하지 않는다.
     * → 과거 데이터 (raw "system" 등) 는 그대로 그대로 표시됨.
     */
    public record RunHistoryViewDto(
            String id,
            String projectId,
            String projectName,
            RunType runType,
            TriggerSource triggerSource,
            String requestedBy,
            String credentialId,
            String workerId,
            RunStatus status,
            OffsetDateTime startedAt,
            OffsetDateTime finishedAt,
            Long durationMs,
            String snapshotId,
            Long batchJobExecutionId,
            String errorMessage,
            /**
             * 実行対象テーブル (TO-BE 物理名). null = 全 binding 対象, 非 null = 部分実行で
             * 選択された TO-BE テーブル名一覧. metadata.selectedTables の型付き写し.
             * FE Run History 表でこの値を表示し「どのテーブルを動かした run か」を識別.
             */
            List<String> tables,
            /**
             * Run History drill-down 用の table 別件数サマリ. {@link StageTableResult} を
             * tobe_table 単位に集約した success / failed / running の件数.
             * 一覧画面で 1 行に 「4 tables: 3✓ 1✗」 のような badge を出すための材料.
             * stage_table_results が一つも無い run (例: 開始直後 / aborted) は 0/0/0/0.
             */
            TableSummaryDto tableSummary,
            Map<String, Object> metadata
    ) {}

    /* ── Endpoints ─────────────────────────────────── */

    /**
     * 単一 project の run 起動.
     *   - api_token (외부 스케줄러) → triggerSource=rest, external_enabled=false 면 503
     *   - master/admin (UI) → triggerSource=manual_ui, external_enabled 의 영향 없음
     *
     * 외부 스케줄러는 /runs (단일) 와 /runs/all (일괄) 의 두 path 모두 사용 가능.
     */
    @PostMapping("/api/v1/runs")
    @PreAuthorize("hasAnyRole('API_CLIENT', 'MASTER', 'ADMIN')")
    public ApiResponse<RunResultDto> startRun(@Valid @RequestBody StartRunRequest req,
                                              Authentication auth) {
        boolean isApiClient = auth.getAuthorities().stream()
                .anyMatch(a -> "ROLE_API_CLIENT".equals(a.getAuthority()));
        if (isApiClient && !solutionSettingsRepo.get().isExternalEnabled()) {
            throw new ApiException("EXTERNAL_DISABLED",
                    "External integrations is OFF — enable in Solution Settings",
                    HttpStatus.SERVICE_UNAVAILABLE);
        }
        TriggerSource source = isApiClient ? TriggerSource.external : TriggerSource.manual;
        String credentialId = isApiClient ? auth.getName() : null;
        String requestedBy = resolveRequestedBy(isApiClient, auth);

        // runType 未指定 時 project.phase から自動決定. 取得した Project は response の name 表示にも再利用.
        RunType runType = req.runType();
        Project project = projectRepo.findById(req.projectId()).orElse(null);
        if (project == null) {
            return ApiResponse.ok(new RunResultDto(null, req.projectId(), null, "REJECTED",
                    "project not found: " + req.projectId()));
        }
        if (runType == null) {
            var rtOpt = RunService.resolveRunTypeFromPhase(project.getPhase());
            if (rtOpt.isEmpty()) {
                return ApiResponse.ok(new RunResultDto(null, project.getId(), project.getName(), "REJECTED",
                        "phase '" + project.getPhase() + "' is not eligible for scheduled run; "
                                + "specify runType explicitly or change phase"));
            }
            runType = rtOpt.get();
        }

        RunResult r = runService.startRun(
                req.projectId(),
                runType,
                source,
                requestedBy,
                credentialId,
                req.tables(),
                req.useCache());
        log.info("startRun via {} projectId={} runType={} by={} → status={}",
                source, req.projectId(), runType, requestedBy, r.status());
        String projectName = project.getName();
        return ApiResponse.ok(RunResultDto.of(r, req.projectId(), projectName));
    }

    /**
     * /runs/all 의 request body. siteId は必須 — 1 Coordinator が複数 site をホストしていても
     * 意図せず別 site の project まで発火しないよう、必ず明示する.
     */
    public record StartAllRequest(
            @NotBlank String siteId
    ) {}

    /**
     * 指定 site の全 project 을 一斉 起動 (외부 스케줄러로부터의 /runs/all entry).
     *   - 対象: siteId が指定する site の全 project (旧設計은 schedule_start_time set 만이었으나,
     *     common mode 에서는 start_time 가 不要 — 결과적으로 무관한 필터가 되어 廃止)
     *   - 각 project 의 phase 로부터 runType (test/rehearsal/cutover) 자동 결정
     *   - eligible 하지 않은 phase (planning/analysis/sign-off/ready/hypercare/done) 의
     *     project 는 결과에 REJECTED 로 포함 — 추적 용
     *
     * cutover phase 의 project 도 含む — production site 의 cutover phase project 가 있으면
     * 본번 切替까지 一発로 발화함. 운용 책임 하에서 사용.
     *
     * 외부 스케줄러 ↔ master/admin UI 双方 호출 가능. triggerSource 는 호출자에 따라
     * external / manual 자동 판별.
     *
     * siteId 必須化 (2026-05-29): 旧仕様은 projectRepo.findAll() 로 全 site 의 全 project
     * 을 対象으로 했으나、1 Coordinator 가 複数 site 을 ホスト する dev / 多 customer 構成
     * では PROD/TEST 同時発火等 의 事故 リスク가 大. body 의 siteId 로 明示 scope 限定 必須.
     */
    @PostMapping("/api/v1/runs/all")
    @PreAuthorize("hasAnyRole('API_CLIENT', 'MASTER', 'ADMIN')")
    public ApiResponse<BulkRunResultDto> startAll(@Valid @RequestBody StartAllRequest req,
                                                  Authentication auth) {
        // External 모드 비활성 시 host 종류 (api_token / JWT 모두) 에 관계없이 503.
        // /runs/all 은 외부 trigger pattern 의 entry 이므로, master/admin UI 가 호출해도
        // external_enabled = false 면 끄는 일관 정책.
        if (!solutionSettingsRepo.get().isExternalEnabled()) {
            throw new ApiException("EXTERNAL_DISABLED",
                    "External integrations is OFF — enable in Solution Settings",
                    HttpStatus.SERVICE_UNAVAILABLE);
        }

        // siteId が指す site が存在しなければ 404. 空 project list が「site 不在」と「site あり
        // だが project 0」で区別つかなくなるのを防ぐ.
        if (!siteRepo.existsById(req.siteId())) {
            throw new ApiException("SITE_NOT_FOUND",
                    "site not found: " + req.siteId(), HttpStatus.NOT_FOUND);
        }

        boolean isApiClient = auth.getAuthorities().stream()
                .anyMatch(a -> "ROLE_API_CLIENT".equals(a.getAuthority()));
        TriggerSource source = isApiClient ? TriggerSource.external : TriggerSource.manual;
        String credentialId = isApiClient ? auth.getName() : null;
        String requestedBy = resolveRequestedBy(isApiClient, auth);

        List<Project> targets = projectRepo.findBySiteId(req.siteId());
        List<RunResultDto> results = new ArrayList<>();
        int started = 0, rejected = 0, locked = 0;
        for (Project p : targets) {
            // Project 의 phase 에 따라 runType 결정 — test/rehearsal/cutover.
            // 그 외 phase 의 project 는 REJECTED 로 결과에 포함 (왜 발화되지 않았는지 추적 가능).
            var rtOpt = RunService.resolveRunTypeFromPhase(p.getPhase());
            if (rtOpt.isEmpty()) {
                results.add(new RunResultDto(null, p.getId(), p.getName(), "REJECTED",
                        "phase '" + p.getPhase() + "' is not eligible for scheduled run"));
                rejected++;
                continue;
            }
            RunResult r = runService.startRun(
                    p.getId(), rtOpt.get(), source, requestedBy, credentialId);
            results.add(RunResultDto.of(r, p.getId(), p.getName()));
            switch (r.status()) {
                case STARTED -> started++;
                case REJECTED -> rejected++;
                case LOCKED -> locked++;
            }
        }
        log.info("startAll via {} → total={} started={} rejected={} locked={}",
                source, targets.size(), started, rejected, locked);
        return ApiResponse.ok(new BulkRunResultDto(targets.size(), started, rejected, locked, results));
    }

    /** UI 의 Stop 버튼 요청 body. reason 생략 가능. */
    public record AbortRunRequest(String reason) {}

    /**
     * 進行中 run 을 中断 (UI Stop 버튼). run_history.status=aborted + projects.run_status=idle 復旧.
     * ⚠️ 現状 동기 실행이라 실행 中 stage thread 를 강제 중단하지는 않음 — status 전이 + lock 解放.
     */
    @PostMapping("/api/v1/runs/{runId}/abort")
    @PreAuthorize("hasAnyRole('MASTER', 'ADMIN')")
    public ApiResponse<RunHistoryViewDto> abortRun(@PathVariable String runId,
                                                   @RequestBody(required = false) AbortRunRequest req) {
        String reason = (req != null && req.reason() != null && !req.reason().isBlank())
                ? req.reason() : "aborted by user";
        RunHistory rh = runService.abortRun(runId, reason);
        log.info("abortRun via UI runId={} reason={}", runId, reason);
        return ApiResponse.ok(toViewDtos(List.of(rh)).get(0));
    }

    /** 進行中 run 一時停止 (running → paused). stage 경계에서 멈춤. */
    @PostMapping("/api/v1/runs/{runId}/pause")
    @PreAuthorize("hasAnyRole('MASTER', 'ADMIN')")
    public ApiResponse<RunHistoryViewDto> pauseRun(@PathVariable String runId) {
        RunHistory rh = runService.pauseRun(runId);
        log.info("pauseRun via UI runId={} → status={}", runId, rh.getStatus());
        return ApiResponse.ok(toViewDtos(List.of(rh)).get(0));
    }

    /** 一時停止 run 再開 (paused → running). */
    @PostMapping("/api/v1/runs/{runId}/resume")
    @PreAuthorize("hasAnyRole('MASTER', 'ADMIN')")
    public ApiResponse<RunHistoryViewDto> resumeRun(@PathVariable String runId) {
        RunHistory rh = runService.resumeRun(runId);
        log.info("resumeRun via UI runId={} → status={}", runId, rh.getStatus());
        return ApiResponse.ok(toViewDtos(List.of(rh)).get(0));
    }

    /** Run の現在 status 取得. user session 認証. */
    @GetMapping("/api/v1/runs/{runId}")
    public ApiResponse<RunHistoryViewDto> get(@PathVariable String runId) {
        RunHistory rh = runHistoryRepo.findById(runId)
                .orElseThrow(() -> new ApiException("RUN_NOT_FOUND",
                        "run not found: " + runId, HttpStatus.NOT_FOUND));
        return ApiResponse.ok(toViewDtos(List.of(rh)).get(0));
    }

    /** 全 project 横断의 최근 run 일람 (최신 50). Dev test page / 운영 dashboard 용. */
    @GetMapping("/api/v1/runs")
    public ApiResponse<List<RunHistoryViewDto>> listAll() {
        return ApiResponse.ok(toViewDtos(runHistoryRepo.findTop50ByOrderByStartedAtDesc()));
    }

    /** Project の run 履歴一覧 (新しい順). */
    @GetMapping("/api/v1/projects/{id}/runs")
    public ApiResponse<List<RunHistoryViewDto>> listByProject(@PathVariable String id) {
        return ApiResponse.ok(toViewDtos(runHistoryRepo.findByProjectIdOrderByStartedAtDesc(id)));
    }

    /**
     * Project の Request Review readiness (Versions 画面の Request Review ゲート用).
     * 全 TO-BE テーブルの最新 run = success の時のみ allReady=true.
     */
    @GetMapping("/api/v1/projects/{id}/run-readiness")
    public ApiResponse<ProjectRunReadinessDto> runReadiness(@PathVariable String id) {
        if (!projectRepo.existsById(id)) {
            throw new ApiException("PROJECT_NOT_FOUND",
                    "project not found: " + id, HttpStatus.NOT_FOUND);
        }
        return ApiResponse.ok(runReadinessService.readinessFor(id));
    }

    /**
     * Run History drill-down — 1 run の per-table 詳細結果.
     * 行展開時に FE が呼び出して per-table の status / rows / duration / error を表示する.
     */
    @GetMapping("/api/v1/runs/{runId}/table-results")
    public ApiResponse<List<TableResultDto>> tableResults(@PathVariable String runId) {
        if (!runHistoryRepo.existsById(runId)) {
            throw new ApiException("RUN_NOT_FOUND",
                    "run not found: " + runId, HttpStatus.NOT_FOUND);
        }
        return ApiResponse.ok(tableResultsService.resultsForRun(runId));
    }

    /* ── DTO 변환 helpers ───────────────────────────── */

    /**
     * RunHistory list → ViewDto list (project name 을 batch lookup 해서 join).
     * requestedBy 등은 entity 의 raw 값 그대로 전달 — 작성 시점에 표시용 텍스트로
     * 저장되어 있는 전제. 과거 데이터 (raw "system" / "external:cred-xxx" 등) 도
     * 그대로 그대로 표시됨.
     */
    private List<RunHistoryViewDto> toViewDtos(List<RunHistory> runs) {
        if (runs.isEmpty()) return List.of();

        List<String> projectIds = runs.stream()
                .map(RunHistory::getProjectId).filter(Objects::nonNull).distinct().toList();
        Map<String, String> projectNames = projectRepo.findAllById(projectIds).stream()
                .collect(Collectors.toMap(Project::getId, Project::getName));

        // Per-run の table summary を一括取得 (N+1 回避).
        List<String> runIds = runs.stream().map(RunHistory::getId).toList();
        Map<String, TableSummaryDto> summaries = tableResultsService.summariesForRuns(runIds);

        return runs.stream()
                .map(r -> new RunHistoryViewDto(
                        r.getId(), r.getProjectId(),
                        projectNames.getOrDefault(r.getProjectId(), "(deleted: " + r.getProjectId() + ")"),
                        r.getRunType(), r.getTriggerSource(),
                        r.getRequestedBy(), r.getCredentialId(),
                        r.getWorkerId(),
                        r.getStatus(), r.getStartedAt(), r.getFinishedAt(),
                        r.getDurationMs(), r.getSnapshotId(),
                        r.getBatchJobExecutionId(), r.getErrorMessage(),
                        extractSelectedTables(r.getMetadata()),
                        summaries.getOrDefault(r.getId(), TableSummaryDto.empty()),
                        r.getMetadata()))
                .toList();
    }

    /**
     * RunHistory.metadata.selectedTables を型付きで取り出す. 非 List / null / 空なら null
     * (全テーブル run の意味). 型不一致要素は無視.
     */
    private static List<String> extractSelectedTables(Map<String, Object> metadata) {
        if (metadata == null) return null;
        Object raw = metadata.get("selectedTables");
        if (!(raw instanceof List<?> list) || list.isEmpty()) return null;
        List<String> result = new ArrayList<>(list.size());
        for (Object o : list) {
            if (o instanceof String s) result.add(s);
        }
        return result.isEmpty() ? null : result;
    }

    /**
     * Run 작성 시점의 requestedBy 텍스트를 결정.
     *   - api_token (외부) → "external (<credentialName>)"
     *   - master/admin UI → username
     * Nightly Job 측은 NightlyRehearsalJob 가 별도 "Quartz nightly" 를 직접 셋.
     */
    private String resolveRequestedBy(boolean isApiClient, Authentication auth) {
        if (!isApiClient) return auth.getName();
        String credId = auth.getName();
        String credName = apiCredentialRepo.findById(credId)
                .map(ApiCredential::getName)
                .orElse(credId);
        return "external (" + credName + ")";
    }

    private static String principalName(Authentication auth) {
        return auth != null ? auth.getName() : "anonymous";
    }
}
