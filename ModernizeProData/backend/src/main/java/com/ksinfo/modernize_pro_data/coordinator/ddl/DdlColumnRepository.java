package com.ksinfo.modernize_pro_data.coordinator.ddl;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;

public interface DdlColumnRepository extends JpaRepository<DdlColumn, String> {
    List<DdlColumn> findByTableIdOrderByOrdinalAsc(String tableId);
    List<DdlColumn> findByTableIdInOrderByOrdinalAsc(List<String> tableIds);
}
