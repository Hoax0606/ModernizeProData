package com.ksinfo.modernize_pro_data.coordinator.mapping;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;
import java.util.Optional;

public interface MappingAsisSkipRepository extends JpaRepository<MappingAsisSkip, String> {

    List<MappingAsisSkip> findByProjectId(String projectId);

    Optional<MappingAsisSkip> findByProjectIdAndAsisSchemaAndAsisTableAndAsisColumn(
            String projectId, String asisSchema, String asisTable, String asisColumn);

    @Modifying
    @Query("DELETE FROM MappingAsisSkip s WHERE s.projectId = :projectId")
    void deleteAllByProjectId(@Param("projectId") String projectId);

    @Modifying
    @Query("DELETE FROM MappingAsisSkip s WHERE s.projectId = :projectId " +
           "AND s.asisSchema = :asisSchema AND s.asisTable = :asisTable AND s.asisColumn = :asisColumn")
    void deleteOne(@Param("projectId") String projectId,
                   @Param("asisSchema") String asisSchema,
                   @Param("asisTable") String asisTable,
                   @Param("asisColumn") String asisColumn);
}
