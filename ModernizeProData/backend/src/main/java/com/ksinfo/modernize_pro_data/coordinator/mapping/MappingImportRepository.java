package com.ksinfo.modernize_pro_data.coordinator.mapping;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;

public interface MappingImportRepository extends JpaRepository<MappingImport, String> {
    List<MappingImport> findByProjectIdOrderByImportedAtDesc(String projectId);
    Optional<MappingImport> findFirstByProjectIdOrderByImportedAtDesc(String projectId);
}
