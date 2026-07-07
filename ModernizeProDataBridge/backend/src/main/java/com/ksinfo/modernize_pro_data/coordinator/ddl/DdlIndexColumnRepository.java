package com.ksinfo.modernize_pro_data.coordinator.ddl;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;

public interface DdlIndexColumnRepository extends JpaRepository<DdlIndexColumn, String> {
    List<DdlIndexColumn> findByIndexIdOrderByOrdinalAsc(String indexId);
    List<DdlIndexColumn> findByIndexIdInOrderByOrdinalAsc(List<String> indexIds);
}
