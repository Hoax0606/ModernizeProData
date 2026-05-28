package com.ksinfo.modernize_pro_data.coordinator.user;

/**
 * 사용자 역할.
 * - master    → Coordinator. 사용자 발급·삭제·승인·시스템 설정 전권.
 * - admin     → Worker. 매핑·실행·일반 작업.
 * - viewer    → 조회만.
 */
public enum UserRole {
    master,
    admin,
    viewer
}
