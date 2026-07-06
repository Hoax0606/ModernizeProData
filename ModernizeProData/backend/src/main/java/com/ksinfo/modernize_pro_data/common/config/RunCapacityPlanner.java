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
    private static final long DEFAULT_SYSTEM_RESERVE_BYTES = 2560L * MB; // OS + 메타 PG 등
    private static final long MIN_USABLE_BYTES = 1024L * MB; // DuckDB 예산 하한 (1GB)

    private final int maxConcurrent;
    private final long runMemoryLimitBytes;
    /** DuckDB 에 줄 수 있는 총 가용 RAM(bytes). adaptive memory_limit 산정의 분자. */
    private final long usableRamBytes;

    public RunCapacityPlanner(RunCapacityProperties props,
                              @org.springframework.beans.factory.annotation.Value("${modernize.mode:coordinator}") String mode) {
        long totalRam = detectTotalRamBytes();
        // DuckDB(native, off-heap) 예산 = 총 RAM − JVM heap(-Xmx) − reserve.
        // coordinator 는 hub(JVM heap) + executor(DuckDB) 를 한 머신에서 겸하므로, 셋이 같은
        // RAM 을 중복 예약하면 초과예약 → swap/경합. heap 을 Runtime.maxMemory() 로 읽어 빼서
        // heap·DuckDB·(coordinator 면 메타PG) 가 RAM 안에 공존하게 한다 (2026-06-10 OOM 완화).
        // reserve 는 mode 별: worker 는 메타 PG 가 없으므로 OS만(작게) → DuckDB 에 RAM 더 할당.
        // ramUsableRatio 는 그 잔여분에 곱하는 가벼운 안전 cushion(0.9).
        boolean isWorker = "worker".equalsIgnoreCase(mode);
        long jvmHeapMax = Runtime.getRuntime().maxMemory();
        int reserveMb = isWorker ? props.getWorkerSystemReserveMb() : props.getSystemReserveMb();
        long systemReserve = reserveMb > 0 ? reserveMb * (long) MB : DEFAULT_SYSTEM_RESERVE_BYTES;
        long afterReserve = totalRam - jvmHeapMax - systemReserve;
        long usableRam = (long) (Math.max(MIN_USABLE_BYTES, afterReserve) * props.getRamUsableRatio());
        int cores = Runtime.getRuntime().availableProcessors();
        long runBudget = props.getMemBudgetMb() > 0
                ? props.getMemBudgetMb() * MB : DEFAULT_RUN_BUDGET_BYTES;

        this.maxConcurrent = props.getMaxConcurrent() > 0
                ? props.getMaxConcurrent()
                : computeMaxConcurrent(usableRam, cores, runBudget, props.getCoresPerRun());
        this.runMemoryLimitBytes = computeRunMemoryLimitBytes(usableRam, this.maxConcurrent);
        this.usableRamBytes = usableRam;

        log.info("RunCapacity: mode={} cores={} totalRam={}MB jvmHeapMax={}MB systemReserve={}MB "
                        + "usableRam={}MB runBudget={}MB -> maxConcurrent={} runMemoryLimit={}MB "
                        + "(override max={} budget={}MB)",
                isWorker ? "worker" : "coordinator", cores, totalRam / MB, jvmHeapMax / MB, systemReserve / MB,
                usableRam / MB, runBudget / MB,
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

    /** DuckDB SET memory_limit 용 문자열 — worst-case(usable/maxConcurrent). 정적. */
    public String getRunMemoryLimit() { return (runMemoryLimitBytes / MB) + "MB"; }

    /**
     * adaptive memory_limit — run bind 시점의 <b>실제 동시 run 수</b>로 가용 RAM 을 나눈다.
     * 혼자 돌면(activeRuns=1) usable 거의 전부 → spill 최소 → 빠름. 정적 usable/maxConcurrent 는
     * 동시성 1 일 때도 1/maxConcurrent 로 굶겨 단일 run 이 느려지던 버그(2026-06-11)를 해소.
     *
     * 분모는 [1, maxConcurrent] 로 clamp — 어차피 maxConcurrent 초과 동시 실행은 게이트가 막으므로,
     * 최악(=maxConcurrent 동시)에도 합이 usable 을 넘지 않아 초과예약 방지. activeRuns 가 그보다
     * 적으면 그만큼 run 당 더 큰 limit (DuckDB 는 soft cap+spill 이라 ramp 시 일시 spill 만).
     *
     * @param activeRuns 현재 이 프로세스에서 실행 중인 run 수 (자기 자신 포함).
     */
    public String getRunMemoryLimit(int activeRuns) {
        int n = Math.max(1, Math.min(activeRuns, maxConcurrent));
        long bytes = usableRamBytes / n;
        return (bytes / MB) + "MB";
    }
}
