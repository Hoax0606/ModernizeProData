package com.ksinfo.modernize_pro_data.common.config;

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
 * - Stateless (JWT 토큰 기반, 세션 없음).
 * - JwtAuthFilter 가 UsernamePasswordAuthenticationFilter 전에 동작.
 * - 인증 없이 허용: /api/v1/health, /api/v1/auth/**, WebSocket handshake.
 * - /api/v1/users/** 는 master 한정 (@PreAuthorize 가 메서드 레벨에서 강제).
 * - 그 외 인증 필요.
 */
@Configuration
@EnableMethodSecurity
@RequiredArgsConstructor
public class SecurityConfig {

    private final JwtAuthFilter jwtAuthFilter;
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
                .addFilterBefore(jwtAuthFilter, UsernamePasswordAuthenticationFilter.class)
                .addFilterAfter(licenseEnforcementFilter, JwtAuthFilter.class);

        return http.build();
    }

    @Bean
    public PasswordEncoder passwordEncoder() {
        return new BCryptPasswordEncoder();
    }
}
