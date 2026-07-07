/**
 * 공통 패키지.
 *
 * Coordinator·Worker 양쪽이 공유하는 도메인 모델, DTO, 유틸리티,
 * 매핑 정의 파서, 인코딩 변환 모듈 등을 포함한다.
 *
 * 하위 패키지 예정:
 *  - model     도메인 엔티티 (User, MappingDef, Run, Audit 등)
 *  - dto       REST 요청·응답 DTO
 *  - mapping   매핑 정의 YAML/JSON 파서
 *  - encoding  Shift JIS / EBCDIC / COMP 변환 유틸
 *  - util      공통 유틸리티
 */
package com.ksinfo.modernize_pro_data.common;
