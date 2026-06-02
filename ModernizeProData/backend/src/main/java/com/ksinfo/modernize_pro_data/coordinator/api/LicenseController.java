package com.ksinfo.modernize_pro_data.coordinator.api;

import com.ksinfo.modernize_pro_data.common.dto.ApiResponse;
import com.ksinfo.modernize_pro_data.common.exception.ApiException;
import com.ksinfo.modernize_pro_data.coordinator.license.HardwareFingerprint;
import com.ksinfo.modernize_pro_data.coordinator.license.License;
import com.ksinfo.modernize_pro_data.coordinator.license.LicenseService;
import com.ksinfo.modernize_pro_data.coordinator.license.LicenseStatus;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.authentication.AnonymousAuthenticationToken;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.time.LocalDate;
import java.time.temporal.ChronoUnit;
import java.util.List;

@Slf4j
@RestController
@RequestMapping("/api/v1/license")
@RequiredArgsConstructor
public class LicenseController {

    private final LicenseService licenseService;
    private final HardwareFingerprint hardwareFingerprint;

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
            LicenseStatus status,
            String boundHardwareId,     // null = v=1 license (machine-agnostic)
            String currentHardwareId,   // this PC's fingerprint -- always present
            boolean hardwareMismatch    // true when boundHardwareId is set and differs
    ) {}

    @GetMapping
    public ApiResponse<LicenseDto> get() {
        License lic = licenseService.getActive();
        LicenseStatus status = licenseService.currentStatus();
        String currentHw = hardwareFingerprint.value();
        if (lic == null) {
            return ApiResponse.ok(new LicenseDto(
                    null, null, null, null, List.of(),
                    null, null, 0, 0, status,
                    null, currentHw, false));
        }
        // ChronoUnit.DAYS.between → 총 일수 (Period.getDays 는 year/month 빼고 일 부분만 반환)
        long days = ChronoUnit.DAYS.between(LocalDate.now(), lic.getExpiresAt());
        return ApiResponse.ok(new LicenseDto(
                lic.getLicenseId(), lic.getCustomer(), lic.getSiteId(),
                lic.getEdition(), lic.getFeatures(),
                lic.getIssuedAt(), lic.getExpiresAt(), lic.getGraceDays(),
                days, status,
                lic.getHardwareId(), currentHw, licenseService.isHardwareMismatch()));
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

    /**
     * Anonymous first-boot endpoint. Only callable while no license is loaded
     * yet -- once a license exists, master must use the authenticated POST
     * /api/v1/license to replace it.
     *
     * <p>Permitted callers: anonymous (no JWT yet, fresh install) or an
     * authenticated master. A worker / admin / viewer that ended up on the
     * /license-setup screen — e.g. because they signed into a Coordinator
     * that lost its license — is rejected. They must ask master to apply
     * the file.
     */
    @PostMapping("/initial-setup")
    public ApiResponse<LicenseDto> initialSetup(@RequestParam("file") MultipartFile file,
                                                 Authentication auth) {
        requireAnonymousOrMaster(auth);
        // anonymous Re-enter 는 license 가 사실상 동작 못 하는 상태에서만 허용 —
        // 정상 / 만료 임박 / grace 기간 (= 도구 사용 가능 상태) 일 땐 거부하고
        // master 가 로그인 후 Settings 에서 정식 replace 하도록 유도.
        // READ_ONLY / EXPIRED / INVALID / MISSING = 통과 (사용자가 새 file 적용 가능).
        LicenseStatus cur = licenseService.currentStatus();
        if (cur == LicenseStatus.ACTIVE || cur == LicenseStatus.EXPIRING || cur == LicenseStatus.IN_GRACE) {
            throw new ApiException("LICENSE_ALREADY_LOADED",
                    "현재 라이선스가 정상 동작 중입니다. 라이선스 교체는 master 로 로그인 후 Settings 에서 진행해 주세요.",
                    HttpStatus.CONFLICT);
        }
        if (file.isEmpty()) {
            throw new ApiException("LICENSE_FILE_EMPTY", "라이선스 파일이 비어있습니다", HttpStatus.BAD_REQUEST);
        }
        try {
            licenseService.upload(file.getBytes(), "first-boot");
            return get();
        } catch (IOException e) {
            throw new ApiException("LICENSE_FILE_READ_FAILED",
                    "파일 읽기 실패: " + e.getMessage(), HttpStatus.BAD_REQUEST);
        }
    }

    /**
     * Raw-body variant of {@link #initialSetup(MultipartFile, Authentication)} —
     * JavaFX WebView's HTTP2Loader NPEs on multipart/form-data POSTs,
     * so the React UI POSTs the license bytes directly as the request body.
     */
    @PostMapping(value = "/initial-setup", consumes = {
            MediaType.APPLICATION_JSON_VALUE,
            MediaType.APPLICATION_OCTET_STREAM_VALUE,
            MediaType.TEXT_PLAIN_VALUE })
    public ApiResponse<LicenseDto> initialSetupRaw(@RequestBody String body,
                                                    Authentication auth) {
        requireAnonymousOrMaster(auth);
        // anonymous Re-enter 는 license 가 사실상 동작 못 하는 상태에서만 허용 —
        // 정상 / 만료 임박 / grace 기간 (= 도구 사용 가능 상태) 일 땐 거부하고
        // master 가 로그인 후 Settings 에서 정식 replace 하도록 유도.
        // READ_ONLY / EXPIRED / INVALID / MISSING = 통과 (사용자가 새 file 적용 가능).
        LicenseStatus cur = licenseService.currentStatus();
        if (cur == LicenseStatus.ACTIVE || cur == LicenseStatus.EXPIRING || cur == LicenseStatus.IN_GRACE) {
            throw new ApiException("LICENSE_ALREADY_LOADED",
                    "현재 라이선스가 정상 동작 중입니다. 라이선스 교체는 master 로 로그인 후 Settings 에서 진행해 주세요.",
                    HttpStatus.CONFLICT);
        }
        if (body == null || body.isBlank()) {
            throw new ApiException("LICENSE_FILE_EMPTY", "라이선스 파일이 비어있습니다", HttpStatus.BAD_REQUEST);
        }
        licenseService.upload(body.getBytes(StandardCharsets.UTF_8), "first-boot");
        return get();
    }

    private static void requireAnonymousOrMaster(Authentication auth) {
        // SecurityConfig permitAll's this endpoint, so unauthenticated
        // callers arrive with either null or an AnonymousAuthenticationToken.
        // Both are fine — that's the first-boot path.
        if (auth == null || auth instanceof AnonymousAuthenticationToken) return;
        boolean isMaster = auth.getAuthorities().stream()
                .anyMatch(a -> "ROLE_MASTER".equals(a.getAuthority()));
        if (!isMaster) {
            throw new ApiException("LICENSE_ROLE_FORBIDDEN",
                    "Only master can apply the initial license. Ask your master administrator.",
                    HttpStatus.FORBIDDEN);
        }
    }
}
