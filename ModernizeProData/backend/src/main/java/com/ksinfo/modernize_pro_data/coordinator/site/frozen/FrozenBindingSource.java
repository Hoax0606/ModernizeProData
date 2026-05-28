package com.ksinfo.modernize_pro_data.coordinator.site.frozen;

import com.ksinfo.modernize_pro_data.coordinator.mapping.MappingTableBindingSource;

public record FrozenBindingSource(
        String id,
        int ordinal,
        String asisSchema,
        String asisTable,
        String alias,
        String role,
        String joinType,
        String joinOn
) {
    public static FrozenBindingSource fromEntity(MappingTableBindingSource s) {
        return new FrozenBindingSource(
                s.getId(),
                s.getOrdinal(),
                s.getAsisSchema(),
                s.getAsisTable(),
                s.getAlias(),
                s.getRole(),
                s.getJoinType(),
                s.getJoinOn()
        );
    }
}
