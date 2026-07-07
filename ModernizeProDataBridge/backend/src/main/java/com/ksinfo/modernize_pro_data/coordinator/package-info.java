/**
 * Coordinator (master) 기능 패키지.
 *
 * 매핑·사용자·진행상황·라이선스 관리, UI 호스팅, 작업 분배,
 * 예약 실행 (Quartz) 등 master 역할에 필요한 모든 구성요소를 포함한다.
 *
 * 하위 패키지 예정:
 *  - api      REST 컨트롤러
 *  - mapping  매핑 정의 CRUD·lock·snapshot
 *  - user     사용자·역할·인증
 *  - license  .lic 검증
 *  - schedule Quartz 작업 정의
 *  - dispatch Worker 작업 분배
 *  - notify   알림 관리
 */
package com.ksinfo.modernize_pro_data.coordinator;
