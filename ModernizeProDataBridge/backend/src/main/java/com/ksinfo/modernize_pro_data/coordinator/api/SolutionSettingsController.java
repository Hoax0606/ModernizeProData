package com.ksinfo.modernize_pro_data.coordinator.api;

import com.ksinfo.modernize_pro_data.common.dto.ApiResponse;
import com.ksinfo.modernize_pro_data.common.exception.ApiException;
import com.ksinfo.modernize_pro_data.coordinator.common.InternalMode;
import com.ksinfo.modernize_pro_data.coordinator.common.SolutionSettings;
import com.ksinfo.modernize_pro_data.coordinator.common.SolutionSettingsRepository;
import com.ksinfo.modernize_pro_data.coordinator.schedule.SchedulerInitializer;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.quartz.SchedulerException;
import org.springframework.http.HttpStatus;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.Authentication;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

import java.time.LocalTime;
import java.time.OffsetDateTime;

/**
 * Solution-level configuration API.
 *
 * 단일 row (id=1) 운용. Internal/External 스케줄러 master switch + mode 설정 의
 * 単一 source of truth. internal_mode (common/individual) + common_time
 * 가 추가됨.
 *
 * Internal 関連 field (enabled/mode/common_time) 가 바뀌면
 * {@link SchedulerInitializer#rescheduleAllNightly()} 호출해서 Quartz Trigger 를
 * 全部 재구축. external 関連 field 변경에서는 reschedule 불필요.
 */
@Slf4j
@RestController
@RequiredArgsConstructor
public class SolutionSettingsController {

    private final SolutionSettingsRepository repo;
    private final SchedulerInitializer schedulerInitializer;

    public record UpdateRequest(
            Boolean internalEnabled,
            InternalMode internalMode,       // common / individual / null
            LocalTime internalCommonTime,    // mode=common 時必須
            Boolean externalEnabled,
            String externalApiEndpoint       // Trigger examples docs に embed される URL
    ) {}

    @GetMapping("/api/v1/solution-settings")
    @PreAuthorize("isAuthenticated()")
    public ApiResponse<SolutionSettings> get() {
        return ApiResponse.ok(repo.get());
    }

    @PatchMapping("/api/v1/solution-settings")
    @PreAuthorize("hasRole('MASTER')")
    @Transactional
    public ApiResponse<SolutionSettings> update(@RequestBody UpdateRequest req,
                                                Authentication auth) {
        SolutionSettings s = repo.get();

        // 1. enabled / mutex 적용. internal=true 면 external 자동 false, 역방향 同.
        if (Boolean.TRUE.equals(req.internalEnabled())) {
            s.setInternalEnabled(true);
            s.setExternalEnabled(false);
        } else if (Boolean.TRUE.equals(req.externalEnabled())) {
            s.setExternalEnabled(true);
            s.setInternalEnabled(false);
        } else {
            // 명시적 false 만 적용 (양쪽 모두 false = 스케줄링 없음, 허용됨)
            if (req.internalEnabled() != null) s.setInternalEnabled(req.internalEnabled());
            if (req.externalEnabled() != null) s.setExternalEnabled(req.externalEnabled());
        }

        // 2. mode / common_time 적용. internal 가 disabled 면 강제로 NULL 화 (재 enable 시
        //    user 가 명시적으로 mode 선택하도록).
        if (!s.isInternalEnabled()) {
            s.setInternalMode(null);
            s.setInternalCommonTime(null);
        } else {
            if (req.internalMode() != null)        s.setInternalMode(req.internalMode());
            if (req.internalCommonTime() != null)  s.setInternalCommonTime(req.internalCommonTime());
            // mode=individual 時 common_time は使用しない — 明示的 NULL 化
            if (s.getInternalMode() == InternalMode.individual) s.setInternalCommonTime(null);
        }

        // 3. 最終状態 validation. internal=true なら mode 必須、mode=common なら time 必須.
        if (s.isInternalEnabled()) {
            if (s.getInternalMode() == null) {
                throw new ApiException("INVALID_INTERNAL_MODE",
                        "internal_enabled=true requires internal_mode (common or individual)",
                        HttpStatus.BAD_REQUEST);
            }
            if (s.getInternalMode() == InternalMode.common && s.getInternalCommonTime() == null) {
                throw new ApiException("INVALID_COMMON_TIME",
                        "internal_mode=common requires internal_common_time",
                        HttpStatus.BAD_REQUEST);
            }
        }

        // External 関連 — endpoint は scheduler trigger と無関係 (docs 用 metadata)
        if (req.externalApiEndpoint() != null) s.setExternalApiEndpoint(req.externalApiEndpoint());

        s.setUpdatedAt(OffsetDateTime.now());
        s.setUpdatedBy(auth.getName());
        repo.save(s);

        // 5. internal 関連 field 가 들어왔으면 Quartz trigger 全部 재구축.
        //    external 만 변경 시는 trigger 영향 없음.
        boolean schedulerAffected = (req.internalEnabled() != null)
                || (req.internalMode() != null)
                || (req.internalCommonTime() != null)
                || Boolean.TRUE.equals(req.externalEnabled());  // mutex auto-flip 의 경우
        if (schedulerAffected) {
            try {
                schedulerInitializer.rescheduleAllNightly();
            } catch (SchedulerException e) {
                log.error("Failed to reschedule after solution settings change", e);
                throw new ApiException("SCHEDULER_ERROR",
                        "Failed to update scheduler: " + e.getMessage(),
                        HttpStatus.INTERNAL_SERVER_ERROR);
            }
        }

        log.info("Solution settings updated by {} — internal={} mode={} common_time={} external={}",
                auth.getName(), s.isInternalEnabled(), s.getInternalMode(),
                s.getInternalCommonTime(), s.isExternalEnabled());
        return ApiResponse.ok(s);
    }
}
