package com.ksinfo.modernize_pro_data.coordinator.site.frozen;

import com.ksinfo.modernize_pro_data.coordinator.mapping.MappingAsisSkip;

/**
 * AS-IS 컬럼 단위 명시적 skip 마킹의 frozen view.
 * SnapshotData JSONB 에 동결되어 has-changes diff + restore 에 사용.
 */
public record FrozenAsisSkip(
        String asisSchema,
        String asisTable,
        String asisColumn
) {
    public static FrozenAsisSkip fromEntity(MappingAsisSkip e) {
        return new FrozenAsisSkip(
                e.getAsisSchema() == null ? "" : e.getAsisSchema(),
                e.getAsisTable(),
                e.getAsisColumn()
        );
    }
}
