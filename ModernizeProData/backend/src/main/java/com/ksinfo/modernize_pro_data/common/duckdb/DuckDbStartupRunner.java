package com.ksinfo.modernize_pro_data.common.duckdb;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

/**
 * 앱 기동 시 DuckDB smoke test 를 background thread 에서 warmup (2026-05-30).
 *
 * <p>옛 동작: synchronous — backend startup 을 3~4s 차단 (encodings + icu extension
 * load, UDF register). 실패 fail-fast.
 *
 * <p>새 동작: async — backend startup 안 차단. backend ready 와 병렬로 DuckDB init.
 * 사용자가 splash → login → mapping 거치는 동안 ready. 첫 stage 실행 시점에 이미
 * connection 준비됨. 실패 시 fail-fast 깨지지만 첫 stage 에서 검출 — desktop PoC 에
 * 적절한 trade.
 */
@Slf4j
@Component
@Order(1)
@RequiredArgsConstructor
public class DuckDbStartupRunner implements ApplicationRunner {

    private final DuckDbService duckDbService;

    @Override
    public void run(ApplicationArguments args) {
        log.info("Scheduling DuckDB smoke test (async warmup)...");
        Thread t = new Thread(() -> {
            try {
                duckDbService.smokeTest();
            } catch (Exception e) {
                log.error("DuckDB async smoke test failed — first stage will fail", e);
            }
        }, "duckdb-warmup");
        t.setDaemon(true);
        t.start();
    }
}
