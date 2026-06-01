package com.ksinfo.modernize_pro_data.launcher;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;

/**
 * Plain-Java update probe for the Worker JavaFX wizard. Spring 아직 시작 전이라
 * UpdateService bean 을 못 쓰니 manifest 만 HTTP GET 으로 직접 받아 version 비교.
 *
 * <p>Apply 자체는 본 Spring 의 UpdateService (auto-apply-on-start=true) 가 처리 —
 * 이 클래스는 사용자에게 "최신 / 업데이트 있음" 만 알리는 용도.
 */
public final class WorkerUpdateProbe {

    private WorkerUpdateProbe() {}

    public static final String DEFAULT_MANIFEST_URL =
            "https://github.com/Hoax0606/Data-Migration_Tool/releases/latest/download/manifest.json";

    /** check 결과. fail = available 정보 없음. */
    public static final class Result {
        public final boolean ok;
        public final String currentVersion;
        public final String latestVersion;
        public final boolean updateAvailable;
        public final String error;

        Result(boolean ok, String current, String latest, boolean avail, String error) {
            this.ok = ok;
            this.currentVersion = current;
            this.latestVersion = latest;
            this.updateAvailable = avail;
            this.error = error;
        }
    }

    /** Manifest URL fetch + version compare. silent fail (사이트 폐쇄망 정상). */
    public static Result probe() {
        return probe(DEFAULT_MANIFEST_URL);
    }

    public static Result probe(String manifestUrl) {
        String current = currentVersion();
        try {
            HttpClient c = HttpClient.newBuilder()
                    .connectTimeout(Duration.ofSeconds(5))
                    .followRedirects(HttpClient.Redirect.NORMAL)
                    .build();
            HttpRequest req = HttpRequest.newBuilder()
                    .uri(URI.create(manifestUrl))
                    .timeout(Duration.ofSeconds(10))
                    .header("Accept", "application/json")
                    .GET().build();
            HttpResponse<String> resp = c.send(req, HttpResponse.BodyHandlers.ofString());
            if (resp.statusCode() / 100 != 2) {
                return new Result(false, current, null, false, "HTTP " + resp.statusCode());
            }
            JsonNode root = new ObjectMapper().readTree(resp.body());
            String latest = root.path("version").asText(null);
            boolean avail = current != null && latest != null && compareVersions(latest, current) > 0;
            return new Result(true, current, latest, avail, null);
        } catch (Exception e) {
            return new Result(false, current, null, false, e.getMessage());
        }
    }

    private static String currentVersion() {
        Package pkg = WorkerUpdateProbe.class.getPackage();
        return pkg == null ? null : pkg.getImplementationVersion();
    }

    /** Same semver compare as UpdateService. */
    private static int compareVersions(String a, String b) {
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
