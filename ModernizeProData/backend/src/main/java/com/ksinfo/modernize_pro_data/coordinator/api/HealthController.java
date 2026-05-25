package com.ksinfo.modernize_pro_data.coordinator.api;

import com.ksinfo.modernize_pro_data.common.dto.ApiResponse;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.time.OffsetDateTime;
import java.util.Map;

/**
 * 헬스 체크 + 도구 정보.
 *
 * GET /api/v1/health         — 단순 alive 확인
 * GET /api/v1/health/info    — 도구·런타임 정보
 */
@RestController
@RequestMapping("/api/v1/health")
public class HealthController {

    @Value("${spring.application.name}")
    private String appName;

    @Value("${modernize.mode}")
    private String mode;

    @GetMapping
    public ApiResponse<Map<String, Object>> health() {
        return ApiResponse.ok(Map.of(
                "status", "UP",
                "timestamp", OffsetDateTime.now()
        ));
    }

    @GetMapping("/info")
    public ApiResponse<Map<String, Object>> info() {
        // defaultLanguage is set by Launcher.java reading the installer's
        // registry value HKCU\Software\ModernizeProData\Language; the React
        // app reads this on first boot to pick its UI language.
        String defaultLang = System.getProperty("mpd.default-lang", "");
        return ApiResponse.ok(Map.of(
                "name", appName,
                "mode", mode,
                "javaVersion", System.getProperty("java.version"),
                "osName", System.getProperty("os.name"),
                "defaultLanguage", defaultLang,
                "timestamp", OffsetDateTime.now()
        ));
    }
}
