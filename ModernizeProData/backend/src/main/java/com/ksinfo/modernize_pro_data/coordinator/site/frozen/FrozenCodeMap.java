package com.ksinfo.modernize_pro_data.coordinator.site.frozen;

import com.ksinfo.modernize_pro_data.coordinator.mapping.MappingCodeMap;

public record FrozenCodeMap(
        String id,
        String domain,
        String sourceValue,
        String targetValue,
        String description,
        int ordinal
) {
    public static FrozenCodeMap fromEntity(MappingCodeMap m) {
        return new FrozenCodeMap(
                m.getId(),
                m.getDomain(),
                m.getSourceValue(),
                m.getTargetValue(),
                m.getDescription(),
                m.getOrdinal()
        );
    }
}
