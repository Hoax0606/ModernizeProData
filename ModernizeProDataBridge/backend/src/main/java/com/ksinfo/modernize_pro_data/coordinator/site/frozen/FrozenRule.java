package com.ksinfo.modernize_pro_data.coordinator.site.frozen;

import com.ksinfo.modernize_pro_data.coordinator.mapping.MappingRule;

import java.time.OffsetDateTime;

public record FrozenRule(
        String id,
        /** 이 rule 이 어떤 mapping_imports row 로부터 왔는지 trace.
         *  옛 snapshot (이 필드 추가 전) 은 null. */
        String importId,
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
                r.getImportId(),
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
