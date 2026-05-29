package com.ksinfo.modernize_pro_data.coordinator.site.frozen;

import java.util.List;

public record SnapshotData(
        List<FrozenRule> rules,
        List<FrozenCodeMap> codeMaps,
        List<FrozenBinding> bindings
) {}
