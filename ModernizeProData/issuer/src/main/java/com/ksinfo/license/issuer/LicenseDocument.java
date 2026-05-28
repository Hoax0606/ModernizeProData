package com.ksinfo.license.issuer;

import com.fasterxml.jackson.annotation.JsonInclude;

import java.time.LocalDate;
import java.util.List;

/**
 * .lic 파일 안의 payload + 서명. backend 의 LicenseDocument 와 동일 포맷.
 *
 * <p>의도적 복제 — backend 와 issuer 사이의 contract 는 JSON 자체. record 클래스를 공유
 * 모듈로 분리하지 않은 이유: PoC 단계에서 30줄 복제가 1개 모듈 추가보다 단순.
 *
 * <p>v2 추가: {@code hardwareId} 가 채워져 있으면 해당 PC 에서만 사용 가능.
 * null 이면 v1 처럼 동작 (machine 무관). NON_NULL 직렬화로 byte 호환 유지.
 */
public record LicenseDocument(
        Payload payload,
        String signature,
        String alg
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
