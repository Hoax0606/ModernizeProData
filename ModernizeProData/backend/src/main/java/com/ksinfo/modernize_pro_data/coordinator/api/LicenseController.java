package com.ksinfo.modernize_pro_data.coordinator.api;

import com.ksinfo.modernize_pro_data.common.dto.ApiResponse;
import com.ksinfo.modernize_pro_data.common.exception.ApiException;
import com.ksinfo.modernize_pro_data.coordinator.license.License;
import com.ksinfo.modernize_pro_data.coordinator.license.LicenseService;
import com.ksinfo.modernize_pro_data.coordinator.license.LicenseStatus;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.time.LocalDate;
import java.time.temporal.ChronoUnit;
import java.util.List;

@Slf4j
@RestController
@RequestMapping("/api/v1/license")
@RequiredArgsConstructor
public class LicenseController {

    private final LicenseService licenseService;

    public record LicenseDto(
            String licenseId,
            String customer,
            String siteId,
            String edition,
            List<String> features,
            LocalDate issuedAt,
            LocalDate expiresAt,
            int graceDays,
            long daysRemaining,
            LicenseStatus status
    ) {}

    @GetMapping
    public ApiResponse<LicenseDto> get() {
        License lic = licenseService.getActive();
        LicenseStatus status = licenseService.currentStatus();
        if (lic == null) {
            return ApiResponse.ok(new LicenseDto(
                    null, null, null, null, List.of(),
                    null, null, 0, 0, status));
        }
        // ChronoUnit.DAYS.between → 총 일수 (Period.getDays 는 year/month 빼고 일 부분만 반환)
        long days = ChronoUnit.DAYS.between(LocalDate.now(), lic.getExpiresAt());
        return ApiResponse.ok(new LicenseDto(
                lic.getLicenseId(), lic.getCustomer(), lic.getSiteId(),
                lic.getEdition(), lic.getFeatures(),
                lic.getIssuedAt(), lic.getExpiresAt(), lic.getGraceDays(),
                days, status));
    }

    /** dev only — 라이선스 DB / 캐시 wipe. MISSING 상태 테스트용. */
    @DeleteMapping
    @PreAuthorize("hasRole('MASTER')")
    public ApiResponse<LicenseDto> clear(Authentication auth) {
        licenseService.clear(auth.getName());
        return get();
    }

    @PostMapping
    @PreAuthorize("hasRole('MASTER')")
    public ApiResponse<LicenseDto> upload(
            @RequestParam("file") MultipartFile file,
            Authentication auth
    ) {
        if (file.isEmpty()) {
            throw new ApiException("LICENSE_FILE_EMPTY", "라이선스 파일이 비어있습니다", HttpStatus.BAD_REQUEST);
        }
        try {
            licenseService.upload(file.getBytes(), auth.getName());
            return get();
        } catch (IOException e) {
            throw new ApiException("LICENSE_FILE_READ_FAILED", "파일 읽기 실패: " + e.getMessage(), HttpStatus.BAD_REQUEST);
        }
    }
}
