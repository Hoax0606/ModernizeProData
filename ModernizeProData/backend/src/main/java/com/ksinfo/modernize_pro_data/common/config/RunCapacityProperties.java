package com.ksinfo.modernize_pro_data.common.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * modernize.run.* — capacity 자동산정 override (현장 사양 자동값이 안 맞을 때).
 * 전부 미설정(0/기본)이면 RunCapacityPlanner 가 RAM/CPU 로 자동 산정한다.
 */
@ConfigurationProperties(prefix = "modernize.run")
public class RunCapacityProperties {

    /** 동시 run 상한. 0/미설정 = 자동 산정. */
    private int maxConcurrent = 0;

    /** run당 메모리 예산(MB). 0/미설정 = 기본 3072. */
    private int memBudgetMb = 0;

    /** 가용 RAM 비율 (전체 중 DuckDB+처리에 쓸 비율). 기본 0.7. */
    private double ramUsableRatio = 0.7;

    /** run 하나가 점유하는 코어 수 가정. 기본 2. */
    private int coresPerRun = 2;

    public int getMaxConcurrent() { return maxConcurrent; }
    public void setMaxConcurrent(int v) { this.maxConcurrent = v; }

    public int getMemBudgetMb() { return memBudgetMb; }
    public void setMemBudgetMb(int v) { this.memBudgetMb = v; }

    public double getRamUsableRatio() { return ramUsableRatio; }
    public void setRamUsableRatio(double v) { this.ramUsableRatio = v; }

    public int getCoresPerRun() { return coresPerRun; }
    public void setCoresPerRun(int v) { this.coresPerRun = v; }
}
