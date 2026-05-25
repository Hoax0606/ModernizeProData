package com.ksinfo.modernize_pro_data.coordinator.auth;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
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
 * API token (案 A の external scheduler 用) 인증 필터 — **인증 전담**.
 *
 * 동작:
 *   1. {@code Authorization: Bearer mig_...} 형식の token만 受理
 *   2. SHA-256 hash → api_credentials lookup → 존재하면 SecurityContext 에 ROLE_API_CLIENT 부여
 *   3. 失敗時은 設定하지 않고 通過 (다음 filter / 미인증 으로 처리됨)
 *
 * principal = credential.id (예: "cred-abc12345"), Controller 에서 Authentication.getName() 으로 취득.
 *
 * 案 C 마이그 시 본 filter 의 lookup 만 갱신하면 됨 — wire protocol (Bearer header) 은 불변.
 *
 * **external_enabled 의 足切り은 본 필터가 担当하지 않음** —
 * RunController.startAll() 등 endpoint 측에서 호출자 종류에 관계없이 일관 적용.
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class ApiTokenAuthFilter extends OncePerRequestFilter {

    private static final String BEARER_PREFIX = "Bearer ";

    private final CredentialService credentialService;

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

        // 任意 token を受け付ける. 他 filter (Worker / JWT) 用 token 은 skip:
        //   - "WK-" prefix     → Worker token (WorkerTokenAuthFilter 가 처리)
        //   - 3-segment dotted → JWT 형식 (JwtAuthFilter 가 처리)
        // 그 外는 SHA-256 hash + DB lookup. 일치하지 않으면 SecurityContext 미설정으로 통과.
        if (token.startsWith("WK-")) {
            chain.doFilter(request, response);
            return;
        }
        if (token.split("\\.").length == 3) {
            chain.doFilter(request, response);
            return;
        }

        // SHA-256 + DB lookup
        credentialService.authenticate(token).ifPresent(cred -> {
            var authority = new SimpleGrantedAuthority("ROLE_API_CLIENT");
            var auth = new UsernamePasswordAuthenticationToken(
                    cred.getId(), null, List.of(authority));
            auth.setDetails(new WebAuthenticationDetailsSource().buildDetails(request));
            SecurityContextHolder.getContext().setAuthentication(auth);
        });

        chain.doFilter(request, response);
    }
}
