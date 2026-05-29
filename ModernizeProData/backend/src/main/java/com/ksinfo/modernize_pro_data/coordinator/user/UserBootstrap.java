package com.ksinfo.modernize_pro_data.coordinator.user;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.CommandLineRunner;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Component;

/**
 * 첫 부팅 시 master 계정이 없으면 username=master / password=password 로 생성.
 * Coordinator 모드일 때만 실행. PoC 단계 기본 비번이므로 운영 전 변경 필수.
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class UserBootstrap implements CommandLineRunner {

    private final UserRepository userRepository;
    private final PasswordEncoder passwordEncoder;
    private final PgRoleService pgRoleService;

    @Override
    public void run(String... args) {
        // 부팅 시 1회 — 메타 PG owner 가 admin user 발급에 필요한 CREATEROLE 권한을 가졌는지 확인.
        pgRoleService.ensureMasterCanCreateRoles();

        if (userRepository.existsByUsername("master")) {
            log.info("master 계정 이미 존재 — 시드 건너뜀");
            return;
        }
        User master = User.create("master", passwordEncoder.encode("password"), UserRole.master);
        userRepository.save(master);
        log.warn("master 계정 자동 생성 (username=master / password=password). 운영 전 비번 변경 필수.");
    }
}
