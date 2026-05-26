package com.ksinfo.modernize_pro_data.coordinator.license;

import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.Locale;

/**
 * 현 PC 의 hardware fingerprint 를 한 번만 계산해서 캐싱.
 *
 * <p>Windows 에선 HKLM\Software\Microsoft\Cryptography\MachineGuid 를 reg.exe 로
 * 읽음 — OS 설치 시 한 번 생성되는 UUID 라 PC 별로 unique. Linux 는 /etc/machine-id
 * 를 동일 목적으로 사용. Mac 또는 다른 OS 는 unknown fallback ("unknown-host") 로
 * 떨어져 license 가 v2 이면 mismatch 처리됨 (PoC 단계는 Windows 만 지원).
 *
 * <p>리턴 형식은 raw machine-id 자체 (UUID 형식). 사용자가 그대로 issuer 에
 * 붙여넣어 발급받기 좋고, 길어야 36 chars 라 .lic 의 JSON payload 부담도 작음.
 */
@Slf4j
@Component
public class HardwareFingerprint {

    private volatile String cached;

    public String value() {
        if (cached != null) return cached;
        synchronized (this) {
            if (cached == null) cached = compute();
            return cached;
        }
    }

    private String compute() {
        String os = System.getProperty("os.name", "").toLowerCase(Locale.ROOT);
        String raw;
        if (os.contains("win")) {
            raw = readWindowsMachineGuid();
        } else if (os.contains("linux")) {
            raw = readLinuxMachineId();
        } else {
            raw = null;
        }
        if (raw == null || raw.isBlank()) {
            log.warn("Hardware fingerprint not available on this OS; falling back to unknown-host");
            return "unknown-host";
        }
        // Normalize: lowercase UUID with dashes.
        return raw.trim().toLowerCase(Locale.ROOT);
    }

    private String readWindowsMachineGuid() {
        try {
            Process p = new ProcessBuilder(
                    "reg", "query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography",
                    "/v", "MachineGuid"
            ).redirectErrorStream(true).start();
            try (BufferedReader r = new BufferedReader(new InputStreamReader(
                    p.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = r.readLine()) != null) {
                    String t = line.trim();
                    if (t.startsWith("MachineGuid") && t.contains("REG_SZ")) {
                        String[] parts = t.split("REG_SZ", 2);
                        if (parts.length == 2) return parts[1].trim();
                    }
                }
            }
            p.waitFor();
        } catch (Exception e) {
            log.warn("reg.exe probe failed: {}", e.getMessage());
        }
        return null;
    }

    private String readLinuxMachineId() {
        try {
            Path p = Path.of("/etc/machine-id");
            if (Files.exists(p)) return Files.readString(p).trim();
        } catch (Exception e) {
            log.warn("/etc/machine-id read failed: {}", e.getMessage());
        }
        return null;
    }

    /** SHA-256 of value, hex, first 16 chars — used for log lines / display when
     *  exposing the raw fingerprint is unnecessary. */
    public String shortDigest() {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] h = md.digest(value().getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder(16);
            for (int i = 0; i < 8; i++) sb.append(String.format("%02x", h[i]));
            return sb.toString();
        } catch (Exception e) {
            return "?";
        }
    }
}
