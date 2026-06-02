package com.ksinfo.modernize_pro_data.coordinator.api;

import com.ksinfo.modernize_pro_data.common.dto.ApiResponse;
import com.ksinfo.modernize_pro_data.common.exception.ApiException;
import com.ksinfo.modernize_pro_data.coordinator.update.ApplyResult;
import com.ksinfo.modernize_pro_data.coordinator.update.UpdateService;
import com.ksinfo.modernize_pro_data.coordinator.update.UpdateStatus;
import lombok.RequiredArgsConstructor;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 자동 업데이트 endpoint — master only.
 *
 * <ul>
 *   <li>{@code GET /api/v1/updates/status} — 현재 / 최신 version + 마지막 check 결과.</li>
 *   <li>{@code POST /api/v1/updates/check} — manifest URL 에서 최신 fetch + cache.</li>
 * </ul>
 *
 * Step 4~5 에서 {@code /apply} 추가 예정.
 */
@RestController
@RequestMapping("/api/v1/updates")
@RequiredArgsConstructor
public class UpdateController {

    private final UpdateService updateService;

    @GetMapping("/status")
    public ApiResponse<UpdateStatus> status(Authentication auth) {
        requireMaster(auth);
        return ApiResponse.ok(updateService.status());
    }

    @PostMapping("/check")
    public ApiResponse<UpdateStatus> check(Authentication auth) {
        requireMaster(auth);
        return ApiResponse.ok(updateService.check());
    }

    @PostMapping("/apply")
    public ApiResponse<ApplyResult> apply(Authentication auth) {
        requireMaster(auth);
        return ApiResponse.ok(updateService.applyLatest());
    }

    private static void requireMaster(Authentication auth) {
        if (auth == null) {
            throw new ApiException("AUTH_REQUIRED", "Login required.");
        }
        // JwtAuthFilter 가 "ROLE_" + role.toUpperCase() 로 박는다 → "ROLE_MASTER".
        boolean isMaster = auth.getAuthorities().stream()
                .map(GrantedAuthority::getAuthority)
                .anyMatch("ROLE_MASTER"::equals);
        if (!isMaster) {
            throw new ApiException("MASTER_ONLY", "Only master can manage updates.");
        }
    }
}
