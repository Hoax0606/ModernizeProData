package com.ksinfo.modernize_pro_data.coordinator.site;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;

public interface ProjectRepository extends JpaRepository<Project, String> {
    List<Project> findBySiteId(String siteId);
    void deleteBySiteId(String siteId);
    boolean existsBySiteIdAndName(String siteId, String name);
    boolean existsBySiteIdAndNameAndIdNot(String siteId, String name, String id);
}
