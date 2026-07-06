package com.ksinfo.modernize_pro_data.common.config;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;

/** RunCapacityPlanner 의 순수 산정 공식 단위 테스트 (자원 감지 무관). */
class RunCapacityPlannerTest {

    private static final long GB = 1024L * 1024 * 1024;

    @Test
    void maxConcurrent_16gb_4core_isCpuBound_2() {
        // 가용 11GB, run당 3GB → mem floor(11/3)=3; cpu floor(4/2)=2 → min=2
        int n = RunCapacityPlanner.computeMaxConcurrent(11 * GB, 4, 3 * GB, 2);
        assertEquals(2, n);
    }

    @Test
    void maxConcurrent_16gb_8core_isMemBound_3() {
        int n = RunCapacityPlanner.computeMaxConcurrent(11 * GB, 8, 3 * GB, 2);
        assertEquals(3, n);
    }

    @Test
    void maxConcurrent_neverBelowOne() {
        int n = RunCapacityPlanner.computeMaxConcurrent(1 * GB, 1, 3 * GB, 2);
        assertEquals(1, n);
    }

    @Test
    void runMemoryLimit_dividesAvailableByConcurrency() {
        long bytes = RunCapacityPlanner.computeRunMemoryLimitBytes(12 * GB, 3);
        assertEquals(4 * GB, bytes);
    }
}
