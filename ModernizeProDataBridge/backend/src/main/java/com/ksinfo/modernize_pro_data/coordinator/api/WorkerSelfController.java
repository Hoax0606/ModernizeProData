package com.ksinfo.modernize_pro_data.coordinator.api;

import com.ksinfo.modernize_pro_data.common.dto.ApiResponse;
import com.ksinfo.modernize_pro_data.common.exception.ApiException;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * Worker process 자체에 대한 조작 (forget-url, restart 등). Worker mode 전용 — Coordinator
 * 에선 거부. anonymous OK — Login 화면에서 호출 가능해야 하므로 (URL 끊기 = 로그인 전 작업).
 */
@RestController
@RequestMapping("/api/v1/worker-self")
@RequiredArgsConstructor
@Slf4j
public class WorkerSelfController {

    @Value("${modernize.mode}")
    private String mode;

    /**
     * 저장된 Coordinator URL 을 HKCU 에서 삭제하고 즉시 종료.
     * 사용자가 다시 launch 하면 JavaFX wizard 의 URL step 부터 다시 시작.
     *
     * mode != worker 에선 NOT_WORKER_MODE 로 거부.
     */
    @PostMapping("/forget-url")
    public ApiResponse<Map<String, Object>> forgetUrl() {
        if (!"worker".equals(mode)) {
            throw new ApiException("NOT_WORKER_MODE", "Only Worker processes can forget the Coordinator URL.");
        }
        try {
            // HKCU\Software\ModernizeProDataBridge\CoordinatorUrl 값만 삭제 (다른 key 는 유지).
            Process p = new ProcessBuilder(
                    "reg", "delete", "HKCU\\Software\\ModernizeProDataBridge",
                    "/v", "CoordinatorUrl", "/f"
            ).redirectErrorStream(true).start();
            int rc = p.waitFor();
            log.info("Worker forget-url: reg delete exit={}", rc);
        } catch (Exception e) {
            log.warn("Worker forget-url: registry delete failed: {}", e.getMessage());
            throw new ApiException("FORGET_URL_FAILED", "Could not remove stored URL: " + e.getMessage());
        }
        // 종료는 응답 send 이후 별 thread 에서 수행 — Edge/WebView2 host 가 process 죽음을
        // 감지해 같이 종료. 사용자가 다시 launch → wizard URL step 진입.
        new Thread(() -> {
            try { Thread.sleep(400); } catch (InterruptedException ignored) {}
            log.info("Worker forget-url: exiting JVM for re-onboarding");
            System.exit(0);
        }, "worker-forget-url-exit").start();
        return ApiResponse.ok(Map.of("status", "shutting-down"));
    }
}
