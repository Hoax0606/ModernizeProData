package com.ksinfo.modernize_pro_data.coordinator.site;

import com.ksinfo.modernize_pro_data.common.exception.ApiException;
import com.ksinfo.modernize_pro_data.coordinator.load.TobeJdbcConnect;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

import java.sql.Connection;
import java.sql.DriverManager;
import java.time.OffsetDateTime;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * TO-BE DB 의 환경별(env) 실시간 도달성(reachability) 체크.
 *
 * <p>기존 {@code TobeDbController.tryConnect} 는 사용자가 버튼을 눌렀을 때만 1회 테스트하고,
 * {@code CheckStage.pingTobeDb} 는 run 시작 시 1회만 확인한다. 그래서 run 도중 TO-BE DB 가
 * 내려가도(Docker/PG down) UI 에는 반영되지 않고, 그 시점 load 실패로만 드러났다.
 *
 * <p>본 서비스는 FE 가 주기적으로 polling 하는 {@code GET /sites/{id}/tobe-db/health} 의
 * 백엔드. site 의 {@code tobeDbByEnv} 에 설정된 각 환경을 실제로 JDBC 연결 시도해 도달성을
 * 돌려준다. 다만:
 * <ul>
 *   <li><b>서버측 캐시</b>({@link #CACHE_TTL_MS}) — 브라우저 여러 개가 동시에 polling 해도
 *       실제 probe 는 (site,env)당 TTL 마다 1회뿐 → TO-BE DB 를 두드리지 않는다.</li>
 *   <li><b>짧은 timeout</b>({@link #PROBE_TIMEOUT_SEC}) + 환경별 <b>병렬 probe</b> — 내려간
 *       환경이 있어도 응답이 길게 늘어지지 않게.</li>
 * </ul>
 *
 * <p>현재 PostgreSQL 만 실제 probe ({@code TobeDbController} 와 동일 제약). 그 외 타입은
 * configured=true, reachable=false, message 로 표시.
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class TobeDbHealthService {

    /** FE 의 ProjectEnvironment 와 동일 키 — 4 환경. */
    private static final List<String> ENVS = List.of("test", "dev", "staging", "production");

    /** probe 결과 캐시 수명. polling 여러 개여도 이 주기마다 1회만 실제 연결. */
    private static final long CACHE_TTL_MS = 5_000;
    /** 한 환경 probe 의 connect/login timeout. 내려간 환경에서 길게 매달리지 않게 짧게. */
    private static final int PROBE_TIMEOUT_SEC = 2;

    private final SiteRepository siteRepository;

    private final Map<String, Cached> cache = new ConcurrentHashMap<>();
    /** env 4개를 병렬 probe 하기 위한 작은 daemon 풀. */
    private final ExecutorService probePool = Executors.newFixedThreadPool(4, r -> {
        Thread t = new Thread(r, "tobe-health-probe");
        t.setDaemon(true);
        return t;
    });

    /** 한 환경의 도달성 결과. configured=설정 충분 여부, reachable=실제 연결 성공. */
    public record EnvHealth(
            String env,
            boolean configured,
            boolean reachable,
            String message,
            OffsetDateTime checkedAt
    ) {}

    private record Cached(EnvHealth health, long ts) {}

    /** 사이트의 전 환경 도달성. env → EnvHealth. */
    public Map<String, EnvHealth> health(String siteId) {
        Site site = siteRepository.findById(siteId)
                .orElseThrow(() -> new ApiException("SITE_NOT_FOUND",
                        "사이트를 찾을 수 없습니다", HttpStatus.NOT_FOUND));
        Map<String, Object> byEnv = site.getTobeDbByEnv();

        // 설정 안 된 환경은 probe 없이 즉시 (cheap). 설정된 환경만 (캐시 miss 시) 병렬 probe.
        Map<String, CompletableFuture<EnvHealth>> futures = new LinkedHashMap<>();
        for (String env : ENVS) {
            Map<String, Object> cfg = configFor(byEnv, env);
            if (!isConfigured(cfg)) {
                futures.put(env, CompletableFuture.completedFuture(
                        new EnvHealth(env, false, false, "not configured", null)));
                continue;
            }
            Cached c = cache.get(cacheKey(siteId, env));
            long now = System.currentTimeMillis();
            if (c != null && (now - c.ts()) < CACHE_TTL_MS) {
                futures.put(env, CompletableFuture.completedFuture(c.health()));
            } else {
                futures.put(env, CompletableFuture.supplyAsync(
                        () -> probeAndCache(siteId, env, cfg), probePool));
            }
        }

        Map<String, EnvHealth> out = new LinkedHashMap<>();
        for (Map.Entry<String, CompletableFuture<EnvHealth>> e : futures.entrySet()) {
            try {
                out.put(e.getKey(), e.getValue().join());
            } catch (Exception ex) {
                out.put(e.getKey(), new EnvHealth(e.getKey(), true, false,
                        "probe failed: " + ex.getMessage(), OffsetDateTime.now()));
            }
        }
        return out;
    }

    private EnvHealth probeAndCache(String siteId, String env, Map<String, Object> cfg) {
        EnvHealth h = probe(env, cfg);
        cache.put(cacheKey(siteId, env), new Cached(h, System.currentTimeMillis()));
        return h;
    }

    /** 실제 JDBC 연결 시도 (PostgreSQL / Oracle). CheckStage.pingTobeDb 와 동일 config 키·빌더. */
    private EnvHealth probe(String env, Map<String, Object> cfg) {
        OffsetDateTime now = OffsetDateTime.now();
        String dialect = TobeJdbcConnect.dialect(cfg);
        if (!TobeJdbcConnect.isSupported(dialect)) {
            return new EnvHealth(env, true, false,
                    "Unsupported TO-BE type: " + str(cfg.get("type")) + " (supported: PostgreSQL, Oracle)", now);
        }
        String url = TobeJdbcConnect.url(cfg);
        Properties props = TobeJdbcConnect.props(cfg, PROBE_TIMEOUT_SEC);
        try (Connection conn = DriverManager.getConnection(url, props)) {
            boolean valid = conn.isValid(PROBE_TIMEOUT_SEC);
            return new EnvHealth(env, true, valid,
                    valid ? "reachable" : "connected but isValid() false", now);
        } catch (Exception e) {
            return new EnvHealth(env, true, false, e.getMessage(), now);
        }
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> configFor(Map<String, Object> byEnv, String env) {
        if (byEnv == null) return null;
        Object cfg = byEnv.get(env);
        return cfg instanceof Map ? (Map<String, Object>) cfg : null;
    }

    /** TobeDbCard.isDbConfigured 와 동일 기준: type/host/database/username 필수. */
    private static boolean isConfigured(Map<String, Object> cfg) {
        if (cfg == null) return false;
        return notBlank(cfg.get("type")) && notBlank(cfg.get("host"))
                && notBlank(cfg.get("database")) && notBlank(cfg.get("username"));
    }

    private static boolean notBlank(Object o) {
        return o != null && !o.toString().isBlank();
    }

    private static String str(Object o) {
        return o == null ? null : o.toString();
    }

    private static String cacheKey(String siteId, String env) {
        return siteId + "|" + env;
    }
}
