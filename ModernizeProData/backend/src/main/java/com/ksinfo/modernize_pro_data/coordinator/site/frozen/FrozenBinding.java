package com.ksinfo.modernize_pro_data.coordinator.site.frozen;

import com.ksinfo.modernize_pro_data.coordinator.mapping.MappingTableBinding;

import java.time.OffsetDateTime;
import java.util.List;

public record FrozenBinding(
        String id,
        String tobeSchema,
        String tobeTable,
        String compositionKind,
        String whereFilter,
        String bindingOrigin,
        String createdBy,
        OffsetDateTime createdAt,
        String updatedBy,
        OffsetDateTime updatedAt,
        List<FrozenBindingSource> sources,
        /** 자식 link 마커 — null 이면 자체 정의. 값 있으면 master project_id. */
        String sharedFromProjectId
) {
    public static FrozenBinding fromEntity(MappingTableBinding b) {
        return new FrozenBinding(
                b.getId(),
                b.getTobeSchema(),
                b.getTobeTable(),
                b.getCompositionKind(),
                b.getWhereFilter(),
                b.getBindingOrigin(),
                b.getCreatedBy(),
                b.getCreatedAt(),
                b.getUpdatedBy(),
                b.getUpdatedAt(),
                b.getSources().stream().map(FrozenBindingSource::fromEntity).toList(),
                b.getSharedFromProjectId()
        );
    }
}
