package com.ksinfo.modernize_pro_data.coordinator.auth;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import lombok.AllArgsConstructor;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

/**
 * 外部スケジューラ用 API token 의 credential.
 *
 * 案 A (ソリューション全体 1 token) 採用、통상 1 行 (name='default') 운용.
 * 案 C (per-credential) への将来 migration 을 위해 scope_* 列을 처음부터 보유.
 *
 * 平文 token 은 보관 X — token_hash (SHA-256) + display_prefix + display_last4 만.
 */
@Entity
@Table(name = "api_credentials")
@Getter @Setter
@NoArgsConstructor
@AllArgsConstructor
public class ApiCredential {

    @Id
    @Column(length = 40)
    private String id;

    @Column(nullable = false, length = 64)
    private String name;

    @Column(name = "token_hash", nullable = false, length = 64)
    private String tokenHash;

    /**
     * ⚠ 平文 token. PoC 要件 (別 session / 別 master でも plain 表示, コマンド例に埋め込み済み) で保管.
     * security 妥協, production deploy 前に客先 security review と整合性確認が必要.
     */
    @Column(name = "token_plain", length = 256)
    private String tokenPlain;

    @Column(name = "display_prefix", nullable = false, length = 8)
    private String displayPrefix;

    @Column(name = "display_last4", nullable = false, length = 4)
    private String displayLast4;

    @Enumerated(EnumType.STRING)
    @Column(name = "scope_type", nullable = false, length = 16)
    private ScopeType scopeType;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "scope_project_ids", columnDefinition = "jsonb")
    private List<String> scopeProjectIds;

    @Column(name = "generated_at", nullable = false)
    private OffsetDateTime generatedAt;

    @Column(name = "generated_by", nullable = false, length = 64)
    private String generatedBy;

    @Column(name = "last_used_at")
    private OffsetDateTime lastUsedAt;

    @Column(name = "revoked_at")
    private OffsetDateTime revokedAt;

    /**
     * 新 credential 登録. 平文 token は外部から発行され、caller (Service) が
     * hash 化 + prefix/last4 抽出した後に呼び出す.
     * ⚠ tokenPlain は PoC 要件で平文保管している (security 妥協).
     */
    public static ApiCredential create(String name,
                                       String tokenHash,
                                       String tokenPlain,
                                       String displayPrefix,
                                       String displayLast4,
                                       ScopeType scopeType,
                                       String generatedBy) {
        ApiCredential c = new ApiCredential();
        c.id = "cred-" + UUID.randomUUID().toString().substring(0, 8);
        c.name = name;
        c.tokenHash = tokenHash;
        c.tokenPlain = tokenPlain;
        c.displayPrefix = displayPrefix;
        c.displayLast4 = displayLast4;
        c.scopeType = scopeType;
        c.generatedAt = OffsetDateTime.now();
        c.generatedBy = generatedBy;
        return c;
    }

    /** UI 表示用 masked string. 예: "abcd••••••••wxyz" (prefix 4 + bullets 8 + last4 4). */
    public String maskedDisplay() {
        return displayPrefix + "••••••••" + displayLast4;
    }

    /** 失効済否 (revoked_at NULL 以外은 失効). */
    public boolean isRevoked() {
        return revokedAt != null;
    }
}
