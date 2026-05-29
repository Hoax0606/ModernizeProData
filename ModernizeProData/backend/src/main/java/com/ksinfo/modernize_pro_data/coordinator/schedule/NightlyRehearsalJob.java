package com.ksinfo.modernize_pro_data.coordinator.schedule;

import com.ksinfo.modernize_pro_data.coordinator.common.SolutionSettingsRepository;
import com.ksinfo.modernize_pro_data.coordinator.run.RunResult;
import com.ksinfo.modernize_pro_data.coordinator.run.RunService;
import com.ksinfo.modernize_pro_data.coordinator.run.RunStartStatus;
import com.ksinfo.modernize_pro_data.coordinator.run.RunType;
import com.ksinfo.modernize_pro_data.coordinator.run.TriggerSource;
import com.ksinfo.modernize_pro_data.coordinator.site.Project;
import com.ksinfo.modernize_pro_data.coordinator.site.ProjectRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.quartz.Job;
import org.quartz.JobExecutionContext;
import org.springframework.stereotype.Component;

import java.util.Optional;

/**
 * Quartz Job — Project ごとの夜間 dry-run rehearsal を発火.
 *
 * Job 自体は薄く、{@link RunService#startRun} を呼ぶだけ. 3 経路 (Nightly /
 * CLI / REST) の挙動を 1 箇所に集約する設計のため.
 *
 * Spring Boot 의 {@code AutowireCapableBeanJobFactory} (QuartzAutoConfiguration
 * 가 자동 설치) 가 RunService 등의 DI を行う.
 *
 * Misfire (Coordinator 가 발화 時刻에 停止중이었던 경우): CronTrigger 의
 * MISFIRE_INSTRUCTION_DO_NOTHING 으로 翌日まで待つ. {@link SchedulerInitializer}
 * 가 Trigger 등록 時점에 설정.
 */
@Component
@RequiredArgsConstructor
@Slf4j
public class NightlyRehearsalJob implements Job {

    /** Quartz JobDataMap のキー — projectId を Job に渡す手段. */
    public static final String DATA_KEY_PROJECT_ID = "projectId";

    private final RunService runService;
    private final SolutionSettingsRepository solutionSettingsRepo;
    private final ProjectRepository projectRepo;

    @Override
    public void execute(JobExecutionContext context) {
        String projectId = context.getMergedJobDataMap().getString(DATA_KEY_PROJECT_ID);
        if (projectId == null) {
            log.error("NightlyRehearsalJob fired without projectId — Trigger 登録が壊れている可能성");
            return;
        }

        // Internal scheduler mutex check — external mode 中에 trigger 가 발화해도 no-op.
        if (!solutionSettingsRepo.get().isInternalEnabled()) {
            log.info("Nightly skipped — internal_enabled=false. projectId={}", projectId);
            return;
        }

        // Project 의 현재 phase 에 따라 起動할 runType 을 결정 (test/rehearsal/cutover).
        // 該当 phase 가 아니면 (planning / analysis / sign-off / ready / hypercare / done) 발화 SKIP.
        Project project = projectRepo.findById(projectId).orElse(null);
        if (project == null) {
            log.warn("Nightly skipped — project not found. projectId={}", projectId);
            return;
        }
        Optional<RunType> runTypeOpt = RunService.resolveRunTypeFromPhase(project.getPhase());
        if (runTypeOpt.isEmpty()) {
            log.info("Nightly skipped — phase '{}' is not eligible for scheduled run. projectId={}",
                    project.getPhase(), projectId);
            return;
        }

        RunType runType = runTypeOpt.get();
        log.info("Quartz fired projectId={} phase={} runType={}",
                projectId, project.getPhase(), runType);

        RunResult result = runService.startRun(
                projectId,
                runType,
                TriggerSource.internal,
                "Quartz nightly",
                null);

        if (result.status() != RunStartStatus.STARTED) {
            log.warn("Nightly not started: projectId={} runType={} status={} reason={}",
                    projectId, runType, result.status(), result.reason());
        }
    }
}
