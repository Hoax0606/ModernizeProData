package com.ksinfo.modernize_pro_data.common.config;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import lombok.extern.slf4j.Slf4j;
import org.slf4j.MDC;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.UUID;

/**
 * 측정 인프라 — 다중 사용자 병목 진단용.
 *
 * (1) 모든 요청에 짧은 traceId 를 MDC 에 넣어 동시 요청의 로그를 묶을 수 있게 한다.
 *     logging pattern 의 %X{traceId} 로 출력. 5-user 측정 시 같은 시점의 listBySite
 *     peak 와 setBaseline retry 발생을 correlation 으로 본다.
 *
 * (2) 진단 대상 endpoint (listBySite / list/create snapshot / setBaseline /
 *     restore-mapping / csv-row-count) 만 [perf] 로 duration 을 찍는다. controller
 *     전부가 아니라 한정 — 측정 자체의 overhead 최소화.
 *
 * production overhead 없음 — MDC put/clear 는 ns 단위, [perf] 는 5개 패턴만.
 */
@Slf4j
@Component
@Order(1)
public class PerfTraceFilter extends OncePerRequestFilter {

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain)
            throws ServletException, IOException {
        String traceId = UUID.randomUUID().toString().substring(0, 8);
        MDC.put("traceId", traceId);
        long start = System.nanoTime();
        try {
            chain.doFilter(req, res);
        } finally {
            String uri = req.getRequestURI();
            if (isPerfTarget(uri)) {
                long ms = (System.nanoTime() - start) / 1_000_000;
                log.info("[perf] {} {} -> {} ({}ms)", req.getMethod(), uri, res.getStatus(), ms);
            }
            MDC.remove("traceId");
        }
    }

    /** 진단 대상 — 5-user 측정의 폭증 endpoint 만. */
    private static boolean isPerfTarget(String uri) {
        if (uri == null) return false;
        return uri.endsWith("/snapshots")                 // listByProject / listBySite / create
                || uri.contains("/baseline")              // setBaseline / clearBaseline
                || uri.contains("/restore-mapping")       // restoreMapping
                || uri.contains("/csv-row-count");        // csv-row-count
    }
}
