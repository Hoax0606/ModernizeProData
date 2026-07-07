package com.ksinfo.modernize_pro_data.coordinator.ddl;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;

public interface DdlImportRepository extends JpaRepository<DdlImport, String> {
    List<DdlImport> findByProjectId(String projectId);
    Optional<DdlImport> findFirstByProjectIdAndSideOrderByImportedAtDesc(String projectId, String side);
    void deleteByProjectIdAndSide(String projectId, String side);
}
