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
 * 동시 run 상한은 RunCapacityPlanner 가 PC 의 RAM/CPU 로 산정한 값을 그대로 쓴다.
 * core==max → queue 가 차길 기다리지 않고 즉시 max 개까지 동시 실행. 초과분은 queue 대기.
 * {@code @EnableAsync} 는 ModernizeProDataApplication 에 이미 있음.
 */
@Slf4j
@Configuration
public class AsyncConfig implements AsyncConfigurer {

    private final RunCapacityPlanner capacityPlanner;

    public AsyncConfig(RunCapacityPlanner capacityPlanner) {
        this.capacityPlanner = capacityPlanner;
    }

    /** @Async 용 실행기 = taskExecutor bean (단일 인스턴스). @Configuration 프록시라 같은 bean 반환. */
    @Override
    public Executor getAsyncExecutor() {
        return taskExecutor();
    }

    @Bean(name = "taskExecutor")
    public Executor taskExecutor() {
        int max = capacityPlanner.getMaxConcurrent();   // 자원 기반 동시 상한
        ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
        // core==max → 즉시 max 개까지 동시 실행 (queue 가 먼저 차길 기다리지 않음).
        executor.setCorePoolSize(max);
        executor.setMaxPoolSize(max);
        executor.setQueueCapacity(100);   // 초과분은 대기 (reject 안 함)
        executor.setThreadNamePrefix("run-exec-");
        executor.initialize();
        log.info("Async executor: core=max={} queue=100 (자원 기반 동시 상한) prefix=run-exec-", max);
        return executor;
    }
}
