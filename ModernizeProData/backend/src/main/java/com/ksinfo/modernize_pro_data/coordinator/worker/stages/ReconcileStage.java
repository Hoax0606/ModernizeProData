package com.ksinfo.modernize_pro_data.coordinator.worker.stages;

import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageInstance;
import com.ksinfo.modernize_pro_data.coordinator.worker.StageContext;
import com.ksinfo.modernize_pro_data.coordinator.worker.StageRunner;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

/**
 * Reconcile stage — AS-IS sanity check (row count / duplicate key 등).
 * 실 로직은 후속 단계에서 채움.
 */
@Service
@Slf4j
public class ReconcileStage implements StageRunner {

    @Override
    public String stageKey() {
        return "reconcile";
    }

    @Override
    public void run(StageContext ctx, StageInstance stage) {
        log.info("[stub] ReconcileStage runId={}", ctx.getRunHistory().getId());
    }
}
