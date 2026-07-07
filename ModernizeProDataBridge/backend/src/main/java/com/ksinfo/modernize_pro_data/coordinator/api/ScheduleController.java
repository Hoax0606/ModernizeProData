package com.ksinfo.modernize_pro_data.coordinator.api;

import com.ksinfo.modernize_pro_data.common.dto.ApiResponse;
import com.ksinfo.modernize_pro_data.common.exception.ApiException;
import com.ksinfo.modernize_pro_data.coordinator.schedule.SchedulerInitializer;
import com.ksinfo.modernize_pro_data.coordinator.site.Project;
import com.ksinfo.modernize_pro_data.coordinator.site.ProjectRepository;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.quartz.SchedulerException;
import org.springframework.http.HttpStatus;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

import java.time.LocalTime;

/**
 * Project 별 schedule 설정 API — Project Settings > Schedule > Nightly rehearsal 으로부터.
 *
 * UPDATE projects 와 Quartz {@code rescheduleJob()} 을 동일 transaction 안에서 수행.
 * 片方 실패 시 양쪽 rollback (DB transaction 內에서 SchedulerException 발생하면 throw).
 */
@Slf4j
@RestController
@RequiredArgsConstructor
public class ScheduleController {

    private final ProjectRepository projectRepo;
    private final SchedulerInitializer schedulerInitializer;

    /**
     * Individual mode 時 の per-project start_time 更新. ON/OFF / mode 切り替え は
     * Solution Settings 側 ({@code /api/v1/solution-settings}). max_duration_min は
     * (auto-abort 機能は無し)
     */
    public record UpdateScheduleRequest(
            LocalTime startTime,
            /** true 로 보내면 startTime 을 NULL 로 clear (이 project 는 스케줄러에서 빠짐). */
            Boolean clearStartTime
    ) {}

    @PatchMapping("/api/v1/projects/{id}/schedule")
    @PreAuthorize("hasAnyRole('MASTER','ADMIN')")
    @Transactional
    public ApiResponse<Project> updateSchedule(@PathVariable String id,
                                               @Valid @RequestBody UpdateScheduleRequest req) {
        Project p = projectRepo.findById(id)
                .orElseThrow(() -> new ApiException("PROJECT_NOT_FOUND",
                        "project not found: " + id, HttpStatus.NOT_FOUND));

        if (Boolean.TRUE.equals(req.clearStartTime())) {
            p.setScheduleStartTime(null);
            p.setScheduleNextRunAt(null);
        } else if (req.startTime() != null) {
            p.setScheduleStartTime(req.startTime());
        }

        projectRepo.save(p);

        try {
            schedulerInitializer.rescheduleNightly(p);
        } catch (SchedulerException e) {
            log.error("Failed to reschedule Quartz trigger for project {}", id, e);
            throw new ApiException("SCHEDULER_ERROR",
                    "Failed to update scheduler: " + e.getMessage(),
                    HttpStatus.INTERNAL_SERVER_ERROR);
        }

        log.info("Schedule updated projectId={} startTime={}", id, p.getScheduleStartTime());
        return ApiResponse.ok(p);
    }
}
