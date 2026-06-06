package com.ksinfo.modernize_pro_data.common.config;

import com.sun.management.OperatingSystemMXBean;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.stereotype.Component;

import java.lang.management.ManagementFactory;

/**
 * PC 자원(RAM·CPU) → 동시 run 상한 + run당 DuckDB memory_limit 자동 산정.
 *
 * 산정 공식은 static 순수 함수(단위 테스트 가능), 자원 감지는 인스턴스 생성자(MXBean).
 * 현장 사양이 가변이라 부팅 시 자동 산정하고, 안 맞으면 application.yml 의
 * modernize.run.* 로 override.
 */
@Component
@EnableConfigurationProperties(RunCapacityProperties.class)
@Slf4j
public class RunCapacityPlanner {

    private static final long MB = 1024L * 1024;
    private static final long DEFAULT_RUN_BUDGET_BYTES = 3072L * MB; // 3GB

    private final int maxConcurrent;
    private final long runMemoryLimitBytes;

    public RunCapacityPlanner(RunCapacityProperties props) {
        long totalRam = detectTotalRamBytes();
        long usableRam = (long) (totalRam * props.getRamUsableRatio());
        int cores = Runtime.getRuntime().availableProcessors();
        long runBudget = props.getMemBudgetMb() > 0
                ? props.getMemBudgetMb() * MB : DEFAULT_RUN_BUDGET_BYTES;

        this.maxConcurrent = props.getMaxConcurrent() > 0
                ? props.getMaxConcurrent()
                : computeMaxConcurrent(usableRam, cores, runBudget, props.getCoresPerRun());
        this.runMemoryLimitBytes = computeRunMemoryLimitBytes(usableRam, this.maxConcurrent);

        log.info("RunCapacity: cores={} totalRam={}MB usableRam={}MB runBudget={}MB "
                        + "-> maxConcurrent={} runMemoryLimit={}MB (override max={} budget={}MB)",
                cores, totalRam / MB, usableRam / MB, runBudget / MB,
                maxConcurrent, runMemoryLimitBytes / MB,
                props.getMaxConcurrent(), props.getMemBudgetMb());
    }

    /** min(메모리 기준, CPU 기준), 최소 1. */
    public static int computeMaxConcurrent(long usableRamBytes, int cores,
                                           long runBudgetBytes, int coresPerRun) {
        long memBound = runBudgetBytes <= 0 ? 1 : usableRamBytes / runBudgetBytes;
        long cpuBound = coresPerRun <= 0 ? cores : (long) cores / coresPerRun;
        long n = Math.min(memBound, cpuBound);
        return (int) Math.max(1, n);
    }

    /** 가용 RAM 을 동시 상한으로 분할 = run 하나가 쓸 memory_limit. */
    public static long computeRunMemoryLimitBytes(long usableRamBytes, int maxConcurrent) {
        if (maxConcurrent <= 0) return usableRamBytes;
        return usableRamBytes / maxConcurrent;
    }

    private long detectTotalRamBytes() {
        try {
            OperatingSystemMXBean os =
                    (OperatingSystemMXBean) ManagementFactory.getOperatingSystemMXBean();
            long total = os.getTotalMemorySize();
            if (total > 0) return total;
        } catch (Throwable t) {
            log.warn("물리 RAM 감지 실패 — 8GB 가정 폴백: {}", t.getMessage());
        }
        return 8L * 1024 * MB; // 폴백 8GB
    }

    public int getMaxConcurrent() { return maxConcurrent; }

    public long getRunMemoryLimitBytes() { return runMemoryLimitBytes; }

    /** DuckDB SET memory_limit 용 문자열 (예: 4096MB). */
    public String getRunMemoryLimit() { return (runMemoryLimitBytes / MB) + "MB"; }
}
