package com.ksinfo.modernize_pro_data.common.config;

import org.junit.jupiter.api.Test;
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/** AsyncConfig 가 RunCapacityPlanner 산정값을 core==max 로 쓰는지 검증. */
class AsyncConfigTest {

    @Test
    void taskExecutor_usesPlannerMaxConcurrent() {
        RunCapacityPlanner planner = mock(RunCapacityPlanner.class);
        when(planner.getMaxConcurrent()).thenReturn(3);

        AsyncConfig cfg = new AsyncConfig(planner);
        ThreadPoolTaskExecutor ex = (ThreadPoolTaskExecutor) cfg.taskExecutor();

        assertEquals(3, ex.getCorePoolSize());
        assertEquals(3, ex.getMaxPoolSize());
    }
}
