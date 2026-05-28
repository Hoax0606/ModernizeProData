package com.ksinfo.modernize_pro_data.common.duckdb;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

/**
 * 앱 기동 시 DuckDB smoke test 자동 실행.
 * 실패 시 앱이 RuntimeException 으로 중단되어 빨리 환경 문제를 잡을 수 있다.
 */
@Slf4j
@Component
@Order(1)
@RequiredArgsConstructor
public class DuckDbStartupRunner implements ApplicationRunner {

    private final DuckDbService duckDbService;

    @Override
    public void run(ApplicationArguments args) {
        log.info("Running DuckDB smoke test on startup...");
        duckDbService.smokeTest();
    }
}
