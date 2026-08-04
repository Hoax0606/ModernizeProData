package com.ksinfo.modernize_pro_data.coordinator.load.spi;

import java.util.List;

/** 적재 후 부착할 FOREIGN KEY 제약 메타. (구 LoadStage.ForeignKeyMeta 를 공용 spi 로 이동.) */
public record ForeignKeyMeta(String name, List<String> columns,
                             String refSchema, String refTable, List<String> refColumns,
                             String onDelete, String onUpdate, String deferrableInfo) {}
