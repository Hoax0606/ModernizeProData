package com.ksinfo.modernize_pro_data.coordinator.mapping;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;

public interface MappingTableBindingRepository extends JpaRepository<MappingTableBinding, String> {

    List<MappingTableBinding> findByProjectId(String projectId);

    /**
     * Snapshot freeze 用 — binding 의 sources 까지 한 쿼리로 가져온다.
     * EAGER 컬렉션 기본 동작은 binding 마다 별도 SELECT (N+1) 이라
     * snapshot 찍을 때 binding 100 개면 101 쿼리. JOIN FETCH 로 한 번에.
     */
    @Query("SELECT DISTINCT b FROM MappingTableBinding b LEFT JOIN FETCH b.sources WHERE b.projectId = :projectId")
    List<MappingTableBinding> findByProjectIdWithSources(@Param("projectId") String projectId);

    java.util.Optional<MappingTableBinding> findByProjectIdAndTobeSchemaAndTobeTable(
            String projectId, String tobeSchema, String tobeTable);

    long countByProjectId(String projectId);

    @Modifying
    @Query("DELETE FROM MappingTableBinding b WHERE b.projectId = :projectId")
    int deleteAllByProjectId(@Param("projectId") String projectId);
}
