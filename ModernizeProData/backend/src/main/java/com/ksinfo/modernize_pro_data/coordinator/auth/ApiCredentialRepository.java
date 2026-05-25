package com.ksinfo.modernize_pro_data.coordinator.auth;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;

public interface ApiCredentialRepository extends JpaRepository<ApiCredential, String> {

    /** Token 認証 hot path — hash で active credential 1 件 lookup. */
    Optional<ApiCredential> findByTokenHashAndRevokedAtIsNull(String tokenHash);

    /** UI 一覧用 — 失効済 含めて新しい順. */
    List<ApiCredential> findAllByOrderByGeneratedAtDesc();

    /** Active credential のみ (一覧 UI で active filter 用). */
    List<ApiCredential> findByRevokedAtIsNullOrderByGeneratedAtDesc();
}
