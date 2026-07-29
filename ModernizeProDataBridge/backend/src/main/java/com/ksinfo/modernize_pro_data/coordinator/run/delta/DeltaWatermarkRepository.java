package com.ksinfo.modernize_pro_data.coordinator.run.delta;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;

public interface DeltaWatermarkRepository extends JpaRepository<DeltaWatermark, String> {

    Optional<DeltaWatermark> findByProjectIdAndTobeSchemaAndTobeTable(
            String projectId, String tobeSchema, String tobeTable);

    List<DeltaWatermark> findByProjectId(String projectId);
}
