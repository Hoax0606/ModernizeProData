package com.ksinfo.modernize_pro_data.coordinator.worker;

/**
 * Worker registration lifecycle.
 *
 * <pre>
 *   PROVISIONED  -- master 가 token 발급. worker 아직 register 안 함.
 *   REGISTERED   -- worker 가 한 번 이상 POST /workers/register 호출.
 *   REVOKED      -- master 가 token 폐기. WorkerTokenAuthFilter 가 거부.
 * </pre>
 */
public enum WorkerStatus {
    PROVISIONED,
    REGISTERED,
    REVOKED
}
