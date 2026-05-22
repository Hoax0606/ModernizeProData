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
 * 동시 접속 정책 (confirm-to-evict):
 * - login: 활성 세션 있으면 409 (AUTH_SESSION_ACTIVE_ELSEWHERE) 로 거부.
 *   클라이언트가 "끊고 로그인" 선택 시 forceSelfLogout 로 세션 무효화 후 재로그인.
 * - logout: user 의 세션 필드 clear + audit.
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

        // confirm-to-evict: 활성 세션 있으면 거부. 클라이언트가 확인 후 forceSelfLogout 호출.
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

    /** master 가 다른 사용자의 세션 강제 종료. audit username=actor, target=대상 */
    @Transactional
    public void forceLogout(String targetUsername, String actorUsername) {
        userRepository.findByUsername(targetUsername).ifPresent(u -> {
            u.setCurrentSessionId(null);
            u.setCurrentSessionIssuedAt(null);
            u.setCurrentSessionExpiresAt(null);
            userRepository.save(u);
            auditLogService.record(null, null, actorUsername, "FORCE_LOGOUT")
                    .target(targetUsername).save();
            log.info("Force logout: {} (by {})", targetUsername, actorUsername);
        });
    }

    /**
     * Self force-logout — 본인이 비번 재인증으로 자기 세션 무효화.
     * Login 거부 (active elsewhere) 후 사용자가 "끊고 로그인" 선택 시 호출.
     */
    @Transactional
    public void forceSelfLogout(String username, String password) {
        User user = userRepository.findByUsername(username)
                .orElseThrow(() -> new ApiException(
                        "AUTH_USER_NOT_FOUND", "존재하지 않는 사용자", HttpStatus.UNAUTHORIZED));
        if (!passwordEncoder.matches(password, user.getPasswordHash())) {
            throw new ApiException(
                    "AUTH_PASSWORD_INVALID", "비밀번호가 일치하지 않습니다", HttpStatus.UNAUTHORIZED);
        }
        user.setCurrentSessionId(null);
        user.setCurrentSessionIssuedAt(null);
        user.setCurrentSessionExpiresAt(null);
        userRepository.save(user);
        auditLogService.record(null, null, username, "FORCE_LOGOUT_SELF").save();
        log.info("Force self-logout: {}", username);
    }
}
