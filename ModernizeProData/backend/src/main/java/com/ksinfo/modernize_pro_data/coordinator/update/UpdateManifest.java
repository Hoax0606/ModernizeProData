package com.ksinfo.modernize_pro_data.coordinator.update;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import lombok.Data;

import java.time.OffsetDateTime;
import java.util.Map;

/**
 * GitHub Release 에 첨부된 {@code manifest.json} 의 schema.
 *
 * <pre>{@code
 * {
 *   "version": "1.0.1",
 *   "releasedAt": "2026-06-01T12:00:00Z",
 *   "assets": {
 *     "delta": { "url": "...", "sha256": "...", "signature": "..." }
 *   },
 *   "minRequiredVersion": "1.0.0",
 *   "releaseNotes": "..."
 * }
 * }</pre>
 *
 * 도구가 fetch 후 {@code version} 비교 → 최신이면 download asset, sha256 / signature 검증.
 * {@code minRequiredVersion} = 이 update 를 적용하기 위해 필요한 최소 현재 version
 * (예: 1.0.0 의 jar 가 1.2.0 으로 한 번에 못 가게 막을 때 사용).
 */
@Data
@JsonIgnoreProperties(ignoreUnknown = true)
public class UpdateManifest {
    private String version;
    private OffsetDateTime releasedAt;
    private Map<String, Asset> assets;
    private String minRequiredVersion;
    private String releaseNotes;

    @Data
    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class Asset {
        private String url;
        private String sha256;
        private String signature;
    }
}
