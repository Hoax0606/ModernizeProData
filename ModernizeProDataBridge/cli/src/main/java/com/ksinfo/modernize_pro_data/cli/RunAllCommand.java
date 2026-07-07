package com.ksinfo.modernize_pro_data.cli;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.hc.client5.http.classic.methods.HttpPost;
import org.apache.hc.client5.http.impl.classic.CloseableHttpClient;
import org.apache.hc.client5.http.impl.classic.HttpClients;
import org.apache.hc.core5.http.HttpEntity;
import org.apache.hc.core5.http.io.entity.EntityUtils;
import picocli.CommandLine.Command;
import picocli.CommandLine.Option;

import java.util.concurrent.Callable;

/**
 * {@code modernize run-all} — schedule_start_time 가 set 된 全 project の
 * rehearsal 을 一斉 起動.
 *
 * POST {@code <endpoint>/api/v1/runs/all} 을 Bearer api_token 으로 叩는다.
 * 外部 스케줄러 (Control-M / Airflow / Jenkins / cron) 가 jobs 1 개로 일괄
 * 트리거 하는 PoC 권장 패턴.
 *
 * Exit code:
 *   0 — 1 개 이상의 project 가 STARTED
 *   1 — 모든 project 가 REJECTED / LOCKED, 혹은 schedule_start_time = NULL 인 project 만 존재
 *   3 — 認証 失敗 (401)
 *   4 — external_enabled = false (503)
 *   9 — 설정 불비 / その他 client 側 에러
 */
@Command(
        name = "run-all",
        description = "Trigger rehearsal for ALL projects with schedule_start_time set.",
        mixinStandardHelpOptions = true
)
public class RunAllCommand implements Callable<Integer> {

    @Option(names = "--config",
            description = "Override config file path (default: ~/.modernize/cli.yml)")
    String configPath;

    private static final ObjectMapper MAPPER = new ObjectMapper();

    @Override
    public Integer call() {
        CliConfig cfg;
        try {
            cfg = CliConfig.load(configPath);
            cfg.validate();
        } catch (Exception e) {
            System.err.println("Configuration error: " + e.getMessage());
            return 9;
        }

        String url = trimTrailingSlash(cfg.getEndpoint()) + "/api/v1/runs/all";

        try (CloseableHttpClient client = HttpClients.createDefault()) {
            HttpPost post = new HttpPost(url);
            post.setHeader("Authorization", "Bearer " + cfg.getToken());
            post.setHeader("Content-Type", "application/json");

            return client.execute(post, response -> {
                int code = response.getCode();
                HttpEntity entity = response.getEntity();
                String responseBody = entity != null ? EntityUtils.toString(entity) : "";

                if (code == 401) {
                    System.err.println("Authentication failed (401). Check 'token' in config.");
                    return 3;
                }
                if (code == 503) {
                    System.err.println("External integrations disabled (503). Enable in Solution Settings.");
                    return 4;
                }
                if (code >= 400) {
                    System.err.println("HTTP " + code + ": " + responseBody);
                    return 9;
                }

                try {
                    JsonNode root = MAPPER.readTree(responseBody);
                    JsonNode data = root.path("data");
                    int total = data.path("totalProjects").asInt(0);
                    int started = data.path("started").asInt(0);
                    int rejected = data.path("rejected").asInt(0);
                    int locked = data.path("locked").asInt(0);

                    System.out.println("total=" + total
                            + " started=" + started
                            + " rejected=" + rejected
                            + " locked=" + locked);

                    return started > 0 ? 0 : 1;
                } catch (Exception e) {
                    System.err.println("Unexpected response format: " + responseBody);
                    return 9;
                }
            });
        } catch (Exception e) {
            System.err.println("Request failed: " + e.getMessage());
            return 9;
        }
    }

    private static String trimTrailingSlash(String s) {
        return s.endsWith("/") ? s.substring(0, s.length() - 1) : s;
    }
}
