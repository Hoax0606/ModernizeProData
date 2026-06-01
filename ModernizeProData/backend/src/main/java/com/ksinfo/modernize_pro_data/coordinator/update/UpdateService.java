package com.ksinfo.modernize_pro_data.coordinator.update;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.json.JsonMapper;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
import jakarta.annotation.PostConstruct;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.time.Duration;
import java.time.OffsetDateTime;
import java.util.HexFormat;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * 자동 업데이트 서비스 — manifest URL fetch + version 비교.
 *
 * <p>현 단계 (Step 1) = read-only: manifest 받아 latest version 만 확인.
 * 다운로드 / 검증 / 적용은 Step 4~5 에서 추가.
 *
 * <p>모든 동작 silent fail — 사이트 PC 의 outbound 차단 환경에서 정상.
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class UpdateService {

    /** GitHub release 의 latest redirect — 항상 가장 최근 release 의 manifest.json. */
    @Value("${modernize.update.manifest-url:https://github.com/Hoax0606/ModernizeProData/releases/latest/download/manifest.json}")
    private String manifestUrl;

    @Value("${modernize.update.enabled:true}")
    private boolean enabled;

    /** Staging dir 의 base. apply 가 여기에 새 jar / host 풀어 둠. Launcher 가 다음
     *  부팅 시 detect → swap. */
    @Value("${modernize.update.staging-dir:#{systemEnvironment['LOCALAPPDATA'] ?: systemProperties['user.home']}}")
    private String stagingDirBase;

    private final UpdateSignatureVerifier verifier;

    private HttpClient httpClient;
    private ObjectMapper mapper;

    /** in-memory cache of last check result. 재기동 시 초기화 — 한 번 더 check 호출 trigger. */
    private volatile UpdateManifest lastManifest;
    private volatile OffsetDateTime lastCheckAt;
    private volatile String lastCheckStatus = "not-yet";
    private volatile String lastCheckError;

    @PostConstruct
    void init() {
        httpClient = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(5))
                .followRedirects(HttpClient.Redirect.NORMAL)
                .build();
        mapper = JsonMapper.builder()
                .addModule(new JavaTimeModule())
                .build();
    }

    /** 현재 jar 의 Implementation-Version. dev 빌드면 null. */
    public String currentVersion() {
        Package pkg = UpdateService.class.getPackage();
        String v = pkg == null ? null : pkg.getImplementationVersion();
        return v;
    }

    /** 현재 상태 — 마지막 check 결과 기반. */
    public UpdateStatus status() {
        String current = currentVersion();
        String latest = lastManifest == null ? null : lastManifest.getVersion();
        boolean available = current != null && latest != null && compareVersions(latest, current) > 0;
        return UpdateStatus.builder()
                .currentVersion(current)
                .latestVersion(latest)
                .lastCheckAt(lastCheckAt)
                .lastCheckStatus(lastCheckStatus)
                .lastCheckError(lastCheckError)
                .updateAvailable(available)
                .releaseNotes(available && lastManifest != null ? lastManifest.getReleaseNotes() : null)
                .build();
    }

    /** Manifest URL 에서 latest manifest 받아 cache. silent fail. */
    public UpdateStatus check() {
        lastCheckAt = OffsetDateTime.now();
        if (!enabled) {
            lastCheckStatus = "failed";
            lastCheckError = "update check disabled (modernize.update.enabled=false)";
            return status();
        }
        try {
            HttpRequest req = HttpRequest.newBuilder()
                    .uri(URI.create(manifestUrl))
                    .timeout(Duration.ofSeconds(10))
                    .header("Accept", "application/json")
                    .GET()
                    .build();
            HttpResponse<String> resp = httpClient.send(req, HttpResponse.BodyHandlers.ofString());
            if (resp.statusCode() / 100 != 2) {
                lastCheckStatus = "failed";
                lastCheckError = "HTTP " + resp.statusCode();
                log.debug("Update check failed: {} {}", resp.statusCode(), manifestUrl);
                return status();
            }
            UpdateManifest m = mapper.readValue(resp.body(), UpdateManifest.class);
            lastManifest = m;
            lastCheckStatus = "success";
            lastCheckError = null;
            log.info("Update check OK — latest version: {}", m.getVersion());
        } catch (Exception e) {
            lastCheckStatus = "failed";
            lastCheckError = e.getMessage();
            // 사이트 PC = outbound 차단 — DEBUG 만. WARN 으로 매번 알리면 noise.
            log.debug("Update check exception: {}", e.toString());
        }
        return status();
    }

    /**
     * Delta zip 다운로드 + sha256 + 서명 검증 + staging dir 풀기.
     *
     * <p>실 swap 은 Launcher 가 다음 부팅 시 처리 — 이 메서드는 staging 까지만.
     * Marker file {@code pending-version.txt} 을 같이 떨어뜨려 Launcher 가 detect.
     *
     * @return 결과 메시지 (사용자에게 표시).
     */
    public ApplyResult applyLatest() {
        UpdateManifest m = lastManifest;
        if (m == null) return ApplyResult.fail("No manifest cached — run check first.");
        UpdateManifest.Asset delta = m.getAssets() == null ? null : m.getAssets().get("delta");
        if (delta == null || delta.getUrl() == null) {
            return ApplyResult.fail("Manifest has no delta asset.");
        }
        String current = currentVersion();
        if (current != null && compareVersions(m.getVersion(), current) <= 0) {
            return ApplyResult.fail("Already up to date.");
        }
        try {
            // 1. download
            HttpRequest req = HttpRequest.newBuilder()
                    .uri(URI.create(delta.getUrl()))
                    .timeout(Duration.ofMinutes(5))
                    .GET().build();
            HttpResponse<byte[]> resp = httpClient.send(req, HttpResponse.BodyHandlers.ofByteArray());
            if (resp.statusCode() / 100 != 2) {
                return ApplyResult.fail("Download failed: HTTP " + resp.statusCode());
            }
            byte[] zip = resp.body();

            // 2. sha256
            String actualSha = sha256Hex(zip);
            if (delta.getSha256() != null && !delta.getSha256().equalsIgnoreCase(actualSha)) {
                return ApplyResult.fail("SHA-256 mismatch — refusing.");
            }

            // 3. signature verify
            if (!verifier.verify(zip, delta.getSignature())) {
                return ApplyResult.fail("Signature verify failed — refusing.");
            }

            // 4. extract to staging
            Path stagingRoot = resolveStagingRoot();
            Path nextDir = stagingRoot.resolve("update-staging").resolve("next-" + m.getVersion());
            if (Files.exists(nextDir)) deleteRecursive(nextDir);
            Files.createDirectories(nextDir);
            unzip(zip, nextDir);

            // 5. marker for Launcher
            Path pending = stagingRoot.resolve("update-staging").resolve("pending-version.txt");
            Files.writeString(pending, m.getVersion());

            log.info("Update staged at {} — restart required (launcher will swap on next boot)", nextDir);
            return ApplyResult.ok("Update " + m.getVersion() + " staged. Restart the application to finish.");
        } catch (Exception e) {
            log.warn("Update apply failed: {}", e.toString());
            return ApplyResult.fail("Apply failed: " + e.getMessage());
        }
    }

    private Path resolveStagingRoot() {
        // %LOCALAPPDATA%\ModernizeProData (인스톨 root 와 동일 위치). Launcher 가 같은 root 기준 swap.
        return Path.of(stagingDirBase, "ModernizeProData");
    }

    private static String sha256Hex(byte[] data) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        return HexFormat.of().formatHex(md.digest(data));
    }

    private static void unzip(byte[] zip, Path target) throws IOException {
        try (ZipInputStream zis = new ZipInputStream(new java.io.ByteArrayInputStream(zip))) {
            ZipEntry e;
            while ((e = zis.getNextEntry()) != null) {
                Path out = target.resolve(e.getName()).normalize();
                if (!out.startsWith(target)) throw new IOException("Zip slip blocked: " + e.getName());
                if (e.isDirectory()) {
                    Files.createDirectories(out);
                } else {
                    Files.createDirectories(out.getParent());
                    Files.copy(zis, out, StandardCopyOption.REPLACE_EXISTING);
                }
                zis.closeEntry();
            }
        }
    }

    private static void deleteRecursive(Path p) throws IOException {
        if (!Files.exists(p)) return;
        try (var s = Files.walk(p)) {
            s.sorted((a, b) -> b.getNameCount() - a.getNameCount()).forEach(x -> {
                try { Files.deleteIfExists(x); } catch (IOException ignored) {}
            });
        }
    }

    /**
     * Semver 비교. {@code a} 가 {@code b} 보다 크면 양수, 작으면 음수, 같으면 0.
     * leading 'v' 허용. SNAPSHOT 등 suffix 무시 (numeric 부분만 비교).
     */
    static int compareVersions(String a, String b) {
        if (a == null || b == null) return 0;
        int[] sa = parse(a);
        int[] sb = parse(b);
        int n = Math.max(sa.length, sb.length);
        for (int i = 0; i < n; i++) {
            int ai = i < sa.length ? sa[i] : 0;
            int bi = i < sb.length ? sb[i] : 0;
            if (ai != bi) return Integer.compare(ai, bi);
        }
        return 0;
    }

    private static int[] parse(String v) {
        String s = v.startsWith("v") || v.startsWith("V") ? v.substring(1) : v;
        // strip suffix like -SNAPSHOT, -rc1
        int dash = s.indexOf('-');
        if (dash >= 0) s = s.substring(0, dash);
        String[] parts = s.split("\\.");
        int[] out = new int[parts.length];
        for (int i = 0; i < parts.length; i++) {
            try { out[i] = Integer.parseInt(parts[i]); }
            catch (NumberFormatException e) { out[i] = 0; }
        }
        return out;
    }
}
