package com.ksinfo.modernize_pro_data.coordinator.update;

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
import java.util.Base64;

/**
 * Update delta zip 의 RSA-2048 SHA-256 서명 검증.
 *
 * <p>본사 master 가 {@code installer/release.ps1} 안에서
 * {@code openssl dgst -sha256 -sign} 으로 만든 서명을 Base64 인코딩해 manifest 의
 * {@code assets.delta.signature} 에 박는다. 도구는 그 서명을 디코딩 + 동봉된 public
 * key 로 검증.
 *
 * <p>public key 는 {@code resources/license/mpd-update-public.pem} 에 임베드 (.gitignore
 * 예외 처리됨). 빌드 시 jar 의 classpath 에 들어감.
 */
@Slf4j
@Component
public class UpdateSignatureVerifier {

    private final PublicKey publicKey;

    public UpdateSignatureVerifier(
            @Value("${modernize.update.public-key:classpath:license/mpd-update-public.pem}") String publicKeyLocation) {
        this.publicKey = loadPublicKey(publicKeyLocation);
    }

    /**
     * Zip file 바이트와 Base64 서명 → SHA256withRSA verify. true = 신뢰. false = 위조 또는 키 부재.
     */
    public boolean verify(byte[] zipBytes, String signatureBase64) {
        if (publicKey == null) {
            log.warn("Update public key not loaded — refusing all updates");
            return false;
        }
        if (signatureBase64 == null || signatureBase64.isBlank()) {
            log.warn("Update signature missing — refusing");
            return false;
        }
        try {
            byte[] sig = Base64.getDecoder().decode(signatureBase64);
            Signature s = Signature.getInstance("SHA256withRSA");
            s.initVerify(publicKey);
            s.update(zipBytes);
            return s.verify(sig);
        } catch (Exception e) {
            log.warn("Update signature verify failed: {}", e.getMessage());
            return false;
        }
    }

    private PublicKey loadPublicKey(String location) {
        try {
            String pem;
            if (location.startsWith("classpath:")) {
                String path = location.substring("classpath:".length());
                try (InputStream is = new ClassPathResource(path).getInputStream()) {
                    pem = new String(is.readAllBytes(), StandardCharsets.UTF_8);
                }
            } else {
                pem = java.nio.file.Files.readString(java.nio.file.Paths.get(location));
            }
            String b64 = pem.replaceAll("-----.*-----", "").replaceAll("\\s+", "");
            byte[] der = Base64.getDecoder().decode(b64);
            return KeyFactory.getInstance("RSA").generatePublic(new X509EncodedKeySpec(der));
        } catch (Exception e) {
            log.warn("Update public key not loadable from {} — verify will always fail. ({})",
                    location, e.getMessage());
            return null;
        }
    }
}
