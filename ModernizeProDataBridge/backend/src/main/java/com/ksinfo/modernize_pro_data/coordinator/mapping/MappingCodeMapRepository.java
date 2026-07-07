package com.ksinfo.modernize_pro_data.coordinator.mapping;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;

public interface MappingCodeMapRepository extends JpaRepository<MappingCodeMap, String> {

    List<MappingCodeMap> findByProjectIdOrderByDomainAscOrdinalAsc(String projectId);

    List<MappingCodeMap> findByProjectIdAndDomainOrderByOrdinalAsc(String projectId, String domain);

    long countByProjectId(String projectId);

    @Modifying
    @Query("DELETE FROM MappingCodeMap c WHERE c.projectId = :projectId")
    int deleteAllByProjectId(@Param("projectId") String projectId);

    @Modifying
    @Query("DELETE FROM MappingCodeMap c WHERE c.projectId = :projectId AND c.domain IN :domains")
    int deleteByProjectIdAndDomainIn(@Param("projectId") String projectId, @Param("domains") java.util.Collection<String> domains);
}
