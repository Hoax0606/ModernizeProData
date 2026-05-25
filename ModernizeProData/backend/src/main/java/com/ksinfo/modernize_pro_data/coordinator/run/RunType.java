package com.ksinfo.modernize_pro_data.coordinator.run;

/**
 * Run 의 종류.
 * - test       : analysis phase 에서 동작 확인용 (소량 샘플)
 * - rehearsal  : rehearsal phase 의 dry-run (검증 전용, 결과 폐기)
 * - cutover    : production 환경 본 전환 (승인된 cutover snapshot 필수)
 *
 * Enum 이름이 DB lowercase 값과 일치 (UserRole 과 동일한 패턴).
 */
public enum RunType {
    test,
    rehearsal,
    cutover
}
