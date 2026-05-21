package com.ksinfo.modernize_pro_data.coordinator.user;

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

import java.time.OffsetDateTime;
import java.util.UUID;

/**
 * 사용자 계정 엔티티.
 * 비밀번호는 BCrypt 해시로만 저장 (passwordHash). 평문 비번은 절대 보관 X.
 */
@Entity
@Table(name = "users")
@Getter @Setter
@NoArgsConstructor
@AllArgsConstructor
public class User {

    @Id
    @Column(length = 40)
    private String id;

    @Column(nullable = false, unique = true, length = 64)
    private String username;

    @Column(name = "password_hash", nullable = false, length = 255)
    private String passwordHash;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 16)
    private UserRole role;

    @Column(name = "created_at", nullable = false)
    private OffsetDateTime createdAt;

    @Column(name = "last_signin_at")
    private OffsetDateTime lastSignInAt;

    /** 동시 접속 차단 (first-wins) — JWT 의 sid claim 과 비교할 현재 활성 세션 식별자. */
    @Column(name = "current_session_id", length = 40)
    private String currentSessionId;

    @Column(name = "current_session_issued_at")
    private OffsetDateTime currentSessionIssuedAt;

    @Column(name = "current_session_expires_at")
    private OffsetDateTime currentSessionExpiresAt;

    /** 새 사용자 생성용 팩토리 — id 자동 부여, createdAt = now. */
    public static User create(String username, String passwordHash, UserRole role) {
        User u = new User();
        u.id = "u-" + UUID.randomUUID().toString().substring(0, 8);
        u.username = username;
        u.passwordHash = passwordHash;
        u.role = role;
        u.createdAt = OffsetDateTime.now();
        return u;
    }
}
