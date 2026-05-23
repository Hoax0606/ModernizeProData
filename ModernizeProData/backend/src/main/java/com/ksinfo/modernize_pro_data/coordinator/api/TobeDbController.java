package com.ksinfo.modernize_pro_data.coordinator.api;

import com.ksinfo.modernize_pro_data.common.dto.ApiResponse;
import com.ksinfo.modernize_pro_data.common.exception.ApiException;
import com.ksinfo.modernize_pro_data.coordinator.site.SiteRepository;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.util.Properties;

/**
 * TO-BE DB 接続テスト.
 *
 * 現状 PostgreSQL のみ対応. 他の DB タイプは data/drivers/ 動的 ClassLoader
 * 経由でローダー Adapter SPI が解決する設計 (詳細は ONBOARDING §9).
 */
@Slf4j
@RestController
@RequiredArgsConstructor
public class TobeDbController {

    private static final int LOGIN_TIMEOUT_SEC = 5;
    private static final int CONNECT_TIMEOUT_SEC = 5;

    private final SiteRepository siteRepository;

    public record TestConnectionRequest(
            @NotBlank String dbType,
            @NotBlank String host,
            @NotBlank String port,
            @NotBlank String database,
            @NotBlank String username,
            String password
    ) {}

    public record TestConnectionResult(
            boolean success,
            String message,
            String sqlState
    ) {}

    @PostMapping("/api/v1/sites/{id}/tobe-db/test-connection")
    @PreAuthorize("hasAnyRole('MASTER','ADMIN')")
    public ApiResponse<TestConnectionResult> testConnection(
            @PathVariable String id,
            @Valid @RequestBody TestConnectionRequest req
    ) {
        if (!siteRepository.existsById(id)) {
            throw new ApiException("SITE_NOT_FOUND",
                    "사이트를 찾을 수 없습니다", HttpStatus.NOT_FOUND);
        }
        return ApiResponse.ok(tryConnect(req, "site=" + id));
    }

    /**
     * 사이트 생성 흐름 (CreateSiteModal) 에서도 같은 검증이 필요해서 site id 없이 받는 endpoint.
     * 실제 DB 연결 시도 로직은 위와 동일.
     */
    @PostMapping("/api/v1/tobe-db/test-connection")
    @PreAuthorize("hasAnyRole('MASTER','ADMIN')")
    public ApiResponse<TestConnectionResult> testConnectionStandalone(
            @Valid @RequestBody TestConnectionRequest req
    ) {
        return ApiResponse.ok(tryConnect(req, "standalone"));
    }

    private TestConnectionResult tryConnect(TestConnectionRequest req, String ctx) {
        if (!"PostgreSQL".equalsIgnoreCase(req.dbType())) {
            return new TestConnectionResult(
                    false,
                    "Only PostgreSQL is supported for now (dbType=" + req.dbType() + ")",
                    null);
        }

        String url = "jdbc:postgresql://" + req.host() + ":" + req.port() + "/" + req.database();
        Properties props = new Properties();
        props.setProperty("user", req.username());
        props.setProperty("password", req.password() == null ? "" : req.password());
        props.setProperty("connectTimeout", String.valueOf(CONNECT_TIMEOUT_SEC));
        props.setProperty("loginTimeout", String.valueOf(LOGIN_TIMEOUT_SEC));

        try (Connection conn = DriverManager.getConnection(url, props)) {
            boolean valid = conn.isValid(LOGIN_TIMEOUT_SEC);
            log.info("TO-BE DB test connection OK: {}, host={}:{}, db={}, user={}",
                    ctx, req.host(), req.port(), req.database(), req.username());
            return new TestConnectionResult(
                    valid, valid ? "Connected" : "Connection opened but isValid() returned false", null);
        } catch (SQLException e) {
            log.warn("TO-BE DB test connection failed: {}, host={}:{}, db={}, user={}, sqlState={}, msg={}",
                    ctx, req.host(), req.port(), req.database(), req.username(),
                    e.getSQLState(), e.getMessage());
            return new TestConnectionResult(false, e.getMessage(), e.getSQLState());
        }
    }
}
