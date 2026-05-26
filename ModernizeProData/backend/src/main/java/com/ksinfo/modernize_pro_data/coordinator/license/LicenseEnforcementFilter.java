package com.ksinfo.modernize_pro_data.coordinator.license;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.lang.NonNull;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.time.Instant;
import java.util.Set;
import java.util.concurrent.atomic.AtomicLong;

/**
 * 라이선스 상태별 API 차단.
 *
 * <pre>
 *   ACTIVE / EXPIRING / IN_GRACE  → 통과
 *   READ_ONLY                     → GET / HEAD 만 통과 (write 차단)
 *   EXPIRED / INVALID / MISSING   → 전부 차단 (단 always-allowed 패스만 통과)
 * </pre>
 *
 * always-allowed (라이선스 상태 무관 통과):
 * - /api/v1/health/**            (헬스체크)
 * - /api/v1/auth/**              (로그인 / 토큰 갱신)
 * - /api/v1/license              (GET = 상태 조회, POST = master 업로드)
 * - /ws/**                       (이미 인증된 세션 유지)
 *
 * touch throttle: 매 요청마다 sealed clock 갱신은 무의미 — 5분 간격으로만.
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class LicenseEnforcementFilter extends OncePerRequestFilter {

    private final LicenseService licenseService;

    private static final Set<String> ALWAYS_ALLOWED_PREFIXES = Set.of(
            "/api/v1/health",
            "/api/v1/auth",
            "/api/v1/license",
            "/ws/",
            // SPA shell + assets so the React app boots even when the server
            // is in MISSING/INVALID/EXPIRED -- otherwise the JS bundle never
            // loads and the user sees the raw 403 JSON instead of the
            // /license-setup wizard.
            "/assets/",
            "/icons/"
    );

    private static final Set<String> ALWAYS_ALLOWED_EXACT = Set.of(
            "/",
            "/index.html",
            "/favicon.svg",
            "/favicon.ico",
            "/mpd.png",
            "/mpd_lic.png"
    );

    private static final long TOUCH_THROTTLE_MS = 5L * 60L * 1000L;
    private final AtomicLong lastTouchAt = new AtomicLong(0L);

    @Override
    protected void doFilterInternal(
            @NonNull HttpServletRequest request,
            @NonNull HttpServletResponse response,
            @NonNull FilterChain chain
    ) throws ServletException, IOException {
        String path = request.getRequestURI();
        if (isAlwaysAllowed(path)) {
            chain.doFilter(request, response);
            return;
        }

        LicenseStatus status = licenseService.currentStatus();
        if (status.isFullyBlocked()) {
            writeBlock(response, status, "License required to use this feature");
            return;
        }
        if (status == LicenseStatus.READ_ONLY && isWriteMethod(request.getMethod())) {
            writeBlock(response, status, "License expired — read-only window. Write operations blocked.");
            return;
        }

        long now = Instant.now().toEpochMilli();
        long last = lastTouchAt.get();
        if (now - last > TOUCH_THROTTLE_MS && lastTouchAt.compareAndSet(last, now)) {
            try {
                licenseService.touchLastSeen();
            } catch (Exception e) {
                log.warn("touchLastSeen failed: {}", e.getMessage());
            }
        }
        chain.doFilter(request, response);
    }

    private boolean isAlwaysAllowed(String path) {
        if (ALWAYS_ALLOWED_EXACT.contains(path)) return true;
        for (String prefix : ALWAYS_ALLOWED_PREFIXES) {
            if (path.startsWith(prefix)) return true;
        }
        // SPA client-side routes (e.g. /login, /license-setup, /dashboard).
        // They contain no extension and aren't under /api or /ws --
        // SpaFallbackController will forward them to /index.html, so the
        // license-MISSING state must let them through, otherwise the React
        // router can't even reach the /license-setup screen.
        if (!path.startsWith("/api/") && !path.startsWith("/ws/") && !path.contains(".")) {
            return true;
        }
        return false;
    }

    private boolean isWriteMethod(String method) {
        return !"GET".equalsIgnoreCase(method) && !"HEAD".equalsIgnoreCase(method) && !"OPTIONS".equalsIgnoreCase(method);
    }

    private void writeBlock(HttpServletResponse response, LicenseStatus status, String msg) throws IOException {
        response.setStatus(HttpServletResponse.SC_FORBIDDEN);
        response.setContentType("application/json;charset=UTF-8");
        String code = switch (status) {
            case MISSING -> "LICENSE_MISSING";
            case INVALID -> "LICENSE_INVALID";
            case EXPIRED -> "LICENSE_EXPIRED";
            case READ_ONLY -> "LICENSE_READ_ONLY";
            default -> "LICENSE_BLOCKED";
        };
        response.getWriter().write(
                "{\"success\":false,\"data\":null,\"error\":{\"code\":\"" + code + "\",\"message\":\""
                        + msg.replace("\"", "\\\"") + "\"},\"timestamp\":\"\"}"
        );
    }
}
