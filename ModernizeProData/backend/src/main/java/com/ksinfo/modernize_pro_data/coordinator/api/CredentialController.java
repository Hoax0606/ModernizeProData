package com.ksinfo.modernize_pro_data.coordinator.api;

import com.ksinfo.modernize_pro_data.common.dto.ApiResponse;
import com.ksinfo.modernize_pro_data.common.exception.ApiException;
import com.ksinfo.modernize_pro_data.coordinator.auth.ApiCredential;
import com.ksinfo.modernize_pro_data.coordinator.auth.CredentialService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

import java.time.OffsetDateTime;

/**
 * API credential 管理 — Scheduler ページの External integrations カードから呼ばれる.
 *
 * Token 発行方向が逆 — 外部スケジューラが発行した token を本ツールが登録するのみ.
 *   GET    /api/v1/credentials/current     ── 現 default の masked display 取得
 *   POST   /api/v1/credentials/register    ── 外部から受け取った token を登録 (既存は自動 revoke)
 *   POST   /api/v1/credentials/{id}/revoke ── 明示的 revoke
 *
 * 認証は user session, role check は master のみ register / revoke 可.
 *
 * <p>⚠ Security note (PoC): tokenPlain を HTTP response に返し frontend が
 * localStorage に保管. air-gap 現場のみ運用前提で受容. 本番投入前に
 * HttpOnly cookie へ移行すること.
 */
@Slf4j
@RestController
@RequiredArgsConstructor
public class CredentialController {

    private final CredentialService credentialService;

    /* ── DTOs ──────────────────────────────────────── */

    public record CurrentCredentialDto(
            String credentialId,
            String maskedDisplay,
            String tokenPlain,        // ⚠ PoC 要件で平文も返す (security 妥協)
            boolean active,
            OffsetDateTime generatedAt,
            OffsetDateTime lastUsedAt
    ) {}

    public record RegisterRequest(
            String plainToken
    ) {}

    public record RegisterResultDto(
            String credentialId,
            String maskedDisplay,
            String tokenPlain         // ⚠ 同上
    ) {}

    /* ── Endpoints ─────────────────────────────────── */

    /** 現 default credential の masked display + 平文. なければ active=false. */
    @GetMapping("/api/v1/credentials/current")
    @PreAuthorize("hasAnyRole('MASTER','ADMIN')")
    public ApiResponse<CurrentCredentialDto> getCurrent() {
        return credentialService.getCurrentDefault()
                .map(c -> ApiResponse.ok(new CurrentCredentialDto(
                        c.getId(),
                        c.maskedDisplay(),
                        c.getTokenPlain(),
                        true,
                        c.getGeneratedAt(),
                        c.getLastUsedAt())))
                .orElseGet(() -> ApiResponse.ok(
                        new CurrentCredentialDto(null, null, null, false, null, null)));
    }

    /**
     * 外部スケジューラが発行した token を登録.
     * 既存 default があれば自動 revoke. 平文はサーバに未保管 (hash + display のみ).
     */
    @PostMapping("/api/v1/credentials/register")
    @PreAuthorize("hasRole('MASTER')")
    public ApiResponse<RegisterResultDto> register(@RequestBody RegisterRequest req, Authentication auth) {
        ApiCredential c = credentialService.registerDefault(req.plainToken(), auth.getName());
        log.info("Master {} registered new credential id={}", auth.getName(), c.getId());
        return ApiResponse.ok(new RegisterResultDto(
                c.getId(),
                c.maskedDisplay(),
                c.getTokenPlain()));
    }

    /** 指定 credential を revoke. */
    @PostMapping("/api/v1/credentials/{id}/revoke")
    @PreAuthorize("hasRole('MASTER')")
    public ApiResponse<ApiCredential> revoke(@PathVariable String id, Authentication auth) {
        ApiCredential c;
        try {
            c = credentialService.revoke(id);
        } catch (IllegalArgumentException e) {
            throw new ApiException("CREDENTIAL_NOT_FOUND",
                    "credential not found: " + id, HttpStatus.NOT_FOUND);
        }
        log.info("Master {} revoked credential id={}", auth.getName(), id);
        return ApiResponse.ok(c);
    }
}
