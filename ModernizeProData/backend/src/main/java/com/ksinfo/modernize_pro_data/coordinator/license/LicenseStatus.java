package com.ksinfo.modernize_pro_data.coordinator.license;

/**
 * 라이선스 상태 — 만료 단계.
 *
 * <pre>
 *   issued            expires           expires+grace      expires+grace+15d        expires+grace+30d
 *     │                  │                     │                    │                       │
 *     │   ACTIVE   ──►   │   IN_GRACE   ──►    │   READ_ONLY   ──►  │   EXPIRED  (전 API 차단)
 *     │                  │   (banner만)        │   (write 차단)     │
 *     │   60d 전부터 EXPIRING (사전 알림)
 * </pre>
 */
public enum LicenseStatus {
    /** 정상 (만료 60일 이상 남음) */
    ACTIVE,
    /** 만료 60일 이내 (사전 알림용) */
    EXPIRING,
    /** 만료 후 grace 기간 (기본 14일). banner 만 표시, 동작 정상 */
    IN_GRACE,
    /** grace 끝 ~ +15일. write API 차단, GET 만 허용 */
    READ_ONLY,
    /** 그 이후. 전 API 차단 (auth · license endpoint 제외) */
    EXPIRED,
    /** .lic 없음 (Coordinator 첫 기동 직후 등) */
    MISSING,
    /** .lic 있으나 서명 검증 실패 / 변조 의심 */
    INVALID;

    /** 변경 가능 (write) 차단되는 상태인지 */
    public boolean isWriteBlocked() {
        return this == READ_ONLY || this == EXPIRED || this == INVALID || this == MISSING;
    }

    /** 전 API 차단 상태인지 */
    public boolean isFullyBlocked() {
        return this == EXPIRED || this == INVALID || this == MISSING;
    }
}
