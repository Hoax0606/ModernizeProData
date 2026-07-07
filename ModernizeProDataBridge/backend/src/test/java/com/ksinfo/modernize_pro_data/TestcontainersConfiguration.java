package com.ksinfo.modernize_pro_data;

import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.context.annotation.Bean;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.utility.DockerImageName;

/**
 * 테스트 컨텍스트에서 사용할 일회용 PostgreSQL 컨테이너.
 *
 * `@ServiceConnection` 이 컨테이너 host/port/credentials 를 Spring DataSource 에 자동 주입.
 * 테스트마다 컨테이너를 다시 띄우지 않도록 `withReuse(true)` 사용 (`~/.testcontainers.properties`
 * 에서 `testcontainers.reuse.enable=true` 가 켜져 있을 때만 실제 재사용).
 *
 * 사용:
 *   @SpringBootTest
 *   @Import(TestcontainersConfiguration.class)
 *   class MyTest { ... }
 */
@TestConfiguration(proxyBeanMethods = false)
public class TestcontainersConfiguration {

    @Bean
    @ServiceConnection
    @SuppressWarnings("resource")
    PostgreSQLContainer<?> postgresContainer() {
        return new PostgreSQLContainer<>(DockerImageName.parse("postgres:16-alpine"))
                .withDatabaseName("mpd_meta_test")
                .withUsername("test")
                .withPassword("test")
                .withReuse(true);
    }
}
