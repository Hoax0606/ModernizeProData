package com.ksinfo.modernize_pro_data.common.config;

import com.ksinfo.modernize_pro_data.coordinator.auth.ApiTokenAuthFilter;
import com.ksinfo.modernize_pro_data.coordinator.auth.JwtAuthFilter;
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
 * - Stateless (JWT / api_token 모두 Bearer 헤더 기반, 세션 없음).
 * - 2 개의 token filter 가 chain 으로 동작:
 *     1. ApiTokenAuthFilter — "Bearer mig_..."  → ROLE_API_CLIENT
 *     2. JwtAuthFilter      — "Bearer eyJ..."   → ROLE_MASTER / ADMIN / VIEWER
 *   admin role user (= UI 의 "Worker") 가 JWT 로 인증 후 /workers/self-register
 *   호출하면 worker_node 가 자동 생성된다. 별도 WK-* token 은 더 이상 없음.
 * - 인증 없이 허용: /api/v1/health, /api/v1/auth/**, WebSocket handshake,
 *   SPA shell 정적 자산 (/, /index.html, /favicon, /mpd*, /assets/**).
 * - /api/v1/users/** 는 master 한정 (@PreAuthorize 가 메서드 레벨에서 강제).
 * - 세부 권한 (ROLE 체크) 는 controller 메서드 @PreAuthorize 가 강제.
 */
@Configuration
@EnableMethodSecurity
@RequiredArgsConstructor
public class SecurityConfig {

    private final JwtAuthFilter jwtAuthFilter;
    private final ApiTokenAuthFilter apiTokenAuthFilter;
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
                        // First-boot license import — anonymous, only succeeds
                        // while no license is yet loaded (controller-side guard).
                        .requestMatchers("/api/v1/license/initial-setup").permitAll()
                        .requestMatchers("/ws/**").permitAll()     // 브라우저 SockJS handshake
                        .requestMatchers("/ws-raw/**").permitAll() // Worker raw WebSocket handshake
                        // SPA shell — bundled Vite 산출물 (login 페이지 진입 전 anonymous 로딩).
                        .requestMatchers("/", "/index.html",
                                         "/favicon.svg", "/favicon.ico",
                                         "/mpd.png", "/mpd_lic.png",
                                         "/assets/**").permitAll()
                        .anyRequest().authenticated()
                )
                // Filter 順序: api_token → jwt. addFilterBefore 는 後에 추가된 것이
                // chain 上 앞쪽에 위치하므로, 의도 順序대로 register.
                .addFilterBefore(jwtAuthFilter, UsernamePasswordAuthenticationFilter.class)
                .addFilterBefore(apiTokenAuthFilter, UsernamePasswordAuthenticationFilter.class)
                .addFilterAfter(licenseEnforcementFilter, JwtAuthFilter.class);

        return http.build();
    }

    @Bean
    public PasswordEncoder passwordEncoder() {
        return new BCryptPasswordEncoder();
    }
}
