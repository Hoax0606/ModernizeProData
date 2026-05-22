package com.ksinfo.modernize_pro_data.coordinator.license;

import java.time.LocalDate;
import java.util.List;

/**
 * .lic 파일 안의 payload + 서명. JSON {payload, signature, alg}.
 * IssuerCli 가 발급하고 LicenseVerifier 가 검증한다.
 */
public record LicenseDocument(
        Payload payload,
        String signature,   // base64
        String alg          // 항상 "Ed25519"
) {
    public record Payload(
            int v,
            String licenseId,
            String customer,
            String siteId,
            String edition,
            List<String> features,
            LocalDate issuedAt,
            LocalDate expiresAt,
            int graceDays,
            String publicKeyFp
    ) {}
}
