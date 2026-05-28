package com.ksinfo.modernize_pro_data.coordinator.license;

import com.fasterxml.jackson.annotation.JsonInclude;

import java.time.LocalDate;
import java.util.List;

/**
 * .lic 파일 안의 payload + 서명. JSON {payload, signature, alg}.
 * IssuerCli 가 발급하고 LicenseVerifier 가 검증한다.
 *
 * <p>Payload version:
 * <ul>
 *   <li>v=1 — original. hardwareId field absent.</li>
 *   <li>v=2 — adds {@code hardwareId} so the license is pinned to one PC.
 *       Empty/null hardwareId in a v=2 doc means the issuer chose not to
 *       bind. {@link com.fasterxml.jackson.annotation.JsonInclude.Include#NON_NULL}
 *       keeps v=1-format JSON byte-identical when hardwareId is null so
 *       Ed25519 signatures over older licenses still verify.</li>
 * </ul>
 */
public record LicenseDocument(
        Payload payload,
        String signature,   // base64
        String alg          // 항상 "Ed25519"
) {
    @JsonInclude(JsonInclude.Include.NON_NULL)
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
            String publicKeyFp,
            String hardwareId
    ) {}
}
