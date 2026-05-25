package com.ksinfo.modernize_pro_data.coordinator.auth;

import com.ksinfo.modernize_pro_data.common.exception.ApiException;
import com.ksinfo.modernize_pro_data.common.util.HashUtil;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.OffsetDateTime;
import java.util.Optional;

/**
 * API credential の登録・失効・認証.
 *
 * 外部スケジューラが発行した token を本ツールが登録するのみ (generate ではなく register).
 * 案 A (single solution-wide token) 採用、通常 name='default' の単一 active row を運用.
 * 新 token 登録時、既存 default は自動 revoke (rotate 動作).
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class CredentialService {

    public static final String DEFAULT_CREDENTIAL_NAME = "default";
    /** 登録可能な token の最小長. 4 prefix + 8 hidden + 4 last4 = 16 chars. */
    private static final int MIN_TOKEN_LENGTH = 16;

    private final ApiCredentialRepository repo;

    /**
     * 外部スケジューラから受け取った平文 token を登録.
     * 既存 default があれば自動 revoke (rotate).
     */
    @Transactional
    public ApiCredential registerDefault(String plainToken, String registeredBy) {
        if (plainToken == null || plainToken.isBlank()) {
            throw new ApiException("INVALID_TOKEN", "token must not be blank", HttpStatus.BAD_REQUEST);
        }
        if (plainToken.length() < MIN_TOKEN_LENGTH) {
            throw new ApiException("TOKEN_TOO_SHORT",
                    "token must be at least " + MIN_TOKEN_LENGTH + " characters (got " + plainToken.length() + ")",
                    HttpStatus.BAD_REQUEST);
        }

        // 既存 default を全 revoke
        repo.findByRevokedAtIsNullOrderByGeneratedAtDesc().stream()
                .filter(c -> DEFAULT_CREDENTIAL_NAME.equals(c.getName()))
                .forEach(c -> {
                    c.setRevokedAt(OffsetDateTime.now());
                    repo.save(c);
                    log.info("Revoked existing credential id={} on rotate", c.getId());
                });

        String hash = HashUtil.sha256Hex(plainToken);
        String displayPrefix = plainToken.substring(0, 4);
        String displayLast4 = plainToken.substring(plainToken.length() - 4);
        // ⚠ PoC 要件で plain も保管 (security 妥協).
        ApiCredential c = ApiCredential.create(
                DEFAULT_CREDENTIAL_NAME,
                hash,
                plainToken,
                displayPrefix,
                displayLast4,
                ScopeType.all,
                registeredBy);
        repo.save(c);
        log.info("Registered new default credential id={} masked={}",
                c.getId(), c.maskedDisplay());
        return c;
    }

    /** UI 가 表示用 masked display を取得するための lookup. */
    public Optional<ApiCredential> getCurrentDefault() {
        return repo.findByRevokedAtIsNullOrderByGeneratedAtDesc().stream()
                .filter(c -> DEFAULT_CREDENTIAL_NAME.equals(c.getName()))
                .findFirst();
    }

    /**
     * 인증 hot path — REST 認証フィルタから呼ばれる.
     * 入力 plain token を hash 化 → active credential を lookup → last_used_at 更新.
     */
    @Transactional
    public Optional<ApiCredential> authenticate(String plainToken) {
        if (plainToken == null || plainToken.isBlank()) {
            return Optional.empty();
        }
        String hash = HashUtil.sha256Hex(plainToken);
        Optional<ApiCredential> credOpt = repo.findByTokenHashAndRevokedAtIsNull(hash);
        credOpt.ifPresent(c -> {
            c.setLastUsedAt(OffsetDateTime.now());
            repo.save(c);
        });
        return credOpt;
    }

    /** 명시적 revoke — UI から個別 credential を失効. */
    @Transactional
    public ApiCredential revoke(String credentialId) {
        ApiCredential c = repo.findById(credentialId)
                .orElseThrow(() -> new IllegalArgumentException("credential not found: " + credentialId));
        if (c.getRevokedAt() == null) {
            c.setRevokedAt(OffsetDateTime.now());
            repo.save(c);
        }
        return c;
    }
}
