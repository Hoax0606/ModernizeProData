package com.ksinfo.modernize_pro_data.coordinator.load.spi;

import java.util.List;

/** 적재 후 부착할 UNIQUE 제약 메타. (구 LoadStage.UniqueConstraintMeta 를 공용 spi 로 이동.) */
public record UniqueConstraintMeta(String name, List<String> columns) {}
