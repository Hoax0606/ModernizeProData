package com.ksinfo.modernize_pro_data.coordinator.runlog;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

import java.time.OffsetDateTime;

/**
 * 운영 로그 한 줄 — POJO. JPA 엔티티가 아닌 이유:
 *   - 12억 라인 인제스트 경로에서 Hibernate 의 dirty checking / 1차 캐시 오버헤드가
 *     생기면 안 됨. JdbcTemplate + COPY 로 직접 다룬다.
 *   - 파티션 동적 생성/DETACH 도 JPA 에서는 어색.
 */
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class RunLogLine {

    /** Worker 가 부여하는 per-run 단조 증가 시퀀스. PK 구성요소. */
    private long seq;

    private String runId;

    private OffsetDateTime ts;

    /** 0=INFO 1=WARN 2=ERROR */
    private short level;

    private String stage;

    private String message;

    /** ERROR 라인만 채워질 수 있음. */
    private String suggestion;

    public static final short LEVEL_INFO  = 0;
    public static final short LEVEL_WARN  = 1;
    public static final short LEVEL_ERROR = 2;

    public static short parseLevel(String name) {
        if (name == null) return LEVEL_INFO;
        return switch (name.toUpperCase()) {
            case "ERROR" -> LEVEL_ERROR;
            case "WARN"  -> LEVEL_WARN;
            default      -> LEVEL_INFO;
        };
    }

    public static String formatLevel(short l) {
        return switch (l) {
            case LEVEL_ERROR -> "ERROR";
            case LEVEL_WARN  -> "WARN";
            default          -> "INFO";
        };
    }
}
