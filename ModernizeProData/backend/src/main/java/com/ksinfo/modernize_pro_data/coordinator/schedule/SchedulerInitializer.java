package com.ksinfo.modernize_pro_data.coordinator.schedule;

import com.ksinfo.modernize_pro_data.coordinator.common.InternalMode;
import com.ksinfo.modernize_pro_data.coordinator.common.SolutionSettings;
import com.ksinfo.modernize_pro_data.coordinator.common.SolutionSettingsRepository;
import com.ksinfo.modernize_pro_data.coordinator.site.Project;
import com.ksinfo.modernize_pro_data.coordinator.site.ProjectRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.quartz.CronScheduleBuilder;
import org.quartz.CronTrigger;
import org.quartz.JobBuilder;
import org.quartz.JobDetail;
import org.quartz.JobKey;
import org.quartz.Scheduler;
import org.quartz.SchedulerException;
import org.quartz.TriggerBuilder;
import org.quartz.TriggerKey;
import org.quartz.impl.matchers.GroupMatcher;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalTime;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.util.Date;
import java.util.List;
import java.util.Set;

/**
 * Coordinator 起動時 + Solution Settings 변경時 에 Quartz Trigger 를 재구축.
 *
 * Quartz は in-memory モード ({@code spring.quartz.job-store-type: memory})
 * 운용. 11 テーブル이 없으므로 起動마다 / 설정 변경 마다 0 부터 Trigger 등록.
 *
 * mode (common / individual):
 *   - common     — 全 project 가 solution_settings.internal_common_time 으로 발화
 *   - individual — project.schedule_start_time 가 NOT NULL 인 project 만 발화
 *
 * Misfire policy: MISFIRE_INSTRUCTION_DO_NOTHING — Coordinator 가 発火時刻에
 * 停止中이었던 경우 그 회를 스킵하고 翌日 まで 待つ.
 */
@Component
@RequiredArgsConstructor
@Slf4j
public class SchedulerInitializer {

    /** Quartz Trigger / Job 의 group 名. */
    public static final String NIGHTLY_GROUP = "nightly";

    private final Scheduler scheduler;
    private final ProjectRepository projectRepo;
    private final SolutionSettingsRepository solutionSettingsRepo;

    @EventListener(ApplicationReadyEvent.class)
    public void onStartup() {
        try {
            rescheduleAllNightly();
        } catch (SchedulerException e) {
            log.error("SchedulerInitializer: failed to register triggers on startup", e);
        }
    }

    /**
     * 全 trigger 削除 + 현재 solution_settings 에 따라 재 등록. Solution Settings
     * 変更 時 (mode / common_time / internal_enabled 切替) 에 호출된다.
     */
    @Transactional
    public void rescheduleAllNightly() throws SchedulerException {
        // 1. NIGHTLY_GROUP 内 既存 trigger / job 全削除
        Set<JobKey> existing = scheduler.getJobKeys(GroupMatcher.jobGroupEquals(NIGHTLY_GROUP));
        for (JobKey jk : existing) {
            scheduler.deleteJob(jk);
        }
        log.info("Cleared {} existing nightly trigger(s)", existing.size());

        SolutionSettings settings = solutionSettingsRepo.get();
        if (!settings.isInternalEnabled()) {
            log.info("internal_enabled=false — no triggers registered");
            return;
        }

        InternalMode mode = settings.getInternalMode();
        if (mode == null) {
            log.warn("internal_enabled=true but internal_mode=null — invalid state, skipping");
            return;
        }

        switch (mode) {
            case common -> {
                LocalTime commonTime = settings.getInternalCommonTime();
                if (commonTime == null) {
                    log.warn("internal_mode=common but common_time=null — skipping");
                    return;
                }
                List<Project> all = projectRepo.findAll();
                log.info("Registering {} common-mode trigger(s) at {}", all.size(), commonTime);
                for (Project p : all) {
                    try {
                        registerNightlyJob(p, commonTime);
                    } catch (SchedulerException e) {
                        log.error("Failed to register common-mode trigger for project {}", p.getId(), e);
                    }
                }
            }
            case individual -> {
                List<Project> scheduled = projectRepo.findByScheduleStartTimeIsNotNull();
                log.info("Registering {} individual-mode trigger(s)", scheduled.size());
                for (Project p : scheduled) {
                    try {
                        registerNightlyJob(p, p.getScheduleStartTime());
                    } catch (SchedulerException e) {
                        log.error("Failed to register individual-mode trigger for project {}", p.getId(), e);
                    }
                }
            }
        }
    }

    /**
     * Individual mode 의 per-project schedule_start_time 변경 時 호출.
     * Common mode 에서는 per-project time 가 의미 없으므로 no-op.
     */
    @Transactional
    public void rescheduleNightly(Project p) throws SchedulerException {
        SolutionSettings settings = solutionSettingsRepo.get();
        if (!settings.isInternalEnabled() || settings.getInternalMode() != InternalMode.individual) {
            // Internal OFF or common mode — per-project 시간 변경은 trigger 영향 없음
            return;
        }

        TriggerKey tk = triggerKey(p.getId());
        if (scheduler.checkExists(tk)) {
            scheduler.unscheduleJob(tk);
        }
        if (scheduler.checkExists(jobKey(p.getId()))) {
            scheduler.deleteJob(jobKey(p.getId()));
        }
        if (p.getScheduleStartTime() != null) {
            registerNightlyJob(p, p.getScheduleStartTime());
        }
    }

    private void registerNightlyJob(Project p, LocalTime t) throws SchedulerException {
        // Quartz cron: sec min hour day month dow.  毎日 hh:mm:00.
        String cron = String.format("0 %d %d * * ?", t.getMinute(), t.getHour());

        JobDetail job = JobBuilder.newJob(NightlyRehearsalJob.class)
                .withIdentity(jobKey(p.getId()))
                .usingJobData(NightlyRehearsalJob.DATA_KEY_PROJECT_ID, p.getId())
                .storeDurably(true)
                .build();

        CronTrigger trigger = TriggerBuilder.newTrigger()
                .withIdentity(triggerKey(p.getId()))
                .forJob(jobKey(p.getId()))
                .withSchedule(CronScheduleBuilder.cronSchedule(cron)
                        .withMisfireHandlingInstructionDoNothing())
                .build();

        scheduler.scheduleJob(job, trigger);

        // UI 表示用 cache: schedule_next_run_at に Quartz が計算した次回発火時刻を書き戻し
        Date next = trigger.getNextFireTime();
        if (next != null) {
            p.setScheduleNextRunAt(OffsetDateTime.ofInstant(next.toInstant(), ZoneId.systemDefault()));
            projectRepo.save(p);
        }

        log.info("Registered nightly trigger projectId={} cron='{}' next={}",
                p.getId(), cron, next);
    }

    private JobKey jobKey(String projectId) {
        return JobKey.jobKey("nightly-rehearsal-" + projectId, NIGHTLY_GROUP);
    }

    private TriggerKey triggerKey(String projectId) {
        return TriggerKey.triggerKey("nightly-rehearsal-" + projectId, NIGHTLY_GROUP);
    }
}
