package com.ksinfo.modernize_pro_data.coordinator.common;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import lombok.AllArgsConstructor;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

import java.time.LocalTime;
import java.time.OffsetDateTime;

/**
 * Solution-level configuration (단일 행 테이블, id=1 固定).
 *
 * 主用途는 External integrations master switch:
 *   external_enabled = false → REST 認証 filter 가 503 で足切り.
 *
 * 다른 설정 (notification retention 等) 도 점진적으로 여기로 이관 예정.
 */
@Entity
@Table(name = "solution_settings")
@Getter @Setter
@NoArgsConstructor
@AllArgsConstructor
public class SolutionSettings {

    /** 単一 row 강제 — DB schema 가 CHECK (id = 1) 보장. */
    public static final Integer SINGLETON_ID = 1;

    @Id
    private Integer id;

    /**
     * 내부 스케줄러 (Quartz Nightly Rehearsal) ON/OFF.
     * external_enabled 와 mutex (DB CHECK 制約 + 서비스 계층 auto-flip).
     */
    @Column(name = "internal_enabled", nullable = false)
    private boolean internalEnabled;

    /**
     * Internal mode — internal_enabled=true 時のみ意味.
     *   common     — internal_common_time 1 つで全 project が発火
     *   individual — project ごとの schedule_start_time で発火
     * internal_enabled=false 時は NULL.
     */
    @Enumerated(EnumType.STRING)
    @Column(name = "internal_mode", length = 16)
    private InternalMode internalMode;

    /** mode="common" 時の発火時刻. mode="individual" 時は使用しない. */
    @Column(name = "internal_common_time")
    private LocalTime internalCommonTime;

    @Column(name = "external_enabled", nullable = false)
    private boolean externalEnabled;

    /**
     * 外部スケジューラ / curl がアクセスする本ツールの URL.
     * Trigger examples docs に substitute される. master が UI で明示入力.
     * 例: "http://coordinator.kdb.internal:8080"
     */
    @Column(name = "external_api_endpoint", length = 512)
    private String externalApiEndpoint;

    @Column(name = "updated_at", nullable = false)
    private OffsetDateTime updatedAt;

    @Column(name = "updated_by", length = 64)
    private String updatedBy;
}
