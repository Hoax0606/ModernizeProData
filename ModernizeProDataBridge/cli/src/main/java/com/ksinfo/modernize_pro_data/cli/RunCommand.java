package com.ksinfo.modernize_pro_data.cli;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.hc.client5.http.classic.methods.HttpPost;
import org.apache.hc.client5.http.impl.classic.CloseableHttpClient;
import org.apache.hc.client5.http.impl.classic.HttpClients;
import org.apache.hc.core5.http.ContentType;
import org.apache.hc.core5.http.HttpEntity;
import org.apache.hc.core5.http.io.entity.EntityUtils;
import org.apache.hc.core5.http.io.entity.StringEntity;
import picocli.CommandLine.Command;
import picocli.CommandLine.Option;

import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.Callable;

/**
 * {@code modernize run --project p-abc [--type rehearsal]} 의 実装.
 *
 * POST {@code <endpoint>/api/v1/runs} を Bearer api_token で叩く.
 * {@code --type} 省略時は BE 가 project.phase 로부터 runType 자동 결정.
 * Response の status (STARTED / REJECTED / LOCKED) に応じて exit code を返す.
 */
@Command(
        name = "run",
        description = "Trigger a project run (test / rehearsal / cutover).",
        mixinStandardHelpOptions = true
)
public class RunCommand implements Callable<Integer> {

    @Option(names = {"-p", "--project"}, required = true,
            description = "Project ID (例: p-abc12345)")
    String projectId;

    @Option(names = {"-t", "--type"},
            description = "Run type: test | rehearsal | cutover. 省略時 BE 가 project.phase 로부터 自動 결정.")
    String runType;

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

        // runType 검증 (지정된 경우만). 省略時은 BE 任せ.
        if (runType != null && !Map.of("test", true, "rehearsal", true, "cutover", true).containsKey(runType)) {
            System.err.println("Invalid runType '" + runType
                    + "'. Must be one of: test, rehearsal, cutover (or omit to auto-derive).");
            return 9;
        }

        String url = trimTrailingSlash(cfg.getEndpoint()) + "/api/v1/runs";
        String body;
        try {
            Map<String, Object> reqMap = new HashMap<>();
            reqMap.put("projectId", projectId);
            if (runType != null) reqMap.put("runType", runType);
            body = MAPPER.writeValueAsString(reqMap);
        } catch (Exception e) {
            System.err.println("Failed to build request body: " + e.getMessage());
            return 9;
        }

        try (CloseableHttpClient client = HttpClients.createDefault()) {
            HttpPost post = new HttpPost(url);
            post.setHeader("Authorization", "Bearer " + cfg.getToken());
            post.setEntity(new StringEntity(body, ContentType.APPLICATION_JSON));

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

                // 成功系: response.success が true で data.status を見る
                try {
                    JsonNode root = MAPPER.readTree(responseBody);
                    JsonNode data = root.path("data");
                    String runId = data.path("runId").asText(null);
                    String status = data.path("status").asText("UNKNOWN");
                    String reason = data.path("reason").asText(null);

                    System.out.println("status=" + status
                            + (runId != null ? " runId=" + runId : "")
                            + (reason != null ? " reason=" + reason : ""));

                    return switch (status) {
                        case "STARTED" -> 0;
                        case "REJECTED" -> 1;
                        case "LOCKED" -> 2;
                        default -> 9;
                    };
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
