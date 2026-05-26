package com.ksinfo.modernize_pro_data.coordinator.worker;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;

public interface WorkerNodeRepository extends JpaRepository<WorkerNode, String> {
    Optional<WorkerNode> findFirstByUserIdAndNameOrderByCreatedAtDesc(String userId, String name);
    List<WorkerNode> findAllByOrderByCreatedAtDesc();
}
