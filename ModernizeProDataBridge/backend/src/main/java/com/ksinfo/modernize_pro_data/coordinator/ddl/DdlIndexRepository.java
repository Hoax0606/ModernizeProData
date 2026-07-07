package com.ksinfo.modernize_pro_data.coordinator.ddl;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;

public interface DdlIndexRepository extends JpaRepository<DdlIndex, String> {
    List<DdlIndex> findByProjectIdAndSide(String projectId, String side);
    List<DdlIndex> findByTableId(String tableId);
    List<DdlIndex> findByTableIdIn(List<String> tableIds);
}
