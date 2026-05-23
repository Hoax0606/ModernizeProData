package com.ksinfo.modernize_pro_data.coordinator.license;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.ClassPathResource;
import org.springframework.stereotype.Component;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.PublicKey;
import java.security.Signature;
import java.security.spec.X509EncodedKeySpec;
import java.time.LocalDate;
import java.time.temporal.ChronoUnit;
import java.util.Base64;

/**
 * .lic 파일을 읽어 Ed25519 서명 검증 + 만료 단계 계산.
 *
 * 공개키는 backend resources/license/public-key.pem 에 임베드. Issuer CLI 가 발급한
 * keypair 의 public 쪽을 빌드 시 복사해 둔다.
 */
@Slf4j
@Component
public class LicenseVerifier {

    private final PublicKey publicKey;
    private final ObjectMapper mapper = new ObjectMapper().findAndRegisterModules();

    public LicenseVerifier(@Value("${modernize.license.public-key:classpath:license/public.pem}") String publicKeyLocation) {
        this.publicKey = loadPublicKey(publicKeyLocation);
    }

    /** raw .lic 바이트 → 검증된 LicenseDocument. 서명 실패 시 null. */
    public LicenseDocument verify(byte[] licBytes) {
        try {
            ObjectNode root = (ObjectNode) mapper.readTree(licBytes);
            String alg = root.path("alg").asText();
            if (!"Ed25519".equals(alg)) {
                log.warn("License alg mismatch: {}", alg);
                return null;
            }
            byte[] signature = Base64.getDecoder().decode(root.path("signature").asText());
            byte[] payloadBytes = mapper.writeValueAsBytes(root.get("payload"));

            Signature sig = Signature.getInstance("Ed25519");
            sig.initVerify(publicKey);
            sig.update(payloadBytes);
            if (!sig.verify(signature)) {
                log.warn("License signature verification FAILED");
                return null;
            }
            return mapper.treeToValue(root, LicenseDocument.class);
        } catch (Exception e) {
            log.warn("License parse/verify failed: {}", e.getMessage());
            return null;
        }
    }

    /**
     * payload + now → 만료 단계 계산.
     * EXPIRING 임계는 60일 전부터.
     */
    public LicenseStatus statusOf(LicenseDocument.Payload payload, LocalDate today) {
        if (payload == null) return LicenseStatus.MISSING;
        LocalDate expires = payload.expiresAt();
        // ChronoUnit.DAYS.between → 총 일수 (Period.getDays 는 year/month 제외한 일 부분만)
        long daysUntilExpire = ChronoUnit.DAYS.between(today, expires);
        if (daysUntilExpire > 60) return LicenseStatus.ACTIVE;
        if (daysUntilExpire >= 0) return LicenseStatus.EXPIRING;
        // 만료 후
        long daysPastExpire = -daysUntilExpire;
        int grace = payload.graceDays();
        if (daysPastExpire <= grace) return LicenseStatus.IN_GRACE;
        if (daysPastExpire <= grace + 15) return LicenseStatus.READ_ONLY;
        return LicenseStatus.EXPIRED;
    }

    private PublicKey loadPublicKey(String location) {
        try {
            byte[] der;
            if (location.startsWith("classpath:")) {
                String path = location.substring("classpath:".length());
                try (InputStream is = new ClassPathResource(path).getInputStream()) {
                    String pem = new String(is.readAllBytes(), StandardCharsets.UTF_8);
                    String b64 = pem.replaceAll("-----.*-----", "").replaceAll("\\s+", "");
                    der = Base64.getDecoder().decode(b64);
                }
            } else {
                String pem = java.nio.file.Files.readString(java.nio.file.Paths.get(location));
                String b64 = pem.replaceAll("-----.*-----", "").replaceAll("\\s+", "");
                der = Base64.getDecoder().decode(b64);
            }
            return KeyFactory.getInstance("Ed25519").generatePublic(new X509EncodedKeySpec(der));
        } catch (Exception e) {
            log.warn("License public key not loadable from {} — license verification will fail until key is provided. ({})",
                    location, e.getMessage());
            return null;
        }
    }
}
