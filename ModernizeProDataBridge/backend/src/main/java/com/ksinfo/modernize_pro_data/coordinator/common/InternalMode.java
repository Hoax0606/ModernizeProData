package com.ksinfo.modernize_pro_data.coordinator.common;

/**
 * Internal scheduler の発火モード.
 *   common     — 全 project が solution_settings.internal_common_time で発火
 *   individual — project ごとの schedule_start_time で発火
 *
 * DB CHECK 制約 (`solution_settings.internal_mode IN ('common', 'individual')`) と整合.
 * `@Enumerated(EnumType.STRING)` で persist されるため、enum constant 名は DB と同じ lowercase.
 */
public enum InternalMode {
    common,
    individual
}
