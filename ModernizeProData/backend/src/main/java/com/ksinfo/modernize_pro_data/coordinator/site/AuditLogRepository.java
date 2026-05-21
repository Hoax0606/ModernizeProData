package com.ksinfo.modernize_pro_data.coordinator.site;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;

import java.util.List;

public interface AuditLogRepository extends JpaRepository<AuditLog, String> {

    @Query("SELECT a FROM AuditLog a WHERE a.siteId = ?1 ORDER BY a.timestamp DESC")
    List<AuditLog> findBySiteOrdered(String siteId);

    @Query("SELECT a FROM AuditLog a WHERE a.projectId = ?1 ORDER BY a.timestamp DESC")
    List<AuditLog> findByProjectOrdered(String projectId);
}
