package com.ksinfo.modernize_pro_data.coordinator.worker.stages;

import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageInstance;
import com.ksinfo.modernize_pro_data.coordinator.worker.StageContext;
import com.ksinfo.modernize_pro_data.coordinator.worker.StageRunner;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

/**
 * Audit stage — TO-BE DDL 제약 평가 (NOT NULL / length / type 등) → 위반 row Quarantine.
 * 실 로직은 후속 단계에서 채움. test / rehearsal 만 (cutover 는 skip).
 */
@Service
@Slf4j
public class AuditStage implements StageRunner {

    @Override
    public String stageKey() {
        return "audit";
    }

    @Override
    public void run(StageContext ctx, StageInstance stage) {
        log.info("[stub] AuditStage runId={}", ctx.getRunHistory().getId());
    }
}
