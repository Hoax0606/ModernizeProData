package com.ksinfo.modernize_pro_data.coordinator.site;

import org.springframework.data.jpa.repository.JpaRepository;

public interface SiteRepository extends JpaRepository<Site, String> {
    boolean existsByName(String name);
    boolean existsByNameAndIdNot(String name, String id);
}
