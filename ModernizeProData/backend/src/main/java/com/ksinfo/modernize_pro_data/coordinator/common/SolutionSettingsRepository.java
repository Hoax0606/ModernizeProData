package com.ksinfo.modernize_pro_data.coordinator.common;

import org.springframework.data.jpa.repository.JpaRepository;

public interface SolutionSettingsRepository extends JpaRepository<SolutionSettings, Integer> {

    /**
     * 単一行 lookup — 起動時 INSERT ... ON CONFLICT 가 보장한 id=1 row 를 가져옴.
     * Helper 로 Service / Filter 가 매번 findById(1) 안 써도 되게.
     */
    default SolutionSettings get() {
        return findById(SolutionSettings.SINGLETON_ID)
                .orElseThrow(() -> new IllegalStateException(
                        "solution_settings row not found — Flyway migration V20260521163530 may not have run."));
    }
}
