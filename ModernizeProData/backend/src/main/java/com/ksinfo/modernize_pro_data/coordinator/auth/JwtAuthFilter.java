package com.ksinfo.modernize_pro_data.coordinator.auth;

import com.ksinfo.modernize_pro_data.coordinator.user.UserRepository;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import lombok.RequiredArgsConstructor;
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
 * Authorization: Bearer xxx 헤더의 JWT 를 검증하고 SecurityContext 에 사용자/권한 주입.
 *
 * 동시 접속 차단 (first-wins) 검증:
 * - token 의 sid claim 이 user.current_session_id 와 일치해야 인증 주입.
 * - 불일치 / null 인 경우 인증 주입 안 함 → SecurityConfig 가 401.
 * - 토큰이 형식적으로 유효해도 user 가 다른 곳에서 logout / 새 로그인 했으면 무효화.
 */
@Component
@RequiredArgsConstructor
public class JwtAuthFilter extends OncePerRequestFilter {

    private final JwtService jwtService;
    private final UserRepository userRepository;

    @Override
    protected void doFilterInternal(
            @NonNull HttpServletRequest request,
            @NonNull HttpServletResponse response,
            @NonNull FilterChain chain
    ) throws ServletException, IOException {
        String header = request.getHeader("Authorization");
        if (header != null && header.startsWith("Bearer ")) {
            String token = header.substring(7);
            jwtService.parse(token).ifPresent(claims -> {
                String username = claims.getSubject();
                String role = claims.get("role", String.class);
                String sid = claims.get("sid", String.class);
                if (username == null || role == null || sid == null) return;
                userRepository.findByUsername(username).ifPresent(user -> {
                    if (sid.equals(user.getCurrentSessionId())) {
                        var authority = new SimpleGrantedAuthority("ROLE_" + role.toUpperCase());
                        var auth = new UsernamePasswordAuthenticationToken(username, null, List.of(authority));
                        auth.setDetails(new WebAuthenticationDetailsSource().buildDetails(request));
                        SecurityContextHolder.getContext().setAuthentication(auth);
                    }
                });
            });
        }
        chain.doFilter(request, response);
    }
}
