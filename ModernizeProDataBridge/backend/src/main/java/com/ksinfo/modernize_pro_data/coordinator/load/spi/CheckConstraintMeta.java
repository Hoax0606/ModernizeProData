package com.ksinfo.modernize_pro_data.coordinator.load.spi;

/** 적재 후 부착할 CHECK 제약 메타. (구 LoadStage.CheckConstraintMeta 를 공용 spi 로 이동.) */
public record CheckConstraintMeta(String name, String checkExpression) {}
