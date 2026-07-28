package com.ksinfo.modernize_pro_data.coordinator.site;

import com.ksinfo.modernize_pro_data.TestcontainersConfiguration;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.testcontainers.containers.PostgreSQLContainer;

import java.util.HashMap;
import java.util.Map;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * TobeDbHealthService.probe 를 <b>실제 PostgreSQL</b>(Testcontainers)로 검증 — Phase 5 의 연결 라우팅
 * (TobeJdbcConnect 경유)이 문자열 조립을 넘어 실연결까지 올바른지. reachable(정상) / unreachable(인증 실패)
 * 두 경로. SiteRepository·Site 는 mock — DB 저장 없이 probe 만 집중.
 */
@SpringBootTest
@Import(TestcontainersConfiguration.class)
class TobeDbHealthServiceIT {

    @Autowired
    private PostgreSQLContainer<?> postgres;

    private Map<String, Object> cfg(String password) {
        Map<String, Object> m = new HashMap<>();
        m.put("type", "PostgreSQL");
        m.put("host", postgres.getHost());
        m.put("port", postgres.getMappedPort(5432));
        m.put("database", postgres.getDatabaseName());
        m.put("username", postgres.getUsername());
        m.put("password", password);
        return m;
    }

    private TobeDbHealthService serviceForSite(Map<String, Object> byEnv) {
        SiteRepository repo = mock(SiteRepository.class);
        Site site = mock(Site.class);
        when(site.getTobeDbByEnv()).thenReturn(byEnv);
        when(repo.findById("s1")).thenReturn(Optional.of(site));
        return new TobeDbHealthService(repo);
    }

    @Test
    void reachableWhenCredentialsValid() {
        TobeDbHealthService svc = serviceForSite(Map.of("test", cfg(postgres.getPassword())));
        Map<String, TobeDbHealthService.EnvHealth> h = svc.health("s1");

        TobeDbHealthService.EnvHealth test = h.get("test");
        assertTrue(test.configured(), "test env 은 설정 완료");
        assertTrue(test.reachable(), "유효 자격증명 → 도달 가능: " + test.message());
        // 설정 안 한 환경은 configured=false, probe 없이 즉시.
        assertFalse(h.get("dev").configured());
    }

    @Test
    void unreachableWhenPasswordWrong() {
        TobeDbHealthService svc = serviceForSite(Map.of("test", cfg("definitely-wrong-password")));
        Map<String, TobeDbHealthService.EnvHealth> h = svc.health("s1");

        TobeDbHealthService.EnvHealth test = h.get("test");
        assertTrue(test.configured(), "설정은 됐지만");
        assertFalse(test.reachable(), "잘못된 비밀번호 → 도달 불가");
        assertNotNull(test.message(), "실패 사유 메시지");
    }
}
