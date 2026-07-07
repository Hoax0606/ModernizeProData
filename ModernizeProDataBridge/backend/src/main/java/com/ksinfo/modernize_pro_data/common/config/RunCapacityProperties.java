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

    /**
     * 가용 RAM 안전 계수 — (총RAM − JVM heap − systemReserve) 에 추가로 곱하는 cushion.
     * DuckDB memory_limit overshoot / OS 변동 대비 여유. 기본 0.9.
     * (heap·reserve 를 이미 명시 차감하므로 0.7 은 이중 할인 — 0.9 로 가벼운 margin 만.)
     */
    private double ramUsableRatio = 0.9;

    /**
     * Coordinator 의 DuckDB 외 상주 메모리 reserve(MB) — OS + 번들 메타 PG18 + WebView 등.
     * DuckDB 예산 산정 시 총 RAM 에서 (이 값 + JVM heap) 을 먼저 뺀다 → heap·DuckDB·PG 가
     * 같은 RAM 을 중복 예약(초과예약)하던 OOM 원인 제거 (2026-06-10). 기본 2560(2.5GB).
     */
    private int systemReserveMb = 2560;

    /**
     * Worker 의 reserve(MB) — Worker 는 메타 PG 가 없지만 OS + WebView2 호스트(msedgewebview2)가
     * 실제로 ~3GB 를 먹는다. 1GB 로 잡았다가 DuckDB 예산이 과대 → 16GB 박스가 swap → 워커 hang
     * 했었다(2026-06-11). 정직하게 3GB. RunCapacityPlanner 가 mode=worker 일 때 systemReserveMb
     * 대신 이 값을 쓴다.
     */
    private int workerSystemReserveMb = 3072;

    /** run 하나가 점유하는 코어 수 가정. 기본 2. */
    private int coresPerRun = 2;

    public int getMaxConcurrent() { return maxConcurrent; }
    public void setMaxConcurrent(int v) { this.maxConcurrent = v; }

    public int getMemBudgetMb() { return memBudgetMb; }
    public void setMemBudgetMb(int v) { this.memBudgetMb = v; }

    public double getRamUsableRatio() { return ramUsableRatio; }
    public void setRamUsableRatio(double v) { this.ramUsableRatio = v; }

    public int getSystemReserveMb() { return systemReserveMb; }
    public void setSystemReserveMb(int v) { this.systemReserveMb = v; }

    public int getWorkerSystemReserveMb() { return workerSystemReserveMb; }
    public void setWorkerSystemReserveMb(int v) { this.workerSystemReserveMb = v; }

    public int getCoresPerRun() { return coresPerRun; }
    public void setCoresPerRun(int v) { this.coresPerRun = v; }
}
