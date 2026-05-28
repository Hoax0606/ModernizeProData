package com.ksinfo.modernize_pro_data.coordinator.api;

import com.ksinfo.modernize_pro_data.common.dto.ApiResponse;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;

/**
 * API 안내 endpoint.
 *
 * 인스톨러 빌드부터는 `/` 가 jpackage 가 번들한 React 의 index.html 을
 * 서빙해야 하므로 안내 응답은 `/api/v1/info` 로 옮김. dev 모드 (Vite 가
 * 별도 5173 으로 떠 있을 때) 에서도 동일하게 `/api/v1/info` 로 접근.
 *
 * <p>인스톨러가 박은 default language 는 {@link HealthController#info()} 의
 * defaultLanguage 필드로 노출됨. 이 컨트롤러는 단순 안내 응답만.
 */
@RestController
public class RootController {

    @Value("${spring.application.name}")
    private String appName;

    @Value("${modernize.mode}")
    private String mode;

    @GetMapping("/api/v1/info")
    public ApiResponse<Map<String, Object>> info() {
        return ApiResponse.ok(Map.of(
                "name", appName,
                "mode", mode,
                "type", "REST API server",
                "endpoints", List.of(
                        "GET  /api/v1/health",
                        "GET  /api/v1/health/info",
                        "POST /api/v1/auth/login"
                )
        ));
    }
}
