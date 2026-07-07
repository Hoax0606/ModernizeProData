package com.ksinfo.modernize_pro_data.coordinator.ddl;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;

public interface DdlForeignKeyRepository extends JpaRepository<DdlForeignKey, String> {
    Optional<DdlForeignKey> findByConstraintId(String constraintId);
    List<DdlForeignKey> findByConstraintIdIn(List<String> constraintIds);
}
