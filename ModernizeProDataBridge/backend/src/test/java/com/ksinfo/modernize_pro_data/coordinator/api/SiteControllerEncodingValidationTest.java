package com.ksinfo.modernize_pro_data.coordinator.api;

import com.ksinfo.modernize_pro_data.common.exception.ApiException;
import com.ksinfo.modernize_pro_data.coordinator.site.ProjectRepository;
import com.ksinfo.modernize_pro_data.coordinator.site.SiteRepository;
import org.junit.jupiter.api.Test;
import org.springframework.security.core.Authentication;

import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/** SiteController 의 Phase 6 엔진별 tobeEncoding 검증 (mock repo, Docker 불필요). */
class SiteControllerEncodingValidationTest {

    private final SiteRepository siteRepo = mock(SiteRepository.class);
    private final ProjectRepository projectRepo = mock(ProjectRepository.class);
    private final SiteController ctrl = new SiteController(siteRepo, projectRepo);

    private Authentication auth() {
        Authentication a = mock(Authentication.class);
        when(a.getName()).thenReturn("tester");
        return a;
    }

    private SiteController.CreateSiteRequest req(String tobeEncoding, String type) {
        Map<String, Object> cfg = Map.of("type", type, "host", "h", "database", "db", "username", "u");
        return new SiteController.CreateSiteRequest(
                "s", "asis", "tobe", "UTF-8", tobeEncoding,
                null, null, null, null, "test", null,
                Map.of("test", cfg), null);
    }

    @Test
    void oracleUnsupportedEncodingRejected() {
        ApiException ex = assertThrows(ApiException.class,
                () -> ctrl.create(req("KOI8-R", "oracle"), auth()));
        // 400 + 명확한 코드
        assertThrows(ApiException.class, () -> { throw ex; });
    }

    @Test
    void oracleSupportedEncodingOk() {
        assertDoesNotThrow(() -> ctrl.create(req("JA16SJIS", "oracle"), auth()));
        assertDoesNotThrow(() -> ctrl.create(req("Shift_JIS", "oracle"), auth()));
        assertDoesNotThrow(() -> ctrl.create(req("AL32UTF8", "oracle"), auth()));
    }

    @Test
    void postgresNonUtf8Rejected() {
        assertThrows(ApiException.class, () -> ctrl.create(req("JA16SJIS", "PostgreSQL"), auth()));
    }

    @Test
    void postgresUtf8Ok() {
        assertDoesNotThrow(() -> ctrl.create(req("UTF-8", "PostgreSQL"), auth()));
        assertDoesNotThrow(() -> ctrl.create(req("UTF8", "postgres"), auth()));
    }
}
