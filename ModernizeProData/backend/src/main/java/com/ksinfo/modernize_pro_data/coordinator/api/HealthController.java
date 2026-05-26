package com.ksinfo.modernize_pro_data.coordinator.api;

import com.ksinfo.modernize_pro_data.common.dto.ApiResponse;
import com.ksinfo.modernize_pro_data.coordinator.license.HardwareFingerprint;
import com.ksinfo.modernize_pro_data.coordinator.license.LicenseService;
import com.ksinfo.modernize_pro_data.coordinator.license.LicenseStatus;
import com.ksinfo.modernize_pro_data.coordinator.worker.WorkerBootstrap;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.time.OffsetDateTime;
import java.util.Map;

/**
 * 헬스 체크 + 도구 정보.
 *
 * GET /api/v1/health              — 단순 alive 확인
 * GET /api/v1/health/info         — 도구·런타임 정보
 * GET /api/v1/health/fingerprint  — 이 PC 의 hardware fingerprint (issuer 에 넣어
 *                                    license 를 PC 에 묶기 위한 값). anonymous OK
 *                                    이므로 로그인 전 first-boot 화면에서도 표시 가능.
 */
@RestController
@RequestMapping("/api/v1/health")
@RequiredArgsConstructor
public class HealthController {

    @Value("${spring.application.name}")
    private String appName;

    @Value("${modernize.mode}")
    private String mode;

    private final HardwareFingerprint hardwareFingerprint;
    private final WorkerBootstrap workerBootstrap;
    private final LicenseService licenseService;

    @GetMapping
    public ApiResponse<Map<String, Object>> health() {
        return ApiResponse.ok(Map.of(
                "status", "UP",
                "timestamp", OffsetDateTime.now()
        ));
    }

    @GetMapping("/info")
    public ApiResponse<Map<String, Object>> info() {
        String defaultLang = System.getProperty("mpd.default-lang", "");
        java.util.LinkedHashMap<String, Object> body = new java.util.LinkedHashMap<>();
        body.put("name", appName);
        body.put("mode", mode);
        body.put("javaVersion", System.getProperty("java.version"));
        body.put("osName", System.getProperty("os.name"));
        body.put("defaultLanguage", defaultLang);
        // licenseStatus is exposed anonymously so the React first-boot screen
        // can decide whether to send the user to the license-setup form
        // before login. MISSING -> show wizard; anything else -> normal login.
        LicenseStatus licStatus = licenseService.currentStatus();
        body.put("licenseStatus", licStatus.name());
        body.put("timestamp", OffsetDateTime.now());
        // Surface the Worker daemon status only when actually running as Worker.
        if (workerBootstrap.isWorkerMode()) {
            body.put("workerStatus", workerBootstrap.snapshot());
        }
        return ApiResponse.ok(body);
    }

    /** Issuer 에 입력해서 license 를 이 PC 에 묶기 위한 값.
     *  - {@code fingerprint}: raw machine id (Windows MachineGuid / Linux machine-id)
     *  - {@code shortDigest}: SHA-256 첫 8바이트 hex — 사용자 확인용 짧은 표시 */
    @GetMapping("/fingerprint")
    public ApiResponse<Map<String, String>> fingerprint() {
        return ApiResponse.ok(Map.of(
                "fingerprint", hardwareFingerprint.value(),
                "shortDigest", hardwareFingerprint.shortDigest()
        ));
    }
}
