package com.ksinfo.modernize_pro_data.coordinator.auth;

import com.ksinfo.modernize_pro_data.common.exception.ApiException;
import com.ksinfo.modernize_pro_data.coordinator.site.AuditLogService;
import com.ksinfo.modernize_pro_data.coordinator.user.User;
import com.ksinfo.modernize_pro_data.coordinator.user.UserRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.OffsetDateTime;
import java.util.UUID;

/**
 * 로그인·로그아웃 처리 — DB 조회 + BCrypt 검증 + JWT 발급 + lastSignInAt 갱신.
 *
 * 동시 접속 차단 (first-wins):
 * - login: user 의 current_session_expires_at 이 미래면 거부 (409).
 *   아니면 새 sid 발급 + user 의 세션 필드 set + audit 기록.
 * - logout: user 의 세션 필드 clear + audit 기록.
 * - JwtAuthFilter 가 매 요청 token 의 sid 와 user.current_session_id 를 비교.
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class AuthService {

    private final UserRepository userRepository;
    private final PasswordEncoder passwordEncoder;
    private final JwtService jwtService;
    private final AuditLogService auditLogService;

    public record LoginResult(String token, String username, String role,
                              OffsetDateTime expiresAt, OffsetDateTime lastSignInAt) {}

    @Transactional
    public LoginResult login(String username, String password) {
        User user = userRepository.findByUsername(username)
                .orElseThrow(() -> new ApiException(
                        "AUTH_USER_NOT_FOUND",
                        "존재하지 않는 사용자",
                        HttpStatus.UNAUTHORIZED));

        if (!passwordEncoder.matches(password, user.getPasswordHash())) {
            throw new ApiException(
                    "AUTH_PASSWORD_INVALID",
                    "비밀번호가 일치하지 않습니다",
                    HttpStatus.UNAUTHORIZED);
        }

        // first-wins: 활성 세션이 있으면 거부.
        OffsetDateTime now = OffsetDateTime.now();
        boolean hasActiveSession = user.getCurrentSessionId() != null
                && user.getCurrentSessionExpiresAt() != null
                && user.getCurrentSessionExpiresAt().isAfter(now);

        if (hasActiveSession) {
            auditLogService.record(null, null, username, "LOGIN_REJECTED")
                    .details("active session issued at " + user.getCurrentSessionIssuedAt())
                    .save();
            log.info("Login rejected (active session elsewhere): {}", username);
            throw new ApiException(
                    "AUTH_SESSION_ACTIVE_ELSEWHERE",
                    "다른 곳에서 이미 로그인되어 있습니다",
                    HttpStatus.CONFLICT);
        }

        // 이전 로그인 시각 캡처 후 갱신
        OffsetDateTime prevSignIn = user.getLastSignInAt();
        user.setLastSignInAt(now);

        // 새 세션 발급
        String sid = UUID.randomUUID().toString();
        String role = user.getRole().name();
        String token = jwtService.issue(user.getUsername(), role, sid);
        OffsetDateTime expiresAt = jwtService.expirationOf(token);

        user.setCurrentSessionId(sid);
        user.setCurrentSessionIssuedAt(now);
        user.setCurrentSessionExpiresAt(expiresAt);
        userRepository.save(user);

        auditLogService.record(null, null, username, "LOGIN").save();
        log.info("Login OK: {} ({})", user.getUsername(), role);
        return new LoginResult(token, user.getUsername(), role, expiresAt, prevSignIn);
    }

    @Transactional
    public void logout(String username) {
        userRepository.findByUsername(username).ifPresent(u -> {
            u.setCurrentSessionId(null);
            u.setCurrentSessionIssuedAt(null);
            u.setCurrentSessionExpiresAt(null);
            userRepository.save(u);
            auditLogService.record(null, null, username, "LOGOUT").save();
            log.info("Logout: {}", username);
        });
    }
}
