package com.ksinfo.modernize_pro_data.coordinator.license;

import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Instant;
import java.util.Arrays;

/**
 * Sealed last-seen file — 시계 조작 (clock rollback) 탐지.
 *
 * <p>운영팀이 OS 시계를 과거로 돌려 만료를 우회하는 것을 막기 위해, 라이선스 활성
 * 상태가 확인될 때마다 AES-GCM 으로 sealed file 을 갱신한다. 다음 기동/요청 시
 * {@link #checkClockSanity(String)} 가 system clock < lastSeen 이면 변조로 간주.
 *
 * <p>키 유도: SHA-256(publicKeyFp + hardcoded-salt) — 도구 소스를 가진 사람은
 * 우회 가능하지만, 의도는 "절도 방지" 가 아니라 "운영자의 시계 조작 탐지". GCM 의
 * authentication tag 가 파일 변조도 같이 잡아준다.
 */
@Slf4j
@Component
public class LicenseSealedClock {

    private static final byte[] KDF_SALT = "modernize-pro-data:license-seal:v1".getBytes(StandardCharsets.UTF_8);
    private static final int NONCE_LEN = 12;
    private static final int TAG_BITS = 128;

    private final Path sealedFile;
    private final ObjectMapper mapper = new ObjectMapper();
    private final SecureRandom random = new SecureRandom();

    public LicenseSealedClock(
            @Value("${modernize.license.sealed-file:${user.home}/.ksinfo-modernize/license-seen.bin}") String location
    ) {
        this.sealedFile = Paths.get(location);
    }

    public record SealedPayload(String licenseId, long lastSeenEpochMs) {}

    /**
     * 현재 시계가 저장된 last-seen 보다 너무 과거인지 검사.
     * 시계 클럭 동기화 오차를 감안해 5분 (300_000 ms) tolerance.
     *
     * @return true 면 정상 / false 면 clock rollback 의심 (= LicenseStatus.INVALID 처리)
     */
    public boolean checkClockSanity(String publicKeyFp) {
        SealedPayload sealed = read(publicKeyFp);
        if (sealed == null) return true; // sealed 파일 없거나 변조 — 첫 기동 가능성도 있어 통과 시킴
        long now = Instant.now().toEpochMilli();
        long tolerance = 5L * 60L * 1000L;
        if (now + tolerance < sealed.lastSeenEpochMs()) {
            log.warn("Clock rollback detected: now={} sealed.lastSeen={} delta={}ms",
                    now, sealed.lastSeenEpochMs(), sealed.lastSeenEpochMs() - now);
            return false;
        }
        return true;
    }

    /** 활성 라이선스 확인 시점마다 호출 — last-seen 을 현재 시각으로 갱신. */
    public void touch(String licenseId, String publicKeyFp) {
        SealedPayload payload = new SealedPayload(licenseId, Instant.now().toEpochMilli());
        write(payload, publicKeyFp);
    }

    public SealedPayload read(String publicKeyFp) {
        if (!Files.exists(sealedFile)) return null;
        try {
            byte[] raw = Files.readAllBytes(sealedFile);
            if (raw.length < NONCE_LEN + 16) {
                log.warn("Sealed last-seen file too short");
                return null;
            }
            byte[] nonce = Arrays.copyOfRange(raw, 0, NONCE_LEN);
            byte[] cipher = Arrays.copyOfRange(raw, NONCE_LEN, raw.length);
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, deriveKey(publicKeyFp), new GCMParameterSpec(TAG_BITS, nonce));
            byte[] plain = c.doFinal(cipher);
            return mapper.readValue(plain, SealedPayload.class);
        } catch (Exception e) {
            log.warn("Sealed last-seen file unreadable (tampered or different key): {}", e.getMessage());
            return null;
        }
    }

    private void write(SealedPayload payload, String publicKeyFp) {
        try {
            Files.createDirectories(sealedFile.getParent());
            byte[] plain = mapper.writeValueAsBytes(payload);
            byte[] nonce = new byte[NONCE_LEN];
            random.nextBytes(nonce);
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.ENCRYPT_MODE, deriveKey(publicKeyFp), new GCMParameterSpec(TAG_BITS, nonce));
            byte[] cipher = c.doFinal(plain);
            byte[] out = new byte[nonce.length + cipher.length];
            System.arraycopy(nonce, 0, out, 0, nonce.length);
            System.arraycopy(cipher, 0, out, nonce.length, cipher.length);
            Path tmp = sealedFile.resolveSibling(sealedFile.getFileName() + ".tmp");
            Files.write(tmp, out);
            Files.move(tmp, sealedFile, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } catch (IOException ioe) {
            log.warn("Sealed last-seen write IO failed: {}", ioe.getMessage());
        } catch (Exception e) {
            log.warn("Sealed last-seen write failed: {}", e.getMessage());
        }
    }

    private SecretKeySpec deriveKey(String publicKeyFp) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        md.update(KDF_SALT);
        md.update((publicKeyFp == null ? "" : publicKeyFp).getBytes(StandardCharsets.UTF_8));
        byte[] digest = md.digest();
        return new SecretKeySpec(digest, 0, 32, "AES");
    }
}
