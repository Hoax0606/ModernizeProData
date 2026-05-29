package com.ksinfo.modernize_pro_data.coordinator.ddl;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;

public interface DdlTableRepository extends JpaRepository<DdlTable, String> {
    List<DdlTable> findByProjectIdAndSideOrderByOrdinalAsc(String projectId, String side);
    List<DdlTable> findByImportId(String importId);
    List<DdlTable> findByProjectIdInAndSide(List<String> projectIds, String side);
}
