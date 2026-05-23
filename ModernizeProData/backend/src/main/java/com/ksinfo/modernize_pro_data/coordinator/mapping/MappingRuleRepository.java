package com.ksinfo.modernize_pro_data.coordinator.mapping;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;

public interface MappingRuleRepository extends JpaRepository<MappingRule, String> {

    List<MappingRule> findByProjectId(String projectId);

    List<MappingRule> findByProjectIdAndTobeTable(String projectId, String tobeTable);

    long countByProjectId(String projectId);

    @Modifying
    @Query("DELETE FROM MappingRule r WHERE r.projectId = :projectId")
    int deleteAllByProjectId(@Param("projectId") String projectId);
}
