package com.ksinfo.modernize_pro_data.coordinator.site.frozen;

import com.ksinfo.modernize_pro_data.coordinator.mapping.MappingRule;

import java.time.OffsetDateTime;

public record FrozenRule(
        String id,
        String tobeSchema,
        String tobeTable,
        String tobeColumn,
        String asisSchema,
        String asisTable,
        String[] asisColumn,
        String[] asisType,
        String codeDomain,
        String strategy,
        String transformRule,
        String transformSql,
        String defaultValue,
        boolean notNullOverride,
        String ruleOrigin,
        String notes,
        String createdBy,
        OffsetDateTime createdAt,
        String updatedBy,
        OffsetDateTime updatedAt
) {
    public static FrozenRule fromEntity(MappingRule r) {
        return new FrozenRule(
                r.getId(),
                r.getTobeSchema(), r.getTobeTable(), r.getTobeColumn(),
                r.getAsisSchema(), r.getAsisTable(),
                r.getAsisColumn(), r.getAsisType(),
                r.getCodeDomain(),
                r.getStrategy(), r.getTransformRule(), r.getTransformSql(),
                r.getDefaultValue(), r.isNotNullOverride(),
                r.getRuleOrigin(), r.getNotes(),
                r.getCreatedBy(), r.getCreatedAt(),
                r.getUpdatedBy(), r.getUpdatedAt()
        );
    }
}
