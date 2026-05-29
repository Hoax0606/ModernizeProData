package com.ksinfo.modernize_pro_data.coordinator.worker;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;

public interface WorkerNodeRepository extends JpaRepository<WorkerNode, String> {
    Optional<WorkerNode> findFirstByUserIdAndNameOrderByCreatedAtDesc(String userId, String name);
    /** 한 user (= admin login) 의 가장 최근 heartbeat 받은 worker. dispatch 시 활성 worker 결정용. */
    Optional<WorkerNode> findFirstByUserIdOrderByLastSeenAtDesc(String userId);
    List<WorkerNode> findAllByOrderByCreatedAtDesc();
}
