package com.ksinfo.modernize_pro_data.common.config;

import com.ksinfo.modernize_pro_data.coordinator.auth.ApiTokenAuthFilter;
import com.ksinfo.modernize_pro_data.coordinator.auth.JwtAuthFilter;
import com.ksinfo.modernize_pro_data.coordinator.auth.WorkerTokenAuthFilter;
import com.ksinfo.modernize_pro_data.coordinator.license.LicenseEnforcementFilter;
import lombok.RequiredArgsConstructor;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.annotation.method.configuration.EnableMethodSecurity;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configurers.AbstractHttpConfigurer;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter;

/**
 * Spring Security 설정.
 *
 * - Stateless (JWT / api_token / worker_token 모두 Bearer 헤더 기반, 세션 없음).
 * - 3 개의 token filter 가 chain 으로 동작:
 *     1. ApiTokenAuthFilter    — "Bearer mig_..."  → ROLE_API_CLIENT
 *     2. WorkerTokenAuthFilter — "Bearer WK-..."   → ROLE_WORKER
 *     3. JwtAuthFilter         — "Bearer eyJ..."   → ROLE_MASTER / ADMIN / VIEWER
 *   각 filter 는 자신의 prefix 가 아니면 통과. 첫 매칭으로 SecurityContext 設정.
 * - 인증 없이 허용: /api/v1/health, /api/v1/auth/**, WebSocket handshake.
 * - 세부 권한 (ROLE 체크) 는 controller 메서드 @PreAuthorize 가 강제.
 */
@Configuration
@EnableMethodSecurity
@RequiredArgsConstructor
public class SecurityConfig {

    private final JwtAuthFilter jwtAuthFilter;
    private final ApiTokenAuthFilter apiTokenAuthFilter;
    private final WorkerTokenAuthFilter workerTokenAuthFilter;
    private final LicenseEnforcementFilter licenseEnforcementFilter;

    @Bean
    public SecurityFilterChain securityFilterChain(HttpSecurity http) throws Exception {
        http
                .csrf(AbstractHttpConfigurer::disable)
                .cors(cors -> {}) // CorsFilter 가 처리
                .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .authorizeHttpRequests(auth -> auth
                        .requestMatchers("/api/v1/health/**").permitAll()
                        .requestMatchers("/api/v1/auth/**").permitAll()
                        .requestMatchers("/ws/**").permitAll() // WebSocket handshake
                        .anyRequest().authenticated()
                )
                // Filter 順序: api_token → worker_token → jwt. addFilterBefore 는
                // 後에 추가된 것이 chain 上 앞쪽에 위치하므로, 의도 順序대로 register.
                .addFilterBefore(jwtAuthFilter, UsernamePasswordAuthenticationFilter.class)
                .addFilterBefore(workerTokenAuthFilter, UsernamePasswordAuthenticationFilter.class)
                .addFilterBefore(apiTokenAuthFilter, UsernamePasswordAuthenticationFilter.class);
                .addFilterBefore(jwtAuthFilter, UsernamePasswordAuthenticationFilter.class)
                .addFilterAfter(licenseEnforcementFilter, JwtAuthFilter.class);

        return http.build();
    }

    @Bean
    public PasswordEncoder passwordEncoder() {
        return new BCryptPasswordEncoder();
    }
}
