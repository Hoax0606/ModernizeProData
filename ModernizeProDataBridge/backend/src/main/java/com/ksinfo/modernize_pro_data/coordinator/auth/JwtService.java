package com.ksinfo.modernize_pro_data.coordinator.auth;

import io.jsonwebtoken.Claims;
import io.jsonwebtoken.ExpiredJwtException;
import io.jsonwebtoken.JwtException;
import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.io.Decoders;
import io.jsonwebtoken.security.Keys;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import javax.crypto.SecretKey;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.time.temporal.ChronoUnit;
import java.util.Date;
import java.util.Optional;

/**
 * JWT 발급·검증.
 * - HS512 (HMAC SHA-512). secret 은 application.yml 의 modernize.jwt.secret (base64).
 * - 만료 시간은 modernize.jwt.expiration-hours (기본 8h).
 * - claims: sub = username, role = master/admin/viewer, iat, exp.
 */
@Slf4j
@Service
public class JwtService {

    private final SecretKey key;
    private final long expirationMillis;

    public JwtService(
            @Value("${modernize.jwt.secret}") String secretBase64,
            @Value("${modernize.jwt.expiration-hours:8}") long expirationHours
    ) {
        byte[] bytes = Decoders.BASE64.decode(secretBase64);
        this.key = Keys.hmacShaKeyFor(bytes);
        this.expirationMillis = expirationHours * 60 * 60 * 1000;
    }

    /** 토큰 발급 — username + role + sid (active session 식별자) 클레임 포함. */
    public String issue(String username, String role, String sessionId) {
        Instant now = Instant.now();
        Instant exp = now.plusMillis(expirationMillis);
        return Jwts.builder()
                .subject(username)
                .claim("role", role)
                .claim("sid", sessionId)
                .issuedAt(Date.from(now))
                .expiration(Date.from(exp))
                .signWith(key)
                .compact();
    }

    /** 만료 시각 (응답 DTO 용). */
    public OffsetDateTime expirationOf(String token) {
        return parse(token)
                .map(Claims::getExpiration)
                .map(d -> d.toInstant().atOffset(ZoneOffset.UTC))
                .orElse(OffsetDateTime.now().plus(expirationMillis, ChronoUnit.MILLIS));
    }

    /** 검증 후 클레임 반환. 실패 시 Optional.empty(). */
    public Optional<Claims> parse(String token) {
        try {
            return Optional.of(
                    Jwts.parser()
                            .verifyWith(key)
                            .build()
                            .parseSignedClaims(token)
                            .getPayload()
            );
        } catch (ExpiredJwtException e) {
            // 토큰 만료는 정상 흐름 (브라우저가 stale 토큰을 다음 요청에 잠깐 같이 보내는 케이스
            // 등) — 로그를 찍지 않는다. 클라이언트는 401 받고 재로그인 한다.
            return Optional.empty();
        } catch (JwtException | IllegalArgumentException e) {
            log.debug("JWT 검증 실패: {}", e.getMessage());
            return Optional.empty();
        }
    }

    public Optional<String> usernameOf(String token) {
        return parse(token).map(Claims::getSubject);
    }

    public Optional<String> roleOf(String token) {
        return parse(token).map(c -> c.get("role", String.class));
    }

    public Optional<String> sidOf(String token) {
        return parse(token).map(c -> c.get("sid", String.class));
    }
}
