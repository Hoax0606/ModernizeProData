package com.ksinfo.license.issuer;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;

import java.nio.file.Files;
import java.nio.file.Path;
import java.security.PrivateKey;
import java.security.Signature;
import java.time.LocalDate;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Payload 를 Ed25519 로 서명하여 .lic 파일로 출력.
 * GUI / CLI 양쪽에서 공통 호출.
 */
public final class LicenseSigner {

    private static final ObjectMapper MAPPER = new ObjectMapper()
            .registerModule(new JavaTimeModule())
            .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS);

    public record Input(
            String licenseId,
            String customer,
            String siteId,
            LocalDate expiresAt,
            int graceDays,
            /** Optional. When non-null/non-blank the issuer emits a v=2 license
             *  bound to this hardware id; null/blank yields a v=1 license that
             *  any PC can import (backward compat for the existing fleet). */
            String hardwareId
    ) {}

    private static final String FIXED_EDITION = "standard";
    private static final List<String> NO_FEATURES = List.of();

    /** Input 받아 서명 + JSON 직렬화 → 파일 저장. 결과 LicenseDocument 반환. */
    public static LicenseDocument signToFile(Input in, Path outFile) throws Exception {
        PrivateKey priv = KeyManager.loadPrivate();
        byte[] pubDer = KeyManager.loadPublicDer();
        String fp = KeyManager.fingerprint(pubDer);

        // backend Verifier 가 Jackson tree 로 payload 를 다시 직렬화하므로,
        // 여기서도 동일한 LinkedHashMap 순서로 작성해야 서명이 일치.
        String hw = in.hardwareId() == null ? null : in.hardwareId().trim();
        if (hw != null && hw.isEmpty()) hw = null;
        int version = (hw != null) ? 2 : 1;

        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("v", version);
        payload.put("licenseId", in.licenseId());
        payload.put("customer", in.customer());
        payload.put("siteId", in.siteId());
        payload.put("edition", FIXED_EDITION);
        payload.put("features", NO_FEATURES);
        payload.put("issuedAt", LocalDate.now().toString());
        payload.put("expiresAt", in.expiresAt().toString());
        payload.put("graceDays", in.graceDays());
        payload.put("publicKeyFp", fp);
        if (hw != null) {
            payload.put("hardwareId", hw);
        }

        byte[] payloadBytes = MAPPER.writeValueAsBytes(payload);
        Signature sig = Signature.getInstance("Ed25519");
        sig.initSign(priv);
        sig.update(payloadBytes);
        String signature = Base64.getEncoder().encodeToString(sig.sign());

        Map<String, Object> lic = new LinkedHashMap<>();
        lic.put("alg", "Ed25519");
        lic.put("payload", payload);
        lic.put("signature", signature);

        Files.createDirectories(outFile.toAbsolutePath().getParent());
        MAPPER.copy().enable(SerializationFeature.INDENT_OUTPUT).writeValue(outFile.toFile(), lic);

        return new LicenseDocument(
                new LicenseDocument.Payload(
                        version, in.licenseId(), in.customer(), in.siteId(), FIXED_EDITION,
                        NO_FEATURES, LocalDate.now(), in.expiresAt(), in.graceDays(), fp, hw
                ),
                signature,
                "Ed25519"
        );
    }

    public static String defaultLicenseId(String customer) {
        String slug = customer.toLowerCase().replaceAll("[^a-z0-9]+", "-").replaceAll("(^-|-$)", "");
        return "MPD-" + LocalDate.now() + "-" + slug;
    }

    private LicenseSigner() {}
}
