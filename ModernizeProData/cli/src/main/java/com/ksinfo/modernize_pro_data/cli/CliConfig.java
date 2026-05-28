package com.ksinfo.modernize_pro_data.cli;

import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.dataformat.yaml.YAMLFactory;
import lombok.AllArgsConstructor;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;

/**
 * CLI 設定ファイル loader. デフォルトパス: {@code ~/.modernize/cli.yml}
 *
 * <pre>
 * endpoint: http://localhost:8080
 * token:    mig_xxxxxxxxxxxxxxxxxxxxxxxxxx_a9f3
 * </pre>
 *
 * 環境変数で override 可能:
 *   MODERNIZE_ENDPOINT, MODERNIZE_TOKEN, MODERNIZE_CONFIG
 */
@Getter @Setter
@NoArgsConstructor
@AllArgsConstructor
public class CliConfig {

    @JsonProperty("endpoint")
    private String endpoint;

    @JsonProperty("token")
    private String token;

    /**
     * 設定 load:
     *   1. {@code --config} flag があれば そのパス
     *   2. 環境変数 MODERNIZE_CONFIG
     *   3. {@code ~/.modernize/cli.yml}
     *
     * 環境変数 MODERNIZE_ENDPOINT / MODERNIZE_TOKEN が定義されていれば
     * YAML 値を上書きする.
     */
    public static CliConfig load(String configPathOverride) throws IOException {
        Path path = resolveConfigPath(configPathOverride);
        CliConfig cfg;
        if (path != null && Files.exists(path)) {
            ObjectMapper mapper = new ObjectMapper(new YAMLFactory());
            cfg = mapper.readValue(path.toFile(), CliConfig.class);
        } else {
            cfg = new CliConfig();
        }

        // 環境変数 override
        String envEndpoint = System.getenv("MODERNIZE_ENDPOINT");
        if (envEndpoint != null && !envEndpoint.isBlank()) {
            cfg.endpoint = envEndpoint;
        }
        String envToken = System.getenv("MODERNIZE_TOKEN");
        if (envToken != null && !envToken.isBlank()) {
            cfg.token = envToken;
        }

        return cfg;
    }

    /** 必須項目 (endpoint, token) が揃っているか検証. */
    public void validate() {
        if (endpoint == null || endpoint.isBlank()) {
            throw new IllegalStateException(
                    "endpoint not configured. Set 'endpoint:' in ~/.modernize/cli.yml or MODERNIZE_ENDPOINT env var.");
        }
        if (token == null || token.isBlank()) {
            throw new IllegalStateException(
                    "token not configured. Set 'token:' in ~/.modernize/cli.yml or MODERNIZE_TOKEN env var.");
        }
    }

    private static Path resolveConfigPath(String override) {
        if (override != null && !override.isBlank()) {
            return Paths.get(override);
        }
        String env = System.getenv("MODERNIZE_CONFIG");
        if (env != null && !env.isBlank()) {
            return Paths.get(env);
        }
        String home = System.getProperty("user.home");
        if (home == null) return null;
        return Paths.get(home, ".modernize", "cli.yml");
    }
}
