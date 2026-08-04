package com.ksinfo.modernize_pro_data.coordinator.run;

/**
 * Run 의 종류.
 * - test       : analysis phase 에서 동작 확인용 (소량 샘플)
 * - rehearsal  : rehearsal phase 의 dry-run (검증 전용, 결과 폐기)
 * - cutover    : production 환경 본 전환 (승인된 cutover snapshot 필수)
 * - delta      : 초기 전량적재 이후 CDC 증분 catch-up. 델타 CSV(op-type I/U/D + PK)를
 *                받아 PK 기준 upsert+delete 병합. production 에서 매일 반복 실행 (전량
 *                Verify/Validation 생략). 초기 적재가 테이블+PK 를 미리 만들어둔 전제.
 *
 * Enum 이름이 DB lowercase 값과 일치 (UserRole 과 동일한 패턴).
 */
public enum RunType {
    test,
    rehearsal,
    cutover,
    delta
}
