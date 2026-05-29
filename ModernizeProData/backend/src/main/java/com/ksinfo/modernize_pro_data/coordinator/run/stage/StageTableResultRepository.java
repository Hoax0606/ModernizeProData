package com.ksinfo.modernize_pro_data.coordinator.run.stage;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.Collection;
import java.util.List;
import java.util.Optional;

public interface StageTableResultRepository extends JpaRepository<StageTableResult, String> {

    List<StageTableResult> findByStageInstanceIdIn(Collection<String> stageInstanceIds);

    Optional<StageTableResult> findByStageInstanceIdAndBindingId(String stageInstanceId, String bindingId);
}
