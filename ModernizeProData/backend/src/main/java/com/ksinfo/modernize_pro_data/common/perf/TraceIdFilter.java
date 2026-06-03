package com.ksinfo.modernize_pro_data.common.perf;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.MDC;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.UUID;

/**
 * 모든 /api/** request 에 8 자리 traceId 를 MDC 에 부여한다.
 * logback pattern 의 {@code [%X{traceId:-}]} 가 자동으로 그것을 출력하므로,
 * 다중 사용자 측정 시 한 사용자 흐름의 [perf] log 를 grep traceId 로 묶을 수 있다.
 *
 * - perf flag off 면 bean 자체 미등록 → prod 오버헤드 zero.
 * - 정적 asset / WebSocket 핸드셰이크 는 제외 (shouldNotFilter).
 * - Security filter 보다 먼저 (HIGHEST_PRECEDENCE+10) — 인증 실패 응답도 traceId 보존.
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 10)
@ConditionalOnProperty(name = "modernize.perf.enabled", havingValue = "true")
public class TraceIdFilter extends OncePerRequestFilter {

    private static final String MDC_KEY = "traceId";

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain)
            throws ServletException, IOException {
        String traceId = UUID.randomUUID().toString().substring(0, 8);
        MDC.put(MDC_KEY, traceId);
        try {
            chain.doFilter(req, res);
        } finally {
            MDC.remove(MDC_KEY);
        }
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest req) {
        return !req.getRequestURI().startsWith("/api/");
    }
}
