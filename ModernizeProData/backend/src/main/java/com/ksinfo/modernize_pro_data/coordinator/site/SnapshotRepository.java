package com.ksinfo.modernize_pro_data.coordinator.site;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;

import java.util.List;
import java.util.Optional;

public interface SnapshotRepository extends JpaRepository<Snapshot, String> {
    List<Snapshot> findByProjectId(String projectId);
    List<Snapshot> findByProjectIdIn(List<String> projectIds);
    
    @Query("SELECT s FROM Snapshot s WHERE s.projectId = ?1 ORDER BY s.createdAt DESC LIMIT 1")
    Optional<Snapshot> findLatestByProjectId(String projectId);
}
