package com.ksinfo.modernize_pro_data.coordinator.ddl;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;

public interface DdlConstraintRepository extends JpaRepository<DdlConstraint, String> {
    List<DdlConstraint> findByProjectIdAndSide(String projectId, String side);
    List<DdlConstraint> findByProjectIdAndSideAndType(String projectId, String side, String type);
    List<DdlConstraint> findByTableId(String tableId);
    List<DdlConstraint> findByTableIdIn(List<String> tableIds);
    List<DdlConstraint> findByTableIdInAndType(List<String> tableIds, String type);
}
