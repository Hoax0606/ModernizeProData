package com.ksinfo.modernize_pro_data.common.config;

import lombok.extern.slf4j.Slf4j;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.AsyncConfigurer;
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor;

import java.util.concurrent.Executor;

/**
 * {@code @Async} 실행기 — 기본 SimpleAsyncTaskExecutor(thread-per-task, 무제한) 대신
 * 제한된 ThreadPool 을 명시. RunExecutionListener 의 run 실행 thread 가 이 풀을 쓴다.
 *
 * 왜: 기본 SimpleAsyncTaskExecutor 는 task 마다 새 thread 를 무한 생성 → 동시 run 이 몰리면
 * thread 폭주 위험 + 부팅 시 warning. ThreadPoolTaskExecutor 로 상한을 둔다.
 *
 * PoC 값: core 2 / max 8 / queue 100. (단일 사이트, 동시 run 적음 가정.)
 * {@code @EnableAsync} 는 ModernizeProDataApplication 에 이미 있음.
 */
@Slf4j
@Configuration
public class AsyncConfig implements AsyncConfigurer {

    /** @Async 용 실행기 = taskExecutor bean (단일 인스턴스). @Configuration 프록시라 같은 bean 반환. */
    @Override
    public Executor getAsyncExecutor() {
        return taskExecutor();
    }

    @Bean(name = "taskExecutor")
    public Executor taskExecutor() {
        ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
        executor.setCorePoolSize(2);
        executor.setMaxPoolSize(8);
        executor.setQueueCapacity(100);
        executor.setThreadNamePrefix("run-exec-");
        executor.initialize();
        log.info("Async executor configured: core=2 max=8 queue=100 prefix=run-exec-");
        return executor;
    }
}
