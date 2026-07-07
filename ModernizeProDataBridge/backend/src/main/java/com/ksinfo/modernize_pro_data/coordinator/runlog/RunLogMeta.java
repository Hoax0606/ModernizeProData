package com.ksinfo.modernize_pro_data.coordinator.runlog;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

import java.time.OffsetDateTime;

/**
 * Run 단위 메타 — run_log_meta 한 줄에 매핑.
 *  - parquet_root: Coordinator 가 cold-tier Parquet 를 떨구는 디렉터리 (Phase B 에서 채워짐)
 *  - counters: 인제스트 측에서 누적. 화면 chip 카운트 캐시 소스.
 */
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class RunLogMeta {
    private String runId;
    private String projectId;
    private OffsetDateTime startedAt;
    private OffsetDateTime endedAt;
    private String parquetRoot;
    private long totalLines;
    private long errorCount;
    private long warnCount;
    private long infoCount;
}
