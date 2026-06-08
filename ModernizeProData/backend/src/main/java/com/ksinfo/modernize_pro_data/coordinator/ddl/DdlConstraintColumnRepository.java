package com.ksinfo.modernize_pro_data.coordinator.ddl;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;

public interface DdlConstraintColumnRepository extends JpaRepository<DdlConstraintColumn, String> {
    List<DdlConstraintColumn> findByConstraintIdOrderByOrdinalAsc(String constraintId);
    List<DdlConstraintColumn> findByConstraintIdInOrderByOrdinalAsc(List<String> constraintIds);
}
