package com.ksinfo.modernize_pro_data.coordinator.api;

import com.ksinfo.modernize_pro_data.common.dto.ApiResponse;
import com.ksinfo.modernize_pro_data.coordinator.auth.AuthService;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.time.OffsetDateTime;
import java.util.Map;

/**
 * 인증 컨트롤러.
 *
 * POST /api/v1/auth/login   — DB 조회 + BCrypt 검증 + JWT 발급
 * POST /api/v1/auth/logout  — stateless 라 클라이언트가 토큰 폐기. 서버는 noop.
 */
@Slf4j
@RestController
@RequestMapping("/api/v1/auth")
@RequiredArgsConstructor
public class AuthController {

    private final AuthService authService;

    public record LoginRequest(
            @NotBlank String username,
            @NotBlank String password
    ) {}

    public record LoginResponse(
            String token,
            String username,
            String role,
            OffsetDateTime expiresAt,
            OffsetDateTime lastSignInAt
    ) {}

    @PostMapping("/login")
    public ApiResponse<LoginResponse> login(@Valid @RequestBody LoginRequest req) {
        var result = authService.login(req.username(), req.password());
        return ApiResponse.ok(new LoginResponse(
                result.token(),
                result.username(),
                result.role(),
                result.expiresAt(),
                result.lastSignInAt()
        ));
    }

    @PostMapping("/logout")
    public ApiResponse<Map<String, String>> logout(Authentication auth) {
        // first-wins 정책상 server-side 에서도 세션 무효화. 다음 로그인 허용을 위해 필수.
        // permitAll endpoint 이므로 auth 가 null 일 수 있음 (토큰 없이 호출). 그 경우 noop.
        if (auth != null && auth.getName() != null) {
            authService.logout(auth.getName());
        }
        return ApiResponse.ok(Map.of("message", "로그아웃 되었습니다"));
    }
}
