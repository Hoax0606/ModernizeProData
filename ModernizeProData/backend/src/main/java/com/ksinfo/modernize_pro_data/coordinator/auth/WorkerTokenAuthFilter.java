package com.ksinfo.modernize_pro_data.coordinator.auth;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.lang.NonNull;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.web.authentication.WebAuthenticationDetailsSource;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.List;

/**
 * Worker (現場 実行 node) 専用 token 認証 filter.
 *
 * 동작:
 *   1. {@code Authorization: Bearer WK-...} 형식의 token 만 受理
 *   2. application.yml 의 {@code app.worker.token} 와 정확 일치 시 SecurityContext 에
 *      ROLE_WORKER 부여, principal = "default" (PoC 用 단일 Worker)
 *   3. 不一致 / 미설정 시는 통과 (인증되지 않은 상태로 후속 SecurityConfig 가 401 반환)
 *
 * 본격적인 worker_nodes 테이블 도입은 별 branch — 그때 token-by-worker 검색으로 확장.
 * 현재는 단일 token / 단일 Worker 想定.
 */
@Slf4j
@Component
public class WorkerTokenAuthFilter extends OncePerRequestFilter {

    private static final String BEARER_PREFIX = "Bearer ";
    private static final String WORKER_TOKEN_PREFIX = "WK-";
    public static final String DEFAULT_WORKER_PRINCIPAL = "default";

    /**
     * application.yml: {@code app.worker.token}. 未設定 (空) なら認証無効 (PoC dev mode).
     * 例 値: {@code WK-7HQ3-2X5L-8MNP}.
     */
    private final String expectedToken;

    public WorkerTokenAuthFilter(@Value("${app.worker.token:}") String expectedToken) {
        this.expectedToken = expectedToken;
    }

    @Override
    protected void doFilterInternal(
            @NonNull HttpServletRequest request,
            @NonNull HttpServletResponse response,
            @NonNull FilterChain chain) throws ServletException, IOException {

        String header = request.getHeader("Authorization");
        if (header == null || !header.startsWith(BEARER_PREFIX)) {
            chain.doFilter(request, response);
            return;
        }

        String token = header.substring(BEARER_PREFIX.length());
        if (!token.startsWith(WORKER_TOKEN_PREFIX)) {
            chain.doFilter(request, response);
            return;
        }

        if (expectedToken == null || expectedToken.isBlank()) {
            log.debug("Worker token received but app.worker.token unset — skipping (PoC dev mode)");
            chain.doFilter(request, response);
            return;
        }

        if (token.equals(expectedToken)) {
            var authority = new SimpleGrantedAuthority("ROLE_WORKER");
            var auth = new UsernamePasswordAuthenticationToken(
                    DEFAULT_WORKER_PRINCIPAL, null, List.of(authority));
            auth.setDetails(new WebAuthenticationDetailsSource().buildDetails(request));
            SecurityContextHolder.getContext().setAuthentication(auth);
        } else {
            log.warn("Worker token mismatch from {}", request.getRemoteAddr());
        }

        chain.doFilter(request, response);
    }
}
