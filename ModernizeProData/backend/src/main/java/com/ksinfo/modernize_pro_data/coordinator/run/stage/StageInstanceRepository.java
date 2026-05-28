package com.ksinfo.modernize_pro_data.coordinator.run.stage;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;

public interface StageInstanceRepository extends JpaRepository<StageInstance, String> {

    List<StageInstance> findByRunIdOrderBySeqAsc(String runId);

    Optional<StageInstance> findByRunIdAndStageKey(String runId, String stageKey);
}
