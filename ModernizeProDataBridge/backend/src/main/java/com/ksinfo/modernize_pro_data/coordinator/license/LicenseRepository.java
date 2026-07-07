package com.ksinfo.modernize_pro_data.coordinator.license;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.Optional;

public interface LicenseRepository extends JpaRepository<License, String> {
    /** 가장 최근 import 된 라이선스 = 활성. */
    Optional<License> findFirstByOrderByImportedAtDesc();
}
