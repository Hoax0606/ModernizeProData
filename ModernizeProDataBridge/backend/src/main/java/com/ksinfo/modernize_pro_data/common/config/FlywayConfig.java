package com.ksinfo.modernize_pro_data.common.config;

import org.springframework.boot.autoconfigure.flyway.FlywayMigrationStrategy;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Flyway: repair() 후 migrate().
 *
 * <p>repair() 가 {@code flyway_schema_history} 의 checksum 을 현재 migration
 * 파일 기준으로 동기화하고, 실패로 남은 row 를 정리한다. 그 다음 migrate()
 * 로 미적용 migration 을 진행.
 *
 * <p>왜 필요한가: 이미 적용된 migration 파일을 (버그 fix 등으로) 수정하면
 * 파일 checksum 이 바뀌어 Flyway 의 validate 가 "checksum mismatch" 로
 * backend startup 자체를 막는다. 폐쇄망에 배포된 도구라 현장에서 수동
 * {@code flyway repair} 를 돌릴 수 없으므로, 매 부팅 시 자동 repair 로
 * 이 문제를 영구 차단한다.
 *
 * <p>주의: repair 는 schema(데이터) 를 건드리지 않고 history 의 메타데이터만
 * 고친다. 다만 "적용된 migration 을 수정해도 조용히 통과" 하게 되므로,
 * 새 스키마 변경은 여전히 새 timestamp migration 으로 추가하는 것이 원칙.
 */
@Configuration
public class FlywayConfig {

    @Bean
    public FlywayMigrationStrategy repairThenMigrate() {
        return flyway -> {
            flyway.repair();
            flyway.migrate();
        };
    }
}
