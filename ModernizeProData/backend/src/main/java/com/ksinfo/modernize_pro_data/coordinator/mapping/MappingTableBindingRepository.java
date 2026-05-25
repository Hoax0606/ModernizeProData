package com.ksinfo.modernize_pro_data.coordinator.mapping;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;

public interface MappingTableBindingRepository extends JpaRepository<MappingTableBinding, String> {

    List<MappingTableBinding> findByProjectId(String projectId);

    java.util.Optional<MappingTableBinding> findByProjectIdAndTobeSchemaAndTobeTable(
            String projectId, String tobeSchema, String tobeTable);

    long countByProjectId(String projectId);

    @Modifying
    @Query("DELETE FROM MappingTableBinding b WHERE b.projectId = :projectId")
    int deleteAllByProjectId(@Param("projectId") String projectId);
}
